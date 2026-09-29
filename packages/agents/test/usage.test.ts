import { describe, expect, it } from 'vitest';
import { AnthropicModel } from '../src/model/anthropic-model.js';
import { BudgetExceededError, MeteredModel, type UsageRecord } from '../src/model/metered-model.js';
import { costUsd } from '../src/model/pricing.js';
import type { ModelClient, ModelTurn } from '../src/model/anthropic-model.js';

describe('costUsd', () => {
  it('prices input, output, cache reads and cache writes from the published table', () => {
    // claude-opus-5-5: $4 in, $20 out, $0.20 cache read, $5 cache write (1.25x) per MTok.
    expect(costUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(4);
    expect(costUsd('claude-opus-5-5', { inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(20);
    expect(costUsd('claude-opus-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 })).toBeCloseTo(5.2);
    expect(costUsd('claude-opus-5', { inputTokens: 2_000, outputTokens: 1_000 })).toBeCloseTo(0.035);
    expect(costUsd('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(6);
  });

  it('is unknown, not zero, for a model the table does not list or usage it was not given', () => {
    expect(costUsd('claude-something-new', { inputTokens: 100, outputTokens: 100 })).toBeNull();
    expect(costUsd('claude-opus-5-5', { inputTokens: null, outputTokens: 100 })).toBeNull();
  });
});

const turn = (over: Partial<ModelTurn> = {}): ModelTurn => ({
  raw: [], text: '', toolUses: [], stopReason: 'end_turn', model: 'claude-opus-5-5', durationMs: 1,
  usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 9000, cacheWriteTokens: 0 }, ...over,
});

describe('MeteredModel', () => {
  it('records each call’s usage and cost', async () => {
    const records: UsageRecord[] = [];
    const inner: ModelClient = { model: 'claude-opus-5-5', complete: async () => turn() };
    const model = new MeteredModel(inner, { beforeCall: async () => {}, record: async (r) => void records.push(r) }, 'investigation');
    await model.complete({ system: 's', messages: [], tools: [] });
    expect(records).toEqual([expect.objectContaining({ kind: 'investigation', inputTokens: 1000, cacheReadTokens: 9000 })]);
    expect(records[0]!.usdCost).toBeCloseTo(1000 * 4e-6 + 500 * 20e-6 + 9000 * 0.2e-6);
  });

  it('sends nothing once the budget is reached', async () => {
    let sent = 0;
    const inner: ModelClient = { model: 'm', complete: async () => (sent++, turn()) };
    const model = new MeteredModel(inner, {
      beforeCall: async () => { throw new BudgetExceededError(12, 10); },
      record: async () => {},
    }, 'patch');
    await expect(model.complete({ system: 's', messages: [], tools: [] })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(sent).toBe(0);
  });
});

describe('AnthropicModel prompt caching', () => {
  // Every investigation turn resent the whole system prompt and history uncached.
  it('marks the system prompt and the conversation for caching, and reads cache usage', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const model = new AnthropicModel({ apiKey: 'sk-ant-test-key', model: 'claude-opus-5-5', fetch: fetchImpl, maxRetries: 0 });
    const out = await model.complete({ system: 'You investigate incidents.', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] });
    expect(body.system).toEqual([{ type: 'text', text: 'You investigate incidents.', cache_control: { type: 'ephemeral' } }]);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(out.usage).toMatchObject({ inputTokens: 10, cacheReadTokens: 4000, cacheWriteTokens: 0 });
  });
});

describe('investigator tool output caps', () => {
  it('cuts a large file and says so', async () => {
    const { investigationTools, MAX_TOOL_TEXT_CHARS } = await import('../src/investigator/tools.js');
    const big = 'x'.repeat(MAX_TOOL_TEXT_CHARS + 500);
    const providers = {
      observability: {} as never,
      sourceControl: { getFile: async () => big } as never,
      knowledge: null,
    };
    const tool = investigationTools('L3', providers).find((t) => t.spec.name === 'read_repository_file')!;
    const ctx = { tool: async (_n: string, _i: unknown, fn: () => Promise<unknown>) => ({ value: await fn(), toolCallId: 't1' }) } as never;
    const out = (await tool.run(ctx, { path: 'big.ts' }, { deployedRevision: 'abc', repository: 'a/b' } as never, providers)) as { content: string; truncated: boolean; note: string };
    expect(out.content).toHaveLength(MAX_TOOL_TEXT_CHARS);
    expect(out.truncated).toBe(true);
    expect(out.note).toMatch(/first 40000 of 40500/);
  });
});

/**
 * What a model call costs, in US dollars.
 *
 * Anthropic's first-party list prices per million tokens, as published on
 * 2026-09-25. A 5-minute cache write is 1.25× the input price; cache reads are
 * priced per model. A model not listed here costs `null` — unknown, never zero — so
 * a spend cap cannot be silently bypassed by a model the table does not know.
 */

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

const price = (input: number, output: number, cacheRead: number): ModelPrice => ({
  inputPerMTok: input,
  outputPerMTok: output,
  cacheReadPerMTok: cacheRead,
  cacheWritePerMTok: input * 1.25,
});

export const PRICES_AS_OF = '2026-09-25';

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': price(10, 50, 0.25),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-opus-5': price(5, 25, 0.5),
  'claude-opus-4-8': price(5, 25, 0.5),
  'claude-sonnet-5-5': price(2, 10, 0.2),
  'claude-sonnet-5': price(2, 10, 0.2),
  'claude-haiku-4-5': price(1, 5, 0.1),
};

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

/** The cost of one call, or null when the model's price or the call's usage is unknown. */
export function costUsd(model: string, usage: TokenUsage): number | null {
  // Responses name the model they ran on, which may carry a dated suffix.
  const key = Object.keys(MODEL_PRICES).find((k) => model === k || model.startsWith(`${k}-2`));
  const p = key ? MODEL_PRICES[key] : undefined;
  if (!p || usage.inputTokens === null || usage.outputTokens === null) return null;
  const perToken = (perMTok: number) => perMTok / 1_000_000;
  return (
    usage.inputTokens * perToken(p.inputPerMTok) +
    usage.outputTokens * perToken(p.outputPerMTok) +
    (usage.cacheReadTokens ?? 0) * perToken(p.cacheReadPerMTok) +
    (usage.cacheWriteTokens ?? 0) * perToken(p.cacheWritePerMTok)
  );
}

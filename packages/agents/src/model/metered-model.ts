import type { ModelClient, ModelRequest, ModelTurn } from './anthropic-model.js';
import { costUsd } from './pricing.js';

/**
 * A model client that checks a budget before each call and records what each call
 * cost after it.
 *
 * Wrapped around the real client, so the investigator and the patch generator are
 * metered without knowing it. A workspace at its monthly cap gets
 * `BudgetExceededError` before the request is sent — nothing is spent past the cap.
 */

export class BudgetExceededError extends Error {
  constructor(readonly spentUsd: number, readonly capUsd: number) {
    super(`The workspace's monthly model budget is reached: $${spentUsd.toFixed(2)} spent of $${capUsd.toFixed(2)}.`);
    this.name = 'BudgetExceededError';
  }
}

export interface UsageRecord {
  kind: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Null when the price or the usage is unknown. */
  usdCost: number | null;
}

export interface UsageMeter {
  /** Throws BudgetExceededError when the workspace may not spend more. */
  beforeCall(): Promise<void>;
  record(usage: UsageRecord): Promise<void>;
}

export class MeteredModel implements ModelClient {
  readonly model: string;

  constructor(
    private readonly inner: ModelClient,
    private readonly meter: UsageMeter,
    /** What the calls are for: 'investigation', 'patch', … */
    private readonly kind: string,
  ) {
    this.model = inner.model;
  }

  async complete(request: ModelRequest): Promise<ModelTurn> {
    await this.meter.beforeCall();
    const turn = await this.inner.complete(request);
    await this.meter.record({
      kind: this.kind,
      model: turn.model,
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      cacheReadTokens: turn.usage.cacheReadTokens ?? null,
      cacheWriteTokens: turn.usage.cacheWriteTokens ?? null,
      usdCost: costUsd(turn.model, turn.usage),
    });
    return turn;
  }
}

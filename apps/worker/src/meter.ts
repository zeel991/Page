import { UsageRepository, type Database } from '@pager/db';
import { BudgetExceededError, type UsageMeter } from '@pager/agents';

/**
 * The worker's meter for one tenant's job: refuse a model call once the workspace's
 * month-to-date spend reaches its cap, and record every call's usage and cost.
 */
export function usageMeter(
  db: Database,
  scope: { organizationId: string; serviceId: string; keySource: 'workspace' | 'operator'; incidentId: () => string | null },
  cap: () => Promise<number | null>,
  now: () => Date = () => new Date(),
): UsageMeter {
  const usage = new UsageRepository(db);
  return {
    async beforeCall() {
      const limit = await cap();
      if (limit === null) return;
      const { usd } = await usage.monthToDate(scope.organizationId, now());
      if (usd >= limit) throw new BudgetExceededError(usd, limit);
    },
    async record(u) {
      await usage.record({
        organizationId: scope.organizationId,
        serviceId: scope.serviceId,
        incidentId: scope.incidentId(),
        kind: u.kind,
        model: u.model,
        keySource: scope.keySource,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        usdCost: u.usdCost,
        at: now(),
      });
    },
  };
}

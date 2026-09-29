import { z } from 'zod';
import { AUTONOMY_LEVELS, type AutonomyLevel } from './policy/tools.js';

/**
 * What a watched service is configured with, and the rules it must satisfy.
 *
 * These were the worker's environment checks (`loadConfig`). Now that a service is
 * customer input saved from the console, the same rules run when it is saved — a
 * service that cannot be watched is refused at the form, not discovered mid-incident.
 */

export const MIN_INTERVAL_SECONDS = 15;
export const MAX_INTERVAL_SECONDS = 3600;

/** Datadog's API hosts, one per site. Keys are never sent anywhere else. */
export const DATADOG_API_HOSTS: ReadonlySet<string> = new Set([
  'api.datadoghq.com',
  'api.us3.datadoghq.com',
  'api.us5.datadoghq.com',
  'api.datadoghq.eu',
  'api.ap1.datadoghq.com',
  'api.ap2.datadoghq.com',
  'api.ddog-gov.com',
]);

/** A Datadog service tag value: what the service is called in Datadog. */
const SERVICE_NAME = /^[A-Za-z0-9_.\-/]{1,100}$/;

export const ServiceConfig = z.object({
  /** The service as the alert source knows it (Datadog's `service` tag). */
  name: z.string().regex(SERVICE_NAME, 'must be a plain Datadog service name (letters, digits, _ . - /)'),
  repositoryId: z.string().uuid(),
  /** Where the running service reports its deployed revision. https, public. */
  healthUrl: z.string().url(),
  alertSource: z.literal('datadog').default('datadog'),
  /** Mandatory: merge clicks count only from this channel. */
  slackChannelId: z.string().min(1, 'a Slack channel is required'),
  slackChannelName: z.string().nullable().optional(),
  /** Null means the repository's default branch. */
  baseBranch: z.string().regex(/^[\w./-]+$/).nullable().optional(),
  autonomyLevel: z
    .enum(AUTONOMY_LEVELS as unknown as [AutonomyLevel, ...AutonomyLevel[]])
    .default('L3')
    // The workflow reports to Slack, which needs L2. Below that it would fail at the
    // first write of every incident.
    .refine((l) => AUTONOMY_LEVELS.indexOf(l) >= AUTONOMY_LEVELS.indexOf('L2'), 'must be at least L2 to report to Slack'),
  readOnly: z.boolean().default(false),
  intervalSeconds: z
    .number()
    .int('must be a whole number of seconds')
    .min(MIN_INTERVAL_SECONDS)
    .max(MAX_INTERVAL_SECONDS)
    .default(60),
  notionParentPageId: z.string().regex(/^[0-9a-fA-F-]{32,36}$/, 'must be a Notion page id').nullable().optional(),
  emailRecipients: z.array(z.string().email()).max(50).default([]),
});
export type ServiceConfig = z.infer<typeof ServiceConfig>;

/** Why a service configuration is refused, as field → message. Empty when valid. */
export function serviceConfigProblems(
  input: unknown,
  opts: { allowInsecureHealthUrl?: boolean } = {},
): { config: ServiceConfig | null; problems: Record<string, string> } {
  const parsed = ServiceConfig.safeParse(input);
  const problems: Record<string, string> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '(root)';
      problems[key] ??= issue.message;
    }
    return { config: null, problems };
  }
  // The health URL is fetched by the worker from inside our network: https only.
  // Plain http is accepted only for local drills, never for a tenant.
  if (!parsed.data.healthUrl.startsWith('https://') && !opts.allowInsecureHealthUrl) {
    return { config: null, problems: { healthUrl: 'must be an https URL' } };
  }
  return { config: parsed.data, problems: {} };
}

/** A Datadog site URL is acceptable only if it is one of Datadog's own API hosts, over https. */
export function isDatadogApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && DATADOG_API_HOSTS.has(parsed.host) && parsed.pathname.replace(/\/+$/, '') === '';
  } catch {
    return false;
  }
}

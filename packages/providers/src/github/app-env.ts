import { GitHubAppClient } from './app-client.js';

const KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_WEBHOOK_SECRET'] as const;

/**
 * The operator's GitHub App from the environment: all of it, or none of it.
 * Half a configuration is refused rather than guessed around.
 */
export function githubAppFromEnv(env: NodeJS.ProcessEnv): GitHubAppClient | null {
  const missing = KEYS.filter((k) => !env[k]?.trim());
  if (missing.length === KEYS.length) return null;
  if (missing.length > 0) throw new Error(`GitHub App partly configured; missing ${missing.join(', ')}.`);
  const value = (k: (typeof KEYS)[number]) => clean(env[k]!);
  return new GitHubAppClient({
    appId: value('GITHUB_APP_ID'),
    // PEMs in env files usually arrive with literal "\n".
    privateKeyPem: value('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'),
    slug: value('GITHUB_APP_SLUG'),
    clientId: value('GITHUB_APP_CLIENT_ID'),
    clientSecret: value('GITHUB_APP_CLIENT_SECRET'),
    webhookSecret: value('GITHUB_APP_WEBHOOK_SECRET'),
    apiBaseUrl: env.PAGER_GITHUB_API_URL ?? 'https://api.github.com',
    webBaseUrl: env.PAGER_GITHUB_WEB_URL ?? 'https://github.com',
  });
}

/**
 * A value as pasted into a dashboard or imported from a .env file: surrounding
 * whitespace and one pair of surrounding quotes are not part of it. A webhook secret
 * with a trailing newline signed nothing GitHub sent, so every delivery was refused.
 */
export function clean(raw: string): string {
  const v = raw.trim();
  const quoted = /^"([\s\S]*)"$/.exec(v) ?? /^'([\s\S]*)'$/.exec(v);
  return quoted ? quoted[1]! : v;
}

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
  return new GitHubAppClient({
    appId: env.GITHUB_APP_ID!,
    // PEMs in env files usually arrive with literal "\n".
    privateKeyPem: env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n'),
    slug: env.GITHUB_APP_SLUG!,
    clientId: env.GITHUB_APP_CLIENT_ID!,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET!,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET!,
    apiBaseUrl: env.PAGER_GITHUB_API_URL ?? 'https://api.github.com',
    webBaseUrl: env.PAGER_GITHUB_WEB_URL ?? 'https://github.com',
  });
}

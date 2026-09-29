import type { NextAuthConfig } from 'next-auth';
import GitHub from 'next-auth/providers/github';

/**
 * Sign-in configuration that is safe for the edge runtime, where middleware runs.
 *
 * GitHub is the only provider. The OAuth client is the Pager Developer GitHub App's
 * own (AUTH_GITHUB_ID / AUTH_GITHUB_SECRET), so the token it yields is a user-to-server
 * token — which is what later proves, at install time, that the person installing
 * the app can actually see the installation they are claiming.
 *
 * The GitHub hosts are configurable only so the local twin can stand in for GitHub in
 * development. In production they are github.com and api.github.com.
 */
const GITHUB_WEB = (process.env.PAGER_GITHUB_WEB_URL ?? 'https://github.com').replace(/\/+$/, '');
const GITHUB_API = (process.env.PAGER_GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');

/** Console surfaces that require a signed-in member. */
export const PROTECTED_PREFIXES = [
  '/dashboard',
  '/incidents',
  '/deployments',
  '/agent-runs',
  '/policies',
  '/onboarding',
  '/services',
  '/settings',
];

export const authConfig = {
  providers: [
    GitHub({
      authorization: { url: `${GITHUB_WEB}/login/oauth/authorize`, params: { scope: 'read:user user:email' } },
      token: `${GITHUB_WEB}/login/oauth/access_token`,
      userinfo: {
        url: `${GITHUB_API}/user`,
        async request({ tokens }: { tokens: { access_token?: string } }) {
          const res = await fetch(`${GITHUB_API}/user`, {
            headers: { authorization: `Bearer ${tokens.access_token}`, 'user-agent': 'pager-developer' },
          });
          if (!res.ok) throw new Error(`GitHub /user answered ${res.status}`);
          return res.json();
        },
      },
    }),
  ],
  pages: { signIn: '/signin' },
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
  trustHost: process.env.AUTH_TRUST_HOST === 'true' || process.env.NODE_ENV !== 'production',
  callbacks: {
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname;
      const needsAuth = PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
      return needsAuth ? Boolean(auth?.user) : true;
    },
  },
} satisfies NextAuthConfig;

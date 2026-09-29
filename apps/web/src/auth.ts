import NextAuth from 'next-auth';
import { authConfig } from './auth.config';
import { internalCall } from './lib/api-token';

/**
 * Full sign-in, run on the console's server.
 *
 * On sign-in the GitHub profile goes to the API, which owns the database: it upserts
 * the person by their numeric GitHub id and, the first time, creates their workspace
 * with them as owner. The session then carries only ids; what a person may see is
 * re-checked by the API on every call.
 */
declare module 'next-auth' {
  interface Session {
    userId?: string;
    organizationId?: string;
  }
}

interface SignInResult {
  userId: string;
  workspaces: { id: string; name: string; role: string }[];
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, account, profile }) {
      if (account?.provider === 'github' && profile) {
        const p = profile as { id?: number | string; login?: string; email?: string | null; name?: string | null; avatar_url?: string | null };
        const result = await internalCall<SignInResult>('/internal/sign-in', {
          provider: 'github',
          subject: String(p.id),
          login: p.login ?? null,
          email: p.email ?? null,
          name: p.name ?? null,
          avatarUrl: p.avatar_url ?? null,
        });
        token.userId = result.userId;
        token.organizationId = result.workspaces[0]?.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.userId === 'string') session.userId = token.userId;
      if (typeof token.organizationId === 'string') session.organizationId = token.organizationId;
      return session;
    },
  },
});

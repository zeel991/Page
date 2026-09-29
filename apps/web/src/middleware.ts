import NextAuth from 'next-auth';
import { authConfig } from './auth.config';

/**
 * Console routes require a signed-in member; the landing page and sign-in do not.
 * This only checks that a session exists. What the session may see is decided by
 * the API, per request, from the membership it re-reads.
 */
export default NextAuth(authConfig).auth;

export const config = {
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|ico)$).*)'],
};

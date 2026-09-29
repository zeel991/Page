import type { FastifyReply, FastifyRequest } from 'fastify';
import { InvalidTokenError, verifyToken } from '@pager/core';
import { IdentityRepository, type Database, type Role } from '@pager/db';

/**
 * Who is calling, established on every request.
 *
 * The console signs an `api-session` token naming the user and the workspace they
 * are acting in. The token alone is not trusted for the workspace: the membership is
 * re-read from the database on each request, so removing someone from a workspace
 * takes effect immediately rather than when their token expires.
 *
 * `organizationId` is only ever taken from here. No route reads it from a body, a
 * query string or a path.
 */

export interface RequestAuth {
  userId: string;
  organizationId: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: RequestAuth;
  }
}

export function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1]! : null;
}

export function sessionGuard(db: Database, secret: string) {
  const identity = new IdentityRepository(db);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    let claims: { sub?: unknown; org?: unknown };
    try {
      claims = verifyToken<{ sub?: unknown; org?: unknown }>(secret, 'api-session', bearer(request));
    } catch (err) {
      await reply.code(401).send({ error: 'unauthenticated', reason: err instanceof InvalidTokenError ? err.message : 'invalid token' });
      return;
    }
    if (typeof claims.sub !== 'string' || typeof claims.org !== 'string') {
      await reply.code(401).send({ error: 'unauthenticated', reason: 'token names no user or workspace' });
      return;
    }
    const membership = await identity.membership(claims.sub, claims.org);
    if (!membership) {
      // Not 403: saying "forbidden" would confirm the workspace exists.
      await reply.code(401).send({ error: 'unauthenticated', reason: 'not a member of this workspace' });
      return;
    }
    request.auth = { userId: claims.sub, organizationId: claims.org, role: membership.role };
  };
}

export function internalGuard(secret: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      verifyToken(secret, 'internal', bearer(request));
    } catch {
      await reply.code(401).send({ error: 'unauthenticated' });
    }
  };
}

/** The caller's authorisation. Only called behind `sessionGuard`. */
export function auth(request: FastifyRequest): RequestAuth {
  if (!request.auth) throw new Error('route is not behind the session guard');
  return request.auth;
}

export function requireRole(request: FastifyRequest, reply: FastifyReply, roles: Role[]): boolean {
  if (roles.includes(auth(request).role)) return true;
  void reply.code(403).send({ error: 'forbidden', reason: `needs one of: ${roles.join(', ')}` });
  return false;
}

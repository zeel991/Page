import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IdentityRepository, type Database } from '@pager/db';

/**
 * Called by the console's server, never by a browser: behind the internal guard.
 *
 * Sign-in lands here so the API stays the only process that owns the database. A
 * first sign-in creates a workspace with the person as its owner.
 */
const SignIn = z.object({
  provider: z.literal('github'),
  subject: z.string().regex(/^\d+$/, 'a GitHub numeric user id'),
  login: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

export async function registerInternalRoutes(app: FastifyInstance, deps: { db: Database }): Promise<void> {
  const identity = new IdentityRepository(deps.db);

  app.post('/internal/sign-in', async (request, reply) => {
    const parsed = SignIn.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid profile', issues: parsed.error.issues });
    const { user, workspaces, created } = await identity.signIn(parsed.data);
    return { userId: user.id, workspaces, created };
  });
}

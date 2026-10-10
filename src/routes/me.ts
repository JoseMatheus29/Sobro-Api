import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Ctx } from '../context.js';
import { profile, users } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { deleteAccount } from '../services/auth.js';

const patchBody = z
  .object({
    name: z.string().trim().max(100),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use um código de moeda de 3 letras.'),
    remindersEnabled: z.boolean(),
  })
  .partial();

const deleteBody = z.object({ password: z.string().min(1).max(128) });

export async function meRoutes(app: FastifyInstance, ctx: Ctx) {
  async function readMe(userId: string) {
    const [row] = await ctx.db
      .select({
        id: users.id,
        email: users.email,
        name: profile.name,
        currency: profile.currency,
        remindersEnabled: profile.remindersEnabled,
      })
      .from(users)
      .innerJoin(profile, eq(profile.userId, users.id))
      .where(eq(users.id, userId));
    if (!row) throw notFound('Conta não encontrada.');
    return row;
  }

  app.get('/me', async (req) => readMe(req.userId));

  app.patch('/me', async (req) => {
    const patch = patchBody.parse(req.body);
    if (Object.keys(patch).length > 0) {
      await ctx.db.update(profile).set(patch).where(eq(profile.userId, req.userId));
    }
    return readMe(req.userId);
  });

  // Exige a senha de novo e apaga tudo de verdade.
  app.delete('/me', async (req, reply) => {
    const body = deleteBody.parse(req.body);
    await deleteAccount(ctx, req.userId, body.password);
    return reply.code(204).send();
  });
}

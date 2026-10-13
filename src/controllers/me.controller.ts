import { z } from 'zod';

import type { Ctx } from '../context.js';
import { deleteAccount } from '../services/auth.js';
import { getMe, updateProfile } from '../services/profile.js';
import type { Handler } from './support.js';

const patchBody = z
  .object({
    name: z.string().trim().max(100),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use um código de moeda de 3 letras.'),
    remindersEnabled: z.boolean(),
  })
  .partial();

const deleteBody = z.object({ password: z.string().min(1).max(128) });

export function createMeController(ctx: Ctx) {
  const get: Handler = async (req) => getMe(ctx.db, req.userId);

  const patch: Handler = async (req) => updateProfile(ctx.db, req.userId, patchBody.parse(req.body));

  // Exige a senha de novo e apaga tudo de verdade.
  const remove: Handler = async (req, reply) => {
    await deleteAccount(ctx, req.userId, deleteBody.parse(req.body).password);
    return reply.code(204).send();
  };

  return { get, patch, remove };
}

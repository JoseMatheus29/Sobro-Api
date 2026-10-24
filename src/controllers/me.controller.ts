import { z } from 'zod';

import type { Ctx } from '../context.js';
import { FailureLimiter } from '../lib/limiter.js';
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

// Rotas de conta: sempre do ator (req.actorId), nunca do perfil escolhido por X-Profile-Id.
export function createMeController(ctx: Ctx) {
  // Senha errada ao excluir a conta: trava o usuário depois de muitas tentativas, além do limite por IP da rota.
  const passwordFailures = new FailureLimiter(5, 15 * 60 * 1000, ctx.config.RATE_LIMIT_ENABLED);

  const get: Handler = async (req) => getMe(ctx.db, req.actorId);

  const patch: Handler = async (req) => updateProfile(ctx.db, req.actorId, patchBody.parse(req.body));

  // Exige a senha de novo e apaga tudo de verdade, inclusive os perfis gerenciados que ficariam sem gerente.
  const remove: Handler = async (req, reply) => {
    const { password } = deleteBody.parse(req.body);
    passwordFailures.assertAllowed(req.actorId);
    try {
      await deleteAccount(ctx, req.actorId, password);
    } catch (error) {
      if ((error as { code?: string }).code === 'invalid_credentials') passwordFailures.fail(req.actorId);
      throw error;
    }
    return reply.code(204).send();
  };

  return { get, patch, remove };
}

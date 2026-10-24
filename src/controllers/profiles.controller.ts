import { z } from 'zod';

import type { Ctx } from '../context.js';
import { FailureLimiter } from '../lib/limiter.js';
import { requiredText } from '../lib/schemas.js';
import { createManagedProfile, deleteManagedProfile, listProfiles, updateManagedProfile } from '../services/profiles.js';
import { sendCreated, type Handler } from './support.js';

const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use um código de moeda de 3 letras.');

const createBody = z.object({ name: requiredText(60), currency: currency.default('BRL') });
const patchBody = z.object({ name: requiredText(60), currency, remindersEnabled: z.boolean() }).partial();
const deleteBody = z.object({ password: z.string().min(1).max(128) });
const idParam = z.object({ id: z.string().uuid().toLowerCase() });

// Rotas de conta: tudo é do ator (req.actorId), nunca do perfil escolhido pelo cabeçalho.
export function createProfilesController(ctx: Ctx) {
  // Senha errada ao apagar um perfil: trava o usuário depois de muitas tentativas, além do limite por IP da rota.
  const passwordFailures = new FailureLimiter(5, 15 * 60 * 1000, ctx.config.RATE_LIMIT_ENABLED);

  const list: Handler = async (req) => listProfiles(ctx.db, req.actorId);

  const create: Handler = async (req, reply) => {
    const body = createBody.parse(req.body);
    return sendCreated(reply, await createManagedProfile(ctx.db, ctx.config, req.actorId, body, req.headers['idempotency-key']));
  };

  const patch: Handler = async (req) => {
    const { id } = idParam.parse(req.params);
    return updateManagedProfile(ctx.db, req.actorId, id, patchBody.parse(req.body));
  };

  // Apaga o perfil e todos os dados dele, de forma definitiva: pede a senha de quem gerencia.
  const remove: Handler = async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { password } = deleteBody.parse(req.body);
    passwordFailures.assertAllowed(req.actorId);
    try {
      await deleteManagedProfile(ctx.db, req.actorId, id, password);
    } catch (error) {
      if ((error as { code?: string }).code === 'invalid_credentials') passwordFailures.fail(req.actorId);
      throw error;
    }
    passwordFailures.reset(req.actorId);
    return reply.code(204).send();
  };

  return { list, create, patch, remove };
}

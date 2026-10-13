import { z } from 'zod';

import type { Ctx } from '../context.js';
import { FailureLimiter } from '../lib/limiter.js';
import { email, newPassword } from '../lib/schemas.js';
import * as auth from '../services/auth.js';
import type { Handler } from './support.js';

const registerBody = z.object({ email, password: newPassword, name: z.string().trim().max(100).optional() });
const loginBody = z.object({ email, password: z.string().min(1).max(128) });
const tokenBody = z.object({ refreshToken: z.string().min(10).max(200) });
const forgotBody = z.object({ email });
const resetBody = z.object({ token: z.string().min(10).max(200), password: newPassword });

export function createAuthController(ctx: Ctx) {
  // Contadores por e-mail, além do limite por IP das rotas: contra força bruta vinda de vários endereços.
  const loginFailures = new FailureLimiter(10, 15 * 60 * 1000, ctx.config.RATE_LIMIT_ENABLED);
  const registerAttempts = new FailureLimiter(5, 60 * 60 * 1000, ctx.config.RATE_LIMIT_ENABLED);

  const register: Handler = async (req, reply) => {
    const body = registerBody.parse(req.body);
    registerAttempts.assertAllowed(body.email);
    registerAttempts.fail(body.email);
    const { userId, session } = await auth.register(ctx, body);
    return reply.code(201).send({ ...session, user: { id: userId, email: body.email } });
  };

  const login: Handler = async (req) => {
    const body = loginBody.parse(req.body);
    loginFailures.assertAllowed(body.email);
    try {
      const { session, user } = await auth.login(ctx, body);
      loginFailures.reset(body.email);
      return { ...session, user };
    } catch (error) {
      loginFailures.fail(body.email);
      throw error;
    }
  };

  const refresh: Handler = async (req) => auth.refresh(ctx, tokenBody.parse(req.body).refreshToken);

  const logout: Handler = async (req, reply) => {
    await auth.logout(ctx, tokenBody.parse(req.body).refreshToken);
    return reply.code(204).send();
  };

  // Sempre 204, exista a conta ou não: a resposta não revela quem tem cadastro.
  const forgotPassword: Handler = async (req, reply) => {
    const body = forgotBody.parse(req.body);
    try {
      await auth.requestPasswordReset(ctx, body.email);
    } catch (error) {
      // Falha no envio não pode virar uma resposta diferente (revelaria a conta); fica só no log.
      req.log.error({ err: error }, 'falha ao enviar o e-mail de redefinição');
    }
    return reply.code(204).send();
  };

  const resetPassword: Handler = async (req, reply) => {
    const body = resetBody.parse(req.body);
    await auth.resetPassword(ctx, body.token, body.password);
    return reply.code(204).send();
  };

  return { register, login, refresh, logout, forgotPassword, resetPassword };
}

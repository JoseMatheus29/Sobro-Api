import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Ctx } from '../context.js';
import { users } from '../db/schema.js';
import { FailureLimiter } from '../lib/limiter.js';
import { email, newPassword } from '../lib/schemas.js';
import * as auth from '../services/auth.js';

const WINDOW = '15 minutes';
const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: WINDOW } } });

const registerBody = z.object({ email, password: newPassword, name: z.string().trim().max(100).optional() });
const loginBody = z.object({ email, password: z.string().min(1).max(128) });
const tokenBody = z.object({ refreshToken: z.string().min(10).max(200) });
const forgotBody = z.object({ email });
const resetBody = z.object({ token: z.string().min(10).max(200), password: newPassword });

export async function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const authCtx: auth.AuthContext = ctx;
  const loginFailures = new FailureLimiter(10, 15 * 60 * 1000, ctx.config.RATE_LIMIT_ENABLED);
  const registerAttempts = new FailureLimiter(5, 60 * 60 * 1000, ctx.config.RATE_LIMIT_ENABLED);

  app.post('/auth/register', limit(20), async (req, reply) => {
    const body = registerBody.parse(req.body);
    registerAttempts.assertAllowed(body.email);
    registerAttempts.fail(body.email);
    const { userId, session } = await auth.register(authCtx, body);
    return reply.code(201).send({ ...session, user: { id: userId, email: body.email } });
  });

  app.post('/auth/login', limit(30), async (req) => {
    const body = loginBody.parse(req.body);
    loginFailures.assertAllowed(body.email);
    try {
      const session = await auth.login(authCtx, body);
      loginFailures.reset(body.email);
      const [user] = await ctx.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, body.email));
      return { ...session, user };
    } catch (error) {
      loginFailures.fail(body.email);
      throw error;
    }
  });

  app.post('/auth/refresh', limit(120), async (req) => {
    const body = tokenBody.parse(req.body);
    return auth.refresh(authCtx, body.refreshToken);
  });

  app.post('/auth/logout', limit(120), async (req, reply) => {
    const body = tokenBody.parse(req.body);
    await auth.logout(authCtx, body.refreshToken);
    return reply.code(204).send();
  });

  // Sempre 204, exista a conta ou não: a resposta não revela quem tem cadastro.
  app.post('/auth/forgot-password', limit(10), async (req, reply) => {
    const body = forgotBody.parse(req.body);
    try {
      await auth.requestPasswordReset(authCtx, body.email);
    } catch (error) {
      // Falha no envio não pode virar uma resposta diferente (revelaria a conta); fica só no log.
      req.log.error({ err: error }, 'falha ao enviar o e-mail de redefinição');
    }
    return reply.code(204).send();
  });

  app.post('/auth/reset-password', limit(20), async (req, reply) => {
    const body = resetBody.parse(req.body);
    await auth.resetPassword(authCtx, body.token, body.password);
    return reply.code(204).send();
  });
}

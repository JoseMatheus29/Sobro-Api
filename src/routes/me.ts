import type { FastifyInstance } from 'fastify';

import type { createMeController } from '../controllers/me.controller.js';

// Pede a senha de novo: limita as tentativas por IP (o contador por usuário fica no controller).
const limitPassword = { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } };

export function meRoutes(app: FastifyInstance, c: ReturnType<typeof createMeController>) {
  app.get('/me', c.get);
  app.patch('/me', c.patch);
  app.delete('/me', limitPassword, c.remove);
}

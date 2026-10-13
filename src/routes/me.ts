import type { FastifyInstance } from 'fastify';

import type { createMeController } from '../controllers/me.controller.js';

export function meRoutes(app: FastifyInstance, c: ReturnType<typeof createMeController>) {
  app.get('/me', c.get);
  app.patch('/me', c.patch);
  app.delete('/me', c.remove);
}

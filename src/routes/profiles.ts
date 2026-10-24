import type { FastifyInstance } from 'fastify';

import type { createProfilesController } from '../controllers/profiles.controller.js';

// Apagar um perfil pede a senha de novo: limita as tentativas por IP (o contador por usuário fica no controller).
const limitPassword = { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } };

// Rotas de conta: sempre do ator, ignoram o cabeçalho X-Profile-Id.
export function profilesRoutes(app: FastifyInstance, c: ReturnType<typeof createProfilesController>) {
  app.get('/profiles', c.list);
  app.post('/profiles', c.create);
  app.patch('/profiles/:id', c.patch);
  app.delete('/profiles/:id', limitPassword, c.remove);
}

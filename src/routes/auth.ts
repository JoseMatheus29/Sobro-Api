import type { FastifyInstance } from 'fastify';

import type { createAuthController } from '../controllers/auth.controller.js';

type AuthController = ReturnType<typeof createAuthController>;

const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '15 minutes' } } });

// Rotas públicas: o limite por IP vem daqui; o por e-mail fica no controller.
export function authRoutes(app: FastifyInstance, c: AuthController) {
  app.post('/auth/register', limit(20), c.register);
  app.post('/auth/login', limit(30), c.login);
  app.post('/auth/refresh', limit(120), c.refresh);
  app.post('/auth/logout', limit(120), c.logout);
  app.post('/auth/forgot-password', limit(10), c.forgotPassword);
  app.post('/auth/reset-password', limit(20), c.resetPassword);
}

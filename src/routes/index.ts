import type { FastifyInstance } from 'fastify';

import { createAuthController } from '../controllers/auth.controller.js';
import { createBackupController } from '../controllers/backup.controller.js';
import { createBudgetsController } from '../controllers/budgets.controller.js';
import { createCardsController } from '../controllers/cards.controller.js';
import { createCategoriesController } from '../controllers/categories.controller.js';
import { createGoalsController } from '../controllers/goals.controller.js';
import { createMeController } from '../controllers/me.controller.js';
import { createProfilesController } from '../controllers/profiles.controller.js';
import { createRecurrencesController } from '../controllers/recurrences.controller.js';
import { createReportsController } from '../controllers/reports.controller.js';
import { createTransactionsController } from '../controllers/transactions.controller.js';
import type { Ctx } from '../context.js';
import { authRoutes } from './auth.js';
import { meRoutes } from './me.js';
import { profilesRoutes } from './profiles.js';
import {
  backupRoutes,
  budgetsRoutes,
  cardsRoutes,
  categoriesRoutes,
  goalsRoutes,
  recurrencesRoutes,
  reportsRoutes,
  transactionsRoutes,
} from './resources.js';

// Cada recurso tem um controller (src/controllers) e um grupo de rotas que só o liga ao caminho.

export function registerPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  authRoutes(app, createAuthController(ctx));
}

// Rotas de conta (/me, /profiles): exigem sessão e são sempre do ator, que o gancho de autenticação do app já
// definiu em req.actorId e req.userId. Ignoram o cabeçalho X-Profile-Id.
export function registerAccountRoutes(app: FastifyInstance, ctx: Ctx) {
  meRoutes(app, createMeController(ctx));
  profilesRoutes(app, createProfilesController(ctx));
}

// Rotas de dados: o app registra, no escopo que chama esta função, o gancho que troca req.userId pelo perfil
// gerenciado escolhido em X-Profile-Id (se o ator puder gerenciá-lo). Os serviços só conhecem req.userId.
export function registerDataRoutes(app: FastifyInstance, ctx: Ctx) {
  categoriesRoutes(app, createCategoriesController(ctx));
  cardsRoutes(app, createCardsController(ctx));
  transactionsRoutes(app, createTransactionsController(ctx));
  goalsRoutes(app, createGoalsController(ctx));
  recurrencesRoutes(app, createRecurrencesController(ctx));
  budgetsRoutes(app, createBudgetsController(ctx));
  reportsRoutes(app, createReportsController(ctx));
  backupRoutes(app, createBackupController(ctx));
}

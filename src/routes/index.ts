import type { FastifyInstance } from 'fastify';

import { createAuthController } from '../controllers/auth.controller.js';
import { createBackupController } from '../controllers/backup.controller.js';
import { createBudgetsController } from '../controllers/budgets.controller.js';
import { createCardsController } from '../controllers/cards.controller.js';
import { createCategoriesController } from '../controllers/categories.controller.js';
import { createGoalsController } from '../controllers/goals.controller.js';
import { createMeController } from '../controllers/me.controller.js';
import { createRecurrencesController } from '../controllers/recurrences.controller.js';
import { createReportsController } from '../controllers/reports.controller.js';
import { createTransactionsController } from '../controllers/transactions.controller.js';
import type { Ctx } from '../context.js';
import { authRoutes } from './auth.js';
import { meRoutes } from './me.js';
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

// Tudo aqui exige sessão: o app registra o gancho de autenticação no escopo que chama esta função.
export function registerProtectedRoutes(app: FastifyInstance, ctx: Ctx) {
  meRoutes(app, createMeController(ctx));
  categoriesRoutes(app, createCategoriesController(ctx));
  cardsRoutes(app, createCardsController(ctx));
  transactionsRoutes(app, createTransactionsController(ctx));
  goalsRoutes(app, createGoalsController(ctx));
  recurrencesRoutes(app, createRecurrencesController(ctx));
  budgetsRoutes(app, createBudgetsController(ctx));
  reportsRoutes(app, createReportsController(ctx));
  backupRoutes(app, createBackupController(ctx));
}

import type { FastifyInstance } from 'fastify';

import type { createBackupController } from '../controllers/backup.controller.js';
import type { createBudgetsController } from '../controllers/budgets.controller.js';
import type { createCardsController } from '../controllers/cards.controller.js';
import type { createCategoriesController } from '../controllers/categories.controller.js';
import type { createGoalsController } from '../controllers/goals.controller.js';
import type { createRecurrencesController } from '../controllers/recurrences.controller.js';
import type { createReportsController } from '../controllers/reports.controller.js';
import type { createTransactionsController } from '../controllers/transactions.controller.js';

type Controller<F extends (...args: never[]) => unknown> = ReturnType<F>;

export function categoriesRoutes(app: FastifyInstance, c: Controller<typeof createCategoriesController>) {
  app.get('/categories', c.list);
  app.post('/categories', c.create);
  app.patch('/categories/:id', c.update);
  app.delete('/categories/:id', c.remove);
}

export function cardsRoutes(app: FastifyInstance, c: Controller<typeof createCardsController>) {
  app.get('/cards', c.list);
  app.post('/cards', c.create);
  app.get('/cards/:id', c.get);
  app.patch('/cards/:id', c.update);
  app.get('/cards/:id/usage', c.usage);
  app.delete('/cards/:id', c.remove);
  app.post('/cards/:id/invoice-payments', c.payInvoice);
}

export function transactionsRoutes(app: FastifyInstance, c: Controller<typeof createTransactionsController>) {
  app.get('/transactions', c.list);
  app.post('/transactions', c.create);
  app.get('/transactions/:id', c.get);
  app.patch('/transactions/:id', c.update);
  app.delete('/transactions/:id', c.remove);
  app.post('/transfers', c.transfer);
}

export function goalsRoutes(app: FastifyInstance, c: Controller<typeof createGoalsController>) {
  app.get('/goals', c.list);
  app.post('/goals', c.create);
  app.get('/goals/:id', c.get);
  app.patch('/goals/:id', c.update);
  app.delete('/goals/:id', c.remove);
  app.get('/goals/:id/entries', c.listGoalEntries);
  app.post('/goals/:id/entries', c.createEntry);
  app.delete('/goals/:id/entries/:entryId', c.removeEntry);
}

export function recurrencesRoutes(app: FastifyInstance, c: Controller<typeof createRecurrencesController>) {
  app.get('/recurrences', c.list);
  app.get('/recurrences/:id', c.get);
  app.post('/recurrences/:id/end', c.end);
  app.post('/recurrences/materialize', c.generateDue);
}

export function budgetsRoutes(app: FastifyInstance, c: Controller<typeof createBudgetsController>) {
  app.get('/budgets/monthly', c.listMonthly);
  app.put('/budgets/monthly/:month', c.setMonthly);
  app.get('/budgets/categories', c.listCategories);
  app.put('/budgets/categories/:categoryId/:month', c.setCategory);
}

export function reportsRoutes(app: FastifyInstance, c: Controller<typeof createReportsController>) {
  app.get('/reports/monthly-totals', c.monthly);
  app.get('/reports/category-totals', c.byCategory);
}

export function backupRoutes(app: FastifyInstance, c: Controller<typeof createBackupController>) {
  app.get('/backup', c.download);
  // Corpo maior que o das outras rotas: o backup traz tudo da conta.
  app.put('/backup', { bodyLimit: 10 * 1024 * 1024 }, c.restore);
}

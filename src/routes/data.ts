import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Ctx } from '../context.js';
import { categories } from '../db/schema.js';
import { runIdempotent, type Outcome } from '../lib/idempotency.js';
import { badRequest } from '../lib/errors.js';
import {
  hexColor,
  idParam,
  isoDate,
  month,
  optionalText,
  positiveMoney,
  requiredText,
  signedMoney,
} from '../lib/schemas.js';
import { validateBackup } from '../shared/backup.js';
import { categoryIds, exportBackup, restoreBackup } from '../services/backup.js';
import { cardUsage, createCard, deleteCard, getCard, listCards, updateCard } from '../services/cards.js';
import {
  categoryBudgetEntries,
  categoryTotals,
  monthlyBudgetEntries,
  monthlyTotals,
  setCategoryBudget,
  setMonthlyBudget,
} from '../services/reports.js';
import {
  endRecurrence,
  getRecurrence,
  listRecurrences,
  materializeDue,
} from '../services/recurrences.js';
import {
  createTransaction,
  createTransfer,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from '../services/transactions.js';

const cardBody = z.object({
  name: requiredText(60),
  number: z.string().trim().max(8).default(''),
  color: hexColor,
  lightColor: hexColor,
  startingBalance: signedMoney.default(0),
});
const cardPatch = cardBody.omit({ startingBalance: true }).partial();

const repeat = z.union([
  z.object({ mode: z.literal('monthly') }),
  z
    .object({
      mode: z.literal('installments'),
      total: z.number().int().min(2).max(99),
      current: z.number().int().min(1).default(1),
    })
    .refine((r) => r.current <= r.total, { message: 'A parcela atual não pode passar do total.', path: ['current'] }),
]);

const transactionBody = z.object({
  cardId: z.number().int().positive(),
  categoryId: requiredText(40),
  name: requiredText(100),
  description: optionalText(500),
  // Magnitude positiva; o sinal vem do tipo. A resposta devolve o valor com sinal.
  amount: positiveMoney,
  type: z.enum(['income', 'expense']),
  occurredAt: isoDate,
  repeat: repeat.optional(),
});

const transactionPatch = z
  .object({
    cardId: z.number().int().positive(),
    categoryId: requiredText(40),
    name: requiredText(100),
    description: z.string().trim().max(500).nullable().transform((v) => (v ? v : null)),
    amount: positiveMoney,
    type: z.enum(['income', 'expense']),
    occurredAt: isoDate,
    applyToNext: z.boolean(),
  })
  .partial();

const listQuery = z.object({
  month: month.optional(),
  cardId: z.coerce.number().int().positive().optional(),
  categoryId: z.string().max(40).optional(),
  type: z.enum(['income', 'expense']).optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  cursor: z.string().max(200).optional(),
});

const transferBody = z.object({
  fromCardId: z.number().int().positive(),
  toCardId: z.number().int().positive(),
  amount: positiveMoney,
  description: optionalText(500),
  occurredAt: isoDate,
});

const budgetBody = z.object({ amount: z.number().finite().min(0).max(99_999_999_999.99).nullable() });
const monthParam = z.object({ month });
const categoryMonthParam = z.object({ categoryId: z.string().max(40), month });

export async function dataRoutes(app: FastifyInstance, ctx: Ctx) {
  const tz = ctx.config.APP_TIMEZONE;

  // Gera as recorrências que venceram antes de ler (ver docs, seção 5): as listas e os saldos já saem certos.
  const fresh = (userId: string) => materializeDue(ctx.db, userId, tz, ctx.now());

  // POST que cria algo, protegido por Idempotency-Key.
  async function create(
    req: FastifyRequest,
    reply: FastifyReply,
    scope: string,
    run: (tx: Parameters<Parameters<typeof ctx.db.transaction>[0]>[0]) => Promise<Outcome>
  ) {
    const out = await runIdempotent(ctx.db, req.userId, scope, req.headers['idempotency-key'], run);
    if (out.replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.code(out.status).send(out.body);
  }

  // ---- categorias ----
  app.get('/categories', async () => ctx.db.select().from(categories).orderBy(categories.name));

  // ---- contas ----
  app.get('/cards', async (req) => {
    await fresh(req.userId);
    return listCards(ctx.db, req.userId);
  });
  app.post('/cards', async (req, reply) => {
    const body = cardBody.parse(req.body);
    return create(req, reply, 'POST /cards', async (tx) => ({
      status: 201,
      body: await createCard(tx, req.userId, body),
    }));
  });
  app.get('/cards/:id', async (req) => getCard(ctx.db, req.userId, idParam.parse(req.params).id));
  app.patch('/cards/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return updateCard(ctx.db, req.userId, id, cardPatch.parse(req.body));
  });
  app.get('/cards/:id/usage', async (req) => cardUsage(ctx.db, req.userId, idParam.parse(req.params).id));
  app.delete('/cards/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await ctx.db.transaction((tx) => deleteCard(tx, req.userId, id));
    return reply.code(204).send();
  });

  // ---- transações ----
  app.get('/transactions', async (req) => {
    await fresh(req.userId);
    return listTransactions(ctx.db, req.userId, listQuery.parse(req.query));
  });
  app.post('/transactions', async (req, reply) => {
    const body = transactionBody.parse(req.body);
    return create(req, reply, 'POST /transactions', async (tx) => ({
      status: 201,
      body: await createTransaction(tx, req.userId, body, tz),
    }));
  });
  app.get('/transactions/:id', async (req) => getTransaction(ctx.db, req.userId, idParam.parse(req.params).id));
  app.patch('/transactions/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = transactionPatch.parse(req.body);
    return ctx.db.transaction((tx) => updateTransaction(tx, req.userId, id, patch, tz));
  });
  app.delete('/transactions/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await ctx.db.transaction((tx) => deleteTransaction(tx, req.userId, id));
    return reply.code(204).send();
  });

  app.post('/transfers', async (req, reply) => {
    const body = transferBody.parse(req.body);
    return create(req, reply, 'POST /transfers', async (tx) => ({
      status: 201,
      body: await createTransfer(tx, req.userId, body, tz),
    }));
  });

  // ---- recorrências ----
  app.get('/recurrences', async (req) => {
    await fresh(req.userId);
    return listRecurrences(ctx.db, req.userId);
  });
  app.get('/recurrences/:id', async (req) => getRecurrence(ctx.db, req.userId, idParam.parse(req.params).id));
  app.post('/recurrences/:id/end', async (req) => {
    const { id } = idParam.parse(req.params);
    await endRecurrence(ctx.db, req.userId, id);
    return getRecurrence(ctx.db, req.userId, id);
  });
  // Alternativa explícita à geração dentro dos GET: o app pode chamar ao abrir.
  app.post('/recurrences/materialize', async (req) => ({ created: await fresh(req.userId) }));

  // ---- orçamentos ----
  app.get('/budgets/monthly', async (req) => monthlyBudgetEntries(ctx.db, req.userId));
  app.put('/budgets/monthly/:month', async (req) => {
    const { month: m } = monthParam.parse(req.params);
    const { amount } = budgetBody.parse(req.body);
    await setMonthlyBudget(ctx.db, req.userId, m, amount);
    return { month: m, amount };
  });
  app.get('/budgets/categories', async (req) => categoryBudgetEntries(ctx.db, req.userId));
  app.put('/budgets/categories/:categoryId/:month', async (req) => {
    const { categoryId, month: m } = categoryMonthParam.parse(req.params);
    const { amount } = budgetBody.parse(req.body);
    if (!(await categoryIds(ctx.db)).has(categoryId)) {
      throw badRequest('Categoria inexistente.', 'validation_failed', [{ path: 'categoryId', message: 'Categoria inexistente.' }]);
    }
    await setCategoryBudget(ctx.db, req.userId, categoryId, m, amount);
    return { categoryId, month: m, amount };
  });

  // ---- relatórios (sempre sem transferências) ----
  app.get('/reports/monthly-totals', async (req) => {
    await fresh(req.userId);
    return monthlyTotals(ctx.db, req.userId);
  });
  app.get('/reports/category-totals', async (req) => {
    const { month: m } = z.object({ month }).parse(req.query);
    await fresh(req.userId);
    return categoryTotals(ctx.db, req.userId, m);
  });

  // ---- backup ----
  app.get('/backup', async (req) => exportBackup(ctx.db, req.userId, ctx.now()));
  // Destrutivo: substitui tudo numa única transação. Corpo maior que o das outras rotas.
  app.put('/backup', { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const validation = validateBackup(req.body, await categoryIds(ctx.db));
    if (!validation.ok) throw badRequest(validation.reason, 'invalid_backup');
    await ctx.db.transaction((tx) => restoreBackup(tx, req.userId, validation.backup, tz));
    return reply.code(204).send();
  });
}


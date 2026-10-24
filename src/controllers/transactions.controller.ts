import { z } from 'zod';

import type { Ctx } from '../context.js';
import { PAYMENT_METHODS } from '../shared/payment.js';
import { idParam, isoDate, month, optionalText, positiveMoney, requiredText } from '../lib/schemas.js';
import {
  createTransaction,
  createTransfer,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from '../services/transactions.js';
import { materialize, sendCreated, type Handler } from './support.js';

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
  // Como a saída foi paga. Sem ele (ou nulo), sai do saldo. Só despesa; 'credit' exige conta com cartão.
  paymentMethod: z.enum(PAYMENT_METHODS).nullish(),
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
    paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
    applyToNext: z.boolean(),
  })
  .partial();

const listQuery = z.object({
  // month filtra pela data; spendingMonth, pelo mês em que o gasto conta (o do vencimento, no crédito).
  month: month.optional(),
  spendingMonth: month.optional(),
  cardId: z.coerce.number().int().positive().optional(),
  categoryId: z.string().max(40).optional(),
  type: z.enum(['income', 'expense']).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
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

export function createTransactionsController(ctx: Ctx) {
  const tz = ctx.config.APP_TIMEZONE;

  const list: Handler = async (req) => {
    const filters = listQuery.parse(req.query);
    await materialize(ctx, req.userId);
    return listTransactions(ctx.db, req.userId, filters);
  };

  const create: Handler = async (req, reply) => {
    const body = transactionBody.parse(req.body);
    return sendCreated(reply, await createTransaction(ctx.db, req.userId, body, tz, req.headers['idempotency-key']));
  };

  const get: Handler = async (req) => getTransaction(ctx.db, req.userId, idParam.parse(req.params).id);

  const update: Handler = async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = transactionPatch.parse(req.body);
    return updateTransaction(ctx.db, req.userId, id, patch, tz);
  };

  // Excluir uma perna de transferência leva as duas.
  const remove: Handler = async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await deleteTransaction(ctx.db, req.userId, id);
    return reply.code(204).send();
  };

  const transfer: Handler = async (req, reply) => {
    const body = transferBody.parse(req.body);
    return sendCreated(reply, await createTransfer(ctx.db, req.userId, body, tz, req.headers['idempotency-key']));
  };

  return { list, create, get, update, remove, transfer };
}

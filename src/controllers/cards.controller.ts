import { z } from 'zod';

import type { Ctx } from '../context.js';
import { hexColor, idParam, isoDate, month, positiveMoney, requiredText, signedMoney } from '../lib/schemas.js';
import { cardUsage, createCard, deleteCard, getCard, listCards, updateCard } from '../services/cards.js';
import { payInvoice } from '../services/invoices.js';
import { materialize, sendCreated, type Handler } from './support.js';

// O cartão de crédito da conta. Os dias vão de 1 a 31 (29, 30 e 31 num mês mais curto caem no último dia).
const creditBody = z.object({
  lastDigits: z.string().trim().regex(/^\d{0,4}$/, 'Use até 4 dígitos.').default(''),
  limit: z.number().finite().min(0).max(99_999_999_999.99).nullable().default(null),
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
});

const invoicePaymentBody = z.object({
  /** A chave da fatura: o mês em que ela fecha. */
  month,
  amount: positiveMoney,
  occurredAt: isoDate,
});

const cardBody = z.object({
  name: requiredText(60),
  number: z.string().trim().max(8).default(''),
  color: hexColor,
  lightColor: hexColor,
  startingBalance: signedMoney.default(0),
  // Sem `credit` (ou nulo), a conta é como sempre foi. No PATCH, nulo tira o cartão.
  credit: creditBody.nullable().optional(),
});
const cardPatch = cardBody.omit({ startingBalance: true }).partial();

export function createCardsController(ctx: Ctx) {
  const list: Handler = async (req) => {
    await materialize(ctx, req.userId);
    return listCards(ctx.db, req.userId);
  };

  const create: Handler = async (req, reply) => {
    const body = cardBody.parse(req.body);
    return sendCreated(reply, await createCard(ctx.db, req.userId, body, req.headers['idempotency-key']));
  };

  const get: Handler = async (req) => getCard(ctx.db, req.userId, idParam.parse(req.params).id);

  const update: Handler = async (req) => {
    const { id } = idParam.parse(req.params);
    return updateCard(ctx.db, req.userId, id, cardPatch.parse(req.body));
  };

  // O que excluir a conta levaria junto, para avisar a pessoa antes.
  const usage: Handler = async (req) => cardUsage(ctx.db, req.userId, idParam.parse(req.params).id);

  const remove: Handler = async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await deleteCard(ctx.db, req.userId, id);
    return reply.code(204).send();
  };

  // Paga (parte de) uma fatura com o saldo desta conta: uma saída na categoria `invoice`.
  const payInvoiceHandler: Handler = async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = invoicePaymentBody.parse(req.body);
    return sendCreated(
      reply,
      await payInvoice(ctx.db, req.userId, id, body, ctx.config.APP_TIMEZONE, req.headers['idempotency-key'])
    );
  };

  return { list, create, get, update, usage, remove, payInvoice: payInvoiceHandler };
}

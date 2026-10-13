import { z } from 'zod';

import type { Ctx } from '../context.js';
import { hexColor, idParam, requiredText, signedMoney } from '../lib/schemas.js';
import { cardUsage, createCard, deleteCard, getCard, listCards, updateCard } from '../services/cards.js';
import { materialize, sendCreated, type Handler } from './support.js';

const cardBody = z.object({
  name: requiredText(60),
  number: z.string().trim().max(8).default(''),
  color: hexColor,
  lightColor: hexColor,
  startingBalance: signedMoney.default(0),
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

  return { list, create, get, update, usage, remove };
}

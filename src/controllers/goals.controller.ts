import { z } from 'zod';

import type { Ctx } from '../context.js';
import { badRequest } from '../lib/errors.js';
import { hexColor, idParam, isoDate, month, positiveMoney, requiredText, signedMoney } from '../lib/schemas.js';
import { GOAL_MAX_MONTHS_AHEAD, GOAL_NAME_MAX_LENGTH } from '../shared/goals.js';
import { addMonths, monthKey } from '../shared/month.js';
import {
  addEntry,
  createGoal,
  deleteEntry,
  deleteGoal,
  getGoal,
  listEntries,
  listGoals,
  updateGoal,
} from '../services/goals.js';
import { sendCreated, type Handler } from './support.js';

const goalBody = z.object({
  name: requiredText(GOAL_NAME_MAX_LENGTH),
  targetAmount: positiveMoney,
  // 'AAAA-MM' ou nulo (sem prazo). Mês no passado é aceito; o teto à frente é conferido com o relógio.
  targetMonth: month.nullable().default(null),
  color: hexColor,
  icon: requiredText(40),
});
const goalPatch = goalBody.partial();

// `amount` é com sinal (ao contrário das transações): positivo guarda, negativo retira.
const entryBody = z.object({
  amount: signedMoney.refine((v) => Math.round(v * 100) !== 0, { message: 'O valor não pode ser zero.' }),
  occurredAt: isoDate.optional(),
});

const entryParams = idParam.extend({ entryId: z.coerce.number().int().positive().max(2_147_483_647) });

export function createGoalsController(ctx: Ctx) {
  // Um prazo pode estar no passado, mas não mais de 120 meses à frente do mês atual.
  function assertTargetMonth(targetMonth: string | null | undefined) {
    if (targetMonth && targetMonth > addMonths(monthKey(ctx.now()), GOAL_MAX_MONTHS_AHEAD)) {
      throw badRequest(`O prazo pode ser de no máximo ${GOAL_MAX_MONTHS_AHEAD} meses à frente.`, 'validation_failed', [
        { path: 'targetMonth', message: `No máximo ${GOAL_MAX_MONTHS_AHEAD} meses à frente.` },
      ]);
    }
  }

  const list: Handler = async (req) => listGoals(ctx.db, req.userId);

  const create: Handler = async (req, reply) => {
    const body = goalBody.parse(req.body);
    assertTargetMonth(body.targetMonth);
    return sendCreated(reply, await createGoal(ctx.db, req.userId, body, req.headers['idempotency-key']));
  };

  const get: Handler = async (req) => getGoal(ctx.db, req.userId, idParam.parse(req.params).id);

  const update: Handler = async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = goalPatch.parse(req.body);
    assertTargetMonth(patch.targetMonth);
    return updateGoal(ctx.db, req.userId, id, patch);
  };

  // Apaga a caixinha e o histórico. Nenhuma conta nem transação muda.
  const remove: Handler = async (req, reply) => {
    await deleteGoal(ctx.db, req.userId, idParam.parse(req.params).id);
    return reply.code(204).send();
  };

  const listGoalEntries: Handler = async (req) => listEntries(ctx.db, req.userId, idParam.parse(req.params).id);

  const createEntry: Handler = async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = entryBody.parse(req.body);
    const input = { amount: body.amount, occurredAt: body.occurredAt ?? ctx.now() };
    return sendCreated(reply, await addEntry(ctx.db, req.userId, id, input, req.headers['idempotency-key']));
  };

  const removeEntry: Handler = async (req, reply) => {
    const { id, entryId } = entryParams.parse(req.params);
    await deleteEntry(ctx.db, req.userId, id, entryId);
    return reply.code(204).send();
  };

  return { list, create, get, update, remove, listGoalEntries, createEntry, removeEntry };
}

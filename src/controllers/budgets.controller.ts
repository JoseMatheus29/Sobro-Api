import { z } from 'zod';

import type { Ctx } from '../context.js';
import { month } from '../lib/schemas.js';
import {
  categoryBudgetEntries,
  monthlyBudgetEntries,
  setCategoryBudget,
  setMonthlyBudget,
} from '../services/reports.js';
import type { Handler } from './support.js';

// `amount` nulo tira o orçamento daquele mês em diante.
const budgetBody = z.object({ amount: z.number().finite().min(0).max(99_999_999_999.99).nullable() });
const monthParam = z.object({ month });
const categoryMonthParam = z.object({ categoryId: z.string().max(40), month });

export function createBudgetsController(ctx: Ctx) {
  const listMonthly: Handler = async (req) => monthlyBudgetEntries(ctx.db, req.userId);

  const setMonthly: Handler = async (req) => {
    const { month: m } = monthParam.parse(req.params);
    const { amount } = budgetBody.parse(req.body);
    await setMonthlyBudget(ctx.db, req.userId, m, amount);
    return { month: m, amount };
  };

  const listCategories: Handler = async (req) => categoryBudgetEntries(ctx.db, req.userId);

  const setCategory: Handler = async (req) => {
    const { categoryId, month: m } = categoryMonthParam.parse(req.params);
    const { amount } = budgetBody.parse(req.body);
    await setCategoryBudget(ctx.db, req.userId, categoryId, m, amount);
    return { categoryId, month: m, amount };
  };

  return { listMonthly, setMonthly, listCategories, setCategory };
}

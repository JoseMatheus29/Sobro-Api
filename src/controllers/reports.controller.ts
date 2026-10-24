import { z } from 'zod';

import type { Ctx } from '../context.js';
import { month } from '../lib/schemas.js';
import { categoryTotals, monthlyTotals } from '../services/reports.js';
import { materialize, type Handler } from './support.js';

// by=date (padrão): agrupa pela data da transação. by=spending: pelo mês em que o gasto conta (o do vencimento da
// fatura, nas compras no crédito).
const by = z.enum(['date', 'spending']).default('date');
const monthlyQuery = z.object({ by });
const categoryTotalsQuery = z.object({ month, by });

// Sempre sem transferências.
export function createReportsController(ctx: Ctx) {
  const monthly: Handler = async (req) => {
    const { by: grouping } = monthlyQuery.parse(req.query);
    await materialize(ctx, req.userId);
    return monthlyTotals(ctx.db, req.userId, grouping);
  };

  const byCategory: Handler = async (req) => {
    const { month: m, by: grouping } = categoryTotalsQuery.parse(req.query);
    await materialize(ctx, req.userId);
    return categoryTotals(ctx.db, req.userId, m, grouping);
  };

  return { monthly, byCategory };
}

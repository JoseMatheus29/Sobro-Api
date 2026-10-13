import { z } from 'zod';

import type { Ctx } from '../context.js';
import { month } from '../lib/schemas.js';
import { categoryTotals, monthlyTotals } from '../services/reports.js';
import { materialize, type Handler } from './support.js';

const categoryTotalsQuery = z.object({ month });

// Sempre sem transferências.
export function createReportsController(ctx: Ctx) {
  const monthly: Handler = async (req) => {
    await materialize(ctx, req.userId);
    return monthlyTotals(ctx.db, req.userId);
  };

  const byCategory: Handler = async (req) => {
    const { month: m } = categoryTotalsQuery.parse(req.query);
    await materialize(ctx, req.userId);
    return categoryTotals(ctx.db, req.userId, m);
  };

  return { monthly, byCategory };
}

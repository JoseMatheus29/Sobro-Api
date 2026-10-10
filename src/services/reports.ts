import { and, asc, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';

import type { Executor } from '../db/client.js';
import { categories, categoryBudgets, monthlyBudgets, transactions } from '../db/schema.js';
import { monthRange } from '../shared/month.js';

export interface MonthTotals {
  month: string;
  income: number;
  expense: number;
}

// Entradas e saídas de cada mês com lançamentos, do mais novo ao mais antigo. Transferências não contam.
export async function monthlyTotals(db: Executor, userId: string): Promise<MonthTotals[]> {
  const month = sql<string>`to_char(${transactions.occurredAt} at time zone 'UTC', 'YYYY-MM')`;
  const rows = await db
    .select({
      month,
      income: sql<number>`coalesce(sum(case when ${transactions.type} = 'income' then abs(${transactions.amount}) else 0 end), 0)`.mapWith(Number),
      expense: sql<number>`coalesce(sum(case when ${transactions.type} = 'expense' then abs(${transactions.amount}) else 0 end), 0)`.mapWith(Number),
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), isNull(transactions.transferId)))
    .groupBy(month)
    .orderBy(desc(month));
  return rows;
}

export interface CategoryTotal {
  categoryId: string;
  categoryName: string;
  icon: string;
  color: string;
  bg: string;
  total: number;
}

// Total de despesas por categoria no mês, da maior para a menor. Transferências não contam.
export async function categoryTotals(db: Executor, userId: string, month: string): Promise<CategoryTotal[]> {
  const { start, end } = monthRange(month);
  const total = sql<number>`sum(abs(${transactions.amount}))`.mapWith(Number);
  return db
    .select({
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      icon: categories.icon,
      color: categories.color,
      bg: categories.bg,
      total,
    })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.type, 'expense'),
        isNull(transactions.transferId),
        gte(transactions.occurredAt, start),
        lt(transactions.occurredAt, end)
      )
    )
    .groupBy(transactions.categoryId, categories.name, categories.icon, categories.color, categories.bg)
    .orderBy(desc(total));
}

// ---- orçamentos ----

export interface BudgetEntry {
  month: string;
  amount: number | null;
}

export interface CategoryBudgetEntry extends BudgetEntry {
  categoryId: string;
}

export async function monthlyBudgetEntries(db: Executor, userId: string): Promise<BudgetEntry[]> {
  return db
    .select({ month: monthlyBudgets.month, amount: monthlyBudgets.amount })
    .from(monthlyBudgets)
    .where(eq(monthlyBudgets.userId, userId))
    .orderBy(asc(monthlyBudgets.month));
}

// O orçamento vale a partir de `month`, até a próxima mudança. `amount` nulo tira o orçamento daí em diante.
export async function setMonthlyBudget(db: Executor, userId: string, month: string, amount: number | null): Promise<void> {
  await db
    .insert(monthlyBudgets)
    .values({ userId, month, amount })
    .onConflictDoUpdate({ target: [monthlyBudgets.userId, monthlyBudgets.month], set: { amount } });
}

export async function categoryBudgetEntries(db: Executor, userId: string): Promise<CategoryBudgetEntry[]> {
  return db
    .select({ categoryId: categoryBudgets.categoryId, month: categoryBudgets.month, amount: categoryBudgets.amount })
    .from(categoryBudgets)
    .where(eq(categoryBudgets.userId, userId))
    .orderBy(asc(categoryBudgets.month), asc(categoryBudgets.categoryId));
}

export async function setCategoryBudget(
  db: Executor,
  userId: string,
  categoryId: string,
  month: string,
  amount: number | null
): Promise<void> {
  await db
    .insert(categoryBudgets)
    .values({ userId, categoryId, month, amount })
    .onConflictDoUpdate({
      target: [categoryBudgets.userId, categoryBudgets.categoryId, categoryBudgets.month],
      set: { amount },
    });
}

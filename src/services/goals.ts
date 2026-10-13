import { and, asc, desc, eq, sql } from 'drizzle-orm';

import type { Db, Executor, Tx } from '../db/client.js';
import { goalEntries, goals } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { runIdempotent, type IdempotencyKey, type Idempotent } from '../lib/idempotency.js';
import { round2 } from '../lib/money.js';
import { movementProblem } from '../shared/goals.js';

export interface GoalRecord {
  id: number;
  name: string;
  targetAmount: number;
  /** 'YYYY-MM' até onde guardar, ou null sem prazo. */
  targetMonth: string | null;
  color: string;
  icon: string;
  /** O que há na caixinha: a soma das movimentações. Sempre calculado, nunca gravado. */
  saved: number;
}

export interface GoalEntryRecord {
  id: number;
  goalId: number;
  /** Positivo quando guarda, negativo quando retira. */
  amount: number;
  occurredAt: string;
}

// O valor guardado sai da mesma consulta, para nunca divergir das movimentações. Os nomes da subconsulta
// vão por extenso: numa consulta de uma tabela só, o Drizzle omite o prefixo das colunas (ver cards.ts).
const savedSum = sql<number>`coalesce((select sum(e.amount) from goal_entries e where e.goal_id = goals.id), 0)`.mapWith(Number);

const goalColumns = {
  id: goals.id,
  name: goals.name,
  targetAmount: goals.targetAmount,
  targetMonth: goals.targetMonth,
  color: goals.color,
  icon: goals.icon,
  saved: savedSum,
};

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const NOT_FOUND = 'Caixinha não encontrada.';

export function listGoals(db: Executor, userId: string): Promise<GoalRecord[]> {
  return db.select(goalColumns).from(goals).where(eq(goals.userId, userId)).orderBy(asc(goals.id));
}

export async function getGoal(db: Executor, userId: string, id: number): Promise<GoalRecord> {
  const [row] = await db
    .select(goalColumns)
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.id, id)));
  if (!row) throw notFound(NOT_FOUND);
  return row;
}

export interface GoalInput {
  name: string;
  targetAmount: number;
  targetMonth: string | null;
  color: string;
  icon: string;
}

// Com `Idempotency-Key`, repetir a chave devolve a caixinha já criada em vez de criar outra.
export function createGoal(db: Db, userId: string, input: GoalInput, key?: IdempotencyKey): Promise<Idempotent<GoalRecord>> {
  return runIdempotent(db, userId, 'POST /goals', key, async (tx) => {
    const [row] = await tx
      .insert(goals)
      .values({ userId, ...input, targetAmount: round2(input.targetAmount) })
      .returning({ id: goals.id });
    return getGoal(tx, userId, row!.id);
  });
}

export async function updateGoal(db: Db, userId: string, id: number, patch: Partial<GoalInput>): Promise<GoalRecord> {
  const set = { ...patch, ...(patch.targetAmount !== undefined ? { targetAmount: round2(patch.targetAmount) } : {}) };
  if (Object.keys(set).length > 0) {
    const updated = await db
      .update(goals)
      .set(set)
      .where(and(eq(goals.userId, userId), eq(goals.id, id)))
      .returning({ id: goals.id });
    if (updated.length === 0) throw notFound(NOT_FOUND);
  }
  return getGoal(db, userId, id);
}

// A caixinha e o histórico se vão (as movimentações saem em cascata). O dinheiro nunca saiu das contas,
// então nenhum saldo nem total de mês muda.
export async function deleteGoal(db: Db, userId: string, id: number): Promise<void> {
  const deleted = await db
    .delete(goals)
    .where(and(eq(goals.userId, userId), eq(goals.id, id)))
    .returning({ id: goals.id });
  if (deleted.length === 0) throw notFound(NOT_FOUND);
}

// ---- movimentações ----

function mapEntry(row: { id: number; goalId: number; amount: number; occurredAt: Date }): GoalEntryRecord {
  return { id: row.id, goalId: row.goalId, amount: row.amount, occurredAt: row.occurredAt.toISOString() };
}

const entryColumns = {
  id: goalEntries.id,
  goalId: goalEntries.goalId,
  amount: goalEntries.amount,
  occurredAt: goalEntries.occurredAt,
};

// Do mais novo ao mais antigo.
export async function listEntries(db: Executor, userId: string, goalId: number): Promise<GoalEntryRecord[]> {
  await getGoal(db, userId, goalId);
  const rows = await db
    .select(entryColumns)
    .from(goalEntries)
    .where(and(eq(goalEntries.userId, userId), eq(goalEntries.goalId, goalId)))
    .orderBy(desc(goalEntries.occurredAt), desc(goalEntries.id));
  return rows.map(mapEntry);
}

// Trava a linha da caixinha e devolve o que há nela. Retiradas e exclusões simultâneas da mesma caixinha
// se serializam aqui, então duas retiradas juntas nunca passam do saldo.
async function lockAndSum(tx: Tx, userId: string, goalId: number): Promise<number> {
  const locked = await tx
    .select({ id: goals.id })
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.id, goalId)))
    .for('update');
  if (locked.length === 0) throw notFound(NOT_FOUND);

  const [row] = await tx
    .select({ saved: sql<number>`coalesce(sum(${goalEntries.amount}), 0)`.mapWith(Number) })
    .from(goalEntries)
    .where(eq(goalEntries.goalId, goalId));
  return round2(row?.saved ?? 0);
}

// `amount` com sinal: positivo guarda, negativo retira. Retirar mais do que há é recusado (409).
export function addEntry(
  db: Db,
  userId: string,
  goalId: number,
  input: { amount: number; occurredAt: Date },
  key?: IdempotencyKey
): Promise<Idempotent<GoalEntryRecord>> {
  return runIdempotent(db, userId, 'POST /goals/entries', key, async (tx) => {
    const saved = await lockAndSum(tx, userId, goalId);
    const amount = round2(input.amount);

    const problem = movementProblem(amount > 0 ? 'deposit' : 'withdraw', Math.abs(amount), saved);
    if (problem === 'invalid') throw badRequest('O valor não pode ser zero.', 'validation_failed', [{ path: 'amount', message: 'O valor não pode ser zero.' }]);
    if (problem === 'exceeds') {
      throw conflict('goal_insufficient', `Só há ${brl.format(saved)} nessa caixinha para retirar.`);
    }

    const [row] = await tx
      .insert(goalEntries)
      .values({ userId, goalId, amount, occurredAt: input.occurredAt })
      .returning(entryColumns);
    return mapEntry(row!);
  });
}

// Apagar um depósito que deixaria a caixinha negativa é recusado (409). Apagar uma retirada só devolve dinheiro.
export function deleteEntry(db: Db, userId: string, goalId: number, entryId: number): Promise<void> {
  return db.transaction(async (tx) => {
    const saved = await lockAndSum(tx, userId, goalId);

    const [entry] = await tx
      .select({ amount: goalEntries.amount })
      .from(goalEntries)
      .where(and(eq(goalEntries.userId, userId), eq(goalEntries.goalId, goalId), eq(goalEntries.id, entryId)));
    if (!entry) throw notFound('Movimentação não encontrada.');

    if (entry.amount > 0 && round2(saved - entry.amount) < 0) {
      throw conflict(
        'goal_insufficient',
        `Não dá para apagar esse depósito de ${brl.format(entry.amount)}: a caixinha tem só ${brl.format(saved)} e ficaria negativa.`
      );
    }
    await tx.delete(goalEntries).where(eq(goalEntries.id, entryId));
  });
}

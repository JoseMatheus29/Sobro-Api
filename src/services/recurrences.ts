import { and, asc, eq, sql } from 'drizzle-orm';

import type { Db, Executor } from '../db/client.js';
import { cards, categories, recurrences, transactions } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { calendarNoon, monthKey } from '../shared/month.js';
import { dueOccurrences, type RecurrenceRule } from '../shared/recurrence.js';

export interface RecurrenceRecord extends RecurrenceRule {
  id: number;
  cardId: number;
  cardName: string;
  categoryId: string;
  categoryName: string;
  categoryIcon: string;
  categoryColor: string;
  name: string;
  description: string | null;
  /** Magnitude positiva de uma ocorrência. */
  amount: number;
}

const recurrenceColumns = {
  id: recurrences.id,
  cardId: recurrences.cardId,
  cardName: cards.name,
  categoryId: recurrences.categoryId,
  categoryName: categories.name,
  categoryIcon: categories.icon,
  categoryColor: categories.color,
  name: recurrences.name,
  description: recurrences.description,
  amount: recurrences.amount,
  day: recurrences.day,
  startMonth: recurrences.startMonth,
  firstInstallment: recurrences.firstInstallment,
  total: recurrences.total,
  endMonth: recurrences.endMonth,
  generatedUntil: recurrences.generatedUntil,
};

function selectRecurrences(db: Executor) {
  return db
    .select(recurrenceColumns)
    .from(recurrences)
    .innerJoin(cards, eq(cards.id, recurrences.cardId))
    .innerJoin(categories, eq(categories.id, recurrences.categoryId));
}

export async function listRecurrences(db: Executor, userId: string): Promise<RecurrenceRecord[]> {
  return selectRecurrences(db).where(eq(recurrences.userId, userId)).orderBy(asc(recurrences.id));
}

export async function getRecurrence(db: Executor, userId: string, id: number): Promise<RecurrenceRecord> {
  const [row] = await selectRecurrences(db).where(and(eq(recurrences.userId, userId), eq(recurrences.id, id)));
  if (!row) throw notFound('Recorrência não encontrada.');
  return row;
}

// A primeira ocorrência é a transação lançada junto; a geração começa no mês seguinte.
export async function createRecurrence(
  tx: Executor,
  userId: string,
  input: {
    cardId: number;
    categoryId: string;
    name: string;
    description: string | null;
    amount: number;
    day: number;
    startMonth: string;
    firstInstallment: number;
    total: number | null;
  }
): Promise<number> {
  const [row] = await tx
    .insert(recurrences)
    .values({ userId, ...input, amount: Math.abs(input.amount), generatedUntil: input.startMonth })
    .returning({ id: recurrences.id });
  return row!.id;
}

// O que muda numa recorrência vale para as próximas ocorrências, não para as já feitas.
export async function updateRecurrence(
  tx: Executor,
  userId: string,
  id: number,
  patch: Partial<{ cardId: number; categoryId: string; name: string; description: string | null; amount: number }>
): Promise<void> {
  const set = { ...patch, ...(patch.amount !== undefined ? { amount: Math.abs(patch.amount) } : {}) };
  if (Object.keys(set).length === 0) return;
  await tx
    .update(recurrences)
    .set(set)
    .where(and(eq(recurrences.userId, userId), eq(recurrences.id, id)));
}

// Encerra: nada depois do que já foi gerado é criado. O que foi feito fica.
export async function endRecurrence(tx: Executor, userId: string, id: number): Promise<void> {
  const ended = await tx
    .update(recurrences)
    .set({ endMonth: sql`${recurrences.generatedUntil}` })
    .where(and(eq(recurrences.userId, userId), eq(recurrences.id, id)))
    .returning({ id: recurrences.id });
  if (ended.length === 0) throw notFound('Recorrência não encontrada.');
}

// Último mês do plano ('YYYY-MM'), em SQL: início + (parcelas que faltam depois da primeira).
const planLastMonth = sql`to_char((${recurrences.startMonth} || '-01')::date + make_interval(months => ${recurrences.total} - ${recurrences.firstInstallment}), 'YYYY-MM')`;

// Só entra quem ainda pode ter algo vencido: gerou até antes do mês atual, não foi encerrada
// e o plano de parcelas não acabou. Assim a pergunta "há algo vencido?" é barata.
function mightBeDue(userId: string, current: string) {
  return and(
    eq(recurrences.userId, userId),
    sql`${recurrences.generatedUntil} < ${current}`,
    sql`(${recurrences.endMonth} is null or ${recurrences.generatedUntil} < ${recurrences.endMonth})`,
    sql`(${recurrences.total} is null or ${recurrences.generatedUntil} < ${planLastMonth})`
  );
}

// Cria as transações das ocorrências que venceram desde a última chamada. Seguro de repetir: cada
// recorrência lembra o último mês gerado, e a linha é travada (FOR UPDATE) para duas chamadas
// simultâneas não gerarem a mesma parcela. Uma transação gerada e depois excluída continua excluída.
export async function materializeDue(db: Db, userId: string, timeZone: string, instant = new Date()): Promise<number> {
  const today = calendarNoon(instant, timeZone);
  const current = monthKey(today);

  const [pending] = await db.select({ id: recurrences.id }).from(recurrences).where(mightBeDue(userId, current)).limit(1);
  if (!pending) return 0;

  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: recurrences.id })
      .from(recurrences)
      .where(mightBeDue(userId, current))
      .for('update');

    let created = 0;
    for (const { id } of locked) {
      const r = await getRecurrence(tx, userId, id);
      const due = dueOccurrences(r, today);
      if (due.length === 0) continue;
      await tx.insert(transactions).values(
        due.map((occurrence) => ({
          userId,
          cardId: r.cardId,
          categoryId: r.categoryId,
          name: r.name,
          description: r.description,
          amount: -Math.abs(r.amount),
          type: 'expense' as const,
          occurredAt: new Date(occurrence.date),
          recurrenceId: r.id,
          installment: r.total !== null ? occurrence.installment : null,
        }))
      );
      await tx
        .update(recurrences)
        .set({ generatedUntil: due[due.length - 1]!.month })
        .where(and(eq(recurrences.userId, userId), eq(recurrences.id, r.id)));
      created += due.length;
    }
    return created;
  });
}


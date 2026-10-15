import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';

import type { Db, Executor, Tx } from '../db/client.js';
import { cards, categories, recurrences, transactions } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { runIdempotent, type IdempotencyKey, type Idempotent } from '../lib/idempotency.js';
import { round2 } from '../lib/money.js';
import { calendarNoon, monthKey, monthRange } from '../shared/month.js';
import { escapeLike, searchWords } from '../shared/search.js';
import { assertCategory } from './categories.js';
import { createRecurrence, endRecurrence, updateRecurrence } from './recurrences.js';

export const TRANSFER_CATEGORY_ID = 'transfer';

export type TransactionType = 'income' | 'expense';

export interface TransactionRecord {
  id: number;
  cardId: number;
  cardName: string;
  categoryId: string;
  categoryName: string;
  categoryIcon: string;
  categoryColor: string;
  name: string;
  description: string | null;
  /** Sempre com sinal: negativo = despesa, positivo = receita. */
  amount: number;
  type: TransactionType;
  occurredAt: string;
  createdAt: string;
  recurrence: { id: number; installment: number | null; total: number | null } | null;
  transferId: number | null;
}

const txColumns = {
  id: transactions.id,
  cardId: transactions.cardId,
  cardName: cards.name,
  categoryId: transactions.categoryId,
  categoryName: categories.name,
  categoryIcon: categories.icon,
  categoryColor: categories.color,
  name: transactions.name,
  description: transactions.description,
  amount: transactions.amount,
  type: transactions.type,
  occurredAt: transactions.occurredAt,
  createdAt: transactions.createdAt,
  recurrenceId: transactions.recurrenceId,
  installment: transactions.installment,
  recurrenceTotal: recurrences.total,
  transferId: transactions.transferId,
};

function selectTransactions(db: Executor) {
  return db
    .select(txColumns)
    .from(transactions)
    .innerJoin(cards, eq(cards.id, transactions.cardId))
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(recurrences, eq(recurrences.id, transactions.recurrenceId));
}

type TxRow = Awaited<ReturnType<typeof selectTransactions>>[number];

function mapRow(row: TxRow): TransactionRecord {
  return {
    id: row.id,
    cardId: row.cardId,
    cardName: row.cardName,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    categoryIcon: row.categoryIcon,
    categoryColor: row.categoryColor,
    name: row.name,
    description: row.description,
    amount: row.amount,
    type: row.type as TransactionType,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    recurrence:
      row.recurrenceId !== null
        ? { id: row.recurrenceId, installment: row.installment, total: row.recurrenceTotal }
        : null,
    transferId: row.transferId,
  };
}

export async function getTransaction(db: Executor, userId: string, id: number): Promise<TransactionRecord> {
  const [row] = await selectTransactions(db).where(and(eq(transactions.userId, userId), eq(transactions.id, id)));
  if (!row) throw notFound('Transação não encontrada.');
  return mapRow(row);
}

// ---- listagem ----

export interface ListFilters {
  month?: string;
  cardId?: number;
  categoryId?: string;
  type?: TransactionType;
  q?: string;
  limit: number;
  cursor?: string;
}

function encodeCursor(row: { occurredAt: Date; id: number }): string {
  return Buffer.from(JSON.stringify([row.occurredAt.toISOString(), row.id])).toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: number } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, number];
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || !Number.isInteger(id)) throw new Error();
    return { at, id };
  } catch {
    throw badRequest('Cursor inválido.', 'invalid_cursor');
  }
}

export async function listTransactions(
  db: Executor,
  userId: string,
  f: ListFilters
): Promise<{ items: TransactionRecord[]; nextCursor: string | null }> {
  const conditions: SQL[] = [eq(transactions.userId, userId)];
  if (f.month) {
    const { start, end } = monthRange(f.month);
    conditions.push(gte(transactions.occurredAt, start), lt(transactions.occurredAt, end));
  }
  if (f.cardId !== undefined) conditions.push(eq(transactions.cardId, f.cardId));
  if (f.categoryId !== undefined) conditions.push(eq(transactions.categoryId, f.categoryId));
  if (f.type !== undefined) conditions.push(eq(transactions.type, f.type));

  // Cada palavra precisa estar no nome, na descrição, na categoria ou na conta, sem acento nem caixa.
  for (const word of searchWords(f.q ?? '')) {
    const pattern = `%${escapeLike(word)}%`;
    conditions.push(
      sql`unaccent(lower(concat_ws(' ', ${transactions.name}, coalesce(${transactions.description}, ''), ${categories.name}, ${cards.name}))) like ${pattern} escape '\\'`
    );
  }
  if (f.cursor) {
    const { at, id } = decodeCursor(f.cursor);
    conditions.push(sql`(${transactions.occurredAt}, ${transactions.id}) < (${at}::timestamptz, ${id}::int)`);
  }

  const rows = await selectTransactions(db)
    .where(and(...conditions))
    .orderBy(desc(transactions.occurredAt), desc(transactions.id))
    .limit(f.limit + 1);

  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(mapRow),
    nextCursor: rows.length > f.limit && last ? encodeCursor(last) : null,
  };
}

// ---- validações de referência ----

async function assertOwnCard(db: Executor, userId: string, cardId: number): Promise<{ name: string }> {
  const [card] = await db
    .select({ name: cards.name })
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.id, cardId)));
  if (!card) throw notFound('Conta não encontrada.');
  return card;
}

function assertNotTransferCategory(categoryId: string): void {
  if (categoryId === TRANSFER_CATEGORY_ID) {
    throw badRequest('A categoria Transferência é só das transferências.', 'validation_failed', [
      { path: 'categoryId', message: 'Use /transfers para transferir entre contas.' },
    ]);
  }
}

// A data é uma data de calendário: guardada como meio-dia UTC do dia que a pessoa vê (no fuso do app),
// para o mês nunca depender da hora em que o lançamento foi feito.
function normalizeDate(date: Date, timeZone: string): Date {
  return calendarNoon(date, timeZone);
}

// ---- criar ----

export type Repeat = { mode: 'monthly' } | { mode: 'installments'; total: number; current: number };

export interface CreateTransactionInput {
  cardId: number;
  categoryId: string;
  name: string;
  description: string | null;
  /** Magnitude positiva; o sinal vem de `type`. */
  amount: number;
  type: TransactionType;
  occurredAt: Date;
  repeat?: Repeat | undefined;
}

// A transação e a recorrência (se houver) entram juntas, numa só transação SQL. Com `Idempotency-Key`,
// repetir a chave devolve a transação já criada.
export function createTransaction(
  db: Db,
  userId: string,
  input: CreateTransactionInput,
  timeZone: string,
  key?: IdempotencyKey
): Promise<Idempotent<TransactionRecord>> {
  return runIdempotent(db, userId, 'POST /transactions', key, (tx) => insertTransaction(tx, userId, input, timeZone));
}

async function insertTransaction(
  tx: Tx,
  userId: string,
  input: CreateTransactionInput,
  timeZone: string
): Promise<TransactionRecord> {
  await assertOwnCard(tx, userId, input.cardId);
  await assertCategory(tx, userId, input.categoryId);
  assertNotTransferCategory(input.categoryId);
  if (input.repeat && input.type !== 'expense') {
    throw badRequest('Só despesas se repetem.', 'validation_failed', [{ path: 'repeat', message: 'Só despesas se repetem.' }]);
  }

  const occurredAt = normalizeDate(input.occurredAt, timeZone);
  const magnitude = round2(Math.abs(input.amount));

  let recurrenceId: number | null = null;
  let installment: number | null = null;
  if (input.repeat) {
    const plan = input.repeat.mode === 'installments' ? input.repeat : null;
    const firstInstallment = plan ? plan.current : 1;
    recurrenceId = await createRecurrence(tx, userId, {
      cardId: input.cardId,
      categoryId: input.categoryId,
      name: input.name,
      description: input.description,
      amount: magnitude,
      day: occurredAt.getUTCDate(),
      startMonth: monthKey(occurredAt),
      firstInstallment,
      total: plan ? plan.total : null,
    });
    installment = plan ? firstInstallment : null;
  }

  const [row] = await tx
    .insert(transactions)
    .values({
      userId,
      cardId: input.cardId,
      categoryId: input.categoryId,
      name: input.name,
      description: input.description,
      amount: input.type === 'expense' ? -magnitude : magnitude,
      type: input.type,
      occurredAt,
      recurrenceId,
      installment,
    })
    .returning({ id: transactions.id });
  return getTransaction(tx, userId, row!.id);
}

// ---- editar ----

export interface UpdateTransactionInput {
  cardId?: number | undefined;
  categoryId?: string | undefined;
  name?: string | undefined;
  description?: string | null | undefined;
  amount?: number | undefined;
  type?: TransactionType | undefined;
  occurredAt?: Date | undefined;
  /** Aplica também às próximas da recorrência. */
  applyToNext?: boolean | undefined;
}

export function updateTransaction(
  db: Db,
  userId: string,
  id: number,
  patch: UpdateTransactionInput,
  timeZone: string
): Promise<TransactionRecord> {
  return db.transaction((tx) => applyUpdate(tx, userId, id, patch, timeZone));
}

async function applyUpdate(
  tx: Tx,
  userId: string,
  id: number,
  patch: UpdateTransactionInput,
  timeZone: string
): Promise<TransactionRecord> {
  const [current] = await tx
    .select({
      type: transactions.type,
      amount: transactions.amount,
      transferId: transactions.transferId,
      recurrenceId: transactions.recurrenceId,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, id)))
    .for('update');
  if (!current) throw notFound('Transação não encontrada.');
  if (current.transferId !== null) {
    throw conflict('transfer_not_editable', 'Uma transferência não se edita: exclua e crie outra.');
  }

  if (patch.cardId !== undefined) await assertOwnCard(tx, userId, patch.cardId);
  if (patch.categoryId !== undefined) {
    await assertCategory(tx, userId, patch.categoryId);
    assertNotTransferCategory(patch.categoryId);
  }

  const type = (patch.type ?? current.type) as TransactionType;
  const set: Partial<typeof transactions.$inferInsert> = {};
  if (patch.cardId !== undefined) set.cardId = patch.cardId;
  if (patch.categoryId !== undefined) set.categoryId = patch.categoryId;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.occurredAt !== undefined) set.occurredAt = normalizeDate(patch.occurredAt, timeZone);
  if (patch.type !== undefined) set.type = patch.type;
  // O sinal sempre acompanha o tipo, mesmo quando só um dos dois muda.
  if (patch.amount !== undefined || patch.type !== undefined) {
    const magnitude = patch.amount !== undefined ? round2(Math.abs(patch.amount)) : Math.abs(current.amount);
    set.amount = type === 'expense' ? -magnitude : magnitude;
  }
  if (Object.keys(set).length > 0) {
    await tx
      .update(transactions)
      .set(set)
      .where(and(eq(transactions.userId, userId), eq(transactions.id, id)));
  }

  if (current.recurrenceId !== null) {
    if (type === 'income') {
      // Só despesa se repete: virar receita encerra a recorrência.
      await endRecurrence(tx, userId, current.recurrenceId);
    } else if (patch.applyToNext) {
      await updateRecurrence(tx, userId, current.recurrenceId, {
        ...(patch.cardId !== undefined ? { cardId: patch.cardId } : {}),
        ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.amount !== undefined ? { amount: round2(Math.abs(patch.amount)) } : {}),
      });
    }
  }
  return getTransaction(tx, userId, id);
}

// ---- excluir ----

// Excluir uma perna de transferência leva as duas, ou os saldos ficariam errados.
export function deleteTransaction(db: Db, userId: string, id: number): Promise<void> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ transferId: transactions.transferId })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.id, id)));
    if (!current) throw notFound('Transação não encontrada.');

    if (current.transferId !== null) {
      await tx
        .delete(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.transferId, current.transferId)));
    } else {
      await tx.delete(transactions).where(and(eq(transactions.userId, userId), eq(transactions.id, id)));
    }
  });
}

// ---- transferências ----

export interface TransferInput {
  fromCardId: number;
  toCardId: number;
  amount: number;
  description: string | null;
  occurredAt: Date;
}

export interface TransferResult {
  transferId: number;
  legs: TransactionRecord[];
}

// As duas pernas entram juntas, numa só transação SQL. Com `Idempotency-Key`, repetir a chave devolve a mesma transferência.
export function createTransfer(
  db: Db,
  userId: string,
  input: TransferInput,
  timeZone: string,
  key?: IdempotencyKey
): Promise<Idempotent<TransferResult>> {
  return runIdempotent(db, userId, 'POST /transfers', key, (tx) => insertTransfer(tx, userId, input, timeZone));
}

async function insertTransfer(tx: Tx, userId: string, input: TransferInput, timeZone: string): Promise<TransferResult> {
  if (input.fromCardId === input.toCardId) {
    throw badRequest('A transferência precisa ser entre contas diferentes.', 'validation_failed', [
      { path: 'toCardId', message: 'Escolha uma conta diferente da de origem.' },
    ]);
  }
  const from = await assertOwnCard(tx, userId, input.fromCardId);
  const to = await assertOwnCard(tx, userId, input.toCardId);

  const amount = round2(Math.abs(input.amount));
  const occurredAt = normalizeDate(input.occurredAt, timeZone);

  const [out] = await tx
    .insert(transactions)
    .values({
      userId,
      cardId: input.fromCardId,
      categoryId: TRANSFER_CATEGORY_ID,
      name: `Para ${to.name}`,
      description: input.description,
      amount: -amount,
      type: 'expense',
      occurredAt,
    })
    .returning({ id: transactions.id });
  // O id da primeira perna dá nome à transferência.
  const transferId = out!.id;
  await tx.update(transactions).set({ transferId }).where(eq(transactions.id, transferId));
  const [inbound] = await tx
    .insert(transactions)
    .values({
      userId,
      cardId: input.toCardId,
      categoryId: TRANSFER_CATEGORY_ID,
      name: `De ${from.name}`,
      description: input.description,
      amount,
      type: 'income',
      occurredAt,
      transferId,
    })
    .returning({ id: transactions.id });

  return {
    transferId,
    legs: [await getTransaction(tx, userId, transferId), await getTransaction(tx, userId, inbound!.id)],
  };
}

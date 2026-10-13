import { and, asc, count, eq, inArray, or, sql } from 'drizzle-orm';

import type { Db, Executor, Tx } from '../db/client.js';
import { cards, recurrences, transactions } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { runIdempotent, type IdempotencyKey, type Idempotent } from '../lib/idempotency.js';

export interface CardRecord {
  id: number;
  name: string;
  number: string;
  color: string;
  lightColor: string;
  /** Saldo atual: inicial + soma das transações. Sempre calculado, nunca gravado. */
  balance: number;
  startingBalance: number;
}

// O saldo atual sai da mesma consulta, para nunca divergir das transações. Os nomes da subconsulta vão
// escritos por extenso: numa consulta de uma tabela só, o Drizzle omite o prefixo das colunas, e `id`
// sem prefixo seria lido como o da própria subconsulta.
const currentBalance = sql<number>`${cards.balance} + coalesce((select sum(t.amount) from transactions t where t.card_id = cards.id), 0)`.mapWith(Number);

const cardColumns = {
  id: cards.id,
  name: cards.name,
  number: cards.number,
  color: cards.color,
  lightColor: cards.lightColor,
  startingBalance: cards.balance,
  balance: currentBalance,
};

export async function listCards(db: Executor, userId: string): Promise<CardRecord[]> {
  return db.select(cardColumns).from(cards).where(eq(cards.userId, userId)).orderBy(asc(cards.id));
}

export async function getCard(db: Executor, userId: string, id: number): Promise<CardRecord> {
  const [row] = await db
    .select(cardColumns)
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.id, id)));
  if (!row) throw notFound('Conta não encontrada.');
  return row;
}

export interface CardInput {
  name: string;
  number: string;
  color: string;
  lightColor: string;
  startingBalance: number;
}

// Com `Idempotency-Key`, repetir a chave devolve a conta já criada em vez de criar outra.
export function createCard(db: Db, userId: string, input: CardInput, key?: IdempotencyKey): Promise<Idempotent<CardRecord>> {
  return runIdempotent(db, userId, 'POST /cards', key, (tx) => insertCard(tx, userId, input));
}

async function insertCard(db: Executor, userId: string, input: CardInput): Promise<CardRecord> {
  const [row] = await db
    .insert(cards)
    .values({
      userId,
      name: input.name,
      number: input.number,
      color: input.color,
      lightColor: input.lightColor,
      balance: input.startingBalance,
    })
    .returning({ id: cards.id });
  return getCard(db, userId, row!.id);
}

export async function updateCard(
  db: Executor,
  userId: string,
  id: number,
  patch: Partial<{ name: string; number: string; color: string; lightColor: string }>
): Promise<CardRecord> {
  if (Object.keys(patch).length > 0) {
    const updated = await db
      .update(cards)
      .set(patch)
      .where(and(eq(cards.userId, userId), eq(cards.id, id)))
      .returning({ id: cards.id });
    if (updated.length === 0) throw notFound('Conta não encontrada.');
  }
  return getCard(db, userId, id);
}

// As transações da conta e a outra perna de toda transferência de que ela participou: uma transferência
// sem a outra metade deixaria o saldo da outra conta errado.
function ofAccount(userId: string, cardId: number) {
  return and(
    eq(transactions.userId, userId),
    or(
      eq(transactions.cardId, cardId),
      inArray(
        transactions.transferId,
        sql`(select ${transactions.transferId} from ${transactions} where ${transactions.userId} = ${userId} and ${transactions.cardId} = ${cardId} and ${transactions.transferId} is not null)`
      )
    )
  );
}

// O que excluir a conta levaria junto, para avisar a pessoa antes.
export async function cardUsage(
  db: Executor,
  userId: string,
  id: number
): Promise<{ transactions: number; recurrences: number }> {
  await getCard(db, userId, id);
  const [tx] = await db.select({ n: count() }).from(transactions).where(ofAccount(userId, id));
  const [rec] = await db
    .select({ n: count() })
    .from(recurrences)
    .where(and(eq(recurrences.userId, userId), eq(recurrences.cardId, id)));
  return { transactions: tx?.n ?? 0, recurrences: rec?.n ?? 0 };
}

// Tudo numa transação SQL: nunca sobra uma perna de transferência sozinha.
export function deleteCard(db: Db, userId: string, id: number): Promise<void> {
  return db.transaction(async (tx: Tx) => {
    // Trava as contas da pessoa: duas exclusões simultâneas não podem tirar a última.
    const owned = await tx.select({ id: cards.id }).from(cards).where(eq(cards.userId, userId)).for('update');
    if (!owned.some((c) => c.id === id)) throw notFound('Conta não encontrada.');
    if (owned.length <= 1) throw conflict('last_card', 'Não dá para excluir a última conta.');

    await tx.delete(recurrences).where(and(eq(recurrences.userId, userId), eq(recurrences.cardId, id)));
    await tx.delete(transactions).where(ofAccount(userId, id));
    await tx.delete(cards).where(and(eq(cards.userId, userId), eq(cards.id, id)));
  });
}


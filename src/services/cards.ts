import { and, asc, count, eq, inArray, or, sql } from 'drizzle-orm';

import type { Db, Executor, Tx } from '../db/client.js';
import { cards, recurrences, transactions } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { runIdempotent, type IdempotencyKey, type Idempotent } from '../lib/idempotency.js';
import { round2 } from '../lib/money.js';
import { isActiveRecurrence } from './recurrences.js';

export interface CardRecord {
  id: number;
  name: string;
  number: string;
  color: string;
  lightColor: string;
  /** Saldo atual: inicial + soma das transações que saem do saldo (as compras no crédito não entram). Sempre calculado. */
  balance: number;
  startingBalance: number;
  /** O cartão de crédito da conta, ou null numa conta sem cartão (sempre presente na resposta). */
  credit: CreditRecord | null;
}

export interface CreditRecord {
  lastDigits: string;
  limit: number | null;
  closingDay: number;
  dueDay: number;
}

export interface CreditInput {
  lastDigits: string;
  limit: number | null;
  closingDay: number;
  dueDay: number;
}

// O saldo atual sai da mesma consulta, para nunca divergir das transações. Os nomes da subconsulta vão
// escritos por extenso: numa consulta de uma tabela só, o Drizzle omite o prefixo das colunas, e `id`
// sem prefixo seria lido como o da própria subconsulta.
// Uma compra no crédito não mexe no saldo: ela entra na fatura, e o saldo só cai quando a fatura é paga.
const currentBalance = sql<number>`${cards.balance} + coalesce((select sum(t.amount) from transactions t where t.card_id = cards.id and t.payment_method is distinct from 'credit'), 0)`.mapWith(Number);

const cardColumns = {
  id: cards.id,
  name: cards.name,
  number: cards.number,
  color: cards.color,
  lightColor: cards.lightColor,
  startingBalance: cards.balance,
  balance: currentBalance,
  creditLastDigits: cards.creditLastDigits,
  creditLimit: cards.creditLimit,
  closingDay: cards.closingDay,
  dueDay: cards.dueDay,
};

type CardRow = {
  id: number;
  name: string;
  number: string;
  color: string;
  lightColor: string;
  startingBalance: number;
  balance: number;
  creditLastDigits: string | null;
  creditLimit: number | null;
  closingDay: number | null;
  dueDay: number | null;
};

// Uma conta tem cartão quando closing_day não é nulo.
function mapCard(row: CardRow): CardRecord {
  const { creditLastDigits, creditLimit, closingDay, dueDay, ...card } = row;
  const credit =
    closingDay !== null && dueDay !== null ? { lastDigits: creditLastDigits ?? '', limit: creditLimit, closingDay, dueDay } : null;
  return { ...card, credit };
}

export async function listCards(db: Executor, userId: string): Promise<CardRecord[]> {
  const rows = await db.select(cardColumns).from(cards).where(eq(cards.userId, userId)).orderBy(asc(cards.id));
  return rows.map(mapCard);
}

export async function getCard(db: Executor, userId: string, id: number): Promise<CardRecord> {
  const [row] = await db
    .select(cardColumns)
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.id, id)));
  if (!row) throw notFound('Conta não encontrada.');
  return mapCard(row);
}

export interface CardInput {
  name: string;
  number: string;
  color: string;
  lightColor: string;
  startingBalance: number;
  credit?: CreditInput | null | undefined;
}

// As colunas do cartão de crédito: todas nulas quando a conta não tem cartão.
function creditColumns(credit: CreditInput | null | undefined) {
  return {
    creditLastDigits: credit ? credit.lastDigits : null,
    creditLimit: credit && credit.limit !== null ? round2(credit.limit) : null,
    closingDay: credit ? credit.closingDay : null,
    dueDay: credit ? credit.dueDay : null,
  };
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
      ...creditColumns(input.credit),
    })
    .returning({ id: cards.id });
  return getCard(db, userId, row!.id);
}

export type CardPatch = Partial<{ name: string; number: string; color: string; lightColor: string }> & {
  /** O cartão inteiro, ou null para tirá-lo da conta. Mudar os dias vale para todas as faturas, também as passadas. */
  credit?: CreditInput | null | undefined;
};

// Tirar o cartão de uma conta com compras no crédito (ou recorrências no crédito ainda valendo) é recusado.
async function assertNoCreditUse(tx: Tx, userId: string, cardId: number): Promise<void> {
  const [purchases] = await tx
    .select({ n: count() })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.cardId, cardId), eq(transactions.paymentMethod, 'credit')));
  const [plans] = await tx
    .select({ n: count() })
    .from(recurrences)
    .where(and(eq(recurrences.userId, userId), eq(recurrences.cardId, cardId), eq(recurrences.paymentMethod, 'credit'), isActiveRecurrence));
  if ((purchases?.n ?? 0) + (plans?.n ?? 0) > 0) {
    throw conflict(
      'credit_in_use',
      'Esta conta tem compras no cartão de crédito. Passe as compras para outra forma de pagamento ou exclua-as antes de tirar o cartão.'
    );
  }
}

export function updateCard(db: Db, userId: string, id: number, patch: CardPatch): Promise<CardRecord> {
  return db.transaction(async (tx) => {
    // Trava a conta: uma compra no crédito gravada ao mesmo tempo espera esta troca terminar.
    const [current] = await tx
      .select({ closingDay: cards.closingDay })
      .from(cards)
      .where(and(eq(cards.userId, userId), eq(cards.id, id)))
      .for('update');
    if (!current) throw notFound('Conta não encontrada.');

    const { credit, ...fields } = patch;
    const set: Partial<typeof cards.$inferInsert> = { ...fields };
    if (credit === null) {
      if (current.closingDay !== null) await assertNoCreditUse(tx, userId, id);
      Object.assign(set, creditColumns(null));
    } else if (credit !== undefined) {
      Object.assign(set, creditColumns(credit));
    }
    if (Object.keys(set).length > 0) {
      await tx.update(cards).set(set).where(and(eq(cards.userId, userId), eq(cards.id, id)));
    }
    // Mudar os dias do cartão vale para todas as faturas, também as passadas: o mês do gasto das compras no
    // crédito desta conta é refeito na mesma transação. (Tirar o cartão não chega aqui com compras no crédito.)
    if (credit) {
      await tx
        .update(transactions)
        .set({
          spendingMonth: sql<string>`spending_month_of(${transactions.occurredAt}, ${transactions.paymentMethod}, ${credit.closingDay}::integer, ${credit.dueDay}::integer)`,
        })
        .where(and(eq(transactions.userId, userId), eq(transactions.cardId, id), eq(transactions.paymentMethod, 'credit')));
    }
    return getCard(tx, userId, id);
  });
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


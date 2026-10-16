import { asc, eq, isNull, or } from 'drizzle-orm';

import type { Db, Tx } from '../db/client.js';
import {
  cards,
  categories,
  categoryBudgets,
  goalEntries,
  goals,
  monthlyBudgets,
  profile,
  recurrences,
  transactions,
} from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { round2 } from '../lib/money.js';
import {
  BACKUP_APP,
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  type BackupFile,
  type BackupRow,
  CUSTOM_CATEGORY_PREFIX,
  validateBackup,
  type ValidBackup,
} from '../shared/backup.js';
import { calendarNoon } from '../shared/month.js';
import { catalogCategoryIds, newCustomCategoryId } from './categories.js';

// Tudo da pessoa no formato do backup do app (serve também para a LGPD). Os ids são os do servidor;
// o `transfer_id` aponta para a primeira perna, como no app.
export async function exportBackup(db: Db, userId: string, now = new Date()): Promise<BackupFile> {
  return db.transaction(async (tx) => {
    // Um retrato consistente (repeatable read), lido em sequência: a transação usa uma conexão só.
    // O catálogo e só as categorias deste usuário: as dos outros nunca entram no arquivo.
    const catalog = await tx
      .select()
      .from(categories)
      .where(or(isNull(categories.userId), eq(categories.userId, userId)))
      .orderBy(asc(categories.seq));
    const cardRows = await tx.select().from(cards).where(eq(cards.userId, userId)).orderBy(asc(cards.id));
    const recurrenceRows = await tx.select().from(recurrences).where(eq(recurrences.userId, userId)).orderBy(asc(recurrences.id));
    const transactionRows = await tx.select().from(transactions).where(eq(transactions.userId, userId)).orderBy(asc(transactions.id));
    const profileRow = await tx.select().from(profile).where(eq(profile.userId, userId));
    const monthly = await tx.select().from(monthlyBudgets).where(eq(monthlyBudgets.userId, userId)).orderBy(asc(monthlyBudgets.month));
    const perCategory = await tx.select().from(categoryBudgets).where(eq(categoryBudgets.userId, userId)).orderBy(asc(categoryBudgets.month));
    const goalRows = await tx.select().from(goals).where(eq(goals.userId, userId)).orderBy(asc(goals.id));
    const goalEntryRows = await tx.select().from(goalEntries).where(eq(goalEntries.userId, userId)).orderBy(asc(goalEntries.id));

    const me = profileRow[0];
    return {
      app: BACKUP_APP,
      format: BACKUP_FORMAT,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: now.toISOString(),
      data: {
        categories: catalog.map((c): BackupRow => ({ id: c.id, name: c.name, icon: c.icon, color: c.color, bg: c.bg })),
        cards: cardRows.map((c): BackupRow => ({
          id: c.id,
          name: c.name,
          number: c.number,
          color: c.color,
          light_color: c.lightColor,
          balance: c.balance,
          credit_last_digits: c.creditLastDigits,
          credit_limit: c.creditLimit,
          closing_day: c.closingDay,
          due_day: c.dueDay,
        })),
        recurrences: recurrenceRows.map((r): BackupRow => ({
          id: r.id,
          card_id: r.cardId,
          category_id: r.categoryId,
          name: r.name,
          description: r.description,
          amount: r.amount,
          day: r.day,
          start_month: r.startMonth,
          first_installment: r.firstInstallment,
          total: r.total,
          end_month: r.endMonth,
          generated_until: r.generatedUntil,
          payment_method: r.paymentMethod,
        })),
        transactions: transactionRows.map((t): BackupRow => ({
          id: t.id,
          card_id: t.cardId,
          category_id: t.categoryId,
          name: t.name,
          description: t.description,
          amount: t.amount,
          type: t.type,
          occurred_at: t.occurredAt.toISOString(),
          created_at: t.createdAt.toISOString(),
          recurrence_id: t.recurrenceId,
          installment: t.installment,
          transfer_id: t.transferId,
          payment_method: t.paymentMethod,
          invoice_month: t.invoiceMonth,
        })),
        profile: [
          {
            id: 1,
            name: me?.name ?? '',
            currency: me?.currency ?? 'BRL',
            avatar_uri: null,
            monthly_budget: null,
            reminders_enabled: me?.remindersEnabled === false ? 0 : 1,
            // O tema fica só no app; o campo existe para o arquivo ter o formato do app (que o trata como opcional).
            theme: 'system',
          },
        ],
        monthly_budgets: monthly.map((b): BackupRow => ({ month: b.month, amount: b.amount })),
        category_budgets: perCategory.map((b): BackupRow => ({ category_id: b.categoryId, month: b.month, amount: b.amount })),
        goals: goalRows.map((g): BackupRow => ({
          id: g.id,
          name: g.name,
          target_amount: g.targetAmount,
          target_month: g.targetMonth,
          color: g.color,
          icon: g.icon,
        })),
        goal_entries: goalEntryRows.map((e): BackupRow => ({
          id: e.id,
          goal_id: e.goalId,
          amount: e.amount,
          occurred_at: e.occurredAt.toISOString(),
        })),
      },
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

const CHUNK = 500;
function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

// Substitui tudo da pessoa pelo conteúdo de um backup que já passou em `validateBackup`. É uma única
// transação SQL: se algo falhar, nada muda. Os ids são refeitos (o Postgres gera os novos) e as
// referências (conta, recorrência, `transfer_id`) são remapeadas. As datas antigas, gravadas como
// instante UTC, viram a data de calendário no fuso do app (meio-dia UTC), o que corrige os lançamentos
// feitos à noite perto da virada do mês.
export async function restoreBackup(tx: Tx, userId: string, backup: ValidBackup, timeZone: string): Promise<void> {
  const { data } = backup;

  // O que aponta para os outros sai primeiro. O perfil e o catálogo de categorias ficam.
  await tx.delete(goalEntries).where(eq(goalEntries.userId, userId));
  await tx.delete(goals).where(eq(goals.userId, userId));
  await tx.delete(transactions).where(eq(transactions.userId, userId));
  await tx.delete(recurrences).where(eq(recurrences.userId, userId));
  await tx.delete(categoryBudgets).where(eq(categoryBudgets.userId, userId));
  await tx.delete(monthlyBudgets).where(eq(monthlyBudgets.userId, userId));
  await tx.delete(cards).where(eq(cards.userId, userId));
  // As categorias do próprio usuário, só depois de nada mais apontar para elas.
  await tx.delete(categories).where(eq(categories.userId, userId));

  const me = data.profile[0];
  if (me) {
    await tx
      .update(profile)
      .set({
        name: String(me.name ?? ''),
        currency: String(me.currency ?? 'BRL'),
        remindersEnabled: me.reminders_enabled !== 0,
      })
      .where(eq(profile.userId, userId));
  }

  // Um backup sem contas ainda deixa o app usável (o que o seedIfEmpty fazia).
  const cardRows: BackupRow[] =
    data.cards.length > 0
      ? data.cards
      : [{ id: 0, name: 'Conta Principal', number: '0001', color: '#3161B2', light_color: '#4A74BB', balance: 0 }];

  const cardIds = new Map<number, number>();
  for (const row of cardRows) {
    const [created] = await tx
      .insert(cards)
      .values({
        userId,
        name: String(row.name),
        number: String(row.number),
        color: String(row.color),
        lightColor: String(row.light_color),
        balance: round2(Number(row.balance ?? 0)),
        creditLastDigits: (row.credit_last_digits as string | null) ?? null,
        creditLimit: row.credit_limit === null || row.credit_limit === undefined ? null : round2(Number(row.credit_limit)),
        closingDay: (row.closing_day as number | null) ?? null,
        dueDay: (row.due_day as number | null) ?? null,
      })
      .returning({ id: cards.id });
    cardIds.set(row.id as number, created!.id);
  }

  // Categorias do usuário: o id é refeito e as referências (transações, recorrências, limites) são remapeadas.
  // As do catálogo que vierem no arquivo são ignoradas.
  const customCategoryIds = new Map<string, string>();
  for (const row of data.categories) {
    const oldId = String(row.id);
    if (!oldId.startsWith(CUSTOM_CATEGORY_PREFIX)) continue;
    const [created] = await tx
      .insert(categories)
      .values({ id: newCustomCategoryId(), userId, name: String(row.name), icon: String(row.icon), color: String(row.color), bg: String(row.bg) })
      .returning({ id: categories.id });
    customCategoryIds.set(oldId, created!.id);
  }
  const categoryOf = (id: unknown) => customCategoryIds.get(String(id)) ?? String(id);

  const recurrenceIds = new Map<number, number>();
  for (const row of data.recurrences) {
    const [created] = await tx
      .insert(recurrences)
      .values({
        userId,
        cardId: cardIds.get(row.card_id as number)!,
        categoryId: categoryOf(row.category_id),
        name: String(row.name),
        description: (row.description as string | null) ?? null,
        amount: round2(Number(row.amount)),
        day: row.day as number,
        startMonth: String(row.start_month),
        firstInstallment: row.first_installment as number,
        total: (row.total as number | null) ?? null,
        endMonth: (row.end_month as string | null) ?? null,
        generatedUntil: String(row.generated_until),
        paymentMethod: (row.payment_method as string | null) ?? null,
      })
      .returning({ id: recurrences.id });
    recurrenceIds.set(row.id as number, created!.id);
  }

  const ordered = [...data.transactions].sort((a, b) => (a.id as number) - (b.id as number));
  const transactionIds = new Map<number, number>();
  for (const batch of chunks(ordered)) {
    const created = await tx
      .insert(transactions)
      .values(
        batch.map((row) => {
          const magnitude = round2(Math.abs(Number(row.amount)));
          const createdAt = Date.parse(String(row.created_at));
          return {
            userId,
            cardId: cardIds.get(row.card_id as number)!,
            categoryId: categoryOf(row.category_id),
            name: String(row.name),
            description: (row.description as string | null) ?? null,
            amount: row.type === 'expense' ? -magnitude : magnitude,
            type: String(row.type),
            occurredAt: calendarNoon(new Date(String(row.occurred_at)), timeZone),
            createdAt: Number.isNaN(createdAt) ? new Date() : new Date(createdAt),
            recurrenceId: row.recurrence_id === null ? null : recurrenceIds.get(row.recurrence_id as number)!,
            installment: (row.installment as number | null) ?? null,
            paymentMethod: (row.payment_method as string | null) ?? null,
            invoiceMonth: (row.invoice_month as string | null) ?? null,
          };
        })
      )
      .returning({ id: transactions.id });
    batch.forEach((row, i) => transactionIds.set(row.id as number, created[i]!.id));
  }

  // O `transfer_id` aponta para a primeira perna; com os ids novos, as duas pernas passam a apontar para a nova.
  for (const row of ordered) {
    if (row.transfer_id === null) continue;
    await tx
      .update(transactions)
      .set({ transferId: transactionIds.get(row.transfer_id as number)! })
      .where(eq(transactions.id, transactionIds.get(row.id as number)!));
  }

  // Caixinhas: os ids são refeitos e as movimentações passam a apontar para o id novo. As datas ficam como
  // vieram (instante), sem normalizar: o histórico é ordenado por elas e não entra em total de mês.
  const goalIds = new Map<number, number>();
  for (const row of data.goals) {
    const [created] = await tx
      .insert(goals)
      .values({
        userId,
        name: String(row.name),
        targetAmount: round2(Number(row.target_amount)),
        targetMonth: (row.target_month as string | null) ?? null,
        color: String(row.color),
        icon: String(row.icon),
      })
      .returning({ id: goals.id });
    goalIds.set(row.id as number, created!.id);
  }
  for (const batch of chunks(data.goal_entries)) {
    await tx.insert(goalEntries).values(
      batch.map((row) => ({
        userId,
        goalId: goalIds.get(row.goal_id as number)!,
        amount: round2(Number(row.amount)),
        occurredAt: new Date(String(row.occurred_at)),
      }))
    );
  }

  for (const batch of chunks(data.monthly_budgets)) {
    await tx
      .insert(monthlyBudgets)
      .values(batch.map((r) => ({ userId, month: String(r.month), amount: r.amount === null ? null : round2(Number(r.amount)) })));
  }
  for (const batch of chunks(data.category_budgets)) {
    await tx.insert(categoryBudgets).values(
      batch.map((r) => ({
        userId,
        categoryId: categoryOf(r.category_id),
        month: String(r.month),
        amount: r.amount === null ? null : round2(Number(r.amount)),
      }))
    );
  }
}

// Confere o arquivo recebido e só então substitui tudo. Recusa com 400 `invalid_backup` sem mexer em nada.
export async function importBackup(db: Db, userId: string, raw: unknown, timeZone: string): Promise<void> {
  const validation = validateBackup(raw, await catalogCategoryIds(db));
  if (!validation.ok) throw badRequest(validation.reason, 'invalid_backup');
  await db.transaction((tx) => restoreBackup(tx, userId, validation.backup, timeZone));
}

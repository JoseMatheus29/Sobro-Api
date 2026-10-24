import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
  jsonb,
  smallint,
} from 'drizzle-orm/pg-core';

// Dinheiro é numeric(14,2); o driver devolve número (mode: 'number') para o resto do código.
const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: 'number' });
const createdAt = () => timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)]
);

export const profile = pgTable('profile', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull().default(''),
  currency: text('currency').notNull().default('BRL'),
  remindersEnabled: boolean('reminders_enabled').notNull().default(true),
});

// `user_id` nulo é o catálogo global (somente leitura, igual para todos); preenchido, é uma categoria
// criada pelo usuário (id `custom-<uuid>`), só dele. O id é único no banco inteiro, então as junções por
// `category_id` continuam valendo, e quem pode usar cada uma é conferido no serviço.
export const categories = pgTable(
  'categories',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icon: text('icon').notNull(),
    color: text('color').notNull(),
    bg: text('bg').notNull(),
    // Ordem de criação (como o rowid do SQLite do app): as do usuário aparecem na ordem em que ele as fez.
    seq: integer('seq').notNull().generatedAlwaysAsIdentity(),
  },
  (t) => [index('categories_user_idx').on(t.userId)]
);

export const cards = pgTable(
  'cards',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    number: text('number').notNull().default(''),
    color: text('color').notNull(),
    lightColor: text('light_color').notNull(),
    // Saldo inicial. O saldo atual é sempre calculado (inicial + soma das transações que saem do saldo).
    balance: money('balance').notNull().default(0),
    // Cartão de crédito da conta: a conta tem cartão quando closing_day não é nulo. A fatura não é gravada:
    // é calculada a partir das compras no crédito e dos pagamentos.
    creditLastDigits: text('credit_last_digits'),
    creditLimit: money('credit_limit'),
    closingDay: smallint('closing_day'),
    dueDay: smallint('due_day'),
  },
  (t) => [
    index('cards_user_idx').on(t.userId),
    check(
      'cards_credit_days_check',
      sql`(${t.closingDay} IS NULL AND ${t.dueDay} IS NULL) OR (${t.closingDay} BETWEEN 1 AND 31 AND ${t.dueDay} BETWEEN 1 AND 31)`
    ),
  ]
);

export const recurrences = pgTable(
  'recurrences',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cardId: integer('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    name: text('name').notNull(),
    description: text('description'),
    // Magnitude positiva de uma ocorrência (só despesas se repetem).
    amount: money('amount').notNull(),
    day: smallint('day').notNull(),
    startMonth: text('start_month').notNull(),
    firstInstallment: integer('first_installment').notNull().default(1),
    total: integer('total'),
    endMonth: text('end_month'),
    generatedUntil: text('generated_until').notNull(),
    // Como as ocorrências são pagas: 'pix', 'debit', 'credit' ou nulo (sai do saldo, como sempre foi).
    paymentMethod: text('payment_method'),
  },
  (t) => [
    index('recurrences_user_generated_idx').on(t.userId, t.generatedUntil),
    index('recurrences_card_idx').on(t.userId, t.cardId),
    check('recurrences_amount_positive', sql`${t.amount} > 0`),
    check('recurrences_payment_method_valid', sql`${t.paymentMethod} IN ('pix', 'debit', 'credit')`),
    check('recurrences_day_range', sql`${t.day} BETWEEN 1 AND 31`),
    check('recurrences_total_valid', sql`${t.total} IS NULL OR ${t.total} >= 1`),
    check(
      'recurrences_installment_valid',
      sql`${t.firstInstallment} >= 1 AND (${t.total} IS NULL OR ${t.firstInstallment} <= ${t.total})`
    ),
    check('recurrences_months_format', sql`${t.startMonth} ~ '^[0-9]{4}-[0-9]{2}$' AND ${t.generatedUntil} ~ '^[0-9]{4}-[0-9]{2}$'`),
  ]
);

export const transactions = pgTable(
  'transactions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cardId: integer('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    name: text('name').notNull(),
    description: text('description'),
    // Com sinal: negativo = despesa, positivo = receita.
    amount: money('amount').notNull(),
    type: text('type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
    recurrenceId: integer('recurrence_id').references(() => recurrences.id, { onDelete: 'set null' }),
    installment: integer('installment'),
    // Id da primeira perna da transferência; as duas pernas compartilham o valor.
    transferId: integer('transfer_id'),
    // Como a saída foi paga: 'pix', 'debit', 'credit' (entra na fatura e não mexe no saldo) ou nulo (sai do saldo).
    paymentMethod: text('payment_method'),
    // 'AAAA-MM' da fatura que este lançamento paga; só nos pagamentos de fatura (categoria `invoice`).
    invoiceMonth: text('invoice_month'),
    // O mês em que o gasto conta ('AAAA-MM'): despesa no crédito = mês do vencimento da fatura que a recebe; todo o
    // resto = mês da data. Derivado (função spending_month_of): toda gravação que muda data, forma de pagamento ou
    // conta o refaz, e mudar os dias do cartão refaz o das compras no crédito dele.
    spendingMonth: text('spending_month').notNull(),
  },
  (t) => [
    index('transactions_user_occurred_idx').on(t.userId, t.occurredAt),
    index('transactions_user_card_idx').on(t.userId, t.cardId),
    index('transactions_user_recurrence_idx').on(t.userId, t.recurrenceId),
    index('transactions_user_transfer_idx').on(t.userId, t.transferId),
    index('transactions_user_card_method_idx').on(t.userId, t.cardId, t.paymentMethod),
    index('transactions_user_spending_month_idx').on(t.userId, t.spendingMonth),
    check('transactions_spending_month_format', sql`${t.spendingMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('transactions_payment_method_valid', sql`${t.paymentMethod} IN ('pix', 'debit', 'credit')`),
    check('transactions_type_valid', sql`${t.type} IN ('income', 'expense')`),
    check(
      'transactions_amount_matches_type',
      sql`(${t.type} = 'income' AND ${t.amount} > 0) OR (${t.type} = 'expense' AND ${t.amount} < 0)`
    ),
  ]
);

export const monthlyBudgets = pgTable(
  'monthly_budgets',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 'YYYY-MM', ou '0000-00' para o valor que já valia antes de haver meses (herdado da v1).
    month: text('month').notNull(),
    amount: money('amount'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.month] }),
    check('monthly_budgets_month_format', sql`${t.month} ~ '^[0-9]{4}-[0-9]{2}$'`),
  ]
);

export const categoryBudgets = pgTable(
  'category_budgets',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    month: text('month').notNull(),
    amount: money('amount'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.categoryId, t.month] }),
    check('category_budgets_month_format', sql`${t.month} ~ '^[0-9]{4}-[0-9]{2}$'`),
  ]
);

// Caixinhas: o dinheiro continua nas contas; a caixinha só diz quanto dele está reservado. Não mexe em
// saldo nem nos totais do mês. O valor guardado é a soma das movimentações, calculado e nunca gravado.
export const goals = pgTable(
  'goals',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    targetAmount: money('target_amount').notNull(),
    // 'YYYY-MM' até onde guardar, ou nulo sem prazo.
    targetMonth: text('target_month'),
    color: text('color').notNull(),
    icon: text('icon').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('goals_user_idx').on(t.userId),
    check('goals_target_positive', sql`${t.targetAmount} > 0`),
    check('goals_target_month_format', sql`${t.targetMonth} IS NULL OR ${t.targetMonth} ~ '^[0-9]{4}-[0-9]{2}$'`),
  ]
);

export const goalEntries = pgTable(
  'goal_entries',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    goalId: integer('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    // Com sinal: positivo guarda, negativo retira.
    amount: money('amount').notNull(),
    // O instante da movimentação, como veio: o histórico é ordenado por ele e não entra em total de mês.
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('goal_entries_user_goal_idx').on(t.userId, t.goalId),
    check('goal_entries_amount_nonzero', sql`${t.amount} <> 0`),
  ]
);

// ---- Tabelas de apoio da API (não existem no app) ----

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Agrupa os tokens de uma mesma sessão, para revogar todos juntos ao detectar reuso.
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    replacedAt: timestamp('replaced_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_unique').on(t.tokenHash),
    index('refresh_tokens_family_idx').on(t.familyId),
    index('refresh_tokens_user_idx').on(t.userId),
  ]
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [uniqueIndex('password_reset_tokens_hash_unique').on(t.tokenHash), index('password_reset_tokens_user_idx').on(t.userId)]
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    response: jsonb('response'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] }), index('idempotency_keys_created_idx').on(t.createdAt)]
);

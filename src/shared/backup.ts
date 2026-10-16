// O formato de backup do app (utils/backup.ts e backup-type.ts): um JSON com as tabelas do banco do app
// (linhas em snake_case). A API lê e escreve o mesmo formato, para o backup da v1 entrar pela v2.

import { INVOICE_CATEGORY_ID, PAYMENT_METHODS } from './payment.js';

export type BackupTableName =
  | 'categories'
  | 'cards'
  | 'recurrences'
  | 'transactions'
  | 'profile'
  | 'monthly_budgets'
  | 'category_budgets'
  | 'goals'
  | 'goal_entries';

export type BackupValue = string | number | null;
export type BackupRow = Record<string, BackupValue>;

interface ColumnSpec {
  name: string;
  kind: 'text' | 'number' | 'integer';
  /** A coluna precisa estar no arquivo. As outras (criadas em versões depois) usam `fallback`. */
  required: boolean;
  nullable?: boolean;
  fallback?: BackupValue;
}

interface TableSpec {
  name: BackupTableName;
  columns: ColumnSpec[];
}

export interface BackupFile {
  app: typeof BACKUP_APP;
  format: typeof BACKUP_FORMAT;
  /** `PRAGMA user_version` do banco de onde veio (6 na v1). */
  schemaVersion: number;
  exportedAt: string;
  data: Partial<Record<BackupTableName, BackupRow[]>>;
}

export interface ValidBackup {
  schemaVersion: number;
  exportedAt: string;
  data: Record<BackupTableName, BackupRow[]>;
}

export type BackupValidation = { ok: true; backup: ValidBackup } | { ok: false; reason: string };

export const BACKUP_APP = 'sobro';
export const BACKUP_FORMAT = 1;
/** As categorias que o usuário cria têm id `custom-...`; só elas viajam no backup (o catálogo vale o da API). */
export const CUSTOM_CATEGORY_PREFIX = 'custom-';

/** A versão do esquema do app (migração v9) que esta API entende. */
export const BACKUP_SCHEMA_VERSION = 9;

const text = (name: string, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ name, kind: 'text', required: true, ...extra });
const number = (name: string, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ name, kind: 'number', required: true, ...extra });
const integer = (name: string, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ name, kind: 'integer', required: true, ...extra });

// Na ordem em que as linhas podem ser inseridas: o que os outros apontam vem primeiro.
export const BACKUP_TABLES: TableSpec[] = [
  { name: 'categories', columns: [text('id'), text('name'), text('icon'), text('color'), text('bg')] },
  {
    name: 'cards',
    columns: [integer('id'), text('name'), text('number'), text('color'), text('light_color'),
      number('balance', { required: false, fallback: 0 }),
      text('credit_last_digits', { required: false, nullable: true, fallback: null }),
      number('credit_limit', { required: false, nullable: true, fallback: null }),
      integer('closing_day', { required: false, nullable: true, fallback: null }),
      integer('due_day', { required: false, nullable: true, fallback: null }),
    ],
  },
  {
    name: 'recurrences',
    columns: [
      integer('id'),
      integer('card_id'),
      text('category_id'),
      text('name'),
      text('description', { required: false, nullable: true, fallback: null }),
      number('amount'),
      integer('day'),
      text('start_month'),
      integer('first_installment', { required: false, fallback: 1 }),
      integer('total', { required: false, nullable: true, fallback: null }),
      text('end_month', { required: false, nullable: true, fallback: null }),
      text('generated_until'),
      text('payment_method', { required: false, nullable: true, fallback: null }),
    ],
  },
  {
    name: 'transactions',
    columns: [
      integer('id'),
      integer('card_id'),
      text('category_id'),
      text('name'),
      text('description', { required: false, nullable: true, fallback: null }),
      number('amount'),
      text('type'),
      text('occurred_at'),
      text('created_at', { required: false, fallback: '' }),
      integer('recurrence_id', { required: false, nullable: true, fallback: null }),
      integer('installment', { required: false, nullable: true, fallback: null }),
      integer('transfer_id', { required: false, nullable: true, fallback: null }),
      text('payment_method', { required: false, nullable: true, fallback: null }),
      text('invoice_month', { required: false, nullable: true, fallback: null }),
    ],
  },
  {
    name: 'profile',
    columns: [
      integer('id'),
      text('name', { required: false, fallback: '' }),
      text('currency', { required: false, fallback: 'BRL' }),
      text('avatar_uri', { required: false, nullable: true, fallback: null }),
      number('monthly_budget', { required: false, nullable: true, fallback: null }),
      integer('reminders_enabled', { required: false, fallback: 1 }),
    ],
  },
  { name: 'monthly_budgets', columns: [text('month'), number('amount', { nullable: true })] },
  { name: 'category_budgets', columns: [text('category_id'), text('month'), number('amount', { nullable: true })] },
  {
    name: 'goals',
    columns: [
      integer('id'),
      text('name'),
      number('target_amount'),
      text('target_month', { required: false, nullable: true, fallback: null }),
      text('color'),
      text('icon'),
    ],
  },
  { name: 'goal_entries', columns: [integer('id'), integer('goal_id'), number('amount'), text('occurred_at')] },
];

export const BACKUP_REASONS = {
  notBackup: 'Esse arquivo não é um backup do Sobrô.',
  newerFormat: 'Esse backup foi feito por uma versão mais nova do app. Atualize o app para importá-lo.',
  newerSchema: 'Esse backup veio de uma versão mais nova do app. Atualize o app para importá-lo.',
  badTable: (table: string) => `Os dados de "${table}" estão em um formato inesperado.`,
  badRow: (table: string, index: number, column: string) => `Linha ${index + 1} de "${table}": o campo "${column}" está ausente ou inválido.`,
  badReference: (table: string, index: number, column: string) => `Linha ${index + 1} de "${table}": "${column}" aponta para algo que não existe no backup.`,
  badType: (index: number) => `Transação ${index + 1}: o tipo precisa ser "income" ou "expense".`,
  badDate: (table: string, index: number) => `Linha ${index + 1} de "${table}": a data é inválida.`,
  badAmount: (index: number) => `Transação ${index + 1}: o valor é zero ou o sinal não combina com o tipo.`,
  badRecurrence: (index: number) => `Recorrência ${index + 1}: dia, parcelas ou valor inválidos.`,
  badMonth: (table: string, index: number) => `Linha ${index + 1} de "${table}": o mês precisa estar no formato AAAA-MM.`,
  badTransfer: (index: number) => `Transação ${index + 1}: a transferência não tem as duas pernas no backup.`,
  duplicateId: (table: string) => `"${table}" tem ids repetidos.`,
  badGoal: (index: number) => `Caixinha ${index + 1}: o valor da meta precisa ser maior que zero.`,
  badGoalEntry: (index: number) => `Movimentação ${index + 1} de caixinha: o valor não pode ser zero.`,
  badCreditCard: (index: number) => `Conta ${index + 1}: o cartão de crédito precisa ter dia de fechamento e de vencimento de 1 a 31, e o limite não pode ser negativo.`,
  badPaymentMethod: (table: string, index: number) =>
    `Linha ${index + 1} de "${table}": a forma de pagamento é inválida (só despesa tem, e crédito exige uma conta com cartão).`,
  badInvoice: (index: number) =>
    `Transação ${index + 1}: um pagamento de fatura precisa de um mês (AAAA-MM) e de valor negativo, e só ele leva mês de fatura.`,
  negativeGoal: (index: number) => `Caixinha ${index + 1}: as movimentações somam menos que zero.`,
};

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fits(column: ColumnSpec, value: unknown): value is BackupValue {
  if (value === null) return column.nullable === true;
  if (column.kind === 'text') return typeof value === 'string';
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return column.kind === 'integer' ? Number.isInteger(value) : true;
}

const MONTH_FORMAT = /^\d{4}-\d{2}$/;

// Confere um arquivo vindo de fora antes de substituir qualquer coisa: quem o fez, a versão, que cada
// linha está completa e que tudo que aponta para algo aponta para algo que existe. As categorias são
// as do catálogo da API (`catalogIds`), não as do arquivo.
export function validateBackup(raw: unknown, catalogIds: ReadonlySet<string>): BackupValidation {
  if (!isRow(raw) || raw.app !== BACKUP_APP || !isRow(raw.data)) return { ok: false, reason: BACKUP_REASONS.notBackup };
  if (typeof raw.format !== 'number' || raw.format > BACKUP_FORMAT) return { ok: false, reason: BACKUP_REASONS.newerFormat };
  if (typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) {
    return { ok: false, reason: BACKUP_REASONS.notBackup };
  }
  if (raw.schemaVersion > BACKUP_SCHEMA_VERSION) return { ok: false, reason: BACKUP_REASONS.newerSchema };

  const data = {} as Record<BackupTableName, BackupRow[]>;
  for (const spec of BACKUP_TABLES) {
    const source = raw.data[spec.name];
    if (source === undefined) {
      data[spec.name] = [];
      continue;
    }
    if (!Array.isArray(source)) return { ok: false, reason: BACKUP_REASONS.badTable(spec.name) };

    const rows: BackupRow[] = [];
    for (let i = 0; i < source.length; i++) {
      const row = source[i];
      if (!isRow(row)) return { ok: false, reason: BACKUP_REASONS.badTable(spec.name) };

      const clean: BackupRow = {};
      for (const column of spec.columns) {
        const value = row[column.name];
        if (value === undefined) {
          if (column.required) return { ok: false, reason: BACKUP_REASONS.badRow(spec.name, i, column.name) };
          clean[column.name] = column.fallback ?? null;
        } else if (!fits(column, value)) {
          return { ok: false, reason: BACKUP_REASONS.badRow(spec.name, i, column.name) };
        } else {
          clean[column.name] = value;
        }
      }
      rows.push(clean);
    }
    data[spec.name] = rows;
  }

  for (const table of ['cards', 'recurrences', 'transactions', 'goals'] as const) {
    if (new Set(data[table].map((r) => r.id)).size !== data[table].length) {
      return { ok: false, reason: BACKUP_REASONS.duplicateId(table) };
    }
  }

  // As chaves primárias dos orçamentos não se repetem (o SQLite do app já garantia isso).
  for (const [table, columns] of [
    ['monthly_budgets', ['month']],
    ['category_budgets', ['category_id', 'month']],
  ] as const) {
    const keys = data[table].map((r) => columns.map((c) => String(r[c])).join('|'));
    if (new Set(keys).size !== keys.length) return { ok: false, reason: BACKUP_REASONS.duplicateId(table) };
  }

  // Categorias do usuário (ids `custom-*`) vêm no próprio arquivo. As do catálogo são ignoradas: valem as da API.
  const customCategories = data.categories.filter((r) => String(r.id).startsWith(CUSTOM_CATEGORY_PREFIX));
  const customIds = new Set(customCategories.map((r) => r.id));
  if (customIds.size !== customCategories.length) return { ok: false, reason: BACKUP_REASONS.duplicateId('categories') };
  const categoryTargets = new Set<unknown>([...catalogIds, ...customIds]);

  const cards = new Set(data.cards.map((r) => r.id));
  const recurrences = new Set(data.recurrences.map((r) => r.id));
  const goals = new Set(data.goals.map((r) => r.id));

  const pointers: [BackupTableName, string, ReadonlySet<unknown>][] = [
    ['recurrences', 'card_id', cards],
    ['recurrences', 'category_id', categoryTargets],
    ['transactions', 'card_id', cards],
    ['transactions', 'category_id', categoryTargets],
    ['category_budgets', 'category_id', categoryTargets],
    ['goal_entries', 'goal_id', goals],
  ];
  for (const [table, column, targets] of pointers) {
    const index = data[table].findIndex((row) => !targets.has(row[column]));
    if (index >= 0) return { ok: false, reason: BACKUP_REASONS.badReference(table, index, column) };
  }
  const orphan = data.transactions.findIndex((r) => r.recurrence_id !== null && !recurrences.has(r.recurrence_id));
  if (orphan >= 0) return { ok: false, reason: BACKUP_REASONS.badReference('transactions', orphan, 'recurrence_id') };

  const badType = data.transactions.findIndex((r) => r.type !== 'income' && r.type !== 'expense');
  if (badType >= 0) return { ok: false, reason: BACKUP_REASONS.badType(badType) };

  for (const table of ['transactions', 'goal_entries'] as const) {
    const badDate = data[table].findIndex((r) => Number.isNaN(Date.parse(String(r.occurred_at))));
    if (badDate >= 0) return { ok: false, reason: BACKUP_REASONS.badDate(table, badDate) };
  }

  // O servidor confere o que o SQLite do app conferia só pelo código: sinal, parcelas e meses.
  const badAmount = data.transactions.findIndex((r) => {
    const amount = r.amount as number;
    return amount === 0 || (r.type === 'income' ? amount < 0 : amount > 0);
  });
  if (badAmount >= 0) return { ok: false, reason: BACKUP_REASONS.badAmount(badAmount) };

  const badRecurrence = data.recurrences.findIndex((r) => {
    const day = r.day as number;
    const first = r.first_installment as number;
    const total = r.total as number | null;
    return (
      day < 1 || day > 31 || (r.amount as number) <= 0 || first < 1 || (total !== null && (total < 1 || first > total))
    );
  });
  if (badRecurrence >= 0) return { ok: false, reason: BACKUP_REASONS.badRecurrence(badRecurrence) };

  for (const [table, columns] of [
    ['recurrences', ['start_month', 'generated_until']],
    ['monthly_budgets', ['month']],
    ['category_budgets', ['month']],
  ] as const) {
    const index = data[table].findIndex((r) => columns.some((c) => !MONTH_FORMAT.test(String(r[c]))));
    if (index >= 0) return { ok: false, reason: BACKUP_REASONS.badMonth(table, index) };
  }

  // Cartão de crédito e forma de pagamento (v9). Arquivos antigos não trazem os campos: eles entram nulos.
  const badCard = data.cards.findIndex((c) => {
    const closing = c.closing_day as number | null;
    const due = c.due_day as number | null;
    const limit = c.credit_limit as number | null;
    const inRange = (day: number | null) => day !== null && day >= 1 && day <= 31;
    const days = (closing === null && due === null) || (inRange(closing) && inRange(due));
    return !days || (limit !== null && limit < 0);
  });
  if (badCard >= 0) return { ok: false, reason: BACKUP_REASONS.badCreditCard(badCard) };

  const cardsWithCredit = new Set(data.cards.filter((c) => c.closing_day !== null).map((c) => c.id));
  const methods = new Set<unknown>(PAYMENT_METHODS);

  const badTransactionMethod = data.transactions.findIndex((r) => {
    const method = r.payment_method;
    if (method === null) return false;
    if (!methods.has(method) || r.type !== 'expense') return true;
    if (r.category_id === 'transfer' || r.category_id === INVOICE_CATEGORY_ID) return true;
    return method === 'credit' && !cardsWithCredit.has(r.card_id);
  });
  if (badTransactionMethod >= 0) {
    return { ok: false, reason: BACKUP_REASONS.badPaymentMethod('transactions', badTransactionMethod) };
  }

  const badRecurrenceMethod = data.recurrences.findIndex((r) => {
    const method = r.payment_method;
    if (method === null) return false;
    return !methods.has(method) || (method === 'credit' && !cardsWithCredit.has(r.card_id));
  });
  if (badRecurrenceMethod >= 0) {
    return { ok: false, reason: BACKUP_REASONS.badPaymentMethod('recurrences', badRecurrenceMethod) };
  }

  // Pagamento de fatura (categoria invoice): mês da fatura e valor negativo. Nas demais, sem mês de fatura.
  const badInvoice = data.transactions.findIndex((r) =>
    r.category_id === INVOICE_CATEGORY_ID
      ? r.invoice_month === null || !MONTH_FORMAT.test(String(r.invoice_month)) || r.type !== 'expense' || (r.amount as number) >= 0
      : r.invoice_month !== null
  );
  if (badInvoice >= 0) return { ok: false, reason: BACKUP_REASONS.badInvoice(badInvoice) };

  // Caixinhas: meta positiva, prazo no formato AAAA-MM, movimentações diferentes de zero e saldo nunca negativo.
  const badGoal = data.goals.findIndex((r) => (r.target_amount as number) <= 0);
  if (badGoal >= 0) return { ok: false, reason: BACKUP_REASONS.badGoal(badGoal) };

  const badGoalMonth = data.goals.findIndex((r) => r.target_month !== null && !MONTH_FORMAT.test(String(r.target_month)));
  if (badGoalMonth >= 0) return { ok: false, reason: BACKUP_REASONS.badMonth('goals', badGoalMonth) };

  const badEntry = data.goal_entries.findIndex((r) => Math.round((r.amount as number) * 100) === 0);
  if (badEntry >= 0) return { ok: false, reason: BACKUP_REASONS.badGoalEntry(badEntry) };

  const centsByGoal = new Map<unknown, number>();
  for (const entry of data.goal_entries) {
    centsByGoal.set(entry.goal_id, (centsByGoal.get(entry.goal_id) ?? 0) + Math.round((entry.amount as number) * 100));
  }
  const negativeGoal = data.goals.findIndex((r) => (centsByGoal.get(r.id) ?? 0) < 0);
  if (negativeGoal >= 0) return { ok: false, reason: BACKUP_REASONS.negativeGoal(negativeGoal) };

  // Uma transferência tem exatamente duas pernas, e o `transfer_id` é o id da primeira.
  const byTransfer = new Map<unknown, BackupRow[]>();
  for (const row of data.transactions) {
    if (row.transfer_id === null) continue;
    byTransfer.set(row.transfer_id, [...(byTransfer.get(row.transfer_id) ?? []), row]);
  }
  for (const [transferId, legs] of byTransfer) {
    const hasFirstLeg = legs.some((leg) => leg.id === transferId);
    if (legs.length !== 2 || !hasFirstLeg) {
      const index = data.transactions.findIndex((r) => r.transfer_id === transferId);
      return { ok: false, reason: BACKUP_REASONS.badTransfer(index) };
    }
  }

  const exportedAt = typeof raw.exportedAt === 'string' ? raw.exportedAt : '';
  return { ok: true, backup: { schemaVersion: raw.schemaVersion, exportedAt, data } };
}

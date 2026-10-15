import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, isNull, or } from 'drizzle-orm';

import type { Db, Executor } from '../db/client.js';
import { categories, categoryBudgets, recurrences, transactions } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { runIdempotent, type IdempotencyKey, type Idempotent } from '../lib/idempotency.js';

export interface CategoryRecord {
  id: string;
  name: string;
  icon: string;
  color: string;
  bg: string;
  /** True para as que o usuário criou; false para o catálogo global. */
  custom: boolean;
}

export interface CategoryInput {
  name: string;
  icon: string;
  color: string;
  bg: string;
}

const columns = {
  id: categories.id,
  name: categories.name,
  icon: categories.icon,
  color: categories.color,
  bg: categories.bg,
  userId: categories.userId,
};

function mapRow(row: { id: string; name: string; icon: string; color: string; bg: string; userId: string | null }): CategoryRecord {
  return { id: row.id, name: row.name, icon: row.icon, color: row.color, bg: row.bg, custom: row.userId !== null };
}

// O catálogo (por nome) e, depois, as do usuário na ordem em que ele as criou.
export async function listCategories(db: Executor, userId: string): Promise<CategoryRecord[]> {
  const catalog = await db.select(columns).from(categories).where(isNull(categories.userId)).orderBy(asc(categories.name));
  const own = await db.select(columns).from(categories).where(eq(categories.userId, userId)).orderBy(asc(categories.seq));
  return [...catalog, ...own].map(mapRow);
}

// Só o catálogo global: é o que um arquivo de backup pode citar sem trazer a própria categoria.
export async function catalogCategoryIds(db: Executor): Promise<Set<string>> {
  const rows = await db.select({ id: categories.id }).from(categories).where(isNull(categories.userId));
  return new Set(rows.map((r) => r.id));
}

// Uma categoria citada pelo app precisa ser do catálogo ou do próprio usuário; a de outra pessoa responde
// como inexistente. A leitura trava a linha (FOR SHARE) para uma exclusão simultânea esperar a gravação
// que a usa terminar, em vez de deixar a transação apontando para uma categoria que sumiu.
export async function assertCategory(db: Executor, userId: string, categoryId: string): Promise<void> {
  const [category] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), or(isNull(categories.userId), eq(categories.userId, userId))))
    .for('share');
  if (!category) {
    throw badRequest('Categoria inexistente.', 'validation_failed', [{ path: 'categoryId', message: 'Categoria inexistente.' }]);
  }
}

// O id é gerado aqui (`custom-` + 32 caracteres) e cabe nos 40 que as rotas aceitam. Com `Idempotency-Key`,
// repetir a chave devolve a categoria já criada em vez de criar outra.
export function createCategory(db: Db, userId: string, input: CategoryInput, key?: IdempotencyKey): Promise<Idempotent<CategoryRecord>> {
  return runIdempotent(db, userId, 'POST /categories', key, async (tx) => {
    const [row] = await tx
      .insert(categories)
      .values({ id: `custom-${randomUUID().replaceAll('-', '')}`, userId, ...input })
      .returning(columns);
    return mapRow(row!);
  });
}

// Só as do próprio usuário: o catálogo e as de outras pessoas respondem 404.
export async function updateCategory(db: Db, userId: string, id: string, patch: Partial<CategoryInput>): Promise<CategoryRecord> {
  const mine = and(eq(categories.id, id), eq(categories.userId, userId));
  if (Object.keys(patch).length > 0) {
    const [row] = await db.update(categories).set(patch).where(mine).returning(columns);
    if (!row) throw notFound('Categoria não encontrada.');
    return mapRow(row);
  }
  const [row] = await db.select(columns).from(categories).where(mine);
  if (!row) throw notFound('Categoria não encontrada.');
  return mapRow(row);
}

// Como no app: com transações ou recorrências usando, recusa (409), para não apagar o histórico de gastos.
// Os limites por categoria vão junto com ela.
export function deleteCategory(db: Db, userId: string, id: string): Promise<void> {
  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.userId, userId)))
      .for('update');
    if (locked.length === 0) throw notFound('Categoria não encontrada.');

    const [used] = await tx
      .select({ n: count() })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.categoryId, id)));
    const [planned] = await tx
      .select({ n: count() })
      .from(recurrences)
      .where(and(eq(recurrences.userId, userId), eq(recurrences.categoryId, id)));
    if ((used?.n ?? 0) + (planned?.n ?? 0) > 0) {
      throw conflict('category_in_use', 'Não é possível excluir uma categoria com transações ou recorrências registradas.');
    }

    await tx.delete(categoryBudgets).where(and(eq(categoryBudgets.userId, userId), eq(categoryBudgets.categoryId, id)));
    await tx.delete(categories).where(eq(categories.id, id));
  });
}

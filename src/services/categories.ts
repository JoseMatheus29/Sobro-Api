import { asc, eq } from 'drizzle-orm';

import type { Executor } from '../db/client.js';
import { categories } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';

// Catálogo global e somente leitura (o app não cria categorias).
export async function listCategories(db: Executor) {
  return db.select().from(categories).orderBy(asc(categories.name));
}

export async function categoryIds(db: Executor): Promise<Set<string>> {
  const rows = await db.select({ id: categories.id }).from(categories);
  return new Set(rows.map((r) => r.id));
}

// Uma categoria citada pelo app precisa existir no catálogo.
export async function assertCategory(db: Executor, categoryId: string): Promise<void> {
  const [category] = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId));
  if (!category) {
    throw badRequest('Categoria inexistente.', 'validation_failed', [{ path: 'categoryId', message: 'Categoria inexistente.' }]);
  }
}

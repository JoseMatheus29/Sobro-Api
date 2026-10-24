import { eq, sql } from 'drizzle-orm';

import type { Executor } from '../db/client.js';
import { profile, users } from '../db/schema.js';
import { notFound } from '../lib/errors.js';

export interface Me {
  id: string;
  email: string;
  name: string;
  currency: string;
  remindersEnabled: boolean;
  /** Quantos perfis gerenciados esta conta tem (o app avisa que excluir a conta os apaga junto). */
  managedProfiles: number;
}

export async function getMe(db: Executor, userId: string): Promise<Me> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: profile.name,
      currency: profile.currency,
      remindersEnabled: profile.remindersEnabled,
      managedProfiles: sql<number>`(select count(*) from profile_access where profile_access.manager_id = users.id)`.mapWith(Number),
    })
    .from(users)
    .innerJoin(profile, eq(profile.userId, users.id))
    .where(eq(users.id, userId));
  // Quem tem e-mail é quem tem login; um perfil gerenciado nunca é lido por aqui.
  if (!row?.email) throw notFound('Conta não encontrada.');
  return { ...row, email: row.email };
}

export async function updateProfile(
  db: Executor,
  userId: string,
  patch: Partial<{ name: string; currency: string; remindersEnabled: boolean }>
): Promise<Me> {
  if (Object.keys(patch).length > 0) {
    await db.update(profile).set(patch).where(eq(profile.userId, userId));
  }
  return getMe(db, userId);
}

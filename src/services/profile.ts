import { eq } from 'drizzle-orm';

import type { Executor } from '../db/client.js';
import { profile, users } from '../db/schema.js';
import { notFound } from '../lib/errors.js';

export interface Me {
  id: string;
  email: string;
  name: string;
  currency: string;
  remindersEnabled: boolean;
}

export async function getMe(db: Executor, userId: string): Promise<Me> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: profile.name,
      currency: profile.currency,
      remindersEnabled: profile.remindersEnabled,
    })
    .from(users)
    .innerJoin(profile, eq(profile.userId, users.id))
    .where(eq(users.id, userId));
  if (!row) throw notFound('Conta não encontrada.');
  return row;
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

import { and, asc, count, eq, sql } from 'drizzle-orm';

import type { Config } from '../config.js';
import type { Db, Executor } from '../db/client.js';
import { cards, profile, profileAccess, users } from '../db/schema.js';
import { AppError, conflict, notFound, unauthorized } from '../lib/errors.js';
import { runIdempotent, type IdempotencyKey, type Idempotent } from '../lib/idempotency.js';
import { verifyPassword } from '../lib/passwords.js';
import { DEFAULT_CARD } from './auth.js';

// Perfis gerenciados: uma linha em `users` sem login (kind = 'managed') que é dona dos dados de outra pessoa,
// cuidados por quem tem login. Nenhuma tabela de dados muda: elas já apontam para um `users.id`.

export interface ProfileRecord {
  id: string;
  kind: 'self' | 'managed';
  name: string;
  currency: string;
  remindersEnabled: boolean;
  /** Só nos perfis gerenciados. */
  createdAt?: string;
}

export const profileForbidden = () => new AppError(403, 'profile_forbidden', 'Você não tem acesso a este perfil.');

/** O ator pode gerenciar os dados desse perfil? Uma consulta pelo índice da chave primária. */
export async function canManage(db: Executor, actorId: string, ownerId: string): Promise<boolean> {
  const [row] = await db
    .select({ ownerId: profileAccess.ownerId })
    .from(profileAccess)
    .where(and(eq(profileAccess.ownerId, ownerId), eq(profileAccess.managerId, actorId)));
  return row !== undefined;
}

export async function countManaged(db: Executor, actorId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(profileAccess).where(eq(profileAccess.managerId, actorId));
  return row?.n ?? 0;
}

const recordColumns = {
  id: users.id,
  kind: users.kind,
  name: profile.name,
  currency: profile.currency,
  remindersEnabled: profile.remindersEnabled,
};

function mapRecord(row: { id: string; kind: string; name: string; currency: string; remindersEnabled: boolean }, createdAt?: Date): ProfileRecord {
  return {
    id: row.id,
    kind: row.kind as ProfileRecord['kind'],
    name: row.name,
    currency: row.currency,
    remindersEnabled: row.remindersEnabled,
    ...(createdAt ? { createdAt: createdAt.toISOString() } : {}),
  };
}

// O perfil do próprio ator primeiro, depois os que ele gerencia, do mais antigo ao mais novo.
export async function listProfiles(db: Executor, actorId: string): Promise<ProfileRecord[]> {
  const [self] = await db
    .select(recordColumns)
    .from(users)
    .innerJoin(profile, eq(profile.userId, users.id))
    .where(eq(users.id, actorId));
  if (!self) throw notFound('Conta não encontrada.');

  const managed = await db
    .select({ ...recordColumns, accessCreatedAt: profileAccess.createdAt })
    .from(profileAccess)
    .innerJoin(users, eq(users.id, profileAccess.ownerId))
    .innerJoin(profile, eq(profile.userId, users.id))
    .where(eq(profileAccess.managerId, actorId))
    .orderBy(asc(profileAccess.createdAt), asc(users.id));
  return [mapRecord(self), ...managed.map((row) => mapRecord(row, row.accessCreatedAt))];
}

async function getManaged(db: Executor, actorId: string, ownerId: string): Promise<ProfileRecord> {
  const [row] = await db
    .select({ ...recordColumns, accessCreatedAt: profileAccess.createdAt })
    .from(profileAccess)
    .innerJoin(users, eq(users.id, profileAccess.ownerId))
    .innerJoin(profile, eq(profile.userId, users.id))
    .where(and(eq(profileAccess.ownerId, ownerId), eq(profileAccess.managerId, actorId)));
  if (!row) throw notFound('Perfil não encontrado.');
  return mapRecord(row, row.accessCreatedAt);
}

export interface CreateProfileInput {
  name: string;
  currency: string;
}

// O usuário sem login, o `profile`, a conta padrão (o app assume pelo menos uma conta, como depois do cadastro) e o
// acesso entram juntos numa transação. Travar a linha do ator serializa as criações dele: duas ao mesmo tempo
// não passam do limite. (NO KEY UPDATE não atrapalha quem só referencia o ator por chave estrangeira.)
export function createManagedProfile(
  db: Db,
  config: Pick<Config, 'MAX_MANAGED_PROFILES'>,
  actorId: string,
  input: CreateProfileInput,
  key?: IdempotencyKey
): Promise<Idempotent<ProfileRecord>> {
  return runIdempotent(db, actorId, 'POST /profiles', key, async (tx) => {
    const [actor] = await tx.select({ id: users.id }).from(users).where(eq(users.id, actorId)).for('no key update');
    if (!actor) throw unauthorized();
    if ((await countManaged(tx, actorId)) >= config.MAX_MANAGED_PROFILES) {
      throw conflict('profile_limit', `Você pode gerenciar até ${config.MAX_MANAGED_PROFILES} perfis.`);
    }

    const [owner] = await tx.insert(users).values({ kind: 'managed' }).returning({ id: users.id });
    await tx.insert(profile).values({ userId: owner!.id, name: input.name, currency: input.currency });
    await tx.insert(cards).values({ userId: owner!.id, ...DEFAULT_CARD });
    await tx.insert(profileAccess).values({ ownerId: owner!.id, managerId: actorId });
    return getManaged(tx, actorId, owner!.id);
  });
}

export async function updateManagedProfile(
  db: Db,
  actorId: string,
  ownerId: string,
  patch: Partial<{ name: string; currency: string; remindersEnabled: boolean }>
): Promise<ProfileRecord> {
  return db.transaction(async (tx) => {
    await getManaged(tx, actorId, ownerId);
    if (Object.keys(patch).length > 0) await tx.update(profile).set(patch).where(eq(profile.userId, ownerId));
    return getManaged(tx, actorId, ownerId);
  });
}

// Apaga o perfil e TUDO dele (as chaves estrangeiras em cascata levam o resto), por isso exige a senha de quem
// gerencia. Um id que não é um perfil dele responde 404 antes de qualquer conferência de senha.
export async function deleteManagedProfile(db: Db, actorId: string, ownerId: string, password: string): Promise<void> {
  await getManaged(db, actorId, ownerId);

  const [actor] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, actorId));
  if (!actor?.passwordHash || !(await verifyPassword(actor.passwordHash, password))) {
    throw unauthorized('Senha incorreta.', 'invalid_credentials');
  }

  const removed = await db
    .delete(users)
    .where(
      and(
        eq(users.id, ownerId),
        eq(users.kind, 'managed'),
        sql`exists (select 1 from ${profileAccess} where ${profileAccess.ownerId} = ${users.id} and ${profileAccess.managerId} = ${actorId})`
      )
    )
    .returning({ id: users.id });
  if (removed.length === 0) throw notFound('Perfil não encontrado.');
}

import { and, eq, lt, sql } from 'drizzle-orm';

import type { Db, Tx } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';
import { badRequest } from './errors.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** O valor do cabeçalho `Idempotency-Key`, como o Fastify o entrega. */
export type IdempotencyKey = string | string[] | undefined;

export interface Idempotent<T> {
  value: T;
  /** True quando a resposta veio da chave guardada, sem gravar de novo. */
  replayed: boolean;
}

// Roda `run` dentro de uma transação SQL. Com `Idempotency-Key`, uma segunda chamada com a mesma chave
// devolve o resultado guardado em vez de gravar outra vez. A chave vale por usuário e por escopo
// (a operação), por 24 horas. Chamadas simultâneas com a mesma chave se serializam no índice único:
// a segunda espera a primeira terminar. Um erro desfaz tudo, inclusive a chave, então pode-se corrigir e repetir.
export async function runIdempotent<T>(
  db: Db,
  userId: string,
  scope: string,
  header: IdempotencyKey,
  run: (tx: Tx) => Promise<T>
): Promise<Idempotent<T>> {
  if (header === undefined) {
    return { value: await db.transaction(run), replayed: false };
  }
  if (typeof header !== 'string' || !KEY_RE.test(header)) {
    throw badRequest('Idempotency-Key inválida: use um UUID ou texto de 8 a 128 caracteres.', 'invalid_idempotency_key');
  }
  const key = `${scope}:${header}`;

  return db.transaction(async (tx) => {
    // Uma chave velha (mais de 24 h) não vale mais.
    await tx
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.key, key),
          lt(idempotencyKeys.createdAt, new Date(Date.now() - TTL_MS))
        )
      );

    const claimed = await tx
      .insert(idempotencyKeys)
      .values({ userId, key })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (claimed.length === 0) {
      const [stored] = await tx
        .select({ response: idempotencyKeys.response })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
      if (stored?.response != null) return { value: stored.response as T, replayed: true };
    }

    const value = await run(tx);
    await tx
      .update(idempotencyKeys)
      .set({ response: value as object })
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    return { value, replayed: false };
  });
}

export async function purgeIdempotencyKeys(db: Db): Promise<void> {
  await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, sql`now() - interval '24 hours'`));
}

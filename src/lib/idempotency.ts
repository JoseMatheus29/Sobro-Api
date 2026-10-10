import { and, eq, lt, sql } from 'drizzle-orm';

import type { Db, Tx } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';
import { badRequest } from './errors.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

export interface Outcome {
  status: number;
  body: unknown;
}

// Roda `run` dentro de uma transação. Com `Idempotency-Key`, uma segunda chamada com a mesma chave
// devolve a resposta guardada em vez de gravar outra vez. A chave vale por usuário e por rota, por 24 horas.
// Chamadas simultâneas com a mesma chave se serializam no índice único: a segunda espera a primeira terminar.
export async function runIdempotent(
  db: Db,
  userId: string,
  scope: string,
  header: string | string[] | undefined,
  run: (tx: Tx) => Promise<Outcome>
): Promise<Outcome & { replayed: boolean }> {
  if (header === undefined) {
    return { ...(await db.transaction(run)), replayed: false };
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
        .select({ statusCode: idempotencyKeys.statusCode, response: idempotencyKeys.response })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
      if (stored?.statusCode != null) {
        return { status: stored.statusCode, body: stored.response, replayed: true };
      }
    }

    const outcome = await run(tx);
    await tx
      .update(idempotencyKeys)
      .set({ statusCode: outcome.status, response: outcome.body as object })
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    return { ...outcome, replayed: false };
  });
}

export async function purgeIdempotencyKeys(db: Db): Promise<void> {
  await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, sql`now() - interval '24 hours'`));
}

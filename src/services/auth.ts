import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import type { Config } from '../config.js';
import type { Db, Executor } from '../db/client.js';
import { cards, passwordResetTokens, profile, refreshTokens, users } from '../db/schema.js';
import { conflict, unauthorized } from '../lib/errors.js';
import type { Mailer } from '../lib/mailer.js';
import { dummyHash, hashPassword, verifyPassword } from '../lib/passwords.js';
import { hashToken, newOpaqueToken, type AccessTokenSigner } from '../lib/tokens.js';

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Segundos até o token de acesso expirar. */
  expiresIn: number;
}

export interface AuthContext {
  db: Db;
  config: Config;
  signer: AccessTokenSigner;
  mailer: Mailer;
}

export const DEFAULT_CARD = { name: 'Conta Principal', number: '0001', color: '#3161B2', lightColor: '#4A74BB' };

const normalizeEmail = (email: string) => email.trim().toLowerCase();

// ---- sessão ----

async function issueRefreshToken(
  db: Executor,
  ctx: AuthContext,
  userId: string,
  familyId: string
): Promise<string> {
  const token = newOpaqueToken();
  await db.insert(refreshTokens).values({
    userId,
    familyId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ctx.config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
  });
  return token;
}

async function sessionFor(db: Executor, ctx: AuthContext, userId: string, familyId: string): Promise<Session> {
  return {
    accessToken: await ctx.signer.sign(userId),
    refreshToken: await issueRefreshToken(db, ctx, userId, familyId),
    expiresIn: ctx.config.ACCESS_TOKEN_TTL_SECONDS,
  };
}

// ---- cadastro e entrada ----

// Cria a conta, o perfil e a conta padrão ("Conta Principal"), o que o seedIfEmpty fazia no app.
export async function register(ctx: AuthContext, input: { email: string; password: string; name?: string }) {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);

  return ctx.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({ email, passwordHash })
      .onConflictDoNothing()
      .returning({ id: users.id });
    const user = inserted[0];
    if (!user) throw conflict('email_taken', 'Já existe uma conta com esse e-mail.');

    await tx.insert(profile).values({ userId: user.id, name: input.name?.trim() ?? '' });
    await tx.insert(cards).values({ userId: user.id, ...DEFAULT_CARD });
    return { userId: user.id, session: await sessionFor(tx, ctx, user.id, crypto.randomUUID()) };
  });
}

export async function login(
  ctx: AuthContext,
  input: { email: string; password: string }
): Promise<{ session: Session; user: { id: string; email: string } }> {
  const [user] = await ctx.db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, normalizeEmail(input.email)));

  // Sem a conta, ainda gasta o tempo de uma verificação: o tempo não revela se o e-mail existe.
  const valid = await verifyPassword(user?.passwordHash ?? (await dummyHash()), input.password);
  // (Só quem tem login tem e-mail e senha: um perfil gerenciado nunca é achado por aqui.)
  if (!user || !user.email || !valid) throw unauthorized('E-mail ou senha incorretos.', 'invalid_credentials');

  return { session: await sessionFor(ctx.db, ctx, user.id, crypto.randomUUID()), user: { id: user.id, email: user.email } };
}

// Renova a sessão. O token de renovação é trocado a cada uso; o recém-trocado continua aceito por uma
// janela curta (resposta perdida, chamadas simultâneas). Um token já trocado fora da janela indica
// roubo: a família inteira é revogada.
export async function refresh(ctx: AuthContext, token: string): Promise<Session> {
  const tokenHash = hashToken(token);
  const outcome = await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).for('update');
    const now = new Date();
    if (!row || row.revokedAt || row.expiresAt <= now) return { ok: false as const, revokeFamily: null };

    if (row.replacedAt) {
      const withinGrace = now.getTime() - row.replacedAt.getTime() <= ctx.config.REFRESH_GRACE_SECONDS * 1000;
      if (!withinGrace) {
        await tx
          .update(refreshTokens)
          .set({ revokedAt: now })
          .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
        // O commit precisa acontecer mesmo respondendo 401, então o erro sai depois da transação.
        return { ok: false as const, revokeFamily: row.familyId };
      }
    } else {
      await tx.update(refreshTokens).set({ replacedAt: now }).where(eq(refreshTokens.id, row.id));
    }
    return { ok: true as const, session: await sessionFor(tx, ctx, row.userId, row.familyId) };
  });

  if (!outcome.ok) throw unauthorized('Sessão expirada. Entre de novo.', 'invalid_refresh_token');
  return outcome.session;
}

// Encerra a sessão deste aparelho: revoga a família do token. Idempotente.
export async function logout(ctx: AuthContext, token: string): Promise<void> {
  const [row] = await ctx.db
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(token)));
  if (!row) return;
  await ctx.db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
}

// ---- recuperação de senha ----

// Sempre termina sem erro, exista a conta ou não (a rota responde 204 nos dois casos).
export async function requestPasswordReset(ctx: AuthContext, emailInput: string): Promise<void> {
  const [user] = await ctx.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, normalizeEmail(emailInput)));
  if (!user?.email) return;

  const token = newOpaqueToken();
  await ctx.db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ctx.config.RESET_TOKEN_TTL_MINUTES * 60 * 1000),
  });
  // O token vai no fragmento (#), que não chega a nenhum servidor nem a log de URL.
  await ctx.mailer.sendPasswordReset(user.email, `${ctx.config.RESET_PASSWORD_URL}#token=${token}`);
}

export async function resetPassword(ctx: AuthContext, token: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  const ok = await ctx.db.transaction(async (tx) => {
    // Uso único: só quem marcar o token como usado primeiro segue adiante.
    const claimed = await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, hashToken(token)),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, sql`now()`)
        )
      )
      .returning({ userId: passwordResetTokens.userId });
    const userId = claimed[0]?.userId;
    if (!userId) return false;

    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
    // Trocar a senha derruba todas as sessões abertas.
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    return true;
  });
  if (!ok) throw unauthorized('O link de redefinição é inválido ou expirou.', 'invalid_reset_token');
}

// ---- conta ----

// Apaga o usuário e tudo dele de verdade (as chaves estrangeiras em cascata levam o resto), inclusive os perfis
// gerenciados que ficariam sem nenhum gerente: dado financeiro de terceiro não pode sobrar sem ninguém com acesso.
export async function deleteAccount(ctx: AuthContext, userId: string, password: string): Promise<void> {
  const [user] = await ctx.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
    throw unauthorized('Senha incorreta.', 'invalid_credentials');
  }
  await ctx.db.transaction(async (tx) => {
    // Trava o usuário: uma criação de perfil dele em andamento espera, e a seguinte já não o encontra.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('no key update');
    // Antes de apagar o usuário: depois disso as linhas de profile_access já teriam sumido por cascata.
    await tx.delete(users).where(
      and(
        eq(users.kind, 'managed'),
        sql`exists (select 1 from profile_access where profile_access.owner_id = users.id and profile_access.manager_id = ${userId})`,
        sql`not exists (select 1 from profile_access where profile_access.owner_id = users.id and profile_access.manager_id <> ${userId})`
      )
    );
    await tx.delete(users).where(eq(users.id, userId));
  });
}


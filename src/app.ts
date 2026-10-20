import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';

import type { Config } from './config.js';
import type { Ctx } from './context.js';
import type { Db } from './db/client.js';
import { AppError, unauthorized, zodFields } from './lib/errors.js';
import type { Mailer } from './lib/mailer.js';
import { createAccessTokenSigner } from './lib/tokens.js';
import { compareVersions } from './lib/version.js';
import { pageRoutes } from './routes/pages.js';
import { registerProtectedRoutes, registerPublicRoutes } from './routes/index.js';

export interface AppDeps {
  db: Db;
  config: Config;
  mailer: Mailer;
  now?: () => Date;
  logger?: FastifyServerOptions['logger'];
}

const API_PREFIX = '/v1';

// Violação (23503) da chave estrangeira `user_id -> users.id`. O Drizzle embrulha o erro do driver em `cause`.
function isMissingUser(error: unknown): boolean {
  for (let current = error as { code?: unknown; constraint?: unknown; cause?: unknown } | undefined, depth = 0; current && depth < 5; depth++) {
    if (current.code === '23503' && typeof current.constraint === 'string' && current.constraint.endsWith('_user_id_users_id_fk')) {
      return true;
    }
    current = current.cause as typeof current;
  }
  return false;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const ctx: Ctx = {
    db: deps.db,
    config,
    mailer: deps.mailer,
    signer: createAccessTokenSigner(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS),
    now: deps.now ?? (() => new Date()),
  };

  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  // CORS para o site (o app nativo não usa). Só as origens de CORS_ORIGINS; sem cookies, a sessão vai no Authorization.
  // O preflight (OPTIONS) é respondido aqui, antes da checagem de versão e de sessão.
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-App-Version', 'Idempotency-Key'],
    exposedHeaders: ['Idempotent-Replayed', 'Retry-After'],
    maxAge: 600,
  });

  // O limite por IP roda depois de o corpo ser lido; o contador por e-mail fica nas rotas de autenticação.
  await app.register(rateLimit, {
    global: false,
    hook: 'preHandler',
    allowList: () => !config.RATE_LIMIT_ENABLED,
    errorResponseBuilder: () => new AppError(429, 'rate_limited', 'Muitas tentativas. Tente de novo em alguns minutos.'),
  });

  // ---- erros num formato único ----
  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) },
      });
    }
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: { code: 'validation_failed', message: 'Dados inválidos.', fields: zodFields(error) } });
    }
    // Token de uma conta já excluída: a gravação bate na chave estrangeira do usuário. É sessão inválida (401), não erro nosso.
    if (isMissingUser(error)) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Sessão inválida ou expirada.' } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = status === 413 ? 'payload_too_large' : status === 429 ? 'rate_limited' : 'bad_request';
      return reply.code(status).send({ error: { code, message: (error as Error).message } });
    }
    // Nada do corpo da requisição vai para o log: só o erro e o id da requisição.
    req.log.error({ err: error }, 'erro inesperado');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Erro interno. Tente de novo.' } });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Rota não encontrada.' } })
  );

  // ---- saúde: sem autenticação e fora de /v1 ----
  // /health só diz que o processo está de pé; /ready testa o banco (é o que o monitoramento usa).
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    try {
      await deps.db.execute(sql`select 1`);
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  // ---- páginas públicas (política de privacidade e exclusão de conta), fora de /v1 ----
  await app.register(pageRoutes);

  // ---- /v1 ----
  await app.register(
    async (v1) => {
      // Versão do app antiga demais: a API pede para atualizar em vez de gravar dado incompleto.
      v1.addHook('onRequest', async (req) => {
        const minimum = config.MIN_APP_VERSION;
        const version = req.headers['x-app-version'];
        if (minimum && typeof version === 'string' && compareVersions(version, minimum) < 0) {
          throw new AppError(426, 'upgrade_required', 'Atualize o app para continuar.');
        }
      });

      registerPublicRoutes(v1, ctx);

      // Tudo daqui para baixo exige sessão. O usuário vem do token, nunca de um campo enviado.
      await v1.register(async (protectedScope) => {
        protectedScope.decorateRequest('userId', '');
        protectedScope.addHook('onRequest', async (req) => {
          const header = req.headers.authorization;
          if (!header?.startsWith('Bearer ')) throw unauthorized();
          try {
            req.userId = await ctx.signer.verify(header.slice(7));
          } catch {
            throw unauthorized();
          }
        });
        registerProtectedRoutes(protectedScope, ctx);
      });
    },
    { prefix: API_PREFIX }
  );

  return app;
}

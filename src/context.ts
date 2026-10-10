import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Mailer } from './lib/mailer.js';
import type { AccessTokenSigner } from './lib/tokens.js';

// Tudo que as rotas precisam, injetado em um lugar só (e trocável nos testes).
export interface Ctx {
  db: Db;
  config: Config;
  signer: AccessTokenSigner;
  mailer: Mailer;
  now: () => Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Id do usuário tirado do token de acesso, nunca de um campo enviado pelo app. */
    userId: string;
  }
}

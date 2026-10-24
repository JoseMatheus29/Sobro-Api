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
    /** Quem fez a requisição: o usuário do token de acesso (sempre quem tem login), nunca um campo enviado pelo app. */
    actorId: string;
    /**
     * De quem são os dados desta requisição. É o mesmo que `actorId`, exceto nas rotas de dados com o cabeçalho
     * `X-Profile-Id` de um perfil gerenciado que o ator pode gerenciar. Os serviços só conhecem este.
     */
    userId: string;
  }
}

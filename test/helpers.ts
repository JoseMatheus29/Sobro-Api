import { TEST_DATABASE_URL } from './db-url.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import type { Mailer } from '../src/lib/mailer.js';

export interface SentMail {
  to: string;
  link: string;
}

export interface TestApp {
  app: FastifyInstance;
  db: DbHandle['db'];
  mails: SentMail[];
  config: Config;
  close: () => Promise<void>;
}

export async function makeApp(options: { env?: Record<string, string>; now?: () => Date } = {}): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_SECRET: 'segredo-de-teste-com-mais-de-trinta-e-dois-caracteres',
    RATE_LIMIT_ENABLED: 'false',
    RESET_PASSWORD_URL: 'https://app.test/redefinir',
    ...options.env,
  });
  const handle = createDb(config.DATABASE_URL, 5);
  const mails: SentMail[] = [];
  const mailer: Mailer = {
    async sendPasswordReset(to, link) {
      mails.push({ to, link });
    },
  };
  const app = await buildApp({ db: handle.db, config, mailer, ...(options.now ? { now: options.now } : {}) });
  await app.ready();
  return {
    app,
    db: handle.db,
    mails,
    config,
    close: async () => {
      await app.close();
      await handle.close();
    },
  };
}

export interface Client {
  token: string;
  refreshToken: string;
  userId: string;
  email: string;
  get: (url: string) => Promise<Res>;
  post: (url: string, body?: unknown, headers?: Record<string, string>) => Promise<Res>;
  patch: (url: string, body?: unknown) => Promise<Res>;
  put: (url: string, body?: unknown) => Promise<Res>;
  del: (url: string, body?: unknown) => Promise<Res>;
}

export interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, unknown>;
}

export const PASSWORD = 'senha-segura-123';

export async function rawRequest(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { body?: unknown; token?: string; headers?: Record<string, string> } = {}
): Promise<Res> {
  const response = await app.inject({
    method,
    url: `/v1${url}`,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
  let body: unknown = undefined;
  if (response.body) {
    try {
      body = JSON.parse(response.body);
    } catch {
      body = response.body;
    }
  }
  return { status: response.statusCode, body, headers: response.headers };
}

export function clientFor(app: FastifyInstance, session: { token: string; refreshToken: string; userId: string; email: string }): Client {
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE') => (url: string, body?: unknown, headers?: Record<string, string>) =>
    rawRequest(app, method, url, { token: session.token, ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) });
  return {
    ...session,
    get: (url) => call('GET')(url),
    post: call('POST'),
    patch: call('PATCH'),
    put: call('PUT'),
    del: call('DELETE'),
  };
}

// Cria uma conta nova (e-mail único por chamada) e devolve um cliente já autenticado.
export async function signup(app: FastifyInstance, name = 'Teste'): Promise<Client> {
  const email = `${randomUUID()}@teste.com`;
  const res = await rawRequest(app, 'POST', '/auth/register', { body: { email, password: PASSWORD, name } });
  if (res.status !== 201) throw new Error(`cadastro falhou: ${res.status} ${JSON.stringify(res.body)}`);
  return clientFor(app, {
    token: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    userId: res.body.user.id,
    email,
  });
}

export const noon = (date: string) => `${date}T12:00:00.000Z`;

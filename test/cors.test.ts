import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { makeApp, type TestApp } from './helpers.js';

const WEB = 'http://localhost:8082';
const OTHER = 'https://evil.example';

describe('CORS_ORIGINS na configuração', () => {
  const base = { DATABASE_URL: 'postgres://x', JWT_SECRET: 'x'.repeat(32) };
  const origins = (value?: string) => loadConfig({ ...base, ...(value !== undefined ? { CORS_ORIGINS: value } : {}) }).CORS_ORIGINS;

  it('sem a variável (ou vazia) nenhuma origem é liberada', () => {
    expect(origins()).toEqual([]);
    expect(origins('')).toEqual([]);
    expect(origins(' , ')).toEqual([]);
  });

  it('aceita várias origens, sem espaços, barra final ou repetição', () => {
    expect(origins(' http://localhost:8082/ , https://app.sobro.com.br,http://localhost:8082')).toEqual([
      'http://localhost:8082',
      'https://app.sobro.com.br',
    ]);
  });

  it.each(['*', 'localhost:8082', 'https://app.com/painel', 'ftp://app.com', 'https://app.com?x=1', 'qualquer coisa'])(
    'recusa "%s": a origem é só esquema, host e porta',
    (value) => {
      expect(() => origins(value)).toThrow(/CORS_ORIGINS/);
    }
  );
});

describe('CORS na API', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ env: { CORS_ORIGINS: `${WEB}, https://app.sobro.com.br`, MIN_APP_VERSION: '2.0.0' } });
  });
  afterAll(() => t.close());

  const preflight = (origin: string, url = '/v1/transactions', headers = 'authorization,content-type,x-app-version,idempotency-key,x-profile-id') =>
    t.app.inject({
      method: 'OPTIONS',
      url,
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': headers },
    });

  it('o preflight da origem liberada passa sem sessão e sem versão do app, com os 5 cabeçalhos', async () => {
    const res = await preflight(WEB);
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    const allowed = String(res.headers['access-control-allow-headers']).toLowerCase().split(/\s*,\s*/);
    expect(allowed.sort()).toEqual(['authorization', 'content-type', 'idempotency-key', 'x-app-version', 'x-profile-id']);
    const methods = String(res.headers['access-control-allow-methods']).split(/\s*,\s*/);
    expect(methods).toEqual(expect.arrayContaining(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']));
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('as duas origens da lista funcionam e cada uma recebe a sua de volta', async () => {
    const res = await preflight('https://app.sobro.com.br');
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.sobro.com.br');
    expect(res.headers.vary).toMatch(/origin/i);
  });

  it('o preflight vale também para rotas públicas e para a raiz da API', async () => {
    for (const url of ['/v1/auth/login', '/v1/auth/refresh', '/v1/me', '/v1/backup']) {
      const res = await preflight(WEB, url);
      expect(res.statusCode, url).toBe(204);
      expect(res.headers['access-control-allow-origin'], url).toBe(WEB);
    }
  });

  it('uma origem fora da lista não recebe permissão nenhuma', async () => {
    const res = await preflight(OTHER);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // Sem Access-Control-Allow-Origin o navegador bloqueia a chamada, mesmo que o plugin liste os cabeçalhos.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('prefixo parecido não conta: a comparação é exata', async () => {
    for (const origin of ['http://localhost:8082.evil.example', 'http://localhost:80820', 'https://localhost:8082', 'http://localhost']) {
      const res = await preflight(origin);
      expect(res.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
  });

  it('a resposta de verdade traz a origem e libera ler Idempotent-Replayed e Retry-After', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/ready', headers: { origin: WEB } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    const exposed = String(res.headers['access-control-expose-headers']).toLowerCase();
    expect(exposed).toContain('idempotent-replayed');
    expect(exposed).toContain('retry-after');
  });

  it('erros também levam o cabeçalho, senão o navegador esconde o 401 e o 426 do site', async () => {
    const unauthorized = await t.app.inject({ method: 'GET', url: '/v1/cards', headers: { origin: WEB } });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['access-control-allow-origin']).toBe(WEB);

    const old = await t.app.inject({ method: 'GET', url: '/v1/cards', headers: { origin: WEB, 'x-app-version': '1.0.0' } });
    expect(old.statusCode).toBe(426);
    expect(old.headers['access-control-allow-origin']).toBe(WEB);

    const missing = await t.app.inject({ method: 'GET', url: '/v1/nao-existe', headers: { origin: WEB } });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['access-control-allow-origin']).toBe(WEB);
  });

  it('a API não usa cookies: nunca anuncia credenciais', async () => {
    const res = await preflight(WEB);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('quem não manda Origin (o app nativo) continua como antes, sem cabeçalhos de CORS', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS sem origens configuradas', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('nenhuma origem é liberada, nem a do Expo web', async () => {
    const res = await t.app.inject({
      method: 'OPTIONS',
      url: '/v1/transactions',
      headers: { origin: WEB, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const get = await t.app.inject({ method: 'GET', url: '/ready', headers: { origin: WEB } });
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
  });
});

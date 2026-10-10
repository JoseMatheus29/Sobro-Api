import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PASSWORD, clientFor, makeApp, rawRequest, signup, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp({ env: { REFRESH_GRACE_SECONDS: '30' } });
});
afterAll(() => t.close());

const register = (email: string, password = PASSWORD) =>
  rawRequest(t.app, 'POST', '/auth/register', { body: { email, password, name: 'Ana' } });

describe('cadastro', () => {
  it('cria conta, perfil e a conta padrão', async () => {
    const email = `${randomUUID()}@teste.com`;
    const res = await register(email.toUpperCase());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ user: { email }, expiresIn: 900 });

    const me = clientFor(t.app, { token: res.body.accessToken, refreshToken: '', userId: res.body.user.id, email });
    expect((await me.get('/me')).body).toMatchObject({ email, name: 'Ana', currency: 'BRL', remindersEnabled: true });
    const cards = (await me.get('/cards')).body;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ name: 'Conta Principal', balance: 0 });
  });

  it('recusa e-mail repetido (sem diferenciar caixa) e senha curta', async () => {
    const email = `${randomUUID()}@teste.com`;
    expect((await register(email)).status).toBe(201);
    const again = await register(email.toUpperCase());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('email_taken');

    const weak = await register(`${randomUUID()}@teste.com`, '123');
    expect(weak.status).toBe(400);
    expect(weak.body.error).toMatchObject({ code: 'validation_failed', fields: [{ path: 'password' }] });
  });
});

describe('login', () => {
  it('entra com a senha certa e recusa a errada com a mesma resposta para conta inexistente', async () => {
    const email = `${randomUUID()}@teste.com`;
    await register(email);

    const ok = await rawRequest(t.app, 'POST', '/auth/login', { body: { email, password: PASSWORD } });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();

    const wrong = await rawRequest(t.app, 'POST', '/auth/login', { body: { email, password: 'errada-errada' } });
    const ghost = await rawRequest(t.app, 'POST', '/auth/login', { body: { email: `${randomUUID()}@teste.com`, password: PASSWORD } });
    expect(wrong.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(wrong.body).toEqual(ghost.body);
  });

  it('rotas protegidas exigem token válido', async () => {
    expect((await rawRequest(t.app, 'GET', '/cards')).status).toBe(401);
    expect((await rawRequest(t.app, 'GET', '/cards', { token: 'lixo' })).status).toBe(401);
  });
});

describe('renovação do token', () => {
  it('troca o token a cada uso e aceita o recém-trocado dentro da janela', async () => {
    const me = await signup(t.app);
    const first = await rawRequest(t.app, 'POST', '/auth/refresh', { body: { refreshToken: me.refreshToken } });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(me.refreshToken);

    // O mesmo token de novo, logo em seguida (resposta perdida): ainda vale.
    const again = await rawRequest(t.app, 'POST', '/auth/refresh', { body: { refreshToken: me.refreshToken } });
    expect(again.status).toBe(200);

    // O novo também segue valendo.
    expect((await rawRequest(t.app, 'POST', '/auth/refresh', { body: { refreshToken: first.body.refreshToken } })).status).toBe(200);
  });

  it('duas renovações simultâneas com o mesmo token funcionam', async () => {
    const me = await signup(t.app);
    const [a, b] = await Promise.all([
      rawRequest(t.app, 'POST', '/auth/refresh', { body: { refreshToken: me.refreshToken } }),
      rawRequest(t.app, 'POST', '/auth/refresh', { body: { refreshToken: me.refreshToken } }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it('token trocado reaparecendo fora da janela revoga a família inteira', async () => {
    const strict = await makeApp({ env: { REFRESH_GRACE_SECONDS: '0' } });
    try {
      const me = await signup(strict.app);
      const rotated = await rawRequest(strict.app, 'POST', '/auth/refresh', { body: { refreshToken: me.refreshToken } });
      expect(rotated.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Reuso do token antigo: parece roubo.
      const reuse = await rawRequest(strict.app, 'POST', '/auth/refresh', { body: { refreshToken: me.refreshToken } });
      expect(reuse.status).toBe(401);
      expect(reuse.body.error.code).toBe('invalid_refresh_token');
      // O token novo da mesma família morreu junto.
      const sibling = await rawRequest(strict.app, 'POST', '/auth/refresh', { body: { refreshToken: rotated.body.refreshToken } });
      expect(sibling.status).toBe(401);
    } finally {
      await strict.close();
    }
  });

  it('logout revoga a sessão deste aparelho', async () => {
    const me = await signup(t.app);
    expect((await rawRequest(t.app, 'POST', '/auth/logout', { body: { refreshToken: me.refreshToken } })).status).toBe(204);
    expect((await rawRequest(t.app, 'POST', '/auth/refresh', { body: { refreshToken: me.refreshToken } })).status).toBe(401);
    // Idempotente.
    expect((await rawRequest(t.app, 'POST', '/auth/logout', { body: { refreshToken: me.refreshToken } })).status).toBe(204);
  });
});

describe('recuperação de senha', () => {
  it('responde 204 exista a conta ou não e só manda e-mail a quem tem conta', async () => {
    const me = await signup(t.app);
    const before = t.mails.length;

    const ghost = await rawRequest(t.app, 'POST', '/auth/forgot-password', { body: { email: `${randomUUID()}@teste.com` } });
    expect(ghost.status).toBe(204);
    expect(t.mails.length).toBe(before);

    const real = await rawRequest(t.app, 'POST', '/auth/forgot-password', { body: { email: me.email } });
    expect(real.status).toBe(204);
    expect(t.mails.at(-1)).toMatchObject({ to: me.email });
    // O token vai no fragmento da URL, que nenhum servidor recebe.
    expect(t.mails.at(-1)!.link).toMatch(/^https:\/\/app\.test\/redefinir#token=.+/);
  });

  it('redefine a senha uma única vez e derruba as sessões abertas', async () => {
    const me = await signup(t.app);
    await rawRequest(t.app, 'POST', '/auth/forgot-password', { body: { email: me.email } });
    const token = t.mails.at(-1)!.link.split('#token=')[1];

    const reset = await rawRequest(t.app, 'POST', '/auth/reset-password', { body: { token, password: 'nova-senha-456' } });
    expect(reset.status).toBe(204);

    const reuse = await rawRequest(t.app, 'POST', '/auth/reset-password', { body: { token, password: 'outra-senha-789' } });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('invalid_reset_token');

    expect((await rawRequest(t.app, 'POST', '/auth/login', { body: { email: me.email, password: PASSWORD } })).status).toBe(401);
    expect((await rawRequest(t.app, 'POST', '/auth/login', { body: { email: me.email, password: 'nova-senha-456' } })).status).toBe(200);
    expect((await rawRequest(t.app, 'POST', '/auth/refresh', { body: { refreshToken: me.refreshToken } })).status).toBe(401);
  });

  it('recusa token inventado', async () => {
    const res = await rawRequest(t.app, 'POST', '/auth/reset-password', { body: { token: 'x'.repeat(40), password: 'nova-senha-456' } });
    expect(res.status).toBe(401);
  });
});

describe('perfil e exclusão da conta', () => {
  it('altera o perfil', async () => {
    const me = await signup(t.app);
    const res = await me.patch('/me', { name: 'Maria', currency: 'usd', remindersEnabled: false });
    expect(res.body).toMatchObject({ name: 'Maria', currency: 'USD', remindersEnabled: false });
    expect((await me.patch('/me', { currency: 'REAL' })).status).toBe(400);
  });

  it('exclui a conta e tudo dela, exigindo a senha', async () => {
    const me = await signup(t.app);
    await me.post('/transactions', { cardId: (await me.get('/cards')).body[0].id, categoryId: 'food', name: 'Pão', amount: 5, type: 'expense', occurredAt: '2026-10-01T12:00:00.000Z' });

    expect((await me.del('/me', { password: 'errada-errada' })).status).toBe(401);
    expect((await me.del('/me', { password: PASSWORD })).status).toBe(204);

    expect((await rawRequest(t.app, 'POST', '/auth/login', { body: { email: me.email, password: PASSWORD } })).status).toBe(401);
    // O token ainda é válido por alguns minutos, mas não há mais dados a mostrar.
    expect((await me.get('/cards')).body).toEqual([]);
    expect((await me.get('/transactions')).body.items).toEqual([]);
  });

  it('gravar com o token de uma conta já excluída dá 401, não 500', async () => {
    const me = await signup(t.app);
    expect((await me.del('/me', { password: PASSWORD })).status).toBe(204);

    const created = await me.post('/cards', { name: 'Fantasma', color: '#000000', lightColor: '#111111' });
    expect(created.status).toBe(401);
    expect(created.body.error.code).toBe('unauthorized');
    expect((await me.put('/budgets/monthly/2026-10', { amount: 1 })).status).toBe(401);
  });
});

describe('versão do app e erros', () => {
  it('pede para atualizar quando a versão é antiga demais', async () => {
    const gated = await makeApp({ env: { MIN_APP_VERSION: '2.0.0' } });
    try {
      const old = await rawRequest(gated.app, 'POST', '/auth/login', { body: { email: 'a@b.com', password: 'x' }, headers: { 'x-app-version': '1.9.0' } });
      expect(old.status).toBe(426);
      expect(old.body.error.code).toBe('upgrade_required');
      const current = await rawRequest(gated.app, 'POST', '/auth/login', { body: { email: 'a@b.com', password: 'x' }, headers: { 'x-app-version': '2.0.0' } });
      expect(current.status).toBe(401);
    } finally {
      await gated.close();
    }
  });

  it('usa um formato único de erro para rota inexistente e JSON quebrado', async () => {
    expect((await rawRequest(t.app, 'GET', '/nao-existe')).body.error.code).toBe('not_found');
    const broken = await t.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{ruim' });
    expect(broken.statusCode).toBe(400);
    expect(JSON.parse(broken.body).error.code).toBe('bad_request');
  });

  it('/health não toca no banco e /ready testa o banco', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
  });

  it('limita tentativas de login por e-mail', async () => {
    const limited = await makeApp({ env: { RATE_LIMIT_ENABLED: 'true' } });
    try {
      const email = `${randomUUID()}@teste.com`;
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push((await rawRequest(limited.app, 'POST', '/auth/login', { body: { email, password: 'errada-errada' } })).status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
    } finally {
      await limited.close();
    }
  });
});

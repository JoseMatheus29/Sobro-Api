import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PASSWORD, makeApp, noon, rawRequest, signup, type Client, type Res, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  // "Hoje" fixo: 10/10/2026.
  t = await makeApp({ now: () => new Date('2026-10-10T15:00:00.000Z') });
});
afterAll(() => t.close());

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

// Uma chamada do ator, opcionalmente em nome de um perfil (X-Profile-Id).
function call(c: Client, method: Method, url: string, o: { body?: unknown; profile?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return rawRequest(t.app, method, url, {
    token: c.token,
    ...(o.body !== undefined ? { body: o.body } : {}),
    headers: { ...(o.profile ? { 'x-profile-id': o.profile } : {}), ...o.headers },
  });
}

async function newProfile(c: Client, name = 'Mãe', extra: Record<string, unknown> = {}): Promise<string> {
  const res = await c.post('/profiles', { name, ...extra });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const mainCard = async (c: Client, profile?: string) => (await call(c, 'GET', '/cards', profile ? { profile } : {})).body[0].id as number;

// Tabelas com dados de uma pessoa, para conferir que nada sobra depois de excluir.
const DATA_TABLES = ['cards', 'transactions', 'recurrences', 'categories', 'goals', 'goal_entries', 'monthly_budgets', 'category_budgets', 'idempotency_keys', 'profile'];

async function rowsOf(userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of DATA_TABLES) {
    const res = await t.db.execute(sql.raw(`select count(*)::int as n from ${table} where user_id = '${userId}'`));
    out[table] = (res.rows[0] as { n: number }).n;
  }
  const user = await t.db.execute(sql.raw(`select count(*)::int as n from users where id = '${userId}'`));
  out.users = (user.rows[0] as { n: number }).n;
  const access = await t.db.execute(sql.raw(`select count(*)::int as n from profile_access where owner_id = '${userId}' or manager_id = '${userId}'`));
  out.profile_access = (access.rows[0] as { n: number }).n;
  return out;
}

const total = (rows: Record<string, number>) => Object.values(rows).reduce((a, b) => a + b, 0);

// Preenche um perfil com um pouco de tudo, para provar o isolamento e a exclusão em cascata.
async function populate(c: Client, profile?: string) {
  const card = await mainCard(c, profile);
  const opts = (body?: unknown, headers?: Record<string, string>) => ({ ...(profile ? { profile } : {}), ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) });
  const category = await call(c, 'POST', '/categories', opts({ name: 'Pets', icon: 'paw', color: '#112233', bg: 'rgba(17,34,51,0.12)' }));
  expect(category.status).toBe(201);
  const tx = await call(
    c,
    'POST',
    '/transactions',
    opts({ cardId: card, categoryId: category.body.id, name: 'Ração', amount: 80, type: 'expense', occurredAt: noon('2026-10-05') }, { 'idempotency-key': randomUUID() })
  );
  expect(tx.status).toBe(201);
  const goal = await call(c, 'POST', '/goals', opts({ name: 'Viagem', targetAmount: 1000, color: '#abcdef', icon: 'plane' }));
  expect(goal.status).toBe(201);
  expect((await call(c, 'POST', `/goals/${goal.body.id}/entries`, opts({ amount: 50 }))).status).toBe(201);
  expect((await call(c, 'PUT', '/budgets/monthly/2026-10', opts({ amount: 500 }))).status).toBe(200);
  expect((await call(c, 'PUT', `/budgets/categories/${category.body.id}/2026-10`, opts({ amount: 100 }))).status).toBe(200);
  expect((await call(c, 'POST', '/transactions', opts({ cardId: card, categoryId: 'food', name: 'Plano', amount: 30, type: 'expense', occurredAt: noon('2026-09-05'), repeat: { mode: 'monthly' } }))).status).toBe(201);
  return { card, categoryId: category.body.id as string, transactionId: tx.body.id as number, goalId: goal.body.id as number };
}

describe('criar e listar perfis', () => {
  it('cria o usuário sem login, o profile, a conta padrão e o acesso, juntos', async () => {
    const me = await signup(t.app);
    const res = await me.post('/profiles', { name: '  Mãe  ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'managed', name: 'Mãe', currency: 'BRL', remindersEnabled: true });
    expect(res.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const id = res.body.id as string;
    const user = (await t.db.execute(sql`select email, password_hash, kind from users where id = ${id}::uuid`)).rows[0] as Record<string, unknown>;
    expect(user).toEqual({ email: null, password_hash: null, kind: 'managed' });
    const access = (await t.db.execute(sql`select manager_id, role from profile_access where owner_id = ${id}::uuid`)).rows;
    expect(access).toEqual([{ manager_id: me.userId, role: 'manager' }]);

    // Nasce com a conta padrão, como depois de um cadastro: o app assume pelo menos uma conta.
    const cards = (await call(me, 'GET', '/cards', { profile: id })).body as { name: string }[];
    expect(cards.map((c) => c.name)).toEqual(['Conta Principal']);
  });

  it('valida o nome e a moeda; a moeda sobe para maiúsculas e o padrão é BRL', async () => {
    const me = await signup(t.app);
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(61) }, { name: 'Ok', currency: 'BR' }, { name: 'Ok', currency: 'REAIS' }]) {
      const res = await me.post('/profiles', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
    expect((await me.post('/profiles', { name: 'x'.repeat(60) })).status).toBe(201);
    expect((await me.post('/profiles', { name: 'Tio', currency: 'usd' })).body.currency).toBe('USD');
  });

  it('lista o próprio perfil primeiro e os gerenciados do mais antigo ao mais novo', async () => {
    const me = await signup(t.app, 'Matheus');
    const a = await newProfile(me, 'Mãe');
    const b = await newProfile(me, 'Pai');
    const list = (await me.get('/profiles')).body as { id: string; kind: string; name: string; createdAt?: string }[];
    expect(list.map((p) => [p.kind, p.name])).toEqual([['self', 'Matheus'], ['managed', 'Mãe'], ['managed', 'Pai']]);
    expect(list[0]!.id).toBe(me.userId);
    expect(list.slice(1).map((p) => p.id)).toEqual([a, b]);
    expect(list[0]).not.toHaveProperty('createdAt');
  });

  it('cada pessoa vê só os perfis que gerencia', async () => {
    const owner = await signup(t.app);
    const stranger = await signup(t.app);
    await newProfile(owner);
    expect(((await stranger.get('/profiles')).body as unknown[]).length).toBe(1);
  });

  it('GET /me traz quantos perfis gerenciados a conta tem', async () => {
    const me = await signup(t.app);
    expect((await me.get('/me')).body.managedProfiles).toBe(0);
    await newProfile(me);
    await newProfile(me, 'Pai');
    expect((await me.get('/me')).body.managedProfiles).toBe(2);
  });

  it('exige sessão', async () => {
    expect((await rawRequest(t.app, 'GET', '/profiles')).status).toBe(401);
    expect((await rawRequest(t.app, 'POST', '/profiles', { body: { name: 'x' } })).status).toBe(401);
  });
});

describe('limite de perfis', () => {
  it('o 6º perfil responde 409 profile_limit (limite padrão: 5)', async () => {
    const me = await signup(t.app);
    for (let i = 1; i <= 5; i++) await newProfile(me, `P${i}`);
    const res = await me.post('/profiles', { name: 'P6' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('profile_limit');
    expect(((await me.get('/profiles')).body as unknown[]).length).toBe(6);
  });

  it('o limite é configurável (MAX_MANAGED_PROFILES)', async () => {
    const small = await makeApp({ env: { MAX_MANAGED_PROFILES: '1' } });
    try {
      const me = await signup(small.app);
      expect((await me.post('/profiles', { name: 'Um' })).status).toBe(201);
      expect((await me.post('/profiles', { name: 'Dois' })).body.error.code).toBe('profile_limit');
    } finally {
      await small.close();
    }
  });

  it('criações simultâneas não passam do limite', async () => {
    const me = await signup(t.app);
    const results = await Promise.all(Array.from({ length: 9 }, (_, i) => me.post('/profiles', { name: `P${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(((await me.get('/profiles')).body as unknown[]).length).toBe(6);
  });

  it('o limite é por conta', async () => {
    const full = await signup(t.app);
    for (let i = 0; i < 5; i++) await newProfile(full);
    const other = await signup(t.app);
    expect((await other.post('/profiles', { name: 'Livre' })).status).toBe(201);
  });
});

describe('editar um perfil', () => {
  it('muda nome, moeda e lembretes de um perfil gerenciado', async () => {
    const me = await signup(t.app);
    const id = await newProfile(me);
    const res = await me.patch(`/profiles/${id}`, { name: 'Dona Maria', currency: 'eur', remindersEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, kind: 'managed', name: 'Dona Maria', currency: 'EUR', remindersEnabled: false });
    expect((await me.patch(`/profiles/${id}`, {})).body.name).toBe('Dona Maria');
    // O perfil do próprio ator não muda por aqui.
    expect((await me.get('/me')).body.name).not.toBe('Dona Maria');
  });

  it('valida os campos', async () => {
    const me = await signup(t.app);
    const id = await newProfile(me);
    for (const body of [{ name: '' }, { name: 'x'.repeat(61) }, { currency: 'BR' }, { remindersEnabled: 'sim' }]) {
      expect((await me.patch(`/profiles/${id}`, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('404 para um perfil de outra pessoa, para um que não existe e para o próprio perfil do ator', async () => {
    const me = await signup(t.app);
    const stranger = await signup(t.app);
    const theirs = await newProfile(stranger);
    for (const id of [theirs, randomUUID(), me.userId]) {
      const res = await me.patch(`/profiles/${id}`, { name: 'Invasor' });
      expect(res.status, id).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
    expect((await stranger.get('/profiles')).body[1].name).toBe('Mãe');
    // Id que não é UUID.
    expect((await me.patch('/profiles/123', { name: 'x' })).status).toBe(400);
  });
});

describe('X-Profile-Id nas rotas de dados', () => {
  it('grava e lê no perfil escolhido; sem o cabeçalho, nada dele aparece', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    const mine = await populate(me);
    const hers = await populate(me, mom);
    expect(hers.transactionId).not.toBe(mine.transactionId);

    const names = async (profile?: string) => ((await call(me, 'GET', '/transactions?limit=50', profile ? { profile } : {})).body.items as { cardId: number }[]).map((i) => i.cardId);
    expect(new Set(await names())).toEqual(new Set([mine.card]));
    expect(new Set(await names(mom))).toEqual(new Set([hers.card]));

    // Cada perfil tem os seus ids em tudo; mudar um orçamento num perfil não aparece no outro.
    const idsOf = async (path: string, profile?: string) =>
      ((await call(me, 'GET', path, profile ? { profile } : {})).body as { id: number }[]).map((x) => x.id);
    for (const path of ['/cards', '/goals', '/recurrences']) {
      const own = await idsOf(path);
      const managed = await idsOf(path, mom);
      expect(own.length, path).toBeGreaterThan(0);
      expect(managed.length, path).toBeGreaterThan(0);
      expect(own.filter((id) => managed.includes(id)), path).toEqual([]);
    }
    expect((await call(me, 'PUT', '/budgets/monthly/2026-10', { profile: mom, body: { amount: 777 } })).status).toBe(200);
    expect((await me.get('/budgets/monthly')).body).toEqual([{ month: '2026-10', amount: 500 }]);
    expect((await call(me, 'GET', '/budgets/monthly', { profile: mom })).body).toEqual([{ month: '2026-10', amount: 777 }]);
    const customOf = async (profile?: string) =>
      ((await call(me, 'GET', '/categories', profile ? { profile } : {})).body as { custom?: boolean; id: string }[]).filter((c) => c.custom).map((c) => c.id);
    expect(await customOf()).toEqual([mine.categoryId]);
    expect(await customOf(mom)).toEqual([hers.categoryId]);
  });

  it('uma categoria própria de um perfil não serve em outro', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    const mine = await populate(me);
    const res = await call(me, 'POST', '/transactions', {
      profile: mom,
      body: { cardId: await mainCard(me, mom), categoryId: mine.categoryId, name: 'x', amount: 1, type: 'expense', occurredAt: noon('2026-10-05') },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('uma conta de um perfil não serve em outro (o cartão é do dono dos dados)', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    const res = await call(me, 'POST', '/transactions', {
      body: { cardId: await mainCard(me, mom), categoryId: 'food', name: 'x', amount: 1, type: 'expense', occurredAt: noon('2026-10-05') },
    });
    expect(res.status).toBe(404);
    const reverse = await call(me, 'POST', '/transactions', {
      profile: mom,
      body: { cardId: await mainCard(me), categoryId: 'food', name: 'x', amount: 1, type: 'expense', occurredAt: noon('2026-10-05') },
    });
    expect(reverse.status).toBe(404);
  });

  it('relatórios e saldos do perfil escolhido não misturam com os do ator', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    await populate(me);
    await populate(me, mom);
    await me.post('/transactions', { cardId: await mainCard(me), categoryId: 'salary', name: 'Salário', amount: 1000, type: 'income', occurredAt: noon('2026-10-06') });
    // No perfil dela: Ração (80) e o plano (30) em outubro, e o plano de setembro (30). O salário é só do ator.
    expect((await call(me, 'GET', '/reports/monthly-totals', { profile: mom })).body).toEqual([
      { month: '2026-10', income: 0, expense: 110 },
      { month: '2026-09', income: 0, expense: 30 },
    ]);
    expect((await me.get('/reports/monthly-totals')).body[0]).toEqual({ month: '2026-10', income: 1000, expense: 110 });
    const cards = (await call(me, 'GET', '/cards', { profile: mom })).body as { balance: number }[];
    expect(cards[0]!.balance).toBe(-140);
    expect((await me.get('/cards')).body[0].balance).toBe(860);
  });

  it('as recorrências são geradas para o dono escolhido', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    await populate(me, mom);
    // O plano mensal do dia 5 já gerou setembro e outubro no perfil dela, e só nele.
    const hers = (await call(me, 'GET', '/transactions?limit=50', { profile: mom })).body.items as { name: string }[];
    expect(hers.filter((i) => i.name === 'Plano')).toHaveLength(2);
    expect((await me.get('/transactions?limit=50')).body.items).toEqual([]);
  });

  it('o backup exporta o perfil escolhido, e restaurar nele não toca nos dados do ator', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    await populate(me);
    await populate(me, mom);

    const hers = (await call(me, 'GET', '/backup', { profile: mom })).body;
    expect(hers.schemaVersion).toBe(9);
    expect(hers.data.transactions.every((x: { name: string }) => ['Ração', 'Plano'].includes(x.name))).toBe(true);

    const mineBefore = (await me.get('/backup')).body;
    // Restaura um arquivo exportado de OUTRA conta no perfil dela.
    const other = await signup(t.app);
    await call(other, 'POST', '/transactions', {
      body: { cardId: await mainCard(other), categoryId: 'food', name: 'Do arquivo', amount: 12, type: 'expense', occurredAt: noon('2026-10-02') },
    });
    const file = (await other.get('/backup')).body;
    expect((await call(me, 'PUT', '/backup', { profile: mom, body: file })).status).toBe(204);

    const herAfter = (await call(me, 'GET', '/transactions?limit=50', { profile: mom })).body.items as { name: string }[];
    expect(herAfter.map((i) => i.name)).toEqual(['Do arquivo']);
    const mineAfter = (await me.get('/backup')).body;
    expect(mineAfter.data.transactions.map((x: { name: string; amount: number }) => [x.name, x.amount])).toEqual(
      mineBefore.data.transactions.map((x: { name: string; amount: number }) => [x.name, x.amount])
    );
    expect(mineAfter.data.goals).toHaveLength(mineBefore.data.goals.length);
  });

  it('o cabeçalho com o id do próprio ator, em maiúsculas ou não, vale como sem cabeçalho', async () => {
    const me = await signup(t.app);
    await populate(me);
    const plain = (await me.get('/cards')).body;
    expect((await call(me, 'GET', '/cards', { profile: me.userId })).body).toEqual(plain);
    expect((await call(me, 'GET', '/cards', { profile: me.userId.toUpperCase() })).body).toEqual(plain);
  });

  it('o id do perfil em maiúsculas funciona', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    const res = await call(me, 'GET', '/cards', { profile: mom.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('X-Profile-Id recusado', () => {
  async function setup() {
    const me = await signup(t.app);
    const stranger = await signup(t.app);
    const theirs = await newProfile(stranger);
    return { me, stranger, theirs };
  }

  it('perfil de outra pessoa, id que não existe e perfil excluído: 403 com o mesmo corpo', async () => {
    const { me, theirs } = await setup();
    const gone = await newProfile(me, 'Excluído');
    expect((await me.del(`/profiles/${gone}`, { password: PASSWORD })).status).toBe(204);

    const bodies = [];
    for (const profile of [theirs, randomUUID(), gone]) {
      const res = await call(me, 'GET', '/cards', { profile });
      expect(res.status, profile).toBe(403);
      expect(res.body.error.code).toBe('profile_forbidden');
      bodies.push(JSON.stringify(res.body));
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('um valor que não é UUID, vazio ou repetido: 400', async () => {
    const me = await signup(t.app);
    for (const value of ['123', 'mae', '', ' ', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz']) {
      const res = await rawRequest(t.app, 'GET', '/cards', { token: me.token, headers: { 'x-profile-id': value } });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
    const twice = await t.app.inject({
      method: 'GET',
      url: '/v1/cards',
      headers: { authorization: `Bearer ${me.token}`, 'x-profile-id': [me.userId, randomUUID()] as unknown as string },
    });
    expect(twice.statusCode).toBe(400);
  });

  it('sem sessão a resposta é 401, nunca 403', async () => {
    const { theirs } = await setup();
    const res = await rawRequest(t.app, 'GET', '/cards', { headers: { 'x-profile-id': theirs } });
    expect(res.status).toBe(401);
  });

  it('a recusa vem antes de qualquer serviço rodar: nada é gravado', async () => {
    const { me, stranger, theirs } = await setup();
    const before = total(await rowsOf(theirs));
    const res = await call(me, 'POST', '/transactions', {
      profile: theirs,
      body: { cardId: await mainCard(stranger), categoryId: 'food', name: 'Invasão', amount: 1, type: 'expense', occurredAt: noon('2026-10-05') },
    });
    expect(res.status).toBe(403);
    expect(total(await rowsOf(theirs))).toBe(before);
    expect((await call(me, 'PUT', '/backup', { profile: theirs, body: {} })).status).toBe(403);
  });
});

// Monta a lista de rotas a partir da árvore que o Fastify imprime.
function routesOf(app: FastifyInstance): { method: Method; path: string }[] {
  const out: { method: Method; path: string }[] = [];
  const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^([│ ]*)[├└]── (\S+) \(([^)]*)\)$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack[depth] = m[2]!;
    const path = stack.join('').replace(/\/+/g, '/');
    for (const method of m[3]!.split(', ')) if (method !== 'HEAD' && method !== 'OPTIONS') out.push({ method: method as Method, path });
  }
  return out;
}

describe('todas as rotas de dados respeitam o cabeçalho', () => {
  const concrete = (path: string) => path.replace(':categoryId', 'food').replace(':month', '2026-10').replace(':entryId', '1').replace(':id', '1');
  const isAccountOrPublic = (path: string) => !path.startsWith('/v1/') || path.startsWith('/v1/auth/') || path === '/v1/me' || path.startsWith('/v1/profiles');

  it('a lista de rotas foi lida (e tem as que importam)', () => {
    const data = routesOf(t.app).filter((r) => !isAccountOrPublic(r.path));
    const keys = data.map((r) => `${r.method} ${r.path}`);
    expect(data.length).toBeGreaterThanOrEqual(30);
    for (const expected of ['GET /v1/cards', 'POST /v1/transactions', 'PUT /v1/backup', 'DELETE /v1/goals/:id/entries/:entryId', 'PUT /v1/budgets/categories/:categoryId/:month', 'POST /v1/transfers']) {
      expect(keys, expected).toContain(expected);
    }
  });

  it('um perfil sem acesso é recusado (403) em TODAS as rotas de dados, antes do serviço', async () => {
    const me = await signup(t.app);
    const stranger = await signup(t.app);
    const theirs = await newProfile(stranger);
    const data = routesOf(t.app).filter((r) => !isAccountOrPublic(r.path));
    for (const route of data) {
      const res = await rawRequest(t.app, route.method, concrete(route.path).replace(/^\/v1/, ''), {
        token: me.token,
        headers: { 'x-profile-id': theirs },
        ...(route.method === 'GET' ? {} : { body: {} }),
      });
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  it('com acesso, o serviço roda no perfil escolhido (nunca 403) em todas elas', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    const data = routesOf(t.app).filter((r) => !isAccountOrPublic(r.path));
    for (const route of data) {
      const res = await rawRequest(t.app, route.method, concrete(route.path).replace(/^\/v1/, ''), {
        token: me.token,
        headers: { 'x-profile-id': mom },
        ...(route.method === 'GET' ? {} : { body: {} }),
      });
      expect([401, 403], `${route.method} ${route.path}`).not.toContain(res.status);
    }
  });

  it('as rotas de conta ignoram o cabeçalho, mesmo inválido ou de outra pessoa', async () => {
    const me = await signup(t.app);
    const stranger = await signup(t.app);
    const theirs = await newProfile(stranger);
    const mom = await newProfile(me);
    for (const profile of [theirs, mom, 'lixo']) {
      const res = await call(me, 'GET', '/me', { profile });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(me.userId);
      const list = await call(me, 'GET', '/profiles', { profile });
      expect(list.status).toBe(200);
      expect(list.body[0].id).toBe(me.userId);
    }
    // PATCH /me com o cabeçalho de um perfil muda o ator, não o perfil.
    expect((await call(me, 'PATCH', '/me', { profile: mom, body: { name: 'Eu mesmo' } })).body.name).toBe('Eu mesmo');
    expect((await me.get('/profiles')).body[1].name).toBe('Mãe');
    // E /auth/* não muda.
    expect((await rawRequest(t.app, 'POST', '/auth/login', { body: { email: me.email, password: PASSWORD }, headers: { 'x-profile-id': mom } })).status).toBe(200);
  });
});

describe('idempotência por dono dos dados', () => {
  const tx = (card: number) => ({ cardId: card, categoryId: 'food', name: 'Almoço', amount: 20, type: 'expense', occurredAt: noon('2026-10-05') });

  it('a mesma chave em dois perfis cria duas coisas, uma em cada', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    const key = { 'idempotency-key': randomUUID() };
    const mine = await call(me, 'POST', '/transactions', { body: tx(await mainCard(me)), headers: key });
    const hers = await call(me, 'POST', '/transactions', { profile: mom, body: tx(await mainCard(me, mom)), headers: key });
    expect([mine.status, hers.status]).toEqual([201, 201]);
    expect(mine.body.id).not.toBe(hers.body.id);
    expect(mine.headers['idempotent-replayed']).toBeUndefined();
    expect(hers.headers['idempotent-replayed']).toBeUndefined();
  });

  it('repetida no mesmo perfil, devolve a primeira com Idempotent-Replayed', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    const key = { 'idempotency-key': randomUUID() };
    const first = await call(me, 'POST', '/transactions', { profile: mom, body: tx(await mainCard(me, mom)), headers: key });
    const again = await call(me, 'POST', '/transactions', { profile: mom, body: tx(await mainCard(me, mom)), headers: key });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect((await call(me, 'GET', '/transactions', { profile: mom })).body.items).toHaveLength(1);
  });

  it('POST /profiles também aceita Idempotency-Key', async () => {
    const me = await signup(t.app);
    const key = { 'idempotency-key': randomUUID() };
    const first = await me.post('/profiles', { name: 'Mãe' }, key);
    const again = await me.post('/profiles', { name: 'Mãe' }, key);
    expect(again.body.id).toBe(first.body.id);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(((await me.get('/profiles')).body as unknown[]).length).toBe(2);
  });
});

describe('excluir um perfil', () => {
  it('com a senha certa apaga o perfil e todos os dados dele, e nada do ator', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    await populate(me);
    await populate(me, mom);
    const mineBefore = await rowsOf(me.userId);
    const hers = await rowsOf(mom);
    // Garante que o teste olha para dados de verdade em cada tabela.
    for (const table of [...DATA_TABLES, 'users', 'profile_access']) expect(hers[table], table).toBeGreaterThan(0);

    const res = await me.del(`/profiles/${mom}`, { password: PASSWORD });
    expect(res.status).toBe(204);

    const after = await rowsOf(mom);
    for (const [table, n] of Object.entries(after)) expect(n, table).toBe(0);
    const mineAfter = await rowsOf(me.userId);
    expect({ ...mineAfter, profile_access: 0 }).toEqual({ ...mineBefore, profile_access: 0 });
    expect(((await me.get('/profiles')).body as unknown[]).length).toBe(1);
    expect((await call(me, 'GET', '/cards', { profile: mom })).status).toBe(403);
  });

  it('senha errada: 401 e nada some; e o contador trava depois de muitas tentativas', async () => {
    const limited = await makeApp({ env: { RATE_LIMIT_ENABLED: 'true' } });
    try {
      const me = await signup(limited.app);
      const mom = (await me.post('/profiles', { name: 'Mãe' })).body.id as string;
      const before = await rowsOf(mom);
      for (let i = 0; i < 5; i++) {
        const res = await me.del(`/profiles/${mom}`, { password: 'senha-errada-123' });
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('invalid_credentials');
      }
      expect(await rowsOf(mom)).toEqual(before);
      // Depois de 5 erros, nem a senha certa é aceita por um tempo.
      expect((await me.del(`/profiles/${mom}`, { password: PASSWORD })).status).toBe(429);
      expect(await rowsOf(mom)).toEqual(before);
    } finally {
      await limited.close();
    }
  });

  it('um perfil que não é seu responde 404, antes de conferir a senha, e nada some', async () => {
    const me = await signup(t.app);
    const stranger = await signup(t.app);
    const theirs = await newProfile(stranger);
    await populate(stranger, theirs);
    const before = await rowsOf(theirs);
    for (const password of [PASSWORD, 'errada-errada']) {
      for (const id of [theirs, randomUUID(), me.userId]) {
        const res = await me.del(`/profiles/${id}`, { password });
        expect(res.status, id).toBe(404);
      }
    }
    expect(await rowsOf(theirs)).toEqual(before);
    expect((await me.get('/me')).status).toBe(200);
  });

  it('exige a senha e um id válido', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    expect((await me.del(`/profiles/${mom}`, {})).status).toBe(400);
    expect((await me.del('/profiles/abc', { password: PASSWORD })).status).toBe(400);
    expect(((await me.get('/profiles')).body as unknown[]).length).toBe(2);
  });
});

describe('excluir a conta de quem gerencia', () => {
  it('apaga o ator e os perfis dele, e não toca nos perfis de outra pessoa', async () => {
    const me = await signup(t.app);
    const stranger = await signup(t.app);
    const a = await newProfile(me, 'Mãe');
    const b = await newProfile(me, 'Pai');
    const theirs = await newProfile(stranger, 'Avó');
    await populate(me, a);
    await populate(stranger, theirs);
    const theirsBefore = await rowsOf(theirs);
    const strangerBefore = await rowsOf(stranger.userId);

    const res = await me.del('/me', { password: PASSWORD });
    expect(res.status).toBe(204);

    for (const id of [me.userId, a, b]) for (const [table, n] of Object.entries(await rowsOf(id))) expect(n, `${id} ${table}`).toBe(0);
    expect(await rowsOf(theirs)).toEqual(theirsBefore);
    expect(await rowsOf(stranger.userId)).toEqual(strangerBefore);
    expect((await rawRequest(t.app, 'POST', '/auth/login', { body: { email: me.email, password: PASSWORD } })).status).toBe(401);
  });

  it('um perfil que ainda tem outro gerente continua existindo', async () => {
    const me = await signup(t.app);
    const partner = await signup(t.app);
    const shared = await newProfile(me, 'Casa');
    const alone = await newProfile(me, 'Só meu');
    // Ainda não há rota para adicionar um segundo gerente: o acesso entra direto no banco.
    await t.db.execute(sql`insert into profile_access (owner_id, manager_id) values (${shared}::uuid, ${partner.userId}::uuid)`);

    expect((await me.del('/me', { password: PASSWORD })).status).toBe(204);
    expect((await rowsOf(shared)).users).toBe(1);
    expect((await rowsOf(alone)).users).toBe(0);
    expect((await partner.get('/profiles')).body.map((p: { name: string }) => p.name)).toEqual([expect.any(String), 'Casa']);
  });

  it('senha errada: 401 e nada some', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    expect((await me.del('/me', { password: 'errada-errada' })).status).toBe(401);
    expect((await rowsOf(mom)).users).toBe(1);
    expect((await me.get('/me')).status).toBe(200);
  });

  it('o cabeçalho não muda quem é excluído: DELETE /me apaga o ator', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    expect((await call(me, 'DELETE', '/me', { profile: mom, body: { password: PASSWORD } })).status).toBe(204);
    expect((await rowsOf(me.userId)).users).toBe(0);
  });

  it('excluir a conta espera uma criação de perfil em andamento e leva o perfil novo junto', async () => {
    const me = await signup(t.app);
    let ownerId = '';
    let finished = false;
    let request: Promise<Res> = Promise.resolve({ status: 0, body: null, headers: {} });
    await t.db.transaction(async (tx) => {
      // Como o POST /profiles no meio da criação: a linha do ator travada e o perfil novo ainda sem commit.
      await tx.execute(sql`select 1 from users where id = ${me.userId}::uuid for no key update`);
      const created = await tx.execute(sql`insert into users (kind) values ('managed') returning id`);
      ownerId = (created.rows[0] as { id: string }).id;
      await tx.execute(sql`insert into profile_access (owner_id, manager_id) values (${ownerId}::uuid, ${me.userId}::uuid)`);
      request = me.del('/me', { password: PASSWORD }).then((res) => {
        finished = true;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished).toBe(false);
    });
    expect((await request).status).toBe(204);
    expect((await rowsOf(ownerId)).users).toBe(0);
  });

  it('excluir a conta durante a criação de um perfil não deixa um perfil sem gerente', async () => {
    // Só olha o que este teste criou (o banco de teste guarda o de execuções anteriores).
    const startedAt = new Date(Date.now() - 1000).toISOString();
    for (let round = 0; round < 5; round++) {
      const me = await signup(t.app);
      await Promise.all([me.del('/me', { password: PASSWORD }), me.post('/profiles', { name: 'Corrida' })]);
      const orphans = await t.db.execute(
        sql`select count(*)::int as n from users u where u.kind = 'managed' and u.created_at >= ${startedAt}::timestamptz and not exists (select 1 from profile_access a where a.owner_id = u.id)`
      );
      expect((orphans.rows[0] as { n: number }).n).toBe(0);
    }
  });
});

describe('quem tem login e quem não tem', () => {
  it('o banco recusa um registro misto, e o perfil gerenciado não tem como entrar', async () => {
    const insert = (email: string | null, hash: string | null, kind: string) =>
      t.db.execute(sql`insert into users (email, password_hash, kind) values (${email}, ${hash}, ${kind})`);
    // self sem e-mail, self sem senha, managed com e-mail, managed com senha, kind desconhecido.
    await expect(insert(null, 'x', 'self')).rejects.toThrow();
    await expect(insert(`${randomUUID()}@x.com`, null, 'self')).rejects.toThrow();
    await expect(insert(`${randomUUID()}@x.com`, null, 'managed')).rejects.toThrow();
    await expect(insert(null, 'hash', 'managed')).rejects.toThrow();
    await expect(insert(null, null, 'robot')).rejects.toThrow();
  });

  it('vários perfis gerenciados convivem (e-mail nulo não conflita) e o e-mail continua único entre quem tem login', async () => {
    const me = await signup(t.app);
    await newProfile(me, 'Um');
    await newProfile(me, 'Dois');
    const dup = await rawRequest(t.app, 'POST', '/auth/register', { body: { email: me.email, password: PASSWORD } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('email_taken');
  });

  it('o acesso não pode ser a si mesmo nem ter um papel desconhecido', async () => {
    const me = await signup(t.app);
    const mom = await newProfile(me);
    await expect(t.db.execute(sql`insert into profile_access (owner_id, manager_id) values (${me.userId}::uuid, ${me.userId}::uuid)`)).rejects.toThrow();
    await expect(t.db.execute(sql`update profile_access set role = 'viewer' where owner_id = ${mom}::uuid`)).rejects.toThrow();
  });

  it('login e recuperação de senha nunca acham um perfil gerenciado', async () => {
    const me = await signup(t.app);
    await newProfile(me);
    t.mails.length = 0;
    expect((await rawRequest(t.app, 'POST', '/auth/login', { body: { email: 'perfil@gerenciado.com', password: PASSWORD } })).status).toBe(401);
    expect((await rawRequest(t.app, 'POST', '/auth/forgot-password', { body: { email: 'perfil@gerenciado.com' } })).status).toBe(204);
    expect(t.mails).toHaveLength(0);
  });

  it('quem já existia segue como self e entra normalmente', async () => {
    const me = await signup(t.app);
    const user = (await t.db.execute(sql`select kind from users where id = ${me.userId}::uuid`)).rows[0] as { kind: string };
    expect(user.kind).toBe('self');
    expect((await rawRequest(t.app, 'POST', '/auth/login', { body: { email: me.email, password: PASSWORD } })).status).toBe(200);
  });
});

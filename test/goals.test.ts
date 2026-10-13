import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { goalEntries, goals } from '../src/db/schema.js';
import { PASSWORD, makeApp, noon, signup, type Client, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  // "Hoje" fixo: 10/10/2026. O teto de prazo é 2036-10 (120 meses à frente).
  t = await makeApp({ now: () => new Date('2026-10-10T15:00:00.000Z') });
});
afterAll(() => t.close());

const goalBody = (extra: Record<string, unknown> = {}) => ({
  name: 'Viagem',
  targetAmount: 1000,
  targetMonth: '2027-06',
  color: '#3161B2',
  icon: 'flight',
  ...extra,
});

async function newGoal(c: Client, extra: Record<string, unknown> = {}) {
  const res = await c.post('/goals', goalBody(extra));
  expect(res.status).toBe(201);
  return res.body as { id: number; saved: number };
}

const entry = (c: Client, goalId: number, amount: number, extra: Record<string, unknown> = {}) =>
  c.post(`/goals/${goalId}/entries`, { amount, ...extra });

const saved = async (c: Client, goalId: number) => (await c.get(`/goals/${goalId}`)).body.saved as number;

describe('caixinhas', () => {
  it('cria, edita e lista com o valor guardado somando depósitos e retiradas', async () => {
    const me = await signup(t.app);
    const first = await me.post('/goals', goalBody());
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: expect.any(Number), name: 'Viagem', targetAmount: 1000, targetMonth: '2027-06', color: '#3161B2', icon: 'flight', saved: 0 });
    const second = await newGoal(me, { name: 'Notebook', targetMonth: null });

    await entry(me, first.body.id, 300);
    await entry(me, first.body.id, 200.5);
    await entry(me, first.body.id, -100);
    await entry(me, second.id, 50);

    const list = (await me.get('/goals')).body;
    expect(list.map((g: { name: string; saved: number }) => [g.name, g.saved])).toEqual([['Viagem', 400.5], ['Notebook', 50]]);
    expect(list[1].targetMonth).toBeNull();

    const edited = await me.patch(`/goals/${first.body.id}`, { name: 'Viagem a Paris', targetAmount: 5000.456, targetMonth: null });
    expect(edited.body).toMatchObject({ name: 'Viagem a Paris', targetAmount: 5000.46, targetMonth: null, saved: 400.5, color: '#3161B2' });
    // Um PATCH sem campos não muda nada.
    expect((await me.patch(`/goals/${first.body.id}`, {})).body.name).toBe('Viagem a Paris');
  });

  it('lista o histórico do mais novo ao mais antigo, guardando o instante como veio', async () => {
    const me = await signup(t.app);
    const goal = await newGoal(me);
    await entry(me, goal.id, 10, { occurredAt: '2026-10-01T01:00:00.000Z' });
    await entry(me, goal.id, 20, { occurredAt: '2026-10-05T12:00:00.000Z' });
    await entry(me, goal.id, 30, { occurredAt: '2026-10-05T12:00:00.000Z' });

    const history = (await me.get(`/goals/${goal.id}/entries`)).body;
    expect(history.map((e: { amount: number }) => e.amount)).toEqual([30, 20, 10]);
    expect(history[2]).toEqual({ id: expect.any(Number), goalId: goal.id, amount: 10, occurredAt: '2026-10-01T01:00:00.000Z' });
  });

  it('sem occurredAt usa o instante de agora', async () => {
    const me = await signup(t.app);
    const goal = await newGoal(me);
    const res = await entry(me, goal.id, 10);
    expect(res.body.occurredAt).toBe('2026-10-10T15:00:00.000Z');
  });
});

describe('retiradas e saldo', () => {
  it('retirar mais do que há dá 409 goal_insufficient e não grava nada', async () => {
    const me = await signup(t.app);
    const goal = await newGoal(me);
    await entry(me, goal.id, 80);

    const res = await entry(me, goal.id, -80.01);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('goal_insufficient');
    expect(res.body.error.message).toContain('80,00');
    expect(await saved(me, goal.id)).toBe(80);
    expect((await me.get(`/goals/${goal.id}/entries`)).body).toHaveLength(1);

    // Retirar exatamente o que há é permitido.
    expect((await entry(me, goal.id, -80)).status).toBe(201);
    expect(await saved(me, goal.id)).toBe(0);
    // E com a caixinha vazia, qualquer retirada é recusada.
    expect((await entry(me, goal.id, -0.01)).status).toBe(409);
  });

  it('duas retiradas simultâneas que juntas passam do saldo: só uma vale', async () => {
    const me = await signup(t.app);
    const goal = await newGoal(me);
    await entry(me, goal.id, 100);

    const results = await Promise.all([entry(me, goal.id, -70), entry(me, goal.id, -70)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await saved(me, goal.id)).toBe(30);
  });

  it('várias retiradas simultâneas nunca deixam o saldo negativo', async () => {
    const me = await signup(t.app);
    const goal = await newGoal(me);
    await entry(me, goal.id, 100);

    const results = await Promise.all(Array.from({ length: 6 }, () => entry(me, goal.id, -30)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await saved(me, goal.id)).toBe(10);
  });

  it('apagar um depósito que deixaria o saldo negativo dá 409; apagar uma retirada só devolve dinheiro', async () => {
    const me = await signup(t.app);
    const goal = await newGoal(me);
    const deposit = (await entry(me, goal.id, 100)).body;
    const withdrawal = (await entry(me, goal.id, -60)).body;

    const refused = await me.del(`/goals/${goal.id}/entries/${deposit.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('goal_insufficient');
    expect(await saved(me, goal.id)).toBe(40);

    expect((await me.del(`/goals/${goal.id}/entries/${withdrawal.id}`)).status).toBe(204);
    expect(await saved(me, goal.id)).toBe(100);
    // Agora o depósito pode ir.
    expect((await me.del(`/goals/${goal.id}/entries/${deposit.id}`)).status).toBe(204);
    expect(await saved(me, goal.id)).toBe(0);
    expect((await me.del(`/goals/${goal.id}/entries/${deposit.id}`)).status).toBe(404);
  });
});

describe('o dinheiro continua nas contas', () => {
  it('guardar, retirar e apagar a caixinha não mudam saldo de conta, relatórios nem transações', async () => {
    const me = await signup(t.app);
    const card = (await me.get('/cards')).body[0].id;
    await me.post('/transactions', { cardId: card, categoryId: 'salary', name: 'Salário', amount: 2000, type: 'income', occurredAt: noon('2026-10-02') });
    await me.post('/transactions', { cardId: card, categoryId: 'food', name: 'Mercado', amount: 150, type: 'expense', occurredAt: noon('2026-10-03') });

    const snapshot = async () => ({
      cards: (await me.get('/cards')).body,
      monthly: (await me.get('/reports/monthly-totals')).body,
      byCategory: (await me.get('/reports/category-totals?month=2026-10')).body,
      transactions: (await me.get('/transactions')).body,
    });
    const before = await snapshot();
    expect(before.cards[0].balance).toBe(1850);

    const goal = await newGoal(me);
    await entry(me, goal.id, 500);
    await entry(me, goal.id, -100);
    expect(await snapshot()).toEqual(before);

    expect((await me.del(`/goals/${goal.id}`)).status).toBe(204);
    expect(await snapshot()).toEqual(before);
  });

  it('excluir a caixinha leva o histórico', async () => {
    const me = await signup(t.app);
    const goal = await newGoal(me);
    await entry(me, goal.id, 10);
    await entry(me, goal.id, 20);

    expect((await me.del(`/goals/${goal.id}`)).status).toBe(204);
    expect((await me.get(`/goals/${goal.id}`)).status).toBe(404);
    expect((await me.get(`/goals/${goal.id}/entries`)).status).toBe(404);
    expect((await me.get('/goals')).body).toEqual([]);
    expect(await t.db.select().from(goalEntries).where(eq(goalEntries.goalId, goal.id))).toEqual([]);
    expect((await me.del(`/goals/${goal.id}`)).status).toBe(404);
  });

  it('excluir a conta do usuário leva as caixinhas e as movimentações', async () => {
    const me = await signup(t.app);
    const goal = await newGoal(me);
    await entry(me, goal.id, 10);

    expect((await me.del('/me', { password: PASSWORD })).status).toBe(204);
    expect(await t.db.select().from(goals).where(eq(goals.userId, me.userId))).toEqual([]);
    expect(await t.db.select().from(goalEntries).where(eq(goalEntries.userId, me.userId))).toEqual([]);
  });
});

describe('idempotência', () => {
  it('POST /goals com a mesma chave não duplica e devolve o cabeçalho', async () => {
    const me = await signup(t.app);
    const key = randomUUID();
    const first = await me.post('/goals', goalBody(), { 'idempotency-key': key });
    const again = await me.post('/goals', goalBody(), { 'idempotency-key': key });

    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect((await me.get('/goals')).body).toHaveLength(1);
  });

  it('POST /goals/:id/entries com a mesma chave guarda uma vez só', async () => {
    const me = await signup(t.app);
    const goal = await newGoal(me);
    const key = randomUUID();

    await entry(me, goal.id, 100);
    const first = await me.post(`/goals/${goal.id}/entries`, { amount: 40 }, { 'idempotency-key': key });
    const again = await me.post(`/goals/${goal.id}/entries`, { amount: 40 }, { 'idempotency-key': key });
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await saved(me, goal.id)).toBe(140);
    expect((await me.get(`/goals/${goal.id}/entries`)).body).toHaveLength(2);
  });

  it('chamadas simultâneas com a mesma chave guardam uma só vez', async () => {
    const me = await signup(t.app);
    const goal = await newGoal(me);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => me.post(`/goals/${goal.id}/entries`, { amount: 25 }, { 'idempotency-key': key })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await saved(me, goal.id)).toBe(25);
  });

  it('uma retirada recusada não deixa a chave guardada', async () => {
    const me = await signup(t.app);
    const goal = await newGoal(me);
    const key = randomUUID();
    expect((await me.post(`/goals/${goal.id}/entries`, { amount: -10 }, { 'idempotency-key': key })).status).toBe(409);
    await entry(me, goal.id, 50);
    expect((await me.post(`/goals/${goal.id}/entries`, { amount: -10 }, { 'idempotency-key': key })).status).toBe(201);
  });
});

describe('validações', () => {
  it('nome: obrigatório e até 30 caracteres', async () => {
    const me = await signup(t.app);
    expect((await me.post('/goals', goalBody({ name: 'x'.repeat(30) }))).status).toBe(201);
    const long = await me.post('/goals', goalBody({ name: 'x'.repeat(31) }));
    expect(long.status).toBe(400);
    expect(long.body.error.fields[0].path).toBe('name');
    expect((await me.post('/goals', goalBody({ name: '   ' }))).status).toBe(400);
  });

  it('valor da meta, cor e ícone', async () => {
    const me = await signup(t.app);
    expect((await me.post('/goals', goalBody({ targetAmount: 0 }))).status).toBe(400);
    expect((await me.post('/goals', goalBody({ targetAmount: -5 }))).status).toBe(400);
    expect((await me.post('/goals', goalBody({ color: 'azul' }))).status).toBe(400);
    expect((await me.post('/goals', goalBody({ icon: '' }))).status).toBe(400);
  });

  it('prazo: formato AAAA-MM, passado aceito e no máximo 120 meses à frente', async () => {
    const me = await signup(t.app);
    expect((await me.post('/goals', goalBody({ targetMonth: '2020-01' }))).status).toBe(201);
    expect((await me.post('/goals', goalBody({ targetMonth: '2036-10' }))).status).toBe(201);

    const far = await me.post('/goals', goalBody({ targetMonth: '2036-11' }));
    expect(far.status).toBe(400);
    expect(far.body.error.fields[0].path).toBe('targetMonth');
    for (const bad of ['out/2026', '2026-13', '2026-1', '202610']) {
      expect((await me.post('/goals', goalBody({ targetMonth: bad }))).status).toBe(400);
    }

    const goal = await newGoal(me);
    expect((await me.patch(`/goals/${goal.id}`, { targetMonth: '2036-11' })).status).toBe(400);
    expect((await me.patch(`/goals/${goal.id}`, { targetMonth: '2036-10' })).status).toBe(200);
  });

  it('movimentação: valor diferente de zero e dentro do limite, data ISO', async () => {
    const me = await signup(t.app);
    const goal = await newGoal(me);
    expect((await entry(me, goal.id, 0)).status).toBe(400);
    expect((await entry(me, goal.id, 0.001)).status).toBe(400);
    expect((await entry(me, goal.id, 1e12)).status).toBe(400);
    expect((await me.post(`/goals/${goal.id}/entries`, { amount: '10' })).status).toBe(400);
    expect((await me.post(`/goals/${goal.id}/entries`, {})).status).toBe(400);
    expect((await entry(me, goal.id, 10, { occurredAt: 'ontem' })).status).toBe(400);
  });

  it('id inválido ou inexistente', async () => {
    const me = await signup(t.app);
    expect((await me.get('/goals/abc')).status).toBe(400);
    expect((await me.get('/goals/999999999')).status).toBe(404);
    expect((await entry(me, 999999999, 10)).status).toBe(404);
  });
});

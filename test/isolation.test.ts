import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeApp, noon, signup, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let alice: Client;
let bob: Client;
let aliceCard: number;
let aliceTx: number;
let aliceRecurrence: number;
let aliceGoal: number;
let aliceEntry: number;

beforeAll(async () => {
  t = await makeApp({ now: () => new Date('2026-10-10T15:00:00.000Z') });
  alice = await signup(t.app, 'Alice');
  bob = await signup(t.app, 'Bob');
  aliceCard = (await alice.get('/cards')).body[0].id;
  aliceTx = (
    await alice.post('/transactions', {
      cardId: aliceCard,
      categoryId: 'food',
      name: 'Segredo da Alice',
      amount: 77,
      type: 'expense',
      occurredAt: noon('2026-10-03'),
      repeat: { mode: 'monthly' },
    })
  ).body.id;
  aliceRecurrence = (await alice.get('/recurrences')).body[0].id;
  await alice.put('/budgets/monthly/2026-10', { amount: 1000 });
  aliceGoal = (await alice.post('/goals', { name: 'Viagem da Alice', targetAmount: 900, targetMonth: null, color: '#3161B2', icon: 'flight' })).body.id;
  aliceEntry = (await alice.post(`/goals/${aliceGoal}/entries`, { amount: 250 })).body.id;
});
afterAll(() => t.close());

// Os ids são sequenciais: a regra de que o id de outra pessoa responde 404 (nunca os dados) precisa de teste.
describe('um usuário não alcança os dados de outro', () => {
  it('contas', async () => {
    expect((await bob.get(`/cards/${aliceCard}`)).status).toBe(404);
    expect((await bob.patch(`/cards/${aliceCard}`, { name: 'Invadida' })).status).toBe(404);
    expect((await bob.get(`/cards/${aliceCard}/usage`)).status).toBe(404);
    expect((await bob.del(`/cards/${aliceCard}`)).status).toBe(404);
    expect((await alice.get(`/cards/${aliceCard}`)).body.name).toBe('Conta Principal');
  });

  it('transações', async () => {
    expect((await bob.get(`/transactions/${aliceTx}`)).status).toBe(404);
    expect((await bob.patch(`/transactions/${aliceTx}`, { amount: 1 })).status).toBe(404);
    expect((await bob.del(`/transactions/${aliceTx}`)).status).toBe(404);
    expect((await alice.get(`/transactions/${aliceTx}`)).body.amount).toBe(-77);
  });

  it('recorrências', async () => {
    expect((await bob.get(`/recurrences/${aliceRecurrence}`)).status).toBe(404);
    expect((await bob.post(`/recurrences/${aliceRecurrence}/end`)).status).toBe(404);
    expect((await alice.get(`/recurrences/${aliceRecurrence}`)).body.endMonth).toBeNull();
  });

  it('as listagens do outro vêm só com os dados dele', async () => {
    expect((await bob.get('/transactions')).body.items).toEqual([]);
    expect((await bob.get('/transactions?q=Segredo')).body.items).toEqual([]);
    expect((await bob.get('/recurrences')).body).toEqual([]);
    expect((await bob.get('/budgets/monthly')).body).toEqual([]);
    expect((await bob.get('/reports/monthly-totals')).body).toEqual([]);
    expect((await bob.get('/reports/category-totals?month=2026-10')).body).toEqual([]);
    const cards = (await bob.get('/cards')).body;
    expect(cards).toHaveLength(1);
    expect(cards[0].id).not.toBe(aliceCard);
  });

  it('caixinhas e movimentações', async () => {
    expect((await bob.get(`/goals/${aliceGoal}`)).status).toBe(404);
    expect((await bob.patch(`/goals/${aliceGoal}`, { name: 'Invadida' })).status).toBe(404);
    expect((await bob.del(`/goals/${aliceGoal}`)).status).toBe(404);
    expect((await bob.get(`/goals/${aliceGoal}/entries`)).status).toBe(404);
    expect((await bob.post(`/goals/${aliceGoal}/entries`, { amount: 10 })).status).toBe(404);
    expect((await bob.post(`/goals/${aliceGoal}/entries`, { amount: -10 })).status).toBe(404);
    expect((await bob.del(`/goals/${aliceGoal}/entries/${aliceEntry}`)).status).toBe(404);

    // Nada mudou para a Alice, e a listagem do Bob não traz a caixinha dela.
    expect((await alice.get(`/goals/${aliceGoal}`)).body).toMatchObject({ name: 'Viagem da Alice', saved: 250 });
    expect((await alice.get(`/goals/${aliceGoal}/entries`)).body).toHaveLength(1);
    expect((await bob.get('/goals')).body).toEqual([]);
  });

  it('o Bob não apaga a movimentação da Alice pela caixinha dele', async () => {
    const bobGoal = (await bob.post('/goals', { name: 'Do Bob', targetAmount: 100, color: '#000000', icon: 'savings' })).body.id;
    expect((await bob.del(`/goals/${bobGoal}/entries/${aliceEntry}`)).status).toBe(404);
    expect((await alice.get(`/goals/${aliceGoal}`)).body.saved).toBe(250);
    expect((await bob.del(`/goals/${bobGoal}`)).status).toBe(204);
  });

  it('não lança em conta alheia nem transfere de/para ela', async () => {
    const bobCard = (await bob.get('/cards')).body[0].id;
    const base = { categoryId: 'food', name: 'x', amount: 1, type: 'expense', occurredAt: noon('2026-10-03') };
    expect((await bob.post('/transactions', { ...base, cardId: aliceCard })).status).toBe(404);
    expect((await bob.post('/transfers', { fromCardId: bobCard, toCardId: aliceCard, amount: 1, occurredAt: noon('2026-10-03') })).status).toBe(404);
    expect((await bob.patch(`/transactions/${aliceTx}`, { cardId: bobCard })).status).toBe(404);

    // Mover a própria transação para a conta da Alice também é recusado.
    const own = (await bob.post('/transactions', { ...base, cardId: bobCard })).body.id;
    expect((await bob.patch(`/transactions/${own}`, { cardId: aliceCard })).status).toBe(404);
  });

  it('o usuário vem do token, nunca de um campo do corpo', async () => {
    const bobCard = (await bob.get('/cards')).body[0].id;
    const res = await bob.post('/transactions', {
      userId: alice.userId,
      cardId: bobCard,
      categoryId: 'food',
      name: 'Do Bob',
      amount: 1,
      type: 'expense',
      occurredAt: noon('2026-10-03'),
    });
    expect(res.status).toBe(201);
    expect((await alice.get('/transactions?q=Do Bob')).body.items).toEqual([]);
    expect((await bob.get('/transactions?q=Do Bob')).body.items).toHaveLength(1);
  });

  it('o backup de um não traz nem substitui os dados do outro', async () => {
    const bobBackup = (await bob.get('/backup')).body;
    expect(JSON.stringify(bobBackup)).not.toContain('Segredo da Alice');
    expect(JSON.stringify(bobBackup)).not.toContain('Viagem da Alice');
    expect(bobBackup.data.goal_entries).toEqual([]);

    expect((await bob.put('/backup', bobBackup)).status).toBe(204);
    expect((await alice.get(`/transactions/${aliceTx}`)).status).toBe(200);
    // Restaurar o backup do Bob (sem caixinhas) não apaga a caixinha da Alice.
    expect((await alice.get(`/goals/${aliceGoal}`)).body.saved).toBe(250);
  });

  it('a Alice continua com tudo', async () => {
    expect((await alice.get('/transactions?limit=50')).body.items.length).toBeGreaterThanOrEqual(1);
    expect((await alice.get('/budgets/monthly')).body).toEqual([{ month: '2026-10', amount: 1000 }]);
  });
});

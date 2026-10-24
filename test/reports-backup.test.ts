import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeApp, noon, signup, type Client, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp({ now: () => new Date('2026-10-10T15:00:00.000Z') });
});
afterAll(() => t.close());

const card = async (c: Client) => (await c.get('/cards')).body[0].id as number;
const tx = (cardId: number, extra: Record<string, unknown>) => ({
  cardId,
  categoryId: 'food',
  name: 'x',
  amount: 10,
  type: 'expense',
  occurredAt: noon('2026-10-05'),
  ...extra,
});

describe('relatórios', () => {
  it('totais por mês, do mais novo ao mais antigo, sem transferências', async () => {
    const me = await signup(t.app);
    const a = await card(me);
    await me.post('/transactions', tx(a, { amount: 100, occurredAt: noon('2026-10-02') }));
    await me.post('/transactions', tx(a, { amount: 50, occurredAt: noon('2026-10-03'), categoryId: 'health' }));
    await me.post('/transactions', tx(a, { amount: 300, type: 'income', categoryId: 'salary', occurredAt: noon('2026-10-04') }));
    await me.post('/transactions', tx(a, { amount: 20, occurredAt: noon('2026-09-15') }));
    const b = (await me.post('/cards', { name: 'B', color: '#000000', lightColor: '#111111' })).body;
    await me.post('/transfers', { fromCardId: a, toCardId: b.id, amount: 999, occurredAt: noon('2026-10-06') });

    expect((await me.get('/reports/monthly-totals')).body).toEqual([
      { month: '2026-10', income: 300, expense: 150 },
      { month: '2026-09', income: 0, expense: 20 },
    ]);

    const byCategory = (await me.get('/reports/category-totals?month=2026-10')).body;
    expect(byCategory.map((c: { categoryId: string; total: number }) => [c.categoryId, c.total])).toEqual([
      ['food', 100],
      ['health', 50],
    ]);
    expect(byCategory[0]).toMatchObject({ categoryName: 'Alimentação', icon: 'restaurant', color: '#E67E22' });
    expect((await me.get('/reports/category-totals')).status).toBe(400);
  });
});

describe('orçamentos', () => {
  it('guardam o valor a partir de um mês, e nulo tira o orçamento', async () => {
    const me = await signup(t.app);
    expect((await me.put('/budgets/monthly/2026-10', { amount: 2000 })).body).toEqual({ month: '2026-10', amount: 2000 });
    await me.put('/budgets/monthly/2026-12', { amount: null });
    await me.put('/budgets/monthly/2026-10', { amount: 2500.5 });
    expect((await me.get('/budgets/monthly')).body).toEqual([
      { month: '2026-10', amount: 2500.5 },
      { month: '2026-12', amount: null },
    ]);
    expect((await me.put('/budgets/monthly/outubro', { amount: 1 })).status).toBe(400);
    expect((await me.put('/budgets/monthly/2026-10', { amount: -1 })).status).toBe(400);
  });

  it('limites por categoria', async () => {
    const me = await signup(t.app);
    await me.put('/budgets/categories/food/2026-10', { amount: 400 });
    await me.put('/budgets/categories/health/2026-10', { amount: 100 });
    await me.put('/budgets/categories/food/2026-11', { amount: null });
    expect((await me.get('/budgets/categories')).body).toEqual([
      { categoryId: 'food', month: '2026-10', amount: 400 },
      { categoryId: 'health', month: '2026-10', amount: 100 },
      { categoryId: 'food', month: '2026-11', amount: null },
    ]);
    expect((await me.put('/budgets/categories/inexistente/2026-10', { amount: 1 })).status).toBe(400);
  });

  it('lista as categorias do catálogo', async () => {
    const me = await signup(t.app);
    const categories = (await me.get('/categories')).body;
    expect(categories.map((c: { id: string }) => c.id).sort()).toEqual(
      ['food', 'health', 'invest', 'invoice', 'leisure', 'other', 'salary', 'shopping', 'transfer', 'transport']
    );
  });
});

describe('backup', () => {
  async function populate(me: Client) {
    const a = await card(me);
    const b = (await me.post('/cards', { name: 'Poupança', number: '9', color: '#000000', lightColor: '#111111', startingBalance: 50 })).body;
    await me.patch('/me', { name: 'Ana', currency: 'BRL', remindersEnabled: false });
    await me.post('/transactions', tx(a, { name: 'Mercado', amount: 80.5, description: 'semana' }));
    await me.post('/transactions', tx(a, { name: 'Plano', amount: 100, occurredAt: noon('2026-08-05'), repeat: { mode: 'installments', total: 6, current: 1 } }));
    await me.post('/transfers', { fromCardId: a, toCardId: b.id, amount: 25, occurredAt: noon('2026-10-06') });
    await me.put('/budgets/monthly/2026-10', { amount: 3000 });
    await me.put('/budgets/categories/food/2026-10', { amount: 500 });
    const goal = (await me.post('/goals', { name: 'Viagem', targetAmount: 1000, targetMonth: '2027-06', color: '#3161B2', icon: 'flight' })).body;
    await me.post(`/goals/${goal.id}/entries`, { amount: 300, occurredAt: '2026-10-02T14:30:00.000Z' });
    await me.post(`/goals/${goal.id}/entries`, { amount: -50, occurredAt: '2026-10-04T09:15:00.000Z' });
    const pets = (await me.post('/categories', { name: 'Pets', icon: 'pets', color: '#E67E22', bg: 'rgba(230,126,34,0.12)' })).body;
    await me.post('/transactions', tx(a, { name: 'Ração', amount: 35, categoryId: pets.id }));
    await me.put(`/budgets/categories/${pets.id}/2026-10`, { amount: 200 });
    return { a, b, goal, pets };
  }

  it('exporta no formato do app e o importa de volta refazendo os ids, com o mesmo resultado', async () => {
    const me = await signup(t.app);
    await populate(me);
    const exported = (await me.get('/backup')).body;

    expect(exported).toMatchObject({ app: 'sobro', format: 1, schemaVersion: 9 });
    expect(Object.keys(exported.data).sort()).toEqual(
      ['cards', 'categories', 'category_budgets', 'goal_entries', 'goals', 'monthly_budgets', 'profile', 'recurrences', 'transactions']
    );
    expect(exported.data.profile).toEqual([
      { id: 1, name: 'Ana', currency: 'BRL', avatar_uri: null, monthly_budget: null, reminders_enabled: 0, theme: 'system' },
    ]);
    expect(exported.data.goals).toEqual([
      { id: expect.any(Number), name: 'Viagem', target_amount: 1000, target_month: '2027-06', color: '#3161B2', icon: 'flight' },
    ]);
    expect(exported.data.goal_entries.map((e: { amount: number; occurred_at: string }) => [e.amount, e.occurred_at])).toEqual([
      [300, '2026-10-02T14:30:00.000Z'],
      [-50, '2026-10-04T09:15:00.000Z'],
    ]);
    const legs = exported.data.transactions.filter((x: { transfer_id: number | null }) => x.transfer_id !== null);
    expect(legs).toHaveLength(2);

    const before = {
      cards: (await me.get('/cards')).body.map((c: { name: string; balance: number }) => [c.name, c.balance]),
      totals: (await me.get('/reports/monthly-totals')).body,
      count: (await me.get('/transactions?limit=100')).body.items.length,
      goals: (await me.get('/goals')).body.map((g: { name: string; saved: number }) => [g.name, g.saved]),
    };

    expect((await me.put('/backup', exported)).status).toBe(204);

    const cardsAfter = (await me.get('/cards')).body;
    expect(cardsAfter.map((c: { name: string; balance: number }) => [c.name, c.balance])).toEqual(before.cards);
    expect((await me.get('/reports/monthly-totals')).body).toEqual(before.totals);
    expect((await me.get('/transactions?limit=100')).body.items).toHaveLength(before.count);
    expect((await me.get('/budgets/monthly')).body).toEqual([{ month: '2026-10', amount: 3000 }]);
    expect((await me.get('/me')).body).toMatchObject({ name: 'Ana', remindersEnabled: false });

    // Os ids foram refeitos, e a transferência continua com as duas pernas apontando para a primeira.
    const items = (await me.get('/transactions?limit=100')).body.items;
    const transferLegs = items.filter((x: { transferId: number | null }) => x.transferId !== null);
    expect(transferLegs).toHaveLength(2);
    expect(transferLegs[0].transferId).toBe(transferLegs[1].transferId);
    expect(transferLegs.map((x: { id: number }) => x.id)).toContain(transferLegs[0].transferId);
    expect(cardsAfter.every((c: { id: number }) => !exported.data.cards.some((o: { id: number }) => o.id === c.id))).toBe(true);
    // A caixinha volta com o mesmo valor guardado, ids novos e o histórico nos mesmos instantes.
    const goalsAfter = (await me.get('/goals')).body;
    expect(goalsAfter.map((g: { name: string; saved: number }) => [g.name, g.saved])).toEqual(before.goals);
    expect(goalsAfter[0].id).not.toBe(exported.data.goals[0].id);
    const history = (await me.get(`/goals/${goalsAfter[0].id}/entries`)).body;
    expect(history.map((e: { amount: number; occurredAt: string }) => [e.amount, e.occurredAt])).toEqual([
      [-50, '2026-10-04T09:15:00.000Z'],
      [300, '2026-10-02T14:30:00.000Z'],
    ]);
    expect((await me.get('/me')).body).not.toHaveProperty('theme');
    // A categoria do usuário viaja no arquivo, volta com id novo e continua ligada à transação e ao limite.
    const customBefore = exported.data.categories.filter((c: { id: string }) => c.id.startsWith('custom-'));
    expect(customBefore).toEqual([{ id: expect.any(String), name: 'Pets', icon: 'pets', color: '#E67E22', bg: 'rgba(230,126,34,0.12)' }]);
    const customAfter = (await me.get('/categories')).body.filter((c: { custom: boolean }) => c.custom);
    expect(customAfter).toEqual([{ id: expect.stringMatching(/^custom-/), name: 'Pets', icon: 'pets', color: '#E67E22', bg: 'rgba(230,126,34,0.12)', custom: true }]);
    expect(customAfter[0].id).not.toBe(customBefore[0].id);
    expect(items.find((x: { name: string }) => x.name === 'Ração')).toMatchObject({ categoryId: customAfter[0].id, categoryName: 'Pets' });
    expect((await me.get('/budgets/categories')).body).toContainEqual({ categoryId: customAfter[0].id, month: '2026-10', amount: 200 });
    // A recorrência veio junto e aponta para a conta nova.
    const rec = (await me.get('/recurrences')).body;
    expect(rec).toHaveLength(1);
    expect(cardsAfter.map((c: { id: number }) => c.id)).toContain(rec[0].cardId);
  });

  it('aceita um backup da v1 (instantes UTC e sem categorias) e corrige o mês de quem lançou à noite', async () => {
    const me = await signup(t.app);
    const v1 = {
      app: 'sobro',
      format: 1,
      schemaVersion: 6,
      exportedAt: '2026-10-09T10:00:00.000Z',
      data: {
        cards: [{ id: 1, name: 'Carteira', number: '0001', color: '#3161B2', light_color: '#4A74BB', balance: 10.5 }],
        transactions: [
          // 22h de Brasília em 30/09: a v1 gravou 01h UTC de 01/10 e a despesa foi parar em outubro.
          { id: 7, card_id: 1, category_id: 'food', name: 'Jantar', amount: -42.9, type: 'expense', occurred_at: '2026-10-01T01:00:00.000Z', created_at: '2026-10-01 01:00:00' },
          { id: 8, card_id: 1, category_id: 'salary', name: 'Salário', amount: 1000, type: 'income', occurred_at: '2026-10-05T12:00:00.000Z' },
        ],
        profile: [{ id: 1, name: 'Zé', currency: 'BRL', avatar_uri: 'file:///x.jpg', monthly_budget: 999, reminders_enabled: 1 }],
        monthly_budgets: [{ month: '0000-00', amount: 1500 }],
      },
    };
    expect((await me.put('/backup', v1)).status).toBe(204);

    const items = (await me.get('/transactions')).body.items;
    expect(items.map((x: { name: string; occurredAt: string }) => [x.name, x.occurredAt])).toEqual([
      ['Salário', '2026-10-05T12:00:00.000Z'],
      ['Jantar', '2026-09-30T12:00:00.000Z'],
    ]);
    expect((await me.get('/cards')).body).toMatchObject([{ name: 'Carteira', balance: 10.5 - 42.9 + 1000 }]);
    expect((await me.get('/budgets/monthly')).body).toEqual([{ month: '0000-00', amount: 1500 }]);
    expect((await me.get('/me')).body.name).toBe('Zé');
  });

  it('um backup sem contas ainda deixa a conta padrão', async () => {
    const me = await signup(t.app);
    await populate(me);
    expect((await me.put('/backup', { app: 'sobro', format: 1, schemaVersion: 6, data: {} })).status).toBe(204);
    const cards = (await me.get('/cards')).body;
    expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe('Conta Principal');
    expect((await me.get('/transactions')).body.items).toEqual([]);
    expect((await me.get('/goals')).body).toEqual([]);
  });

  const goal = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    name: 'Meta',
    target_amount: 100,
    target_month: null,
    color: '#3161B2',
    icon: 'savings',
    ...extra,
  });
  const customCategory = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: 'Pets', icon: 'pets', color: '#E67E22', bg: 'rgba(230,126,34,0.12)', ...extra });
  const goalEntry = (id: number, goalId: number, amount: number) => ({ id, goal_id: goalId, amount, occurred_at: '2026-10-05T14:00:00.000Z' });

  const valid = () => ({
    app: 'sobro',
    format: 1,
    schemaVersion: 6,
    data: {
      cards: [{ id: 1, name: 'C', number: '1', color: '#000000', light_color: '#111111', balance: 0 }],
      transactions: [{ id: 1, card_id: 1, category_id: 'food', name: 't', amount: -5, type: 'expense', occurred_at: '2026-10-05T12:00:00.000Z' }],
    },
  });

  it.each([
    ['não é do Sobrô', (b: any) => (b.app = 'outro')],
    ['formato mais novo', (b: any) => (b.format = 2)],
    ['esquema mais novo', (b: any) => (b.schemaVersion = 10)],
    ['conta que não existe', (b: any) => (b.data.transactions[0].card_id = 99)],
    ['categoria que não existe', (b: any) => (b.data.transactions[0].category_id = 'nada')],
    ['tipo inválido', (b: any) => (b.data.transactions[0].type = 'x')],
    ['data inválida', (b: any) => (b.data.transactions[0].occurred_at = 'ontem')],
    ['valor zero', (b: any) => (b.data.transactions[0].amount = 0)],
    ['sinal que não combina com o tipo', (b: any) => (b.data.transactions[0].amount = 5)],
    ['campo obrigatório ausente', (b: any) => delete b.data.transactions[0].name],
    ['ids repetidos', (b: any) => b.data.cards.push({ ...b.data.cards[0] })],
    ['transferência com uma perna só', (b: any) => (b.data.transactions[0].transfer_id = 1)],
    ['recorrência com dia 40', (b: any) => (b.data.recurrences = [{ id: 1, card_id: 1, category_id: 'food', name: 'r', amount: 5, day: 40, start_month: '2026-10', generated_until: '2026-10' }])],
    ['orçamento com mês inválido', (b: any) => (b.data.monthly_budgets = [{ month: 'out', amount: 1 }])],
    ['orçamento repetido', (b: any) => (b.data.monthly_budgets = [{ month: '2026-10', amount: 1 }, { month: '2026-10', amount: 2 }])],
    ['caixinha com id repetido', (b: any) => (b.data.goals = [goal(1), goal(1)])],
    ['movimentação apontando para caixinha inexistente', (b: any) => ((b.data.goals = [goal(1)]), (b.data.goal_entries = [goalEntry(1, 99, 10)]))],
    ['meta de caixinha com valor zero', (b: any) => (b.data.goals = [goal(1, { target_amount: 0 })])],
    ['prazo de caixinha inválido', (b: any) => (b.data.goals = [goal(1, { target_month: 'out/2026' })])],
    ['caixinha cujas movimentações somam menos que zero', (b: any) => ((b.data.goals = [goal(1)]), (b.data.goal_entries = [goalEntry(1, 1, 10), goalEntry(2, 1, -20)]))],
    ['movimentação de caixinha com valor zero', (b: any) => ((b.data.goals = [goal(1)]), (b.data.goal_entries = [goalEntry(1, 1, 0)]))],
    ['movimentação de caixinha com data inválida', (b: any) => ((b.data.goals = [goal(1)]), (b.data.goal_entries = [{ ...goalEntry(1, 1, 10), occurred_at: 'ontem' }]))],
    ['categoria própria com id repetido', (b: any) => (b.data.categories = [customCategory('custom-1'), customCategory('custom-1')])],
    ['categoria própria sem nome', (b: any) => ((b.data.categories = [customCategory('custom-1')]), delete b.data.categories[0].name)],
    ['transação apontando para categoria própria que não está no arquivo', (b: any) => (b.data.transactions[0].category_id = 'custom-9999')],
    ['limite apontando para categoria própria que não está no arquivo', (b: any) => (b.data.category_budgets = [{ category_id: 'custom-9999', month: '2026-10', amount: 1 }])],
    ['caixinha sem nome', (b: any) => ((b.data.goals = [goal(1)]), delete b.data.goals[0].name)],
  ])('recusa um backup com %s e não muda nada', async (_name, break_) => {
    const me = await signup(t.app);
    const a = await card(me);
    await me.post('/transactions', tx(a, { name: 'Intacta' }));

    const body = valid();
    break_(body);
    const res = await me.put('/backup', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_backup');
    expect((await me.get('/transactions')).body.items.map((x: { name: string }) => x.name)).toEqual(['Intacta']);
  });

  it('recusa corpo que não é um backup', async () => {
    const me = await signup(t.app);
    expect((await me.put('/backup', [])).status).toBe(400);
    expect((await me.put('/backup', { app: 'sobro' })).status).toBe(400);
  });

  describe('arquivos de qualquer versão do app', () => {
    const at = (schemaVersion: number, data: Record<string, unknown>) => ({ app: 'sobro', format: 1, schemaVersion, exportedAt: '2026-10-09T10:00:00.000Z', data });
    const baseCards = [{ id: 1, name: 'Carteira', number: '0001', color: '#3161B2', light_color: '#4A74BB', balance: 0 }];
    const expense = (id: number, extra: Record<string, unknown> = {}) => ({
      id, card_id: 1, category_id: 'food', name: `gasto ${id}`, amount: -10, type: 'expense', occurred_at: '2026-10-05T12:00:00.000Z', ...extra,
    });

    const files: [string, number, () => unknown][] = [
      ['v1', 1, () => at(1, { cards: baseCards, transactions: [expense(1)], profile: [{ id: 1, name: 'Zé', currency: 'BRL', avatar_uri: null, monthly_budget: 800 }] })],
      [
        'v4',
        4,
        () =>
          at(4, {
            cards: baseCards,
            recurrences: [{ id: 1, card_id: 1, category_id: 'leisure', name: 'Streaming', amount: 30, day: 5, start_month: '2026-09', generated_until: '2026-10' }],
            transactions: [expense(1), expense(2, { recurrence_id: 1, category_id: 'leisure' })],
            monthly_budgets: [{ month: '0000-00', amount: 1500 }],
            profile: [{ id: 1, name: 'Zé', currency: 'BRL', avatar_uri: null, monthly_budget: null }],
          }),
      ],
      [
        'v6',
        6,
        () =>
          at(6, {
            cards: [...baseCards, { id: 2, name: 'Poupança', number: '2', color: '#277F2B', light_color: '#3FA145', balance: 100 }],
            transactions: [
              expense(1),
              expense(2, { category_id: 'transfer', name: 'Para Poupança', amount: -40, transfer_id: 2 }),
              { ...expense(3, { category_id: 'transfer', name: 'De Carteira', amount: 40, type: 'income', transfer_id: 2 }), card_id: 2 },
            ],
            category_budgets: [{ category_id: 'food', month: '2026-10', amount: 300 }],
            profile: [{ id: 1, name: 'Zé', currency: 'BRL', avatar_uri: null, monthly_budget: null, reminders_enabled: 0 }],
          }),
      ],
      [
        'v8',
        8,
        () =>
          at(8, {
            cards: baseCards,
            transactions: [expense(1)],
            profile: [{ id: 1, name: 'Zé', currency: 'BRL', avatar_uri: null, monthly_budget: null, reminders_enabled: 1, theme: 'dark' }],
            goals: [goal(1, { name: 'Viagem', target_amount: 500, target_month: '2027-01' })],
            goal_entries: [goalEntry(1, 1, 200), goalEntry(2, 1, -50)],
          }),
      ],
    ];

    it.each(files)('aceita um arquivo %s e o que se exporta depois entra de novo', async (_name, version, build) => {
      const me = await signup(t.app);
      await populate(me); // tem caixinha: o arquivo substitui tudo, e um arquivo antigo não traz caixinhas

      expect((await me.put('/backup', build())).status).toBe(204);
      expect((await me.get('/me')).body.name).toBe('Zé');
      expect((await me.get('/me')).body).not.toHaveProperty('theme');

      const goalsNow = (await me.get('/goals')).body;
      expect(goalsNow.map((g: { name: string; saved: number }) => [g.name, g.saved])).toEqual(version === 8 ? [['Viagem', 150]] : []);

      // O que a API exporta entra de volta sem reclamar, em qualquer versão de origem.
      const exported = (await me.get('/backup')).body;
      expect(exported.schemaVersion).toBe(9);
      expect((await me.put('/backup', exported)).status).toBe(204);
      expect((await me.get('/goals')).body.map((g: { saved: number }) => g.saved)).toEqual(goalsNow.map((g: { saved: number }) => g.saved));
    });

    it('o tema do arquivo do app é aceito e descartado', async () => {
      const me = await signup(t.app);
      const v8 = files[3]![2]() as { data: { profile: { theme: string }[] } };
      expect(v8.data.profile[0]!.theme).toBe('dark');
      expect((await me.put('/backup', v8)).status).toBe(204);
      expect((await me.get('/me')).body).toEqual({ id: me.userId, email: me.email, name: 'Zé', currency: 'BRL', remindersEnabled: true, managedProfiles: 0 });
      // O backup exportado volta com o tema neutro, nunca o 'dark' do arquivo.
      expect((await me.get('/backup')).body.data.profile[0].theme).toBe('system');
    });
  });

  describe('categorias do usuário no backup', () => {
    const at = (data: Record<string, unknown>) => ({ app: 'sobro', format: 1, schemaVersion: 6, exportedAt: '2026-10-09T10:00:00.000Z', data });
    const baseCards = [{ id: 1, name: 'Carteira', number: '0001', color: '#3161B2', light_color: '#4A74BB', balance: 0 }];

    it('aceita um backup da v1 com categoria própria (id gerado pela data) e refaz o id', async () => {
      const me = await signup(t.app);
      const file = at({
        categories: [{ id: 'food', name: 'Alimentação', icon: 'restaurant', color: '#E67E22', bg: 'rgba(230,126,34,0.12)' }, customCategory('custom-1728000000000')],
        cards: baseCards,
        recurrences: [{ id: 1, card_id: 1, category_id: 'custom-1728000000000', name: 'Banho', amount: 60, day: 5, start_month: '2026-09', generated_until: '2026-10' }],
        transactions: [
          { id: 1, card_id: 1, category_id: 'custom-1728000000000', name: 'Ração', amount: -35, type: 'expense', occurred_at: '2026-10-05T12:00:00.000Z' },
          { id: 2, card_id: 1, category_id: 'custom-1728000000000', name: 'Banho', amount: -60, type: 'expense', occurred_at: '2026-09-05T12:00:00.000Z', recurrence_id: 1 },
        ],
        category_budgets: [{ category_id: 'custom-1728000000000', month: '2026-10', amount: 150 }],
      });
      expect((await me.put('/backup', file)).status).toBe(204);

      const custom = (await me.get('/categories')).body.filter((c: { custom: boolean }) => c.custom);
      expect(custom).toHaveLength(1);
      expect(custom[0].id).not.toBe('custom-1728000000000');
      const items = (await me.get('/transactions?limit=50')).body.items;
      expect(items.map((x: { categoryName: string }) => x.categoryName)).toEqual(expect.arrayContaining(['Pets']));
      expect(items.filter((x: { categoryId: string }) => x.categoryId === custom[0].id).length).toBeGreaterThanOrEqual(2);
      expect((await me.get('/recurrences')).body[0]).toMatchObject({ categoryId: custom[0].id, categoryName: 'Pets' });
      expect((await me.get('/budgets/categories')).body).toEqual([{ categoryId: custom[0].id, month: '2026-10', amount: 150 }]);

      // O que a API exporta entra de volta.
      expect((await me.put('/backup', (await me.get('/backup')).body)).status).toBe(204);
      expect((await me.get('/categories')).body.filter((c: { custom: boolean }) => c.custom)).toHaveLength(1);
    });

    it('as categorias do catálogo que vêm no arquivo são ignoradas', async () => {
      const me = await signup(t.app);
      const file = at({ categories: [{ id: 'food', name: 'Comida alterada', icon: 'x', color: '#000000', bg: 'x' }], cards: baseCards });
      expect((await me.put('/backup', file)).status).toBe(204);
      expect((await me.get('/categories')).body.find((c: { id: string }) => c.id === 'food')).toMatchObject({ name: 'Alimentação', custom: false });
    });

    it('um backup sem categorias próprias apaga as do usuário, junto com o que as usava', async () => {
      const me = await signup(t.app);
      await populate(me);
      expect((await me.get('/categories')).body.some((c: { custom: boolean }) => c.custom)).toBe(true);

      expect((await me.put('/backup', at({ cards: baseCards }))).status).toBe(204);
      expect((await me.get('/categories')).body.some((c: { custom: boolean }) => c.custom)).toBe(false);
      expect((await me.get('/transactions')).body.items).toEqual([]);
      expect((await me.get('/budgets/categories')).body).toEqual([]);
    });

    it('o backup de um usuário leva só as categorias dele', async () => {
      const alice = await signup(t.app, 'Alice');
      const bob = await signup(t.app, 'Bob');
      await alice.post('/categories', { name: 'Da Alice', icon: 'pets', color: '#E67E22', bg: 'rgba(230,126,34,0.12)' });
      await bob.post('/categories', { name: 'Do Bob', icon: 'pets', color: '#3161B2', bg: 'rgba(49,97,178,0.12)' });

      const names = async (c: Client) =>
        (await c.get('/backup')).body.data.categories.filter((x: { id: string }) => x.id.startsWith('custom-')).map((x: { name: string }) => x.name);
      expect(await names(alice)).toEqual(['Da Alice']);
      expect(await names(bob)).toEqual(['Do Bob']);
    });

    it('restaurar o backup de um não toca nas categorias do outro', async () => {
      const alice = await signup(t.app, 'Alice');
      const bob = await signup(t.app, 'Bob');
      const mine = (await alice.post('/categories', { name: 'Da Alice', icon: 'pets', color: '#E67E22', bg: 'rgba(230,126,34,0.12)' })).body;

      expect((await bob.put('/backup', (await bob.get('/backup')).body)).status).toBe(204);
      expect((await alice.get('/categories')).body.find((c: { id: string }) => c.id === mine.id)).toMatchObject({ name: 'Da Alice' });
    });
  });

  describe('arquivo exportado pelo app v8 (fixture)', () => {
    type BackupFileLike = { data: Record<string, Record<string, unknown>[]> };
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/app-backup-v8.json', import.meta.url), 'utf8')) as BackupFileLike;

    // O conteúdo sem os ids: referências viram nomes, para comparar arquivos de ids diferentes.
    function canonical(file: BackupFileLike) {
      const d = file.data;
      const cardName = (id: unknown) => d.cards!.find((c) => c.id === id)!.name;
      const goalName = (id: unknown) => d.goals!.find((g) => g.id === id)!.name;
      // As categorias próprias (custom-*) mudam de id: comparam-se pelo nome.
      const categoryLabel = (id: unknown) => (String(id).startsWith('custom-') ? `custom:${d.categories!.find((c) => c.id === id)!.name}` : id);
      const sorted = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();
      return {
        categories: sorted(d.categories!.filter((c) => String(c.id).startsWith('custom-')).map((c) => [c.name, c.icon, c.color, c.bg])),
        cards: sorted(d.cards!.map((c) => [c.name, c.number, c.balance])),
        transactions: sorted(
          d.transactions!.map((x) => [cardName(x.card_id), categoryLabel(x.category_id), x.name, x.amount, x.type, x.occurred_at, x.recurrence_id !== null, x.transfer_id !== null])
        ),
        recurrences: sorted(d.recurrences!.map((r) => [cardName(r.card_id), r.name, r.amount, r.day, r.generated_until])),
        monthly_budgets: sorted(d.monthly_budgets!.map((b) => [b.month, b.amount])),
        category_budgets: sorted(d.category_budgets!.map((b) => [categoryLabel(b.category_id), b.month, b.amount])),
        goals: sorted(d.goals!.map((g) => [g.name, g.target_amount, g.target_month, g.color, g.icon])),
        goal_entries: sorted(d.goal_entries!.map((e) => [goalName(e.goal_id), e.amount, e.occurred_at])),
      };
    }

    it('entra com PUT /backup e GET /backup devolve o mesmo conteúdo, com ids refeitos e o mesmo valor nas caixinhas', async () => {
      const me = await signup(t.app);
      expect((await me.put('/backup', fixture)).status).toBe(204);

      const exported = (await me.get('/backup')).body as BackupFileLike;
      expect(canonical(exported)).toEqual(canonical(fixture));

      // Os ids foram refeitos.
      const oldCardIds = fixture.data.cards!.map((c) => c.id);
      expect(exported.data.cards!.some((c) => oldCardIds.includes(c.id))).toBe(false);

      const goals = (await me.get('/goals')).body;
      expect(goals.map((g: { name: string; saved: number }) => [g.name, g.saved])).toEqual([['Viagem', 1000], ['Reserva', 300]]);
      // As caixinhas não mexem nas contas: o saldo da principal vem só das transações do arquivo.
      const cards = (await me.get('/cards')).body;
      expect(cards.map((c: { name: string; balance: number }) => [c.name, c.balance])).toEqual([['Conta Principal', 2857.85], ['Poupança', 1800]]);
      expect((await me.get('/me')).body).toMatchObject({ name: 'Pessoa de Teste' });
    });
  });
});

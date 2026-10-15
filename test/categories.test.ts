import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { categories } from '../src/db/schema.js';
import { PASSWORD, makeApp, noon, signup, type Client, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp({ now: () => new Date('2026-10-10T15:00:00.000Z') });
});
afterAll(() => t.close());

const categoryBody = (extra: Record<string, unknown> = {}) => ({
  name: 'Pets',
  icon: 'pets',
  color: '#E67E22',
  bg: 'rgba(230,126,34,0.12)',
  ...extra,
});

async function newCategory(c: Client, extra: Record<string, unknown> = {}) {
  const res = await c.post('/categories', categoryBody(extra));
  expect(res.status).toBe(201);
  return res.body as { id: string; name: string };
}

const firstCard = async (c: Client) => (await c.get('/cards')).body[0].id as number;

const expense = (cardId: number, categoryId: string, extra: Record<string, unknown> = {}) => ({
  cardId,
  categoryId,
  name: 'Ração',
  amount: 40,
  type: 'expense',
  occurredAt: noon('2026-10-05'),
  ...extra,
});

const CATALOG = ['food', 'health', 'invest', 'leisure', 'other', 'salary', 'shopping', 'transfer', 'transport'];

describe('listar', () => {
  it('um usuário novo vê só o catálogo, marcado como não personalizado', async () => {
    const me = await signup(t.app);
    const list = (await me.get('/categories')).body;
    expect(list.map((c: { id: string }) => c.id).sort()).toEqual(CATALOG);
    expect(list.every((c: { custom: boolean }) => c.custom === false)).toBe(true);
    expect(list[0]).toEqual({ id: expect.any(String), name: expect.any(String), icon: expect.any(String), color: expect.any(String), bg: expect.any(String), custom: false });
  });

  it('o catálogo vem primeiro (por nome) e as do usuário depois, na ordem em que foram criadas', async () => {
    const me = await signup(t.app);
    const zebra = await newCategory(me, { name: 'Zebra' });
    const abelha = await newCategory(me, { name: 'Abelha' });

    const list = (await me.get('/categories')).body as { id: string; name: string; custom: boolean }[];
    expect(list.slice(0, 9).every((c) => !c.custom)).toBe(true);
    const names = list.slice(0, 9).map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'pt-BR')));
    expect(list.slice(9).map((c) => [c.id, c.name, c.custom])).toEqual([
      [zebra.id, 'Zebra', true],
      [abelha.id, 'Abelha', true],
    ]);
  });
});

describe('criar, editar e excluir', () => {
  it('cria com id gerado pelo servidor', async () => {
    const me = await signup(t.app);
    const res = await me.post('/categories', categoryBody());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.stringMatching(/^custom-[0-9a-f]{32}$/), name: 'Pets', icon: 'pets', color: '#E67E22', bg: 'rgba(230,126,34,0.12)', custom: true });
    // O id cabe nos 40 caracteres que as outras rotas aceitam.
    expect(res.body.id.length).toBeLessThanOrEqual(40);
  });

  it('valida os campos', async () => {
    const me = await signup(t.app);
    expect((await me.post('/categories', categoryBody({ name: 'x'.repeat(30) }))).status).toBe(201);
    const long = await me.post('/categories', categoryBody({ name: 'x'.repeat(31) }));
    expect(long.status).toBe(400);
    expect(long.body.error.fields[0].path).toBe('name');
    expect((await me.post('/categories', categoryBody({ name: '  ' }))).status).toBe(400);
    expect((await me.post('/categories', categoryBody({ color: 'laranja' }))).status).toBe(400);
    expect((await me.post('/categories', categoryBody({ icon: '' }))).status).toBe(400);
    expect((await me.post('/categories', categoryBody({ bg: '' }))).status).toBe(400);
    expect((await me.post('/categories', { name: 'Só o nome' })).status).toBe(400);
  });

  it('edita só o que veio; um PATCH vazio não muda nada', async () => {
    const me = await signup(t.app);
    const cat = await newCategory(me);
    const edited = await me.patch(`/categories/${cat.id}`, { name: 'Animais', color: '#3161B2' });
    expect(edited.body).toMatchObject({ id: cat.id, name: 'Animais', color: '#3161B2', icon: 'pets', custom: true });
    expect((await me.patch(`/categories/${cat.id}`, {})).body.name).toBe('Animais');
    expect((await me.patch(`/categories/${cat.id}`, { name: 'x'.repeat(31) })).status).toBe(400);
  });

  it('o catálogo não se edita nem se exclui (404)', async () => {
    const me = await signup(t.app);
    expect((await me.patch('/categories/food', { name: 'Comida' })).status).toBe(404);
    expect((await me.del('/categories/food')).status).toBe(404);
    expect((await me.patch('/categories/custom-inexistente', { name: 'x' })).status).toBe(404);
    expect((await me.get('/categories')).body.find((c: { id: string }) => c.id === 'food').name).toBe('Alimentação');
  });

  it('exclui uma categoria sem uso e leva os limites dela', async () => {
    const me = await signup(t.app);
    const cat = await newCategory(me);
    await me.put(`/budgets/categories/${cat.id}/2026-10`, { amount: 300 });
    expect((await me.get('/budgets/categories')).body).toHaveLength(1);

    expect((await me.del(`/categories/${cat.id}`)).status).toBe(204);
    expect((await me.get('/budgets/categories')).body).toEqual([]);
    expect((await me.get('/categories')).body.some((c: { id: string }) => c.id === cat.id)).toBe(false);
    expect((await me.del(`/categories/${cat.id}`)).status).toBe(404);
  });

  it('recusa excluir uma categoria com transações (409) e deixa excluir depois que elas saem', async () => {
    const me = await signup(t.app);
    const cat = await newCategory(me);
    const tx = (await me.post('/transactions', expense(await firstCard(me), cat.id))).body;

    const refused = await me.del(`/categories/${cat.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('category_in_use');
    expect(refused.body.error.message).toContain('transações');
    expect((await me.get('/categories')).body.some((c: { id: string }) => c.id === cat.id)).toBe(true);

    await me.del(`/transactions/${tx.id}`);
    expect((await me.del(`/categories/${cat.id}`)).status).toBe(204);
  });

  it('recusa excluir uma categoria usada só por uma recorrência', async () => {
    const me = await signup(t.app);
    const cat = await newCategory(me);
    const first = (await me.post('/transactions', expense(await firstCard(me), cat.id, { repeat: { mode: 'monthly' } }))).body;
    await me.del(`/transactions/${first.id}`); // a recorrência continua

    const refused = await me.del(`/categories/${cat.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('category_in_use');
  });
});

describe('usar uma categoria própria', () => {
  it('em transações, recorrências, limites, filtros e relatórios', async () => {
    const me = await signup(t.app);
    const cat = await newCategory(me, { name: 'Pets' });
    const card = await firstCard(me);

    const created = await me.post('/transactions', expense(card, cat.id, { amount: 40 }));
    expect(created.body).toMatchObject({ categoryId: cat.id, categoryName: 'Pets', categoryIcon: 'pets', categoryColor: '#E67E22' });
    await me.post('/transactions', expense(card, cat.id, { name: 'Banho', amount: 60, repeat: { mode: 'monthly' } }));
    await me.put(`/budgets/categories/${cat.id}/2026-10`, { amount: 500 });

    expect((await me.get(`/transactions?categoryId=${cat.id}&month=2026-10`)).body.items).toHaveLength(2);
    const totals = (await me.get('/reports/category-totals?month=2026-10')).body;
    expect(totals).toEqual([{ categoryId: cat.id, categoryName: 'Pets', icon: 'pets', color: '#E67E22', bg: 'rgba(230,126,34,0.12)', total: 100 }]);
    expect((await me.get('/budgets/categories')).body).toEqual([{ categoryId: cat.id, month: '2026-10', amount: 500 }]);

    // Trocar a categoria de uma transação (e das próximas da recorrência) por outra própria.
    const other = await newCategory(me, { name: 'Banho e tosa' });
    const edited = await me.patch(`/transactions/${created.body.id}`, { categoryId: other.id });
    expect(edited.body).toMatchObject({ categoryId: other.id, categoryName: 'Banho e tosa' });
    // Renomear reflete nas transações já lançadas (a junção é por id).
    await me.patch(`/categories/${other.id}`, { name: 'Pet shop' });
    expect((await me.get(`/transactions/${created.body.id}`)).body.categoryName).toBe('Pet shop');
  });

  it('a categoria Transferência continua só das transferências', async () => {
    const me = await signup(t.app);
    expect((await me.post('/transactions', expense(await firstCard(me), 'transfer'))).status).toBe(400);
  });
});

describe('isolamento entre usuários', () => {
  it('o outro não vê, não edita, não exclui e não usa a categoria alheia', async () => {
    const alice = await signup(t.app, 'Alice');
    const bob = await signup(t.app, 'Bob');
    const mine = await newCategory(alice, { name: 'Segredo da Alice' });
    const bobCard = await firstCard(bob);

    expect((await bob.get('/categories')).body.some((c: { id: string }) => c.id === mine.id)).toBe(false);
    expect(JSON.stringify((await bob.get('/categories')).body)).not.toContain('Segredo da Alice');
    expect((await bob.patch(`/categories/${mine.id}`, { name: 'Invadida' })).status).toBe(404);
    expect((await bob.del(`/categories/${mine.id}`)).status).toBe(404);

    // Usar a categoria dela responde como categoria inexistente.
    const used = await bob.post('/transactions', expense(bobCard, mine.id));
    expect(used.status).toBe(400);
    expect(used.body.error.fields[0]).toMatchObject({ path: 'categoryId', message: 'Categoria inexistente.' });
    const own = (await bob.post('/transactions', expense(bobCard, 'food'))).body;
    expect((await bob.patch(`/transactions/${own.id}`, { categoryId: mine.id })).status).toBe(400);
    expect((await bob.put(`/budgets/categories/${mine.id}/2026-10`, { amount: 10 })).status).toBe(400);

    // Nada mudou para a Alice.
    expect((await alice.get('/categories')).body.find((c: { id: string }) => c.id === mine.id)).toMatchObject({ name: 'Segredo da Alice' });
  });
});

describe('idempotência', () => {
  it('a mesma chave não cria duas categorias e devolve o cabeçalho', async () => {
    const me = await signup(t.app);
    const key = randomUUID();
    const first = await me.post('/categories', categoryBody(), { 'idempotency-key': key });
    const again = await me.post('/categories', categoryBody(), { 'idempotency-key': key });

    expect(first.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect((await me.get('/categories')).body.filter((c: { custom: boolean }) => c.custom)).toHaveLength(1);
  });
});

describe('concorrência', () => {
  // Excluir a categoria ao mesmo tempo em que se grava uma transação com ela: ou a transação entra e a
  // exclusão é recusada, ou a exclusão vence e a transação é recusada. Nunca erro do servidor nem
  // transação apontando para uma categoria que sumiu.
  it('excluir e usar ao mesmo tempo nunca dá 500 nem deixa transação órfã', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);

    for (let round = 0; round < 8; round++) {
      const cat = await newCategory(me, { name: `Corrida ${round}` });
      const [removed, used] = await Promise.all([me.del(`/categories/${cat.id}`), me.post('/transactions', expense(card, cat.id, { name: `t${round}` }))]);

      expect([204, 409]).toContain(removed.status);
      expect([201, 400]).toContain(used.status);
      // Exatamente um dos dois vence.
      expect((removed.status === 204) !== (used.status === 201)).toBe(true);

      const stillThere = (await me.get('/categories')).body.some((c: { id: string }) => c.id === cat.id);
      expect(stillThere).toBe(removed.status === 409);
    }
    // Toda transação restante aponta para uma categoria que existe.
    const items = (await me.get('/transactions?limit=100')).body.items;
    expect(items.every((x: { categoryName: string }) => typeof x.categoryName === 'string')).toBe(true);
  });
});

describe('excluir a conta', () => {
  it('leva as categorias do usuário, mesmo usadas por transações', async () => {
    const me = await signup(t.app);
    const cat = await newCategory(me);
    await me.post('/transactions', expense(await firstCard(me), cat.id));

    expect((await me.del('/me', { password: PASSWORD })).status).toBe(204);
    expect(await t.db.select().from(categories).where(eq(categories.userId, me.userId))).toEqual([]);
    // O catálogo continua intacto.
    expect((await t.db.select().from(categories)).filter((c) => c.userId === null)).toHaveLength(9);
  });
});

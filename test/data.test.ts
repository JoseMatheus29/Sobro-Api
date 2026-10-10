import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeApp, noon, signup, type Client, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  // "Hoje" fixo: 10/10/2026, dia de calendário em Brasília.
  t = await makeApp({ now: () => new Date('2026-10-10T15:00:00.000Z') });
});
afterAll(() => t.close());

async function firstCard(c: Client) {
  return (await c.get('/cards')).body[0] as { id: number };
}

const expense = (cardId: number, extra: Record<string, unknown> = {}) => ({
  cardId,
  categoryId: 'food',
  name: 'Mercado',
  amount: 50,
  type: 'expense',
  occurredAt: noon('2026-10-05'),
  ...extra,
});

describe('contas', () => {
  it('cria, edita e calcula o saldo atual a partir do inicial e das transações', async () => {
    const me = await signup(t.app);
    const created = await me.post('/cards', { name: 'Nubank', number: '1234', color: '#820AD1', lightColor: '#A04FE0', startingBalance: 100 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Nubank', balance: 100, startingBalance: 100 });
    const id = created.body.id;

    await me.post('/transactions', expense(id, { amount: 30 }));
    await me.post('/transactions', { ...expense(id), type: 'income', categoryId: 'salary', name: 'Salário', amount: 200 });
    expect((await me.get(`/cards/${id}`)).body).toMatchObject({ balance: 270, startingBalance: 100 });

    const edited = await me.patch(`/cards/${id}`, { name: 'Roxinho' });
    expect(edited.body).toMatchObject({ name: 'Roxinho', balance: 270 });
  });

  it('valida os campos', async () => {
    const me = await signup(t.app);
    const res = await me.post('/cards', { name: '', color: 'azul', lightColor: '#fff' });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.map((f: { path: string }) => f.path).sort()).toEqual(['color', 'name']);
  });

  it('exclusão em cascata leva transações, recorrências e a outra perna das transferências', async () => {
    const me = await signup(t.app);
    const main = await firstCard(me);
    const other = (await me.post('/cards', { name: 'Outra', color: '#000000', lightColor: '#111111' })).body;
    const third = (await me.post('/cards', { name: 'Terceira', color: '#000000', lightColor: '#111111' })).body;

    await me.post('/transactions', expense(main.id));
    await me.post('/transactions', expense(main.id, { name: 'Academia', repeat: { mode: 'monthly' } }));
    await me.post('/transactions', expense(third.id, { name: 'Fica' }));
    await me.post('/transfers', { fromCardId: other.id, toCardId: main.id, amount: 40, occurredAt: noon('2026-10-06') });

    // Antes de excluir a "Outra": o uso mostra o que vai junto (a perna dela e a outra perna, na principal).
    expect((await me.get(`/cards/${other.id}/usage`)).body).toEqual({ transactions: 2, recurrences: 0 });
    expect((await me.get(`/cards/${main.id}/usage`)).body).toEqual({ transactions: 4, recurrences: 1 });

    expect((await me.del(`/cards/${main.id}`)).status).toBe(204);
    // A conta principal levou a perna da transferência que estava na "Outra": o saldo dela volta a zero.
    expect((await me.get(`/cards/${other.id}`)).body.balance).toBe(0);
    expect((await me.get('/recurrences')).body).toEqual([]);
    const left = (await me.get('/transactions')).body.items;
    expect(left.map((x: { name: string }) => x.name)).toEqual(['Fica']);
  });

  it('não deixa excluir a última conta', async () => {
    const me = await signup(t.app);
    const only = await firstCard(me);
    const res = await me.del(`/cards/${only.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('last_card');
  });
});

describe('transações', () => {
  it('guarda despesa negativa e receita positiva, devolvendo o valor com sinal', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    const out = await me.post('/transactions', expense(card.id, { amount: 12.345, description: '  almoço  ' }));
    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({ amount: -12.35, type: 'expense', description: 'almoço', categoryName: 'Alimentação', recurrence: null, transferId: null });

    const inc = await me.post('/transactions', expense(card.id, { type: 'income', categoryId: 'salary', amount: 1000 }));
    expect(inc.body.amount).toBe(1000);
  });

  it('recusa valor zero, negativo, referência inexistente e conta de outra pessoa', async () => {
    const me = await signup(t.app);
    const stranger = await signup(t.app);
    const card = await firstCard(me);

    expect((await me.post('/transactions', expense(card.id, { amount: 0 }))).status).toBe(400);
    expect((await me.post('/transactions', expense(card.id, { amount: -5 }))).status).toBe(400);
    expect((await me.post('/transactions', expense(card.id, { categoryId: 'nao-existe' }))).status).toBe(400);
    expect((await me.post('/transactions', expense(card.id, { type: 'outro' }))).status).toBe(400);
    expect((await me.post('/transactions', expense(card.id, { categoryId: 'transfer' }))).status).toBe(400);
    expect((await stranger.post('/transactions', expense(card.id))).status).toBe(404);
  });

  it('grava a data como o dia de calendário de Brasília ao meio-dia UTC', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    // 22h de Brasília do último dia de setembro = 01h UTC de 1º de outubro. Continua em setembro.
    const night = await me.post('/transactions', expense(card.id, { occurredAt: '2026-10-01T01:00:00.000Z' }));
    expect(night.body.occurredAt).toBe('2026-09-30T12:00:00.000Z');
    expect((await me.get('/transactions?month=2026-09')).body.items).toHaveLength(1);
    expect((await me.get('/transactions?month=2026-10')).body.items).toHaveLength(0);
  });

  it('lista por mês, conta, categoria e tipo, da mais nova para a mais antiga', async () => {
    const me = await signup(t.app);
    const a = await firstCard(me);
    const b = (await me.post('/cards', { name: 'B', color: '#000000', lightColor: '#111111' })).body;
    await me.post('/transactions', expense(a.id, { name: 'um', occurredAt: noon('2026-10-01') }));
    await me.post('/transactions', expense(a.id, { name: 'dois', occurredAt: noon('2026-10-20'), categoryId: 'health' }));
    await me.post('/transactions', expense(b.id, { name: 'tres', occurredAt: noon('2026-10-20') }));
    await me.post('/transactions', expense(a.id, { name: 'velha', occurredAt: noon('2026-09-30') }));
    await me.post('/transactions', expense(a.id, { name: 'renda', type: 'income', categoryId: 'salary', occurredAt: noon('2026-10-02') }));

    const names = async (query: string) => (await me.get(`/transactions?${query}`)).body.items.map((x: { name: string }) => x.name);
    expect(await names('month=2026-10')).toEqual(['tres', 'dois', 'renda', 'um']);
    expect(await names(`month=2026-10&cardId=${b.id}`)).toEqual(['tres']);
    expect(await names('month=2026-10&categoryId=health')).toEqual(['dois']);
    expect(await names('month=2026-10&type=income')).toEqual(['renda']);
    expect(await names('')).toContain('velha');
    expect((await me.get('/transactions?month=2026-13')).status).toBe(400);
  });

  it('pagina com cursor sem repetir nem perder linhas', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    for (let i = 1; i <= 7; i++) {
      await me.post('/transactions', expense(card.id, { name: `t${i}`, occurredAt: noon(i % 2 ? '2026-10-03' : '2026-10-04') }));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { body: { items: { name: string }[]; nextCursor: string | null } } = await me.get(`/transactions?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...res.body.items.map((x) => x.name));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect((await me.get('/transactions?cursor=lixo')).body.error.code).toBe('invalid_cursor');
  });

  it('busca ignorando acento e caixa, exigindo todas as palavras, e trata curingas como texto', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    await me.post('/transactions', expense(card.id, { name: 'Pão de queijo', description: 'Padaria da esquina' }));
    await me.post('/transactions', expense(card.id, { name: 'Desconto 100%' }));
    await me.post('/transactions', expense(card.id, { name: 'Cinema', categoryId: 'leisure' }));

    const found = async (q: string) => (await me.get(`/transactions?q=${encodeURIComponent(q)}`)).body.items.map((x: { name: string }) => x.name);
    expect(await found('PAO queijo')).toEqual(['Pão de queijo']);
    expect(await found('padaria esquina')).toEqual(['Pão de queijo']);
    expect(await found('alimentacao')).toHaveLength(2);
    expect(await found('lazer')).toEqual(['Cinema']);
    expect(await found('100%')).toEqual(['Desconto 100%']);
    expect(await found('%')).toEqual(['Desconto 100%']);
    expect(await found('_')).toEqual([]);
    expect(await found('pao cinema')).toEqual([]);
  });

  it('edita mantendo o sinal coerente com o tipo', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    const created = (await me.post('/transactions', expense(card.id, { amount: 10 }))).body;

    expect((await me.patch(`/transactions/${created.id}`, { amount: 25 })).body).toMatchObject({ amount: -25, type: 'expense' });
    // Só o tipo muda: o valor vira receita, com a mesma magnitude.
    expect((await me.patch(`/transactions/${created.id}`, { type: 'income', categoryId: 'salary' })).body).toMatchObject({ amount: 25, type: 'income' });
    const moved = await me.patch(`/transactions/${created.id}`, { name: 'Novo', description: '', occurredAt: noon('2026-11-02') });
    expect(moved.body).toMatchObject({ name: 'Novo', description: null, occurredAt: noon('2026-11-02') });
    expect((await me.patch(`/transactions/${created.id}`, { amount: 0 })).status).toBe(400);
  });

  it('exclui, e excluir de novo dá 404', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    const created = (await me.post('/transactions', expense(card.id))).body;
    expect((await me.del(`/transactions/${created.id}`)).status).toBe(204);
    expect((await me.del(`/transactions/${created.id}`)).status).toBe(404);
    expect((await me.get(`/transactions/${created.id}`)).status).toBe(404);
  });
});

describe('transferências', () => {
  it('cria as duas pernas, move os saldos e some dos totais', async () => {
    const me = await signup(t.app);
    const a = await firstCard(me);
    const b = (await me.post('/cards', { name: 'Poupança', color: '#000000', lightColor: '#111111' })).body;
    await me.post('/transactions', expense(a.id, { type: 'income', categoryId: 'salary', amount: 500, occurredAt: noon('2026-10-02') }));

    const res = await me.post('/transfers', { fromCardId: a.id, toCardId: b.id, amount: 120, description: 'reserva', occurredAt: noon('2026-10-06') });
    expect(res.status).toBe(201);
    const [out, inbound] = res.body.legs;
    expect(out).toMatchObject({ cardId: a.id, amount: -120, type: 'expense', categoryId: 'transfer', name: 'Para Poupança', transferId: res.body.transferId, id: res.body.transferId });
    expect(inbound).toMatchObject({ cardId: b.id, amount: 120, type: 'income', name: 'De Conta Principal', transferId: res.body.transferId });

    expect((await me.get(`/cards/${a.id}`)).body.balance).toBe(380);
    expect((await me.get(`/cards/${b.id}`)).body.balance).toBe(120);
    // Entradas e saídas do mês não incluem a transferência.
    expect((await me.get('/reports/monthly-totals')).body).toEqual([{ month: '2026-10', income: 500, expense: 0 }]);
    expect((await me.get('/reports/category-totals?month=2026-10')).body).toEqual([]);
  });

  it('não se edita; excluir uma perna leva as duas', async () => {
    const me = await signup(t.app);
    const a = await firstCard(me);
    const b = (await me.post('/cards', { name: 'B', color: '#000000', lightColor: '#111111' })).body;
    const { legs } = (await me.post('/transfers', { fromCardId: a.id, toCardId: b.id, amount: 10, occurredAt: noon('2026-10-06') })).body;

    const edit = await me.patch(`/transactions/${legs[1].id}`, { amount: 99 });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('transfer_not_editable');

    expect((await me.del(`/transactions/${legs[1].id}`)).status).toBe(204);
    expect((await me.get('/transactions')).body.items).toEqual([]);
    expect((await me.get(`/cards/${a.id}`)).body.balance).toBe(0);
  });

  it('recusa a mesma conta, conta de outra pessoa e valor inválido', async () => {
    const me = await signup(t.app);
    const stranger = await signup(t.app);
    const a = await firstCard(me);
    const theirs = await firstCard(stranger);
    const b = (await me.post('/cards', { name: 'B', color: '#000000', lightColor: '#111111' })).body;
    const base = { fromCardId: a.id, toCardId: b.id, amount: 10, occurredAt: noon('2026-10-06') };

    expect((await me.post('/transfers', { ...base, toCardId: a.id })).status).toBe(400);
    expect((await me.post('/transfers', { ...base, toCardId: theirs.id })).status).toBe(404);
    expect((await me.post('/transfers', { ...base, amount: 0 })).status).toBe(400);
  });
});

describe('recorrências', () => {
  it('lançar com repeat cria a recorrência junto e a geração completa os meses vencidos uma única vez', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    const first = await me.post('/transactions', expense(card.id, { name: 'Academia', amount: 119.9, occurredAt: noon('2026-06-05'), repeat: { mode: 'monthly' } }));
    expect(first.status).toBe(201);
    expect(first.body.recurrence).toMatchObject({ installment: null, total: null });

    // "Hoje" é 10/10/2026: vencem julho, agosto, setembro e outubro (dia 5).
    const list = (await me.get('/transactions?limit=50')).body.items;
    expect(list.map((x: { occurredAt: string }) => x.occurredAt.slice(0, 10)).sort()).toEqual(['2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05']);
    expect(list.every((x: { amount: number }) => x.amount === -119.9)).toBe(true);

    // Repetir a leitura não gera de novo.
    expect((await me.get('/transactions?limit=50')).body.items).toHaveLength(5);
    expect((await me.post('/recurrences/materialize')).body).toEqual({ created: 0 });
    expect((await me.get('/recurrences')).body[0]).toMatchObject({ generatedUntil: '2026-10', day: 5, startMonth: '2026-06', total: null });
  });

  it('plano de parcelas numera, para na última e não gera depois', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    const plan = await me.post('/transactions', expense(card.id, { name: 'Celular', amount: 150, occurredAt: noon('2026-08-20'), repeat: { mode: 'installments', total: 4, current: 2 } }));
    expect(plan.body.recurrence).toMatchObject({ installment: 2, total: 4 });

    const items = (await me.get('/transactions?limit=50')).body.items as { installment?: number; recurrence: { installment: number } }[];
    // 20/08 (parcela 2, lançada à mão) e 20/09 (parcela 3). A de 20/10 ainda não venceu em 10/10.
    expect(items.map((x) => x.recurrence.installment).sort()).toEqual([2, 3]);
    expect((await me.get('/recurrences')).body[0]).toMatchObject({ generatedUntil: '2026-09', firstInstallment: 2, total: 4 });
  });

  it('valida o plano e só aceita repetir despesa', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    expect((await me.post('/transactions', expense(card.id, { repeat: { mode: 'installments', total: 3, current: 5 } }))).status).toBe(400);
    expect((await me.post('/transactions', expense(card.id, { repeat: { mode: 'installments', total: 1 } }))).status).toBe(400);
    expect((await me.post('/transactions', expense(card.id, { type: 'income', categoryId: 'salary', repeat: { mode: 'monthly' } }))).status).toBe(400);
  });

  it('applyToNext muda a recorrência; sem ele, só a transação', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    const first = (await me.post('/transactions', expense(card.id, { name: 'Streaming', amount: 30, occurredAt: noon('2026-10-02'), repeat: { mode: 'monthly' } }))).body;

    await me.patch(`/transactions/${first.id}`, { amount: 40 });
    expect((await me.get('/recurrences')).body[0].amount).toBe(30);

    await me.patch(`/transactions/${first.id}`, { amount: 45, name: 'Streaming Plus', applyToNext: true });
    expect((await me.get('/recurrences')).body[0]).toMatchObject({ amount: 45, name: 'Streaming Plus' });
  });

  it('virar receita encerra a recorrência, e encerrar à mão para a geração', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    const a = (await me.post('/transactions', expense(card.id, { name: 'A', occurredAt: noon('2026-10-02'), repeat: { mode: 'monthly' } }))).body;
    await me.patch(`/transactions/${a.id}`, { type: 'income', categoryId: 'salary' });
    const [recA] = (await me.get('/recurrences')).body;
    expect(recA.endMonth).toBe(recA.generatedUntil);

    const b = (await me.post('/transactions', expense(card.id, { name: 'B', occurredAt: noon('2026-08-02'), repeat: { mode: 'monthly' } }))).body;
    const rec = (await me.get('/recurrences')).body.find((r: { name: string }) => r.name === 'B');
    const ended = await me.post(`/recurrences/${rec.id}/end`);
    expect(ended.body.endMonth).toBe('2026-10');
    expect(b.id).toBeTruthy();
  });

  it('o dia 31 cai no último dia do mês curto', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    await me.post('/transactions', expense(card.id, { name: 'Aluguel', occurredAt: noon('2026-07-31'), repeat: { mode: 'monthly' } }));
    const dates = (await me.get('/transactions?limit=50')).body.items.map((x: { occurredAt: string }) => x.occurredAt.slice(0, 10)).sort();
    // 10/10/2026: agosto (31), setembro (30); outubro (31) ainda não venceu.
    expect(dates).toEqual(['2026-07-31', '2026-08-31', '2026-09-30']);
  });

  it('duas leituras simultâneas não geram a mesma parcela duas vezes', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    await me.post('/transactions', expense(card.id, { name: 'Corrida', occurredAt: noon('2026-07-01'), repeat: { mode: 'monthly' } }));
    await Promise.all([me.get('/transactions'), me.get('/cards'), me.get('/recurrences'), me.post('/recurrences/materialize'), me.get('/transactions')]);
    const dates = (await me.get('/transactions?limit=50')).body.items.map((x: { occurredAt: string }) => x.occurredAt.slice(0, 10));
    expect(dates).toHaveLength(4);
    expect(new Set(dates).size).toBe(4);
  });

  it('uma transação gerada e excluída continua excluída', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    await me.post('/transactions', expense(card.id, { name: 'Seguro', occurredAt: noon('2026-08-01'), repeat: { mode: 'monthly' } }));
    const items = (await me.get('/transactions?limit=50')).body.items;
    const september = items.find((x: { occurredAt: string }) => x.occurredAt.startsWith('2026-09'));
    await me.del(`/transactions/${september.id}`);
    expect((await me.get('/transactions?limit=50')).body.items).toHaveLength(items.length - 1);
  });
});

describe('idempotência', () => {
  it('a mesma chave devolve a resposta original sem gravar de novo', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    const key = randomUUID();

    const first = await me.post('/transactions', expense(card.id), { 'idempotency-key': key });
    const second = await me.post('/transactions', expense(card.id), { 'idempotency-key': key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect((await me.get('/transactions')).body.items).toHaveLength(1);

    // Outra chave grava outra.
    await me.post('/transactions', expense(card.id), { 'idempotency-key': randomUUID() });
    expect((await me.get('/transactions')).body.items).toHaveLength(2);
  });

  it('chamadas simultâneas com a mesma chave gravam uma só vez', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => me.post('/transactions', expense(card.id), { 'idempotency-key': key })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect((await me.get('/transactions')).body.items).toHaveLength(1);
  });

  it('vale para contas e transferências, e a chave é por rota e por usuário', async () => {
    const me = await signup(t.app);
    const other = await signup(t.app);
    const key = randomUUID();
    const body = { name: 'X', color: '#000000', lightColor: '#111111' };

    const a = await me.post('/cards', body, { 'idempotency-key': key });
    const b = await me.post('/cards', body, { 'idempotency-key': key });
    expect(b.body.id).toBe(a.body.id);
    expect((await me.get('/cards')).body).toHaveLength(2);

    // O mesmo texto de chave em outra rota ou por outra pessoa não colide.
    const card = await firstCard(me);
    const tx = await me.post('/transactions', expense(card.id), { 'idempotency-key': key });
    expect(tx.status).toBe(201);
    const theirs = await other.post('/cards', body, { 'idempotency-key': key });
    expect(theirs.body.id).not.toBe(a.body.id);
  });

  it('um erro não fica guardado: corrigir e repetir com a mesma chave funciona', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    const key = randomUUID();
    expect((await me.post('/transactions', expense(card.id, { amount: 0 }), { 'idempotency-key': key })).status).toBe(400);
    expect((await me.post('/transactions', expense(card.id), { 'idempotency-key': key })).status).toBe(201);
  });

  it('recusa uma chave malformada', async () => {
    const me = await signup(t.app);
    const card = await firstCard(me);
    const res = await me.post('/transactions', expense(card.id), { 'idempotency-key': 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_idempotency_key');
  });
});

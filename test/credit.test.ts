import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeApp, noon, signup, type Client, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  // "Hoje" fixo: 10/10/2026.
  t = await makeApp({ now: () => new Date('2026-10-10T15:00:00.000Z') });
});
afterAll(() => t.close());

const CREDIT = { lastDigits: '0001', limit: 6000, closingDay: 3, dueDay: 10 };

async function creditCard(c: Client, extra: Record<string, unknown> = {}) {
  const res = await c.post('/cards', { name: 'Nubank', color: '#820AD1', lightColor: '#A04FE0', startingBalance: 1000, credit: CREDIT, ...extra });
  expect(res.status).toBe(201);
  return res.body as { id: number };
}

const mainCard = async (c: Client) => (await c.get('/cards')).body[0].id as number;
const balanceOf = async (c: Client, id: number) => (await c.get(`/cards/${id}`)).body.balance as number;

const expense = (cardId: number, extra: Record<string, unknown> = {}) => ({
  cardId,
  categoryId: 'food',
  name: 'Compra',
  amount: 100,
  type: 'expense',
  occurredAt: noon('2026-10-05'),
  ...extra,
});

const payInvoice = (c: Client, cardId: number, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  c.post(`/cards/${cardId}/invoice-payments`, { month: '2026-11', amount: 200, occurredAt: noon('2026-10-16'), ...extra }, headers);

describe('cartão de crédito na conta', () => {
  it('uma conta sem cartão devolve credit: null, sempre presente', async () => {
    const me = await signup(t.app);
    const card = (await me.get('/cards')).body[0];
    expect(card).toHaveProperty('credit', null);
    const created = await me.post('/cards', { name: 'Carteira', color: '#000000', lightColor: '#111111' });
    expect(created.body).toHaveProperty('credit', null);
  });

  it('cria com o cartão e devolve credit nas rotas de leitura', async () => {
    const me = await signup(t.app);
    const card = await creditCard(me);
    expect((await me.get(`/cards/${card.id}`)).body).toMatchObject({ name: 'Nubank', startingBalance: 1000, credit: CREDIT });
    expect((await me.get('/cards')).body.find((c: { id: number }) => c.id === card.id).credit).toEqual(CREDIT);
  });

  it('o final e o limite são opcionais (padrão "" e nulo); os dias aceitam de 1 a 31', async () => {
    const me = await signup(t.app);
    const res = await me.post('/cards', { name: 'Só dias', color: '#000000', lightColor: '#111111', credit: { closingDay: 31, dueDay: 1 } });
    expect(res.status).toBe(201);
    expect(res.body.credit).toEqual({ lastDigits: '', limit: null, closingDay: 31, dueDay: 1 });
  });

  it('valida o cartão', async () => {
    const me = await signup(t.app);
    const create = (credit: unknown) => me.post('/cards', { name: 'X', color: '#000000', lightColor: '#111111', credit });
    expect((await create({ closingDay: 0, dueDay: 10 })).status).toBe(400);
    expect((await create({ closingDay: 32, dueDay: 10 })).status).toBe(400);
    expect((await create({ closingDay: 3, dueDay: 32 })).status).toBe(400);
    expect((await create({ closingDay: 3 })).status).toBe(400);
    expect((await create({ closingDay: 3.5, dueDay: 10 })).status).toBe(400);
    expect((await create({ lastDigits: '12345', closingDay: 3, dueDay: 10 })).status).toBe(400);
    expect((await create({ lastDigits: 'ab', closingDay: 3, dueDay: 10 })).status).toBe(400);
    expect((await create({ closingDay: 3, dueDay: 10, limit: -1 })).status).toBe(400);
    expect((await create({ lastDigits: '0001', closingDay: 3, dueDay: 10, limit: 0 })).status).toBe(201);
  });

  it('PATCH liga, troca e tira o cartão, sem mexer no resto', async () => {
    const me = await signup(t.app);
    const id = await mainCard(me);

    const on = await me.patch(`/cards/${id}`, { credit: CREDIT });
    expect(on.body.credit).toEqual(CREDIT);
    // Outros campos não mexem no cartão.
    expect((await me.patch(`/cards/${id}`, { name: 'Renomeada' })).body).toMatchObject({ name: 'Renomeada', credit: CREDIT });
    // Trocar os dias vale para a conta inteira.
    expect((await me.patch(`/cards/${id}`, { credit: { ...CREDIT, closingDay: 28, dueDay: 5, limit: null } })).body.credit).toEqual({
      lastDigits: '0001',
      limit: null,
      closingDay: 28,
      dueDay: 5,
    });
    const off = await me.patch(`/cards/${id}`, { credit: null });
    expect(off.status).toBe(200);
    expect(off.body.credit).toBeNull();
    expect((await me.get(`/cards/${id}`)).body.credit).toBeNull();
  });
});

describe('saldo e compras no crédito', () => {
  it('a compra no crédito não mexe no saldo; pagar a fatura tira; excluir o pagamento devolve', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    expect(await balanceOf(me, id)).toBe(1000);

    await me.post('/transactions', expense(id, { amount: 300, paymentMethod: 'credit' }));
    expect(await balanceOf(me, id)).toBe(1000);

    await me.post('/transactions', expense(id, { amount: 50, paymentMethod: 'pix' }));
    await me.post('/transactions', expense(id, { amount: 30, paymentMethod: 'debit' }));
    await me.post('/transactions', expense(id, { amount: 20 })); // sem método: sai do saldo, como sempre
    expect(await balanceOf(me, id)).toBe(900);

    const payment = (await payInvoice(me, id, { amount: 300 })).body;
    expect(await balanceOf(me, id)).toBe(600);

    expect((await me.del(`/transactions/${payment.id}`)).status).toBe(204);
    expect(await balanceOf(me, id)).toBe(900);
  });

  it('pagar a mais fica registrado e o saldo acompanha', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    await me.post('/transactions', expense(id, { amount: 100, paymentMethod: 'credit' }));
    expect((await payInvoice(me, id, { amount: 250 })).status).toBe(201);
    expect(await balanceOf(me, id)).toBe(750);
  });
});

describe('paymentMethod nas transações', () => {
  it('devolve paymentMethod e invoiceMonth (nulos nas transações comuns)', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    const credit = (await me.post('/transactions', expense(id, { paymentMethod: 'credit' }))).body;
    const plain = (await me.post('/transactions', expense(id))).body;
    expect(credit).toMatchObject({ paymentMethod: 'credit', invoiceMonth: null });
    expect(plain).toMatchObject({ paymentMethod: null, invoiceMonth: null });
    expect((await me.get(`/transactions/${credit.id}`)).body.paymentMethod).toBe('credit');
  });

  it('crédito em conta sem cartão é recusado (400, no campo paymentMethod)', async () => {
    const me = await signup(t.app);
    const res = await me.post('/transactions', expense(await mainCard(me), { paymentMethod: 'credit' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.fields[0]).toEqual({ path: 'paymentMethod', message: 'Esta conta não tem cartão de crédito.' });
    // Pix e débito não dependem do cartão.
    expect((await me.post('/transactions', expense(await mainCard(me), { paymentMethod: 'pix' }))).status).toBe(201);
    expect((await me.post('/transactions', expense(await mainCard(me), { paymentMethod: 'debit' }))).status).toBe(201);
  });

  it('só vale em despesa: receita com qualquer forma de pagamento é recusada', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    for (const paymentMethod of ['pix', 'debit', 'credit']) {
      const res = await me.post('/transactions', expense(id, { type: 'income', categoryId: 'salary', paymentMethod }));
      expect(res.status).toBe(400);
      expect(res.body.error.fields[0].path).toBe('paymentMethod');
    }
    // paymentMethod nulo em receita é o normal.
    expect((await me.post('/transactions', expense(id, { type: 'income', categoryId: 'salary', paymentMethod: null }))).status).toBe(201);
  });

  it('não vale na categoria de transferência nem na de fatura (a categoria já é recusada)', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    const transfer = await me.post('/transactions', expense(id, { categoryId: 'transfer', paymentMethod: 'credit' }));
    expect(transfer.status).toBe(400);
    const invoice = await me.post('/transactions', expense(id, { categoryId: 'invoice', paymentMethod: 'credit' }));
    expect(invoice.status).toBe(400);
    expect(invoice.body.error.fields[0].path).toBe('categoryId');
    // Sem paymentMethod, a categoria da fatura continua recusada: use a rota de pagamento.
    expect((await me.post('/transactions', expense(id, { categoryId: 'invoice' }))).status).toBe(400);
    // As transferências não carregam forma de pagamento.
    const other = (await me.post('/cards', { name: 'B', color: '#000000', lightColor: '#111111' })).body;
    const legs = (await me.post('/transfers', { fromCardId: id, toCardId: other.id, amount: 10, occurredAt: noon('2026-10-06') })).body.legs;
    expect(legs.every((l: { paymentMethod: unknown }) => l.paymentMethod === null)).toBe(true);
  });

  it('recusa um valor desconhecido', async () => {
    const me = await signup(t.app);
    expect((await me.post('/transactions', expense(await mainCard(me), { paymentMethod: 'dinheiro' }))).status).toBe(400);
  });

  it('filtra por paymentMethod, aceitando os três valores', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    await me.post('/transactions', expense(id, { name: 'c1', paymentMethod: 'credit' }));
    await me.post('/transactions', expense(id, { name: 'c2', paymentMethod: 'credit' }));
    await me.post('/transactions', expense(id, { name: 'p1', paymentMethod: 'pix' }));
    await me.post('/transactions', expense(id, { name: 'd1', paymentMethod: 'debit' }));
    await me.post('/transactions', expense(id, { name: 'n1' }));

    const names = async (method: string) => (await me.get(`/transactions?paymentMethod=${method}`)).body.items.map((x: { name: string }) => x.name).sort();
    expect(await names('credit')).toEqual(['c1', 'c2']);
    expect(await names('pix')).toEqual(['p1']);
    expect(await names('debit')).toEqual(['d1']);
    expect((await me.get('/transactions?paymentMethod=cash')).status).toBe(400);
  });

  it('edita a forma de pagamento; despesa que vira receita perde o método sozinha', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    const tx = (await me.post('/transactions', expense(id, { paymentMethod: 'credit', amount: 80 }))).body;

    expect((await me.patch(`/transactions/${tx.id}`, { paymentMethod: 'pix' })).body.paymentMethod).toBe('pix');
    expect(await balanceOf(me, id)).toBe(920); // agora sai do saldo
    expect((await me.patch(`/transactions/${tx.id}`, { paymentMethod: 'credit' })).body.paymentMethod).toBe('credit');
    expect(await balanceOf(me, id)).toBe(1000);
    expect((await me.patch(`/transactions/${tx.id}`, { paymentMethod: null })).body.paymentMethod).toBeNull();

    await me.patch(`/transactions/${tx.id}`, { paymentMethod: 'credit' });
    const income = await me.patch(`/transactions/${tx.id}`, { type: 'income', categoryId: 'salary' });
    expect(income.status).toBe(200);
    expect(income.body).toMatchObject({ type: 'income', paymentMethod: null });
    // Pedir um método ao mesmo tempo em que vira receita é recusado.
    const again = (await me.post('/transactions', expense(id, { paymentMethod: 'pix' }))).body;
    expect((await me.patch(`/transactions/${again.id}`, { type: 'income', categoryId: 'salary', paymentMethod: 'pix' })).status).toBe(400);
  });

  it('trocar a conta de uma compra no crédito para uma sem cartão é recusado', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    const plain = await mainCard(me);
    const tx = (await me.post('/transactions', expense(id, { paymentMethod: 'credit' }))).body;

    const moved = await me.patch(`/transactions/${tx.id}`, { cardId: plain });
    expect(moved.status).toBe(400);
    expect(moved.body.error.fields[0]).toMatchObject({ path: 'paymentMethod', message: 'Esta conta não tem cartão de crédito.' });
    // Trocando o método junto, a mudança de conta passa.
    expect((await me.patch(`/transactions/${tx.id}`, { cardId: plain, paymentMethod: 'pix' })).status).toBe(200);
  });
});

describe('pagamento da fatura', () => {
  it('cria uma saída na categoria invoice, com nome, mês e valor negativo', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    const res = await payInvoice(me, id, { month: '2026-11', amount: 1239.37 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      cardId: id,
      categoryId: 'invoice',
      categoryName: 'Fatura do cartão',
      name: 'Fatura Nubank nov/2026',
      amount: -1239.37,
      type: 'expense',
      paymentMethod: null,
      invoiceMonth: '2026-11',
      occurredAt: '2026-10-16T12:00:00.000Z',
      transferId: null,
      recurrence: null,
    });
    // Aparece na lista da conta como qualquer saída.
    expect((await me.get(`/transactions?cardId=${id}`)).body.items.map((x: { id: number }) => x.id)).toContain(res.body.id);
  });

  it('a data do pagamento é o dia de calendário de Brasília, ao meio-dia UTC', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    const res = await payInvoice(me, id, { occurredAt: '2026-10-17T01:00:00.000Z' }); // 22h de 16/10 em Brasília
    expect(res.body.occurredAt).toBe('2026-10-16T12:00:00.000Z');
  });

  it('recusa conta sem cartão, mês inválido, valor zero ou negativo e campos faltando', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    const plain = await mainCard(me);

    const noCard = await payInvoice(me, plain);
    expect(noCard.status).toBe(400);
    expect(noCard.body.error.fields[0].message).toBe('Esta conta não tem cartão de crédito.');
    for (const month of ['2026-13', '2026-1', 'nov/2026', '202611', '']) {
      expect((await payInvoice(me, id, { month })).status).toBe(400);
    }
    expect((await payInvoice(me, id, { amount: 0 })).status).toBe(400);
    expect((await payInvoice(me, id, { amount: -5 })).status).toBe(400);
    expect((await me.post(`/cards/${id}/invoice-payments`, { month: '2026-11' })).status).toBe(400);
    expect((await payInvoice(me, id, { occurredAt: 'ontem' })).status).toBe(400);
  });

  it('a conta de outra pessoa responde 404', async () => {
    const alice = await signup(t.app, 'Alice');
    const bob = await signup(t.app, 'Bob');
    const { id } = await creditCard(alice);
    expect((await payInvoice(bob, id)).status).toBe(404);
    expect((await payInvoice(alice, 999999999)).status).toBe(404);
  });

  it('não se edita (409), mas se exclui', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    const payment = (await payInvoice(me, id)).body;

    for (const patch of [{ amount: 1 }, { name: 'x' }, { paymentMethod: 'pix' }]) {
      const res = await me.patch(`/transactions/${payment.id}`, patch);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('invoice_payment_not_editable');
    }
    expect((await me.del(`/transactions/${payment.id}`)).status).toBe(204);
  });

  it('aceita Idempotency-Key: repetir não paga duas vezes', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    const key = randomUUID();
    const first = await payInvoice(me, id, {}, { 'idempotency-key': key });
    const again = await payInvoice(me, id, {}, { 'idempotency-key': key });

    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await balanceOf(me, id)).toBe(800);
  });

  it('a categoria invoice aparece no catálogo, como a transfer', async () => {
    const me = await signup(t.app);
    const catalog = (await me.get('/categories')).body;
    expect(catalog.find((c: { id: string }) => c.id === 'invoice')).toMatchObject({ name: 'Fatura do cartão', custom: false });
    expect((await me.patch('/categories/invoice', { name: 'x' })).status).toBe(404);
    expect((await me.del('/categories/invoice')).status).toBe(404);
  });
});

describe('relatórios', () => {
  it('contam a compra no crédito no mês da compra e ignoram o pagamento da fatura', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    await me.post('/transactions', expense(id, { amount: 300, paymentMethod: 'credit', occurredAt: noon('2026-10-07') }));
    await me.post('/transactions', expense(id, { amount: 100, paymentMethod: 'pix', occurredAt: noon('2026-10-08') }));
    await me.post('/transactions', expense(id, { type: 'income', categoryId: 'salary', amount: 2000, occurredAt: noon('2026-10-02') }));
    // A fatura que fecha em novembro, paga em 10/11: não é gasto de novembro.
    await payInvoice(me, id, { month: '2026-11', amount: 300, occurredAt: noon('2026-11-10') });
    // E um pagamento no mesmo mês das compras também não entra.
    await payInvoice(me, id, { month: '2026-10', amount: 50, occurredAt: noon('2026-10-20') });

    expect((await me.get('/reports/monthly-totals')).body).toEqual([{ month: '2026-10', income: 2000, expense: 400 }]);
    const october = (await me.get('/reports/category-totals?month=2026-10')).body;
    expect(october.map((c: { categoryId: string; total: number }) => [c.categoryId, c.total])).toEqual([['food', 400]]);
    expect((await me.get('/reports/category-totals?month=2026-11')).body).toEqual([]);
  });

  it('a fatura de um mês não é gasto desse mês nem some o gasto que ela cobre', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    await me.post('/transactions', expense(id, { amount: 120, paymentMethod: 'credit', occurredAt: noon('2026-09-20') }));
    await payInvoice(me, id, { month: '2026-10', amount: 120, occurredAt: noon('2026-10-10') });

    const totals = (await me.get('/reports/monthly-totals')).body;
    expect(totals).toEqual([{ month: '2026-09', income: 0, expense: 120 }]);
  });
});

describe('tirar o cartão (credit_in_use)', () => {
  it('com compras no crédito, recusa; sem elas, deixa', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    const purchase = (await me.post('/transactions', expense(id, { paymentMethod: 'credit' }))).body;

    const refused = await me.patch(`/cards/${id}`, { credit: null });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('credit_in_use');
    expect(refused.body.error.message).toContain('cartão de crédito');
    expect((await me.get(`/cards/${id}`)).body.credit).toEqual(CREDIT);

    await me.del(`/transactions/${purchase.id}`);
    expect((await me.patch(`/cards/${id}`, { credit: null })).status).toBe(200);
  });

  it('compras em pix ou débito não impedem', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    await me.post('/transactions', expense(id, { paymentMethod: 'pix' }));
    await me.post('/transactions', expense(id, { paymentMethod: 'debit' }));
    expect((await me.patch(`/cards/${id}`, { credit: null })).status).toBe(200);
  });

  it('uma recorrência no crédito ainda valendo impede; encerrada, não', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    const first = (await me.post('/transactions', expense(id, { name: 'Streaming', paymentMethod: 'credit', occurredAt: noon('2026-10-05'), repeat: { mode: 'monthly' } }))).body;
    // Sai a compra que já foi lançada: sobra só a recorrência.
    await me.del(`/transactions/${first.id}`);

    const refused = await me.patch(`/cards/${id}`, { credit: null });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('credit_in_use');

    const recurrence = (await me.get('/recurrences')).body[0];
    await me.post(`/recurrences/${recurrence.id}/end`);
    expect((await me.patch(`/cards/${id}`, { credit: null })).status).toBe(200);
  });

  it('mudar o dia de fechamento e vencimento é sempre permitido, mesmo com compras', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    await me.post('/transactions', expense(id, { paymentMethod: 'credit' }));
    expect((await me.patch(`/cards/${id}`, { credit: { ...CREDIT, closingDay: 31, dueDay: 15 } })).body.credit.closingDay).toBe(31);
  });

  // Tirar o cartão ao mesmo tempo em que se grava uma compra no crédito: ou a compra entra e tirar é recusado,
  // ou o cartão sai e a compra é recusada. Nunca erro do servidor nem compra no crédito numa conta sem cartão.
  it('tirar o cartão e comprar ao mesmo tempo nunca dá 500 nem deixa compra órfã', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);

    for (let round = 0; round < 8; round++) {
      const [removed, bought] = await Promise.all([
        me.patch(`/cards/${id}`, { credit: null }),
        me.post('/transactions', expense(id, { name: `c${round}`, paymentMethod: 'credit' })),
      ]);
      expect([200, 409]).toContain(removed.status);
      expect([201, 400]).toContain(bought.status);
      expect((removed.status === 200) !== (bought.status === 201)).toBe(true);

      const now = (await me.get(`/cards/${id}`)).body.credit;
      const credits = (await me.get('/transactions?paymentMethod=credit&limit=100')).body.items;
      if (now === null) expect(credits).toEqual([]);
      // Liga o cartão de novo para a próxima rodada.
      await me.patch(`/cards/${id}`, { credit: CREDIT });
      for (const purchase of credits) await me.del(`/transactions/${purchase.id}`);
    }
  });
});

describe('recorrências e parcelas no crédito', () => {
  it('um parcelado no crédito gera as parcelas seguintes com paymentMethod credit', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    const first = await me.post('/transactions', expense(id, { name: 'Celular', amount: 150, paymentMethod: 'credit', occurredAt: noon('2026-07-05'), repeat: { mode: 'installments', total: 4, current: 1 } }));
    expect(first.status).toBe(201);
    expect(first.body.paymentMethod).toBe('credit');

    // 10/10/2026: já venceram ago, set e out (dia 5), então são 4 parcelas, todas no crédito.
    const items = (await me.get('/transactions?limit=50')).body.items as { paymentMethod: string | null; recurrence: { installment: number } }[];
    expect(items).toHaveLength(4);
    expect(items.every((x) => x.paymentMethod === 'credit')).toBe(true);
    expect(items.map((x) => x.recurrence.installment).sort()).toEqual([1, 2, 3, 4]);

    expect((await me.get('/recurrences')).body[0]).toMatchObject({ paymentMethod: 'credit', total: 4 });
    // Nenhuma parcela mexeu no saldo.
    expect(await balanceOf(me, id)).toBe(1000);
  });

  it('uma recorrência em pix gera as ocorrências em pix, que saem do saldo', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    await me.post('/transactions', expense(id, { name: 'Academia', amount: 100, paymentMethod: 'pix', occurredAt: noon('2026-08-05'), repeat: { mode: 'monthly' } }));
    const items = (await me.get('/transactions?limit=50')).body.items;
    expect(items.every((x: { paymentMethod: string }) => x.paymentMethod === 'pix')).toBe(true);
    expect(await balanceOf(me, id)).toBe(1000 - 300); // ago, set e out
  });

  it('applyToNext copia a forma de pagamento para a recorrência', async () => {
    const me = await signup(t.app);
    const { id } = await creditCard(me);
    const first = (await me.post('/transactions', expense(id, { name: 'Plano', paymentMethod: 'credit', occurredAt: noon('2026-10-02'), repeat: { mode: 'monthly' } }))).body;
    expect((await me.get('/recurrences')).body[0].paymentMethod).toBe('credit');

    await me.patch(`/transactions/${first.id}`, { paymentMethod: 'debit' });
    expect((await me.get('/recurrences')).body[0].paymentMethod).toBe('credit'); // sem applyToNext, só a transação

    await me.patch(`/transactions/${first.id}`, { paymentMethod: 'debit', applyToNext: true });
    expect((await me.get('/recurrences')).body[0].paymentMethod).toBe('debit');
    await me.patch(`/transactions/${first.id}`, { paymentMethod: null, applyToNext: true });
    expect((await me.get('/recurrences')).body[0].paymentMethod).toBeNull();
  });

  it('uma recorrência no crédito exige conta com cartão desde o início', async () => {
    const me = await signup(t.app);
    const res = await me.post('/transactions', expense(await mainCard(me), { paymentMethod: 'credit', repeat: { mode: 'monthly' } }));
    expect(res.status).toBe(400);
    expect((await me.get('/recurrences')).body).toEqual([]);
  });
});

describe('isolamento', () => {
  it('as compras no crédito de uma pessoa não aparecem para outra', async () => {
    const alice = await signup(t.app, 'Alice');
    const bob = await signup(t.app, 'Bob');
    const { id } = await creditCard(alice);
    await alice.post('/transactions', expense(id, { name: 'Segredo no crédito', paymentMethod: 'credit' }));

    expect((await bob.get('/transactions?paymentMethod=credit')).body.items).toEqual([]);
    expect((await bob.get(`/cards/${id}`)).status).toBe(404);
    expect((await bob.patch(`/cards/${id}`, { credit: null })).status).toBe(404);
    expect((await bob.post('/transactions', expense(id, { paymentMethod: 'credit' }))).status).toBe(404);
  });
});

describe('backup v9', () => {
  async function populate(me: Client) {
    const { id } = await creditCard(me, { name: 'Roxinho' });
    const plain = await mainCard(me);
    await me.post('/transactions', expense(id, { name: 'No crédito', amount: 300, paymentMethod: 'credit', occurredAt: noon('2026-10-07') }));
    await me.post('/transactions', expense(id, { name: 'No pix', amount: 40, paymentMethod: 'pix', occurredAt: noon('2026-10-08') }));
    await me.post('/transactions', expense(plain, { name: 'Sem método', amount: 10, occurredAt: noon('2026-10-09') }));
    await me.post('/transactions', expense(id, { name: 'Parcelado', amount: 90, paymentMethod: 'credit', occurredAt: noon('2026-09-05'), repeat: { mode: 'installments', total: 3, current: 1 } }));
    await payInvoice(me, id, { month: '2026-11', amount: 120, occurredAt: noon('2026-10-12') });
    return { id, plain };
  }

  it('exporta com schemaVersion 9 e os campos novos', async () => {
    const me = await signup(t.app);
    await populate(me);
    const exported = (await me.get('/backup')).body;

    expect(exported.schemaVersion).toBe(9);
    const withCard = exported.data.cards.find((c: { name: string }) => c.name === 'Roxinho');
    expect(withCard).toMatchObject({ credit_last_digits: '0001', credit_limit: 6000, closing_day: 3, due_day: 10 });
    const withoutCard = exported.data.cards.find((c: { name: string }) => c.name !== 'Roxinho');
    expect(withoutCard).toMatchObject({ credit_last_digits: null, credit_limit: null, closing_day: null, due_day: null });

    const byName = (name: string) => exported.data.transactions.find((x: { name: string }) => x.name === name);
    expect(byName('No crédito')).toMatchObject({ payment_method: 'credit', invoice_month: null });
    expect(byName('No pix')).toMatchObject({ payment_method: 'pix' });
    expect(byName('Sem método')).toMatchObject({ payment_method: null, invoice_month: null });
    expect(byName('Fatura Roxinho nov/2026')).toMatchObject({ category_id: 'invoice', invoice_month: '2026-11', payment_method: null, amount: -120 });
    expect(exported.data.recurrences[0].payment_method).toBe('credit');
  });

  it('restaura mantendo credit, paymentMethod, invoiceMonth e os saldos', async () => {
    const me = await signup(t.app);
    const { id } = await populate(me);
    const before = {
      cards: (await me.get('/cards')).body.map((c: { name: string; balance: number; credit: unknown }) => [c.name, c.balance, c.credit]),
      items: (await me.get('/transactions?limit=100')).body.items.map((x: { name: string; amount: number; paymentMethod: string | null; invoiceMonth: string | null }) => [x.name, x.amount, x.paymentMethod, x.invoiceMonth]).sort(),
      totals: (await me.get('/reports/monthly-totals')).body,
    };
    expect(before.cards.find((c: unknown[]) => c[0] === 'Roxinho')![2]).toEqual(CREDIT);
    const exported = (await me.get('/backup')).body;

    expect((await me.put('/backup', exported)).status).toBe(204);

    const cardsAfter = (await me.get('/cards')).body;
    expect(cardsAfter.map((c: { name: string; balance: number; credit: unknown }) => [c.name, c.balance, c.credit])).toEqual(before.cards);
    expect(cardsAfter.find((c: { name: string }) => c.name === 'Roxinho').id).not.toBe(id); // ids refeitos
    const itemsAfter = (await me.get('/transactions?limit=100')).body.items.map((x: { name: string; amount: number; paymentMethod: string | null; invoiceMonth: string | null }) => [x.name, x.amount, x.paymentMethod, x.invoiceMonth]).sort();
    expect(itemsAfter).toEqual(before.items);
    expect((await me.get('/reports/monthly-totals')).body).toEqual(before.totals);
    expect((await me.get('/recurrences')).body[0].paymentMethod).toBe('credit');
  });

  it('um backup v8 do app entra com tudo nulo nos campos novos', async () => {
    const me = await signup(t.app);
    const v8 = JSON.parse(readFileSync(new URL('./fixtures/app-backup-v8.json', import.meta.url), 'utf8'));
    expect(v8.schemaVersion).toBe(8);
    expect((await me.put('/backup', v8)).status).toBe(204);

    expect((await me.get('/cards')).body.every((c: { credit: unknown }) => c.credit === null)).toBe(true);
    const items = (await me.get('/transactions?limit=100')).body.items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((x: { paymentMethod: unknown; invoiceMonth: unknown }) => x.paymentMethod === null && x.invoiceMonth === null)).toBe(true);
    expect((await me.get('/recurrences')).body.every((r: { paymentMethod: unknown }) => r.paymentMethod === null)).toBe(true);
    expect((await me.get('/backup')).body.schemaVersion).toBe(9);
  });

  it('arquivos das versões 1 e 6 também entram', async () => {
    const me = await signup(t.app);
    const v1 = { app: 'sobro', format: 1, schemaVersion: 1, data: { cards: [{ id: 1, name: 'Carteira', number: '0001', color: '#3161B2', light_color: '#4A74BB', balance: 10 }], transactions: [{ id: 1, card_id: 1, category_id: 'food', name: 'x', amount: -5, type: 'expense', occurred_at: '2026-10-05T12:00:00.000Z' }] } };
    expect((await me.put('/backup', v1)).status).toBe(204);
    expect((await me.get('/cards')).body[0]).toMatchObject({ balance: 5, credit: null });
  });

  const base = () => ({
    app: 'sobro',
    format: 1,
    schemaVersion: 9,
    data: {
      cards: [
        { id: 1, name: 'Com cartão', number: '1', color: '#000000', light_color: '#111111', balance: 0, credit_last_digits: '0001', credit_limit: 1000, closing_day: 3, due_day: 10 },
        { id: 2, name: 'Sem cartão', number: '2', color: '#000000', light_color: '#111111', balance: 0 },
      ],
      transactions: [
        { id: 1, card_id: 1, category_id: 'food', name: 't', amount: -5, type: 'expense', occurred_at: '2026-10-05T12:00:00.000Z', payment_method: 'credit' },
      ],
    },
  });

  it('a base de teste é válida', async () => {
    const me = await signup(t.app);
    expect((await me.put('/backup', base())).status).toBe(204);
  });

  it.each([
    ['cartão com fechamento e sem vencimento', (b: any) => (b.data.cards[0].due_day = null)],
    ['cartão com vencimento e sem fechamento', (b: any) => (b.data.cards[0].closing_day = null)],
    ['dia de fechamento 32', (b: any) => (b.data.cards[0].closing_day = 32)],
    ['dia de vencimento 0', (b: any) => (b.data.cards[0].due_day = 0)],
    ['limite negativo', (b: any) => (b.data.cards[0].credit_limit = -1)],
    ['forma de pagamento desconhecida', (b: any) => (b.data.transactions[0].payment_method = 'cash')],
    ['crédito em conta sem cartão', (b: any) => (b.data.transactions[0].card_id = 2)],
    ['forma de pagamento em receita', (b: any) => Object.assign(b.data.transactions[0], { type: 'income', amount: 5, category_id: 'salary', payment_method: 'pix' })],
    ['forma de pagamento na categoria de transferência', (b: any) => Object.assign(b.data.transactions[0], { category_id: 'transfer', payment_method: 'pix' })],
    ['pagamento de fatura sem mês', (b: any) => Object.assign(b.data.transactions[0], { category_id: 'invoice', payment_method: null, invoice_month: null })],
    ['pagamento de fatura com mês inválido', (b: any) => Object.assign(b.data.transactions[0], { category_id: 'invoice', payment_method: null, invoice_month: 'nov' })],
    ['pagamento de fatura com valor positivo', (b: any) => Object.assign(b.data.transactions[0], { category_id: 'invoice', payment_method: null, invoice_month: '2026-11', type: 'income', amount: 5 })],
    ['mês de fatura numa transação comum', (b: any) => Object.assign(b.data.transactions[0], { payment_method: null, invoice_month: '2026-11' })],
    ['recorrência no crédito em conta sem cartão', (b: any) => (b.data.recurrences = [{ id: 1, card_id: 2, category_id: 'food', name: 'r', amount: 5, day: 5, start_month: '2026-10', generated_until: '2026-10', payment_method: 'credit' }])],
    ['recorrência com forma de pagamento desconhecida', (b: any) => (b.data.recurrences = [{ id: 1, card_id: 1, category_id: 'food', name: 'r', amount: 5, day: 5, start_month: '2026-10', generated_until: '2026-10', payment_method: 'cash' }])],
  ])('recusa um backup com %s e não muda nada', async (_name, break_) => {
    const me = await signup(t.app);
    await me.post('/transactions', expense(await mainCard(me), { name: 'Intacta' }));

    const body = base();
    break_(body);
    const res = await me.put('/backup', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_backup');
    expect((await me.get('/transactions')).body.items.map((x: { name: string }) => x.name)).toEqual(['Intacta']);
  });
});

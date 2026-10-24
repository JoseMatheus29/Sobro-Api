import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { invoiceDueMonth } from '../src/shared/payment.js';
import { makeApp, noon, signup, type Client, type TestApp } from './helpers.js';

let t: TestApp;
const users: string[] = [];
beforeAll(async () => {
  // "Hoje" fixo: 10/10/2026.
  t = await makeApp({ now: () => new Date('2026-10-10T15:00:00.000Z') });
});
afterAll(() => t.close());

async function newUser() {
  const me = await signup(t.app);
  users.push(me.userId);
  return me;
}

async function creditCard(c: Client, closingDay: number, dueDay: number, name = 'Cartão') {
  const res = await c.post('/cards', { name, color: '#820AD1', lightColor: '#A04FE0', credit: { closingDay, dueDay } });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

const mainCard = async (c: Client) => (await c.get('/cards')).body[0].id as number;

const buy = (c: Client, cardId: number, date: string, extra: Record<string, unknown> = {}) =>
  c.post('/transactions', {
    cardId,
    categoryId: 'food',
    name: 'Compra',
    amount: 100,
    type: 'expense',
    occurredAt: noon(date),
    paymentMethod: 'credit',
    ...extra,
  });

const spendingOf = async (c: Client, id: number) => (await c.get(`/transactions/${id}`)).body.spendingMonth as string;

// Linhas cujo spending_month gravado difere do que a função calcula agora, entre os usuários deste arquivo.
async function mismatches(): Promise<number> {
  const list = sql.join(users.map((u) => sql`${u}::uuid`), sql`, `);
  const res = await t.db.execute(sql`
    select count(*)::int as n from transactions t join cards c on c.id = t.card_id
    where t.user_id in (${list})
      and t.spending_month is distinct from spending_month_of(t.occurred_at, t.payment_method, c.closing_day, c.due_day)`);
  return (res.rows[0] as { n: number }).n;
}

// [rótulo, data, forma de pagamento, fechamento, vencimento, mês do gasto esperado]
const CASES: [string, string, string | null, number | null, number | null, string][] = [
  ['C=3 D=10, 27/10', '2026-10-27', 'credit', 3, 10, '2026-11'],
  ['C=3 D=10, 03/11 (o dia do fechamento ainda entra)', '2026-11-03', 'credit', 3, 10, '2026-11'],
  ['C=3 D=10, 05/11', '2026-11-05', 'credit', 3, 10, '2026-12'],
  ['C=25 D=5, 25/10', '2026-10-25', 'credit', 25, 5, '2026-11'],
  ['C=25 D=5, 27/10', '2026-10-27', 'credit', 25, 5, '2026-12'],
  ['C=31 D=5, 28/02 (fevereiro fecha no 28)', '2026-02-28', 'credit', 31, 5, '2026-03'],
  ['C=31 D=5, 01/03', '2026-03-01', 'credit', 31, 5, '2026-04'],
  ['C=31 D=5, 29/02 de ano bissexto', '2028-02-29', 'credit', 31, 5, '2028-03'],
  ['C=30 D=31, 30/04 (vence no mês em que fecha)', '2026-04-30', 'credit', 30, 31, '2026-04'],
  ['C=25 D=5, 31/12 (vira o ano)', '2026-12-31', 'credit', 25, 5, '2027-02'],
  ['C=25 D=25 (vence no mesmo dia: mês seguinte), 10/10', '2026-10-10', 'credit', 25, 25, '2026-11'],
  ['Pix de 27/10', '2026-10-27', 'pix', 25, 5, '2026-10'],
  ['débito', '2026-10-27', 'debit', 25, 5, '2026-10'],
  ['sem forma de pagamento', '2026-10-27', null, 25, 5, '2026-10'],
  ['conta sem cartão', '2026-10-27', null, null, null, '2026-10'],
];

describe('spending_month_of (a regra, no banco)', () => {
  it.each(CASES)('%s', async (_label, date, method, closing, due, expected) => {
    const res = await t.db.execute(
      sql`select spending_month_of(${`${date}T12:00:00.000Z`}::timestamptz, ${method}::text, ${closing}::integer, ${due}::integer) as m`
    );
    expect((res.rows[0] as { m: string }).m).toBe(expected);
  });
});

describe('invoiceDueMonth (nome da fatura)', () => {
  it.each([
    ['2026-11', 3, 10, '2026-11'],
    ['2026-11', 25, 5, '2026-12'],
    ['2026-12', 25, 5, '2027-01'],
    ['2026-03', 30, 31, '2026-03'],
    ['2026-03', 10, 10, '2026-04'],
  ])('fecha em %s (C=%i, D=%i) → vence em %s', (month, closing, due, expected) => {
    expect(invoiceDueMonth(month, closing, due)).toBe(expected);
  });
});

describe('spendingMonth nas transações', () => {
  it('uma compra no crédito conta no mês do vencimento; a data continua a da compra', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    const res = await buy(me, card, '2026-10-27');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ spendingMonth: '2026-12', paymentMethod: 'credit' });
    expect(res.body.occurredAt).toBe(noon('2026-10-27'));

    // O fechamento ainda inclui a compra do dia 25: ela vence em novembro.
    expect((await buy(me, card, '2026-10-25')).body.spendingMonth).toBe('2026-11');
    expect(await mismatches()).toBe(0);
  });

  it('Pix, débito, sem forma de pagamento, receita e transferência contam no mês da data', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    const other = await mainCard(me);
    for (const method of ['pix', 'debit', null]) {
      expect((await buy(me, card, '2026-10-27', { paymentMethod: method })).body.spendingMonth).toBe('2026-10');
    }
    const income = await me.post('/transactions', { cardId: card, categoryId: 'salary', name: 'Salário', amount: 500, type: 'income', occurredAt: noon('2026-10-27') });
    expect(income.body.spendingMonth).toBe('2026-10');
    const transfer = await me.post('/transfers', { fromCardId: card, toCardId: other, amount: 10, occurredAt: noon('2026-10-27') });
    expect(transfer.status).toBe(201);
    expect(transfer.body.legs.map((l: { spendingMonth: string }) => l.spendingMonth)).toEqual(['2026-10', '2026-10']);
    expect(await mismatches()).toBe(0);
  });

  it('aparece na lista, no detalhe e na edição', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    const created = (await buy(me, card, '2026-10-27')).body;
    expect((await me.get(`/transactions/${created.id}`)).body.spendingMonth).toBe('2026-12');
    expect((await me.get('/transactions')).body.items[0].spendingMonth).toBe('2026-12');
    expect((await me.patch(`/transactions/${created.id}`, { name: 'Outro nome' })).body.spendingMonth).toBe('2026-12');
  });

  it('editar a data de um lado a outro do fechamento muda o mês do gasto', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    const id = (await buy(me, card, '2026-10-25')).body.id as number;
    expect(await spendingOf(me, id)).toBe('2026-11');
    expect((await me.patch(`/transactions/${id}`, { occurredAt: noon('2026-10-26') })).body.spendingMonth).toBe('2026-12');
    expect((await me.patch(`/transactions/${id}`, { occurredAt: noon('2026-10-01') })).body.spendingMonth).toBe('2026-11');
    expect(await mismatches()).toBe(0);
  });

  it('trocar a forma de pagamento volta ao mês da data, e voltar ao crédito refaz', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    const id = (await buy(me, card, '2026-10-27')).body.id as number;
    expect((await me.patch(`/transactions/${id}`, { paymentMethod: 'pix' })).body.spendingMonth).toBe('2026-10');
    expect((await me.patch(`/transactions/${id}`, { paymentMethod: 'credit' })).body.spendingMonth).toBe('2026-12');
    expect((await me.patch(`/transactions/${id}`, { paymentMethod: null })).body.spendingMonth).toBe('2026-10');
  });

  it('virar receita zera a forma de pagamento e o mês do gasto volta ao da data', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    const id = (await buy(me, card, '2026-10-27')).body.id as number;
    const res = await me.patch(`/transactions/${id}`, { type: 'income', categoryId: 'salary' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paymentMethod: null, spendingMonth: '2026-10' });
  });

  it('trocar de conta usa os dias da conta nova', async () => {
    const me = await newUser();
    const a = await creditCard(me, 25, 5, 'A');
    const b = await creditCard(me, 3, 10, 'B');
    const id = (await buy(me, a, '2026-10-27')).body.id as number;
    expect(await spendingOf(me, id)).toBe('2026-12');
    expect((await me.patch(`/transactions/${id}`, { cardId: b })).body.spendingMonth).toBe('2026-11');
    expect(await mismatches()).toBe(0);
  });

  it('um pagamento de fatura conta no mês da data', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    const res = await me.post(`/cards/${card}/invoice-payments`, { month: '2026-11', amount: 50, occurredAt: noon('2026-12-01') });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ categoryId: 'invoice', invoiceMonth: '2026-11', spendingMonth: '2026-12' });
  });

  it('o nome do pagamento usa o mês do vencimento da fatura', async () => {
    const me = await newUser();
    // Fecha em 25/11 e vence em 05/12: o banco a chama de dezembro.
    const wraps = await creditCard(me, 25, 5, 'Roxo');
    const wrapped = await me.post(`/cards/${wraps}/invoice-payments`, { month: '2026-11', amount: 50, occurredAt: noon('2026-12-01') });
    expect(wrapped.body.name).toBe('Fatura Roxo dez/2026');
    expect(wrapped.body.invoiceMonth).toBe('2026-11');
    // Vencimento depois do fechamento: o mesmo mês.
    const same = await creditCard(me, 3, 10, 'Azul');
    const plain = await me.post(`/cards/${same}/invoice-payments`, { month: '2026-11', amount: 50, occurredAt: noon('2026-11-09') });
    expect(plain.body.name).toBe('Fatura Azul nov/2026');
    // Vira o ano.
    const year = await me.post(`/cards/${wraps}/invoice-payments`, { month: '2026-12', amount: 50, occurredAt: noon('2027-01-02') });
    expect(year.body.name).toBe('Fatura Roxo jan/2027');
  });
});

describe('filtro spendingMonth', () => {
  it('seleciona pelo mês do gasto, e month continua selecionando pela data', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    const purchase = (await buy(me, card, '2026-10-27')).body.id as number;
    const pix = (await buy(me, card, '2026-12-03', { paymentMethod: 'pix' })).body.id as number;

    const ids = async (q: string) => ((await me.get(`/transactions?${q}`)).body.items as { id: number }[]).map((i) => i.id).sort();
    expect(await ids('spendingMonth=2026-12')).toEqual([purchase, pix].sort());
    expect(await ids('spendingMonth=2026-10')).toEqual([]);
    expect(await ids('month=2026-10')).toEqual([purchase]);
    expect(await ids('month=2026-12')).toEqual([pix]);
    // Os dois juntos valem os dois.
    expect(await ids('month=2026-10&spendingMonth=2026-12')).toEqual([purchase]);
    expect(await ids('month=2026-12&spendingMonth=2026-10')).toEqual([]);
  });

  it('pagina por cursor com o filtro', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    for (const day of ['2026-10-26', '2026-10-27', '2026-10-28']) await buy(me, card, day);
    const first = (await me.get('/transactions?spendingMonth=2026-12&limit=2')).body;
    expect(first.items).toHaveLength(2);
    const second = (await me.get(`/transactions?spendingMonth=2026-12&limit=2&cursor=${first.nextCursor}`)).body;
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('recusa um valor inválido', async () => {
    const me = await newUser();
    for (const bad of ['2026-13', '2026-1', 'dezembro', '']) {
      const res = await me.get(`/transactions?spendingMonth=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
  });

  it('não enxerga o mês do gasto de outra pessoa', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    await buy(owner, await creditCard(owner, 25, 5), '2026-10-27');
    expect((await stranger.get('/transactions?spendingMonth=2026-12')).body.items).toEqual([]);
  });
});

describe('mudar os dias do cartão', () => {
  it('refaz o mês do gasto das compras no crédito daquela conta, e só delas', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    const other = await creditCard(me, 25, 5, 'Outro');
    const purchase = (await buy(me, card, '2026-10-27')).body.id as number;
    const pix = (await buy(me, card, '2026-10-27', { paymentMethod: 'pix' })).body.id as number;
    const elsewhere = (await buy(me, other, '2026-10-27')).body.id as number;
    expect(await spendingOf(me, purchase)).toBe('2026-12');

    const res = await me.patch(`/cards/${card}`, { credit: { closingDay: 28, dueDay: 10 } });
    expect(res.status).toBe(200);
    // Agora a compra de 27/10 entra na fatura que fecha em 28/10 e vence em 10/11.
    expect(await spendingOf(me, purchase)).toBe('2026-11');
    expect(await spendingOf(me, pix)).toBe('2026-10');
    expect(await spendingOf(me, elsewhere)).toBe('2026-12');
    expect(await mismatches()).toBe(0);
  });

  it('um PATCH que não mexe no cartão não altera nada', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    const id = (await buy(me, card, '2026-10-27')).body.id as number;
    await me.patch(`/cards/${card}`, { name: 'Renomeado' });
    expect(await spendingOf(me, id)).toBe('2026-12');
  });

  it('trocar os dias no meio de várias compras não deixa nenhuma com o mês errado', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    const days = ['01', '10', '20', '25', '26', '28'];
    const patches = [3, 28, 15, 25, 5].map((d) => me.patch(`/cards/${card}`, { credit: { closingDay: d, dueDay: 10 } }));
    const purchases = days.map((d) => buy(me, card, `2026-10-${d}`));
    const results = await Promise.all([...patches, ...purchases]);
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(await mismatches()).toBe(0);
  });
});

describe('recorrências e parcelas', () => {
  it('cada parcela no crédito nasce com o mês de vencimento da sua própria fatura', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    // Parcelas no dia 27: jul, ago e set já venceram em 10/10/2026.
    const first = await buy(me, card, '2026-07-27', { name: 'Celular', repeat: { mode: 'installments', total: 4, current: 1 } });
    expect(first.status).toBe(201);
    const items = (await me.get('/transactions?limit=50')).body.items as { occurredAt: string; spendingMonth: string; recurrence: { installment: number } }[];
    const bySpending = items.sort((a, b) => a.recurrence.installment - b.recurrence.installment).map((i) => [i.recurrence.installment, i.spendingMonth]);
    // Compra de 27/07 → fatura que fecha em 25/08 → vence em 05/09; e assim por diante.
    expect(bySpending).toEqual([[1, '2026-09'], [2, '2026-10'], [3, '2026-11']]);
    expect(await mismatches()).toBe(0);
  });

  it('a geração das ocorrências no crédito espera uma troca de dias do cartão em andamento', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    await buy(me, card, '2026-08-27', { name: 'Plano', repeat: { mode: 'monthly' } });

    // Como o PATCH do cartão: trava a conta, troca os dias e refaz as compras no crédito. A geração (disparada por
    // um GET no meio disso) tem de esperar a troca terminar e gravar com os dias novos, não com os antigos.
    let finished = false;
    let request: Promise<unknown> = Promise.resolve();
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from cards where id = ${card} for update`);
      request = me.get('/transactions').then((res) => {
        finished = true;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished).toBe(false);
      await tx.execute(sql`update cards set closing_day = 28, due_day = 10 where id = ${card}`);
      await tx.execute(
        sql`update transactions set spending_month = spending_month_of(occurred_at, payment_method, 28, 10) where card_id = ${card} and payment_method = 'credit'`
      );
    });
    await request;
    expect(finished).toBe(true);
    expect(await mismatches()).toBe(0);
  });

  it('uma recorrência em pix gera ocorrências no mês da data', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    await buy(me, card, '2026-08-27', { paymentMethod: 'pix', name: 'Academia', repeat: { mode: 'monthly' } });
    const months = ((await me.get('/transactions?limit=50')).body.items as { spendingMonth: string }[]).map((i) => i.spendingMonth).sort();
    expect(months).toEqual(['2026-08', '2026-09']);
  });
});

describe('relatórios por mês do gasto', () => {
  async function scenario() {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    await buy(me, card, '2026-10-27', { amount: 300, categoryId: 'shopping' });
    await buy(me, card, '2026-10-20', { amount: 100, categoryId: 'food' });
    await buy(me, card, '2026-10-27', { amount: 40, categoryId: 'food', paymentMethod: 'pix' });
    await me.post('/transactions', { cardId: card, categoryId: 'salary', name: 'Salário', amount: 1000, type: 'income', occurredAt: noon('2026-10-05') });
    await me.post(`/cards/${card}/invoice-payments`, { month: '2026-11', amount: 100, occurredAt: noon('2026-10-30') });
    return me;
  }

  it('by=date (e sem by) agrupa pela data, como sempre', async () => {
    const me = await scenario();
    const expected = [{ month: '2026-10', income: 1000, expense: 440 }];
    expect((await me.get('/reports/monthly-totals')).body).toEqual(expected);
    expect((await me.get('/reports/monthly-totals?by=date')).body).toEqual(expected);
  });

  it('by=spending agrupa pelo mês em que o gasto conta, sem o pagamento da fatura', async () => {
    const me = await scenario();
    const res = (await me.get('/reports/monthly-totals?by=spending')).body as { month: string; income: number; expense: number }[];
    // 27/10 → fatura de nov (vence 05/12); 20/10 → fatura de out (vence 05/11); o Pix e a receita ficam em outubro.
    expect(res).toEqual([
      { month: '2026-12', income: 0, expense: 300 },
      { month: '2026-11', income: 0, expense: 100 },
      { month: '2026-10', income: 1000, expense: 40 },
    ]);
  });

  it('os dois modos somam o mesmo total no conjunto de todos os meses', async () => {
    const me = await scenario();
    const sum = (rows: { income: number; expense: number }[]) => rows.reduce((acc, r) => [acc[0]! + r.income, acc[1]! + r.expense], [0, 0]);
    const byDate = sum((await me.get('/reports/monthly-totals?by=date')).body);
    const bySpending = sum((await me.get('/reports/monthly-totals?by=spending')).body);
    expect(bySpending).toEqual(byDate);
  });

  it('category-totals?by=spending soma as despesas do mês do gasto', async () => {
    const me = await scenario();
    const dec = (await me.get('/reports/category-totals?month=2026-12&by=spending')).body as { categoryId: string; total: number }[];
    expect(dec.map((c) => [c.categoryId, c.total])).toEqual([['shopping', 300]]);
    const nov = (await me.get('/reports/category-totals?month=2026-11&by=spending')).body as { categoryId: string; total: number }[];
    expect(nov.map((c) => [c.categoryId, c.total])).toEqual([['food', 100]]);
    // Por data, tudo continua em outubro, e o pagamento da fatura nunca entra.
    const oct = (await me.get('/reports/category-totals?month=2026-10')).body as { categoryId: string; total: number }[];
    expect(oct.map((c) => [c.categoryId, c.total])).toEqual([['shopping', 300], ['food', 140]]);
    expect(oct.some((c) => c.categoryId === 'invoice')).toBe(false);
  });

  it('recusa um by desconhecido', async () => {
    const me = await newUser();
    for (const url of ['/reports/monthly-totals?by=vencimento', '/reports/category-totals?month=2026-10&by=x']) {
      const res = await me.get(url);
      expect(res.status, url).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
  });

  it('os totais de uma pessoa não incluem os de outra', async () => {
    const owner = await scenario();
    const stranger = await newUser();
    expect((await stranger.get('/reports/monthly-totals?by=spending')).body).toEqual([]);
    expect((await owner.get('/reports/monthly-totals?by=spending')).body.length).toBe(3);
  });
});

describe('backup', () => {
  it('o mês do gasto não vai no arquivo e a restauração o recalcula', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    await buy(me, card, '2026-10-27');
    await buy(me, card, '2026-10-20', { paymentMethod: 'pix' });
    const before = ((await me.get('/transactions')).body.items as { name: string; occurredAt: string; spendingMonth: string }[])
      .map((i) => `${i.occurredAt} ${i.spendingMonth}`)
      .sort();

    const exported = (await me.get('/backup')).body;
    expect(exported.schemaVersion).toBe(9);
    expect(JSON.stringify(exported)).not.toContain('spending_month');

    expect((await me.put('/backup', exported)).status).toBe(204);
    const after = ((await me.get('/transactions')).body.items as { occurredAt: string; spendingMonth: string }[])
      .map((i) => `${i.occurredAt} ${i.spendingMonth}`)
      .sort();
    expect(after).toEqual(before);
    expect(await mismatches()).toBe(0);
  });

  it('restaurar com os dias do cartão alterados no arquivo usa os dias do arquivo', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    await buy(me, card, '2026-10-27');
    const exported = (await me.get('/backup')).body;
    const cardRow = exported.data.cards.find((c: { closing_day: number | null }) => c.closing_day !== null);
    cardRow.closing_day = 28;
    cardRow.due_day = 10;
    expect((await me.put('/backup', exported)).status).toBe(204);
    expect((await me.get('/transactions')).body.items[0].spendingMonth).toBe('2026-11');
  });
});

describe('migração 0007', () => {
  it('o backfill preenche o que já existe com o mesmo resultado da regra', async () => {
    const me = await newUser();
    const card = await creditCard(me, 25, 5);
    const other = await creditCard(me, 3, 10, 'Outro');
    for (const [id, date] of [[card, '2026-10-27'], [card, '2026-10-25'], [other, '2026-11-05']] as const) await buy(me, id, date);
    await buy(me, card, '2026-10-27', { paymentMethod: 'pix' });
    const expected = ((await me.get('/transactions')).body.items as { id: number; spendingMonth: string }[]).map((i) => [i.id, i.spendingMonth]);

    // Apaga o mês do gasto das linhas deste usuário e roda o UPDATE do arquivo da migração, só para elas.
    const file = readFileSync(new URL('../drizzle/0007_mes_do_gasto.sql', import.meta.url), 'utf8');
    const update = /UPDATE "transactions" t[\s\S]*?WHERE c\."id" = t\."card_id";/.exec(file)?.[0];
    expect(update).toBeTruthy();
    await t.db.execute(sql`update transactions set spending_month = '1999-01' where user_id = ${me.userId}::uuid`);
    await t.db.execute(sql.raw(update!.replace(/;$/, ` AND t."user_id" = '${me.userId}'`)));
    const restored = ((await me.get('/transactions')).body.items as { id: number; spendingMonth: string }[]).map((i) => [i.id, i.spendingMonth]);
    expect(restored).toEqual(expected);
  });
});

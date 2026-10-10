import { describe, expect, it } from 'vitest';

import { maskUrl } from '../src/lib/logging.js';
import { compareVersions } from '../src/lib/version.js';
import { addMonths, calendarNoon, monthKey, monthRange } from '../src/shared/month.js';
import { dueOccurrences, lastMonthOf, occurrenceDate, occurrenceIn, type RecurrenceRule } from '../src/shared/recurrence.js';
import { escapeLike, foldText, searchWords } from '../src/shared/search.js';

const rule = (overrides: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  day: 20,
  startMonth: '2026-09',
  firstInstallment: 3,
  total: 10,
  endMonth: null,
  generatedUntil: '2026-09',
  ...overrides,
});
const monthly = (overrides: Partial<RecurrenceRule> = {}) => rule({ day: 3, firstInstallment: 1, total: null, ...overrides });

describe('month', () => {
  it('soma meses atravessando o ano', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });

  it('dá a faixa [início, fim) do mês em UTC', () => {
    const { start, end } = monthRange('2026-12');
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(monthKey(start)).toBe('2026-12');
  });

  it('calendarNoon usa o dia que a pessoa vê no fuso', () => {
    // 22h de Brasília no último dia do mês é 01h UTC do dia seguinte: continua no dia 30.
    expect(calendarNoon(new Date('2026-10-01T01:00:00.000Z'), 'America/Sao_Paulo').toISOString()).toBe('2026-09-30T12:00:00.000Z');
    expect(calendarNoon(new Date('2026-10-01T12:00:00.000Z'), 'America/Sao_Paulo').toISOString()).toBe('2026-10-01T12:00:00.000Z');
  });

  it('calendarNoon é idempotente para o meio-dia UTC que o app grava', () => {
    const once = calendarNoon(new Date('2026-10-05T12:00:00.000Z'), 'America/Sao_Paulo');
    expect(calendarNoon(once, 'America/Sao_Paulo').toISOString()).toBe(once.toISOString());
  });
});

describe('recorrência', () => {
  it('a ocorrência cai no dia do vencimento, ao meio-dia UTC', () => {
    expect(occurrenceDate('2026-10', 20)).toBe('2026-10-20T12:00:00.000Z');
  });

  it('dia 31 cai no último dia de um mês curto', () => {
    expect(occurrenceDate('2027-02', 31)).toBe('2027-02-28T12:00:00.000Z');
    expect(occurrenceDate('2028-02', 31)).toBe('2028-02-29T12:00:00.000Z');
    expect(occurrenceDate('2026-04', 31)).toBe('2026-04-30T12:00:00.000Z');
  });

  it('um plano de parcelas termina no mês da última parcela', () => {
    expect(lastMonthOf(rule())).toBe('2027-04');
    expect(lastMonthOf(monthly())).toBeNull();
  });

  it('encerrar à mão para antes do plano, nunca depois', () => {
    expect(lastMonthOf(rule({ endMonth: '2026-12' }))).toBe('2026-12');
    expect(lastMonthOf(rule({ endMonth: '2030-01' }))).toBe('2027-04');
  });

  it('numera as parcelas a partir da lançada à mão', () => {
    expect(occurrenceIn(rule(), '2026-10')).toMatchObject({ month: '2026-10', installment: 4 });
    expect(occurrenceIn(rule(), '2027-04')).toMatchObject({ installment: 10 });
    expect(occurrenceIn(rule(), '2026-09')).toBeNull();
    expect(occurrenceIn(rule(), '2027-05')).toBeNull();
  });

  it('só gera o que já venceu, do mês seguinte ao último gerado', () => {
    const now = new Date('2026-12-10T12:00:00.000Z');
    expect(dueOccurrences(rule(), now).map((o) => o.month)).toEqual(['2026-10', '2026-11']);
    // Em 20/12 a de dezembro (dia 20) ainda não venceu às 12h do dia 10.
    expect(dueOccurrences(rule(), new Date('2026-12-20T12:00:00.000Z')).map((o) => o.month)).toEqual(['2026-10', '2026-11', '2026-12']);
  });

  it('não repete o que já foi gerado e para no fim do plano', () => {
    const now = new Date('2030-01-01T12:00:00.000Z');
    expect(dueOccurrences(rule({ generatedUntil: '2027-04' }), now)).toEqual([]);
    expect(dueOccurrences(rule(), now).at(-1)?.installment).toBe(10);
  });
});

describe('busca', () => {
  it('dobra acento e caixa', () => {
    expect(foldText('  Alimentação ')).toBe('alimentacao');
  });

  it('separa as palavras e limita a quantidade', () => {
    expect(searchWords('Pão  de   queijo')).toEqual(['pao', 'de', 'queijo']);
    expect(searchWords('a b c d e f g h i j')).toHaveLength(8);
  });

  it('escapa os curingas do LIKE', () => {
    expect(escapeLike('100%_ok\\')).toBe('100\\%\\_ok\\\\');
  });
});

describe('versão do app', () => {
  it('compara numericamente', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
    expect(compareVersions('2.0.1', '2.0.0')).toBe(1);
    expect(compareVersions('2.0.0-beta', '2.0.0')).toBe(0);
  });
});

describe('máscara de logs', () => {
  it('esconde o termo buscado e tokens da URL', () => {
    expect(maskUrl('/v1/transactions?month=2026-10&q=remedio')).toBe('/v1/transactions?month=2026-10&q=%5Bredacted%5D');
    expect(maskUrl('/v1/cards')).toBe('/v1/cards');
  });
});

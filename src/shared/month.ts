// Portado de utils/month.ts do app. Meses são chaves 'YYYY-MM' lidas em UTC.
// `occurred_at` guarda a data de calendário como meio-dia UTC, então o fuso não muda o dia (ver docs, seção 2).

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: string): boolean {
  return MONTH_RE.test(value);
}

export function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function parseKey(key: string): { year: number; month: number } {
  const [year, month] = key.split('-').map(Number) as [number, number];
  return { year, month: month - 1 };
}

export function addMonths(key: string, delta: number): string {
  const { year, month } = parseKey(key);
  return monthKey(new Date(Date.UTC(year, month + delta, 1, 12)));
}

// [início, fim) do mês em UTC, para filtrar `occurred_at` por faixa e usar o índice.
export function monthRange(key: string): { start: Date; end: Date } {
  const { year, month } = parseKey(key);
  return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) };
}

// Data de calendário (no fuso informado) de um instante, como meio-dia UTC desse dia.
// É o "hoje" da geração de recorrências e a normalização de registros antigos do backup.
export function calendarNoon(instant: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant); // 'YYYY-MM-DD'
  const [y, m, d] = parts.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12));
}

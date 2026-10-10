// Portado de utils/recurrence.ts do app: as mesmas regras de vencimento, dia 31 em mês curto e última parcela.
import { addMonths, monthKey } from './month.js';

export interface RecurrenceRule {
  day: number;
  startMonth: string;
  firstInstallment: number;
  total: number | null;
  endMonth: string | null;
  generatedUntil: string;
}

export interface Occurrence {
  month: string;
  /** ISO 8601, meio-dia UTC no dia do vencimento. */
  date: string;
  installment: number;
}

// "2026-10" + dia 31 → meio-dia UTC no dia 31, ou no último dia de um mês mais curto.
export function occurrenceDate(month: string, day: number): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return new Date(Date.UTC(year, m - 1, Math.min(day, lastDay), 12)).toISOString();
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}

// O último mês em que a recorrência vale, ou null enquanto não tem fim.
export function lastMonthOf(r: RecurrenceRule): string | null {
  const byPlan = r.total !== null ? addMonths(r.startMonth, r.total - r.firstInstallment) : null;
  if (byPlan !== null && r.endMonth !== null) return byPlan < r.endMonth ? byPlan : r.endMonth;
  return byPlan ?? r.endMonth;
}

// A ocorrência de um mês, se houver uma depois da primeira (lançada à mão).
export function occurrenceIn(r: RecurrenceRule, month: string): Occurrence | null {
  const k = monthsBetween(r.startMonth, month);
  if (k < 1) return null;
  const last = lastMonthOf(r);
  if (last !== null && month > last) return null;
  return { month, date: occurrenceDate(month, r.day), installment: r.firstInstallment + k };
}

// Ocorrências vencidas que ainda não viraram transação, da mais antiga para a mais nova.
export function dueOccurrences(r: RecurrenceRule, now: Date): Occurrence[] {
  const due: Occurrence[] = [];
  const nowIso = now.toISOString();
  const until = monthKey(now);
  for (let month = addMonths(r.generatedUntil, 1); month <= until; month = addMonths(month, 1)) {
    const occurrence = occurrenceIn(r, month);
    if (!occurrence) break;
    if (occurrence.date > nowIso) break;
    due.push(occurrence);
  }
  return due;
}

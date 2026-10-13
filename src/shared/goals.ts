// Portado de utils/goals.ts do app. O progresso de uma caixinha (percentual, prazo, sugestão por mês)
// continua sendo calculado no app; aqui fica só a regra que o servidor precisa impor.

export type MovementKind = 'deposit' | 'withdraw';

export type MovementProblem = 'invalid' | 'exceeds';

export const GOAL_NAME_MAX_LENGTH = 30;
// Uma caixinha pode ter prazo até este número de meses à frente.
export const GOAL_MAX_MONTHS_AHEAD = 120;

const cents = (value: number) => Math.round(value * 100) / 100;

// Se um valor pode entrar ou sair de uma caixinha: só se retira o que há nela.
// `amount` é a magnitude positiva; o tipo da movimentação diz se guarda ou retira.
export function movementProblem(kind: MovementKind, amount: number, saved: number): MovementProblem | null {
  if (!Number.isFinite(amount) || amount <= 0) return 'invalid';
  if (kind === 'withdraw' && cents(amount) > cents(saved)) return 'exceeds';
  return null;
}

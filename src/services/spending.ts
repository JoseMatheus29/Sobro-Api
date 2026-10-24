import { sql, type SQL } from 'drizzle-orm';

import type { PaymentMethod } from '../shared/payment.js';

// O mês em que o gasto conta, calculado no banco pela função spending_month_of (migração 0007), a única
// implementação da regra: despesa no crédito conta no mês do vencimento da fatura que a recebe; todo o resto,
// no mês da data. Os dias do cartão vêm da própria conta, lidos na mesma instrução da gravação.
//
// Quem grava com o cartão em jogo trava a conta antes (FOR SHARE), e mudar os dias do cartão pede FOR UPDATE:
// uma gravação e uma troca de dias nunca se cruzam, e o valor gravado sempre usa os dias vigentes.
export function spendingMonthSql(occurredAt: Date, paymentMethod: PaymentMethod | string | null, cardId: number): SQL<string> {
  return sql<string>`spending_month_of(${occurredAt.toISOString()}::timestamptz, ${paymentMethod}::text, (select closing_day from cards where id = ${cardId}), (select due_day from cards where id = ${cardId}))`;
}

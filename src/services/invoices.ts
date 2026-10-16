import { and, eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { cards, transactions } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { runIdempotent, type IdempotencyKey, type Idempotent } from '../lib/idempotency.js';
import { round2 } from '../lib/money.js';
import { INVOICE_CATEGORY_ID, NO_CREDIT_MESSAGE, monthLabel } from '../shared/payment.js';
import { calendarNoon } from '../shared/month.js';
import { getTransaction, type TransactionRecord } from './transactions.js';

export interface InvoicePaymentInput {
  /** A chave da fatura: 'AAAA-MM' do mês em que ela fecha. */
  month: string;
  /** Positivo. O servidor não limita ao total da fatura (o app limita na tela). */
  amount: number;
  occurredAt: Date;
}

// Paga (parte de) uma fatura com o saldo da própria conta do cartão: uma saída na categoria `invoice`.
// Mexe no saldo, mas não é gasto do mês (as compras já contaram na data em que foram feitas). Para desfazer,
// exclui-se a transação, e a fatura volta a ficar em aberto. Com `Idempotency-Key`, repetir a chave devolve
// o mesmo pagamento.
export function payInvoice(
  db: Db,
  userId: string,
  cardId: number,
  input: InvoicePaymentInput,
  timeZone: string,
  key?: IdempotencyKey
): Promise<Idempotent<TransactionRecord>> {
  return runIdempotent(db, userId, 'POST /cards/invoice-payments', key, async (tx) => {
    // FOR SHARE: tirar o cartão da conta ao mesmo tempo espera este pagamento terminar.
    const [card] = await tx
      .select({ name: cards.name, closingDay: cards.closingDay })
      .from(cards)
      .where(and(eq(cards.userId, userId), eq(cards.id, cardId)))
      .for('share');
    if (!card) throw notFound('Conta não encontrada.');
    if (card.closingDay === null) {
      throw badRequest(NO_CREDIT_MESSAGE, 'validation_failed', [{ path: 'cardId', message: NO_CREDIT_MESSAGE }]);
    }

    const [row] = await tx
      .insert(transactions)
      .values({
        userId,
        cardId,
        categoryId: INVOICE_CATEGORY_ID,
        name: `Fatura ${card.name} ${monthLabel(input.month)}`,
        description: null,
        amount: -round2(Math.abs(input.amount)),
        type: 'expense',
        occurredAt: calendarNoon(input.occurredAt, timeZone),
        paymentMethod: null,
        invoiceMonth: input.month,
      })
      .returning({ id: transactions.id });
    return getTransaction(tx, userId, row!.id);
  });
}

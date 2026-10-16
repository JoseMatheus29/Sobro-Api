// Forma de pagamento de uma saída e o cartão de crédito da conta. A fatura não é gravada: o app a calcula a
// partir das compras no crédito e dos pagamentos (utils/invoice.ts); o servidor só valida e faz os relatórios.

export const PAYMENT_METHODS = ['pix', 'debit', 'credit'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Categoria do catálogo só dos pagamentos de fatura: mexe no saldo, mas não é gasto do mês. */
export const INVOICE_CATEGORY_ID = 'invoice';

export const NO_CREDIT_MESSAGE = 'Esta conta não tem cartão de crédito.';

const MONTH_ABBREVIATIONS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// "2026-11" → "nov/2026", para o nome do pagamento de fatura.
export function monthLabel(month: string): string {
  const [year, m] = month.split('-') as [string, string];
  return `${MONTH_ABBREVIATIONS[Number(m) - 1]}/${year}`;
}

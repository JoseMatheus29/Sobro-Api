-- O mês em que o gasto conta (AAAA-MM). Despesa no crédito: o mês do vencimento da fatura que recebe a compra;
-- todo o resto: o mês da data (as datas são gravadas ao meio-dia UTC, então é o dia do calendário).
--   fatura da compra: a do próprio mês se o dia <= fechamento (limitado ao último dia do mês); senão, a do mês seguinte.
--   vencimento da fatura: no mês em que fecha se vencimento > fechamento; senão, no mês seguinte.
-- Esta função é a única implementação da regra no servidor: o backfill abaixo, as gravações e a troca dos dias do
-- cartão a usam.
CREATE FUNCTION spending_month_of(occurred_at timestamptz, payment_method text, closing_day integer, due_day integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT to_char(
    date_trunc('month', occurred_at AT TIME ZONE 'UTC')
      + (
        CASE
          WHEN payment_method = 'credit' AND closing_day IS NOT NULL AND due_day IS NOT NULL THEN
            (CASE WHEN extract(day FROM occurred_at AT TIME ZONE 'UTC') <=
                       LEAST(closing_day,
                             extract(day FROM (date_trunc('month', occurred_at AT TIME ZONE 'UTC') + interval '1 month - 1 day')))
                  THEN 0 ELSE 1 END)
            + (CASE WHEN due_day > closing_day THEN 0 ELSE 1 END)
          ELSE 0
        END
      ) * interval '1 month',
    'YYYY-MM')
$$;--> statement-breakpoint
-- A coluna entra nula, é preenchida com o que já existe e só então vira obrigatória.
ALTER TABLE "transactions" ADD COLUMN "spending_month" text;--> statement-breakpoint
UPDATE "transactions" t
SET "spending_month" = spending_month_of(t."occurred_at", t."payment_method", c."closing_day", c."due_day")
FROM "cards" c
WHERE c."id" = t."card_id";--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "spending_month" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "transactions_user_spending_month_idx" ON "transactions" USING btree ("user_id","spending_month");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_spending_month_format" CHECK ("transactions"."spending_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "cards" ADD COLUMN "credit_last_digits" text;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "credit_limit" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "closing_day" smallint;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "due_day" smallint;--> statement-breakpoint
ALTER TABLE "recurrences" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "invoice_month" text;--> statement-breakpoint
CREATE INDEX "transactions_user_card_method_idx" ON "transactions" USING btree ("user_id","card_id","payment_method");--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_credit_days_check" CHECK (("cards"."closing_day" IS NULL AND "cards"."due_day" IS NULL) OR ("cards"."closing_day" BETWEEN 1 AND 31 AND "cards"."due_day" BETWEEN 1 AND 31));--> statement-breakpoint
ALTER TABLE "recurrences" ADD CONSTRAINT "recurrences_payment_method_valid" CHECK ("recurrences"."payment_method" IN ('pix', 'debit', 'credit'));--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_method_valid" CHECK ("transactions"."payment_method" IN ('pix', 'debit', 'credit'));
--> statement-breakpoint
-- Categoria do catálogo (global, como a transfer): só para pagamentos de fatura. O app a esconde das listas de escolha.
INSERT INTO "categories" ("id", "name", "icon", "color", "bg") VALUES
  ('invoice', 'Fatura do cartão', 'credit-card', '#718096', 'rgba(113,128,150,0.12)')
ON CONFLICT ("id") DO NOTHING;

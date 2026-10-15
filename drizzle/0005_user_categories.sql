ALTER TABLE "categories" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "seq" integer NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "categories_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_user_idx" ON "categories" USING btree ("user_id");
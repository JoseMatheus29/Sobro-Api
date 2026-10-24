-- Perfis gerenciados: users.kind ('self' tem login; 'managed' é dono dos dados de outra pessoa, sem e-mail nem senha) e
-- profile_access (quem pode gerenciar quem). Aditivo: quem já existe vira 'self' pelo padrão, e o código antigo
-- (que não conhece kind) continua gravando normalmente durante o deploy.
CREATE TABLE "profile_access" (
	"owner_id" uuid NOT NULL,
	"manager_id" uuid NOT NULL,
	"role" text DEFAULT 'manager' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_access_owner_id_manager_id_pk" PRIMARY KEY("owner_id","manager_id"),
	CONSTRAINT "profile_access_role_valid" CHECK ("profile_access"."role" IN ('manager')),
	CONSTRAINT "profile_access_not_self" CHECK ("profile_access"."owner_id" <> "profile_access"."manager_id")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kind" text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_access" ADD CONSTRAINT "profile_access_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_access" ADD CONSTRAINT "profile_access_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_access_manager_idx" ON "profile_access" USING btree ("manager_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kind_valid" CHECK ("users"."kind" IN ('self', 'managed'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_login_by_kind" CHECK (("users"."kind" = 'self' AND "users"."email" IS NOT NULL AND "users"."password_hash" IS NOT NULL) OR ("users"."kind" = 'managed' AND "users"."email" IS NULL AND "users"."password_hash" IS NULL));
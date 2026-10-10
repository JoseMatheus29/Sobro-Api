# API do Sobrô?

Servidor do Sobrô?: login obrigatório, todos os dados no Postgres e o app como cliente online.
Requisitos, modelo de dados e hospedagem: [api-requisitos-e-hospedagem.md](api-requisitos-e-hospedagem.md).

**Stack:** Node 22, Fastify 5, Zod, PostgreSQL 16, Drizzle ORM (+ drizzle-kit), `@node-rs/argon2`, `jose`, Vitest.

## Rodando

```bash
cp .env.example .env          # ajuste JWT_SECRET (32+ caracteres)
docker compose up -d db       # Postgres de desenvolvimento, porta 5432
npm install
npm run dev                   # aplica as migrações e sobe em http://localhost:3000
```

Sem `RESEND_API_KEY`, o link de redefinição de senha aparece no log (só para desenvolvimento).

## Testes

Os testes de integração usam um Postgres real (porta 5433, em memória) para valer locks, `FOR UPDATE` e `unaccent`.

```bash
npm run test:db               # sobe o Postgres de teste (Docker)
npm test                      # unitários + integração (use TEST_DATABASE_URL para outro banco)
npm run typecheck
```

## Postman

Importe `postman/sobro-api.postman_collection.json` e `postman/sobro-local.postman_environment.json` e escolha o ambiente "Sobrô local". Rode as pastas em ordem (começando por **Autenticação > Cadastrar**): tokens e ids ficam guardados nas variáveis da coleção. Rodar a coleção inteira (Runner) funciona de ponta a ponta e termina excluindo a conta de teste.

## Estrutura

| Pasta | O que tem |
| --- | --- |
| `src/routes` | Rotas HTTP (`auth`, `me`, `data`). Validam a entrada com Zod e chamam os serviços. |
| `src/services` | Regras e consultas: contas, transações, recorrências, relatórios, autenticação, backup. |
| `src/shared` | Regras puras portadas do app (`month`, `recurrence`, `search`, `backup`). Mantenha em dia com `utils/` do app. |
| `src/db` | Schema Drizzle, cliente e migrações. As migrações ficam em `drizzle/`. |
| `src/lib` | Erros, senhas, tokens, e-mail, idempotência, logs. |
| `test` | Vitest. |

Migrações: depois de mudar `src/db/schema.ts`, rode `npx drizzle-kit generate` e comite o SQL gerado. Nunca edite uma migração já aplicada.

## Deploy (Heroku)

Variáveis de ambiente: `DATABASE_URL` (o Heroku define), `JWT_SECRET`, `DB_SSL=true`, `TRUST_PROXY=true`,
`RESEND_API_KEY`, `MAIL_FROM`, `RESET_PASSWORD_URL`. Veja `.env.example`.
Com mais de uma instância, tire `runMigrations` de `src/server.ts` e rode `npm run db:migrate` na release phase.

## Convenções da API

- Tudo sob `/v1`; `/health` (processo de pé) e `/ready` (testa o banco) ficam na raiz, sem autenticação.
- Erros: `{ "error": { "code", "message", "fields?" } }`.
- Entrada de valor: magnitude positiva (`amount: 50`); a resposta devolve com sinal (despesa negativa).
- Datas: `occurredAt` vira o dia de calendário em `America/Sao_Paulo`, gravado como meio-dia UTC.
- Listas de transações: `{ items, nextCursor }`; passe `cursor` para a próxima página.
- `Idempotency-Key` (UUID) nos `POST` que criam algo: repetir a mesma chave devolve a resposta original.
- `X-App-Version`: com `MIN_APP_VERSION` definido, versões menores recebem 426.

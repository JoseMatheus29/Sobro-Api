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
| `src/routes` | Só ligam caminho a controller e carregam opções da rota (limite de tentativas, tamanho do corpo). |
| `src/controllers` | Um por recurso (`cards`, `transactions`, `auth`...). Validam a entrada com Zod, chamam os serviços e escolhem a resposta HTTP. |
| `src/services` | Regras e consultas ao banco: contas, transações, recorrências, relatórios, autenticação, backup. Não conhecem HTTP. |
| `src/shared` | Regras puras portadas do app (`month`, `recurrence`, `search`, `backup`). Mantenha em dia com `utils/` do app. |
| `src/db` | Schema Drizzle, cliente e migrações. As migrações ficam em `drizzle/`. |
| `src/lib` | Erros, senhas, tokens, e-mail, idempotência, logs. |
| `test` | Vitest. |

Migrações: depois de mudar `src/db/schema.ts`, rode `npx drizzle-kit generate` e comite o SQL gerado. Nunca edite uma migração já aplicada.

## Deploy (Heroku)

O Heroku usa o buildpack do Node: instala as dependências, roda `npm run build` (compila para `dist/`) e sobe o que o `Procfile` manda.

```
release: node dist/db/migrate.js   # migra o banco antes de a versão nova entrar no ar; se falhar, ela nem entra
web: node dist/server.js
```

**Recursos:** um app na região `us`, dyno **Basic** (sempre ligado) e o add-on **Heroku Postgres Essential-0** (≈ US$ 12 por mês). O add-on define `DATABASE_URL`; o Heroku define `PORT`.

**Variáveis de ambiente (Settings > Config Vars):**

| Variável | Valor |
| --- | --- |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | texto aleatório com 32+ caracteres (nunca o do `.env.example`) |
| `DB_SSL` | `true` (o Heroku Postgres exige TLS com certificado autoassinado) |
| `TRUST_PROXY` | `true` (o limite de tentativas precisa ver o IP real) |
| `RESEND_API_KEY`, `MAIL_FROM`, `RESET_PASSWORD_URL` | e-mail de redefinição de senha. Sem a chave, nenhum e-mail sai e o link não vai para o log |
| `MIN_APP_VERSION` | opcional: versões do app abaixo dela recebem 426 |

**Passo a passo pelo painel (deploy automático pelo GitHub):**

1. Em *New > Create new app*, escolha um nome e a região `United States`.
2. Em *Resources*, adicione **Heroku Postgres** (plano Essential-0) e troque o dyno web para **Basic**.
3. Em *Settings > Config Vars*, crie as variáveis da tabela acima.
4. Em *Deploy*, escolha *GitHub*, conecte `JoseMatheus29/Sobro-Api`, selecione a branch (`main`) e clique em *Deploy Branch*. Depois ligue o *Enable Automatic Deploys* (marque *Wait for CI to pass* se houver CI).
5. Confira `https://<app>.herokuapp.com/ready` (deve responder `{"status":"ok"}`) e os logs em *More > View logs*.
6. Em *Account settings > Billing*, configure um alerta de gasto: o que passar do crédito é cobrado no cartão.

Com mais de um dyno web, a migração continua só na release phase; tire `runMigrations` de `src/server.ts` para não migrar duas vezes ao subir.

## Convenções da API

- Tudo sob `/v1`; `/health` (processo de pé) e `/ready` (testa o banco) ficam na raiz, sem autenticação.
- Erros: `{ "error": { "code", "message", "fields?" } }`.
- Entrada de valor: magnitude positiva (`amount: 50`); a resposta devolve com sinal (despesa negativa).
- Datas: o `occurredAt` de transações e transferências vira o dia de calendário em `America/Sao_Paulo`, gravado como meio-dia UTC. O das movimentações de caixinha fica como veio (é um instante, e o histórico se ordena por ele).
- Listas de transações: `{ items, nextCursor }`; passe `cursor` para a próxima página.
- `Idempotency-Key` (UUID) nos `POST` que criam algo: repetir a mesma chave devolve a resposta original.
- Caixinhas: o `amount` de `POST /goals/:id/entries` é **com sinal** (positivo guarda, negativo retira), ao contrário das transações. `saved` vem calculado (soma das movimentações) e retirar mais do que há responde 409 `goal_insufficient`.
- `X-App-Version`: com `MIN_APP_VERSION` definido, versões menores recebem 426.

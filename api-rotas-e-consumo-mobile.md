# API do Sobrô? — rotas e como o mobile deve consumir

Guia para quem escreve o cliente do app. Complementa o [api-requisitos-e-hospedagem.md](api-requisitos-e-hospedagem.md) (requisitos e decisões) e o [README.md](README.md) (como rodar). Aqui estão **todas as rotas**, o formato exato de cada corpo e resposta, e **como o app deve usar** a API.

## Sumário

1. [Convenções gerais](#1-convenções-gerais)
2. [Como o app deve consumir](#2-como-o-app-deve-consumir)
3. [Rotas](#3-rotas): [saúde](#31-saúde) · [autenticação](#32-autenticação) · [perfil](#33-perfil) · [categorias](#34-categorias) · [contas](#35-contas-cards) · [transações](#36-transações) · [transferências](#37-transferências) · [recorrências](#38-recorrências) · [caixinhas](#39-caixinhas-goals) · [orçamentos](#310-orçamentos) · [relatórios](#311-relatórios) · [backup](#312-backup)
4. [Tabela de erros](#4-tabela-de-erros)
5. [Cliente HTTP de exemplo](#5-cliente-http-de-exemplo)

---

## 1. Convenções gerais

| Assunto | Regra |
| --- | --- |
| **URL base** | `https://sobro-api-b00e8bca72f0.herokuapp.com`. Tudo fica sob `/v1`, menos `/health` e `/ready`. |
| **Formato** | JSON nos dois sentidos. Envie `Content-Type: application/json`. |
| **Autenticação** | `Authorization: Bearer <accessToken>` em tudo, **exceto** `/health`, `/ready` e `/v1/auth/*`. |
| **Versão do app** | Envie `X-App-Version: 1.2.0` em **toda** requisição. Se a API exigir uma versão mínima e a sua for menor, responde **426** `upgrade_required`: mostre "Atualize o app". |
| **Idempotência** | Nos `POST` que **criam** algo (`/cards`, `/transactions`, `/transfers`, `/cards/:id/invoice-payments`, `/goals`, `/goals/:id/entries`) envie `Idempotency-Key: <uuid>`. Detalhes na [seção 2.5](#25-tentar-de-novo-sem-duplicar-idempotency-key). |
| **Dinheiro** | Números JSON com até 2 casas (`120.5`). Veja a [seção 2.6](#26-dinheiro-e-datas) para o sinal. |
| **Datas** | `occurredAt` em ISO 8601 com `Z` (ex.: `2026-10-05T12:00:00.000Z`). Meses são texto `AAAA-MM`. |
| **Ids** | Inteiros (`id: 12`). O id do usuário é um UUID. |
| **Isolamento** | Todo dado é do usuário do token (ou do **perfil gerenciado** escolhido em `X-Profile-Id`, veja a [seção 3.3](#33-perfil)). Um id de outra pessoa responde **404**, igual a um id que não existe. |
| **Perfil ativo** | `X-Profile-Id: <uuid>` (opcional) nas rotas de **dados**: faz a requisição valer para um perfil gerenciado que a sua conta cuida. Sem ele, os dados são os seus. `/auth/*`, `/me` e `/profiles` o ignoram. |
| **Paginação** | Só em `GET /transactions`: `{ items, nextCursor }`. |

**Formato de erro (sempre o mesmo):**

```json
{ "error": { "code": "validation_failed", "message": "Dados inválidos.", "fields": [{ "path": "amount", "message": "O valor precisa ser maior que zero." }] } }
```

`fields` só vem em erro de validação. Os códigos estão na [tabela de erros](#4-tabela-de-erros). As mensagens (`message`) já estão em português e podem ser mostradas ao usuário.

---

## 2. Como o app deve consumir

### 2.1 Visão geral do modelo

A API é a **fonte de verdade**. O app é um cliente **online**: toda tela lê e grava pela API, sem banco local e sem fila de envio. Por isso:

- **Calcule no app** o que são funções puras: resumo do mês, insights, histórico, previsão e progresso das caixinhas. A API devolve as linhas; o app calcula.
- **A API cuida** de guardar, validar, gerar as recorrências vencidas, calcular o saldo atual de cada conta, o valor guardado das caixinhas e as somas de `/reports`.
- A camada `db/` do app troca o SQLite por chamadas HTTP **mantendo os hooks** (`useCards`, `useTransactions` etc.). `notifyDataChanged` e `useFocusEffect` continuam sendo o gatilho de nova busca.

### 2.2 Sessão: login, tokens e armazenamento

1. **Entrar:** `POST /v1/auth/login` (ou `/auth/register`) devolve `accessToken` (vale **15 minutos**) e `refreshToken` (vale 60 dias, **uso único**).
2. **Guardar:** os dois tokens em `expo-secure-store`, **nunca** em `AsyncStorage` nem em log. (`expo-secure-store` é módulo nativo: exige novo build.)
3. **Usar:** o `accessToken` em `Authorization: Bearer ...`.
4. **Renovar:** quando o `accessToken` expira (a API responde **401**), chame `POST /v1/auth/refresh` com o `refreshToken`. A resposta traz **os dois tokens novos**: salve-os **antes** de usar. O token antigo deixa de valer.
5. **Falhou a renovação (401):** a sessão acabou. Apague os tokens e leve para a tela de entrar.
6. **Sair:** `POST /v1/auth/logout` com o `refreshToken` e depois apague os dois tokens locais. Se o logout falhar por rede, apague localmente do mesmo jeito.

**Sem sessão válida, o app só mostra** entrar, criar conta e recuperar senha. `app/index.tsx` decide: tem token → abas; não tem → login.

### 2.3 Renovação de token sem corrida (importante)

Uma tela dispara várias chamadas ao mesmo tempo. Se o token expirou, **todas** recebem 401 juntas. Se cada uma renovar, o token de renovação (de uso único) é gasto várias vezes e a sessão pode ser derrubada.

Faça **uma renovação só** e as demais chamadas **esperam o mesmo resultado** (uma promessa compartilhada), depois repetem a requisição **uma vez**. O [cliente de exemplo](#5-cliente-http-de-exemplo) já faz isso.

Regras:
- **Não renove** em resposta a 401 das rotas `/auth/*` (um `invalid_credentials` no login não é token expirado).
- Se a renovação falhar por **rede** (não por 401), **não deslogue**: é um erro de conexão. Só deslogue em 401.
- O servidor aceita o token recém-trocado por **30 segundos** (cobre resposta perdida). Fora dessa janela, reusar um token antigo é tratado como roubo e **revoga a sessão inteira**.
- Opcional: renovar **antes** de vencer, usando `expiresIn` (segundos) da resposta, por exemplo aos 80% do prazo.

### 2.4 Carregar dados e atualizar telas

- Ao abrir uma tela, o hook busca na API e mostra **carregando**. Com as linhas, o app calcula.
- **Busque em paralelo.** O Dashboard precisa de várias coisas, e o servidor está nos EUA (cada chamada tem ida e volta de rede). Dispare tudo junto com `Promise.all`:

| Tela | Chamadas |
| --- | --- |
| Dashboard do mês | `GET /cards`, `GET /transactions?month=`, `GET /reports/category-totals?month=`, `GET /budgets/monthly`, `GET /budgets/categories`, `GET /recurrences`, `GET /goals` |
| Histórico | `GET /reports/monthly-totals`, `GET /budgets/monthly`, `GET /recurrences` (previsão) |
| Carteira | `GET /cards` (já traz o saldo atual) |
| Detalhe de uma transação | `GET /transactions/:id` |
| Caixinha | `GET /goals/:id`, `GET /goals/:id/entries` |

- Depois de **criar, editar ou excluir**, chame a API e, se deu certo, **busque de novo** o que a tela mostra (`notifyDataChanged`).
- Use um **cache em memória** (por exemplo TanStack Query) para as telas abrirem na hora ao voltar a elas, com `staleTime` curto e refetch no foco. **Não grave dados financeiros em disco.**
- **Recorrências são geradas no servidor** quando você lê `GET /cards`, `/transactions`, `/recurrences` ou `/reports/*`. Você não precisa pedir; só leia. Se quiser forçar ao abrir o app: `POST /recurrences/materialize`.

### 2.5 Tentar de novo sem duplicar (`Idempotency-Key`)

Se um `POST` grava no servidor mas a resposta **se perde** (sinal ruim), o botão "Tentar de novo" criaria duas transações. Evite assim:

1. **Gere um UUID por tentativa de salvar** (quando a pessoa toca em "Salvar"), por exemplo com `expo-crypto` (`Crypto.randomUUID()`).
2. Envie esse UUID em `Idempotency-Key`.
3. Se falhar por rede/timeout e a pessoa tocar em "Tentar de novo", **reenvie o mesmo UUID**. A API devolve a resposta original em vez de gravar outra vez, com o cabeçalho de resposta `Idempotent-Replayed: true`.
4. **Uma tentativa nova de verdade** (a pessoa mudou o formulário e salvou outra vez) **ganha um UUID novo**.

Detalhes: a chave vale **24 horas**, por usuário. Tem de ter 8 a 128 caracteres (`A-Z a-z 0-9 _ -`), senão **400** `invalid_idempotency_key`. Um erro (400, 404, 409) **não** guarda a chave: dá para corrigir e reenviar a mesma. `PATCH` e `DELETE` não precisam de chave: repetir um `PATCH` dá o mesmo resultado, e repetir um `DELETE` que já funcionou responde 404, que o app pode tratar como sucesso.

### 2.6 Dinheiro e datas

**Sinal do valor (atenção, muda por rota):**

| Onde | O que enviar | O que volta |
| --- | --- | --- |
| Transações, transferências, recorrências, **pagamentos de fatura** | `amount` **positivo** (magnitude). O tipo (`income`/`expense`) define o sinal | transação com sinal: despesa **negativa**, receita **positiva** |
| **Movimentações de caixinha** | `amount` **com sinal**: positivo guarda, negativo retira | com sinal |
| Orçamentos e metas | positivo | positivo |

Converta os centavos digitados em número (`cents / 100`) e **não envie mais de 2 casas**. O servidor arredonda para 2.

**Datas:**
- **`occurredAt` de transação/transferência:** é uma **data de calendário**, não um instante. Envie o dia que a pessoa vê, **ao meio-dia UTC**: `2026-10-05T12:00:00.000Z`. O servidor, de qualquer forma, converte o instante para o dia em `America/Sao_Paulo` e grava ao meio-dia UTC. **Não** use `new Date().toISOString()` direto: um lançamento às 22h de Brasília cairia no mês seguinte. Monte a data pelo dia local (`AAAA-MM-DD` + `T12:00:00.000Z`).
- **`occurredAt` de movimentação de caixinha:** é um **instante** e fica como veio. Pode omitir (a API usa "agora").
- **Meses:** texto `AAAA-MM` (ex.: `2026-10`). Leia/gere sempre em UTC, como `utils/month.ts` já faz.

### 2.7 Erros: o que fazer em cada caso

| Situação | O que o app faz |
| --- | --- |
| Sem rede / timeout (`fetch` lança) | Aviso "Sem conexão" com **Tentar de novo**. Nada é mostrado como salvo. Mantenha o formulário preenchido. Reuse a `Idempotency-Key` ao tentar de novo. |
| **401** em rota protegida | Renova o token uma vez (seção 2.3) e repete. Se a renovação der 401, vai para o login. |
| **400** `validation_failed` | Mostre `fields[].message` junto de cada campo (`fields[].path` diz qual). |
| **404** | A coisa não existe mais (foi apagada, ou é de outro usuário). Atualize a tela. |
| **409** | Regra de negócio. Mostre a `message`. Veja os códigos na [seção 4](#4-tabela-de-erros). |
| **426** | Tela de "Atualize o app". |
| **429** | "Muitas tentativas. Tente em alguns minutos." Não repita em loop. |
| **5xx** | "Erro no servidor. Tente de novo." com botão. Pode repetir `GET`; para `POST`, só com a mesma `Idempotency-Key`. |

Mostre as mensagens por `showToast` (nunca `Alert.alert`), e mantenha os textos fixos do app em `-type.ts`, como no resto do projeto.

### 2.8 Funções puras que continuam no app

Resumo do mês e comparação com o anterior (`buildSummary`), histórico (`buildHistory`, a partir de `/reports/monthly-totals` e dos orçamentos), insights (`generateInsights`), orçamento e limite vigentes (`budgetForMonth`, `limitsForMonth`), previsão dos próximos meses (`plannedTransactions`, `futureMonths`, a partir de `GET /recurrences`) e progresso das caixinhas (`goalProgress`, `totalReserved`, `freeBalance`).

### 2.9 Lembretes

Continuam sendo **notificações locais** (`expo-notifications`). Reagende a partir de `GET /recurrences` ao abrir o app e ao voltar ao primeiro plano. O servidor não envia push.

### 2.10 Migrar os testadores da v1

A v1 guarda tudo no aparelho. Para trazer os dados: o testador **exporta o JSON** em *Perfil > Seus dados* na v1, atualiza para a v2, cria a conta e **importa o JSON** no mesmo cartão, que chama `PUT /backup`. Antes de enviar, o app mostra as contagens do arquivo e **pede confirmação** (é destrutivo). Se vier **400** `invalid_backup`, mostre a `message` (diz exatamente o que está errado no arquivo).

### 2.11 Excluir a conta

`DELETE /me` com a senha no corpo. Apaga tudo de verdade. Depois, apague os tokens locais e volte ao login. A Play Store exige também um **link público na web** para a exclusão.

---

## 3. Rotas

Convenção das tabelas: **corpo** = JSON enviado; **resposta** = JSON recebido. `?` marca campo opcional.

### 3.1 Saúde

Sem autenticação e **fora de `/v1`**.

| Rota | Para quê | Resposta |
| --- | --- | --- |
| `GET /health` | O processo está de pé (não toca no banco) | `200 { "status": "ok" }` |
| `GET /ready` | O banco responde. Use para monitoramento | `200 { "status": "ok" }` ou `503 { "status": "unavailable" }` |

### 3.2 Autenticação

Todas **sem** `Authorization`. Têm limite de tentativas por IP (ver 429).

#### `POST /v1/auth/register` — criar conta

Cria o usuário, o perfil e a conta padrão **"Conta Principal"**.

- **Corpo:** `{ "email": string, "password": string (8 a 128), "name"?: string (até 100) }`
- **Resposta `201`:** `{ "accessToken", "refreshToken", "expiresIn": 900, "user": { "id", "email" } }`
- **Erros:** `400` validação (e-mail inválido, senha curta) · `409` `email_taken` · `429`

#### `POST /v1/auth/login` — entrar

- **Corpo:** `{ "email", "password" }`
- **Resposta `200`:** igual ao cadastro (`accessToken`, `refreshToken`, `expiresIn`, `user`)
- **Erros:** `401` `invalid_credentials` (a mesma resposta para e-mail inexistente ou senha errada) · `429` depois de 10 erros para o mesmo e-mail em 15 minutos

#### `POST /v1/auth/refresh` — renovar a sessão

- **Corpo:** `{ "refreshToken" }`
- **Resposta `200`:** `{ "accessToken", "refreshToken", "expiresIn" }` (**sem** `user`). Salve **os dois** novos.
- **Erros:** `401` `invalid_refresh_token` (token inexistente, expirado, revogado ou reusado) → deslogar.

#### `POST /v1/auth/logout` — encerrar a sessão deste aparelho

- **Corpo:** `{ "refreshToken" }` · **Resposta `204`**. Idempotente.

#### `POST /v1/auth/forgot-password` — pedir o link de redefinição

- **Corpo:** `{ "email" }` · **Resposta `204`** **sempre**, exista a conta ou não (não revela quem tem cadastro).
- O e-mail só sai se o servidor tiver o serviço de e-mail configurado. O link abre uma tela do app ou página web com o token **no fragmento** (`...#token=XYZ`).

#### `POST /v1/auth/reset-password` — definir a nova senha

- **Corpo:** `{ "token": string, "password": string (8 a 128) }` — o `token` vem do link do e-mail e **vai no corpo** (nunca na URL).
- **Resposta `204`.** Todas as sessões abertas caem: o app deve mandar para o login.
- **Erros:** `401` `invalid_reset_token` (inválido, expirado ou já usado)

### 3.3 Perfil

#### `GET /v1/me`
**Resposta `200`:** `{ "id", "email", "name", "currency": "BRL", "remindersEnabled": true, "managedProfiles": 0 }`. `managedProfiles` é quantos perfis gerenciados a conta tem (avise na hora de excluir a conta: eles vão junto). Sempre da pessoa logada, mesmo com `X-Profile-Id`.

#### `PATCH /v1/me`
- **Corpo (todos opcionais):** `{ "name"?: string (≤100), "currency"?: "BRL" (3 letras), "remindersEnabled"?: boolean }`
- **Resposta `200`:** o perfil atualizado (mesmo formato do `GET`).
- O **tema** (claro/escuro) **não existe na API**: fica só no app (precisa valer antes do login).

#### `DELETE /v1/me` — excluir a conta e todos os dados
- **Corpo:** `{ "password": string }` · **Resposta `204`**.
- Apaga também os **perfis gerenciados** da conta que ficariam sem nenhum gerente (hoje, todos os que ela criou).
- **Erros:** `401` `invalid_credentials` (senha errada) · `429` depois de muitas senhas erradas seguidas.

### 3.3.1 Perfis gerenciados

Uma conta pode cuidar das finanças de outra pessoa (por exemplo, a sua mãe) sem sair e entrar de novo. O perfil gerenciado **não tem login**: é só um dono de dados separado, que a sua conta acessa.

| Rota | Corpo | Resposta | Observações |
| --- | --- | --- | --- |
| `GET /v1/profiles` | | `200 [ perfil ]` | O seu perfil primeiro (`kind: "self"`), depois os gerenciados (`kind: "managed"`, com `createdAt`), do mais antigo ao mais novo. |
| `POST /v1/profiles` | `{ name (1 a 60), currency?: "BRL" }` | `201 perfil` | Nasce com uma conta ("Conta Principal"). `409` `profile_limit` ao passar do limite (5 por padrão). Aceita `Idempotency-Key`. |
| `PATCH /v1/profiles/:id` | `{ name?, currency?, remindersEnabled? }` | `200 perfil` | Só de perfil gerenciado seu. O seu próprio perfil continua em `PATCH /me`. `404` para qualquer outro id. |
| `DELETE /v1/profiles/:id` | `{ password }` (a **sua** senha) | `204` | Apaga o perfil e **todos** os dados dele, de forma definitiva. `401` `invalid_credentials` (senha errada) · `404` (não é um perfil seu) · `429` (muitas senhas erradas). |

```json
{ "id": "…", "kind": "managed", "name": "Mãe", "currency": "BRL", "remindersEnabled": true, "createdAt": "2026-10-25T12:00:00.000Z" }
```

**Trocar de perfil.** Mande `X-Profile-Id: <id do perfil>` em **todas as rotas de dados** enquanto ele estiver ativo (contas, transações, transferências, categorias, caixinhas, recorrências, orçamentos, relatórios e backup). Sem o cabeçalho, ou com o seu próprio id, vale o seu perfil. A API confere o acesso em **toda** requisição; se responder `403` `profile_forbidden`, volte para o seu perfil e avise. Um id que não é UUID responde `400`.

- Cada perfil tem **os seus** dados: categorias próprias, orçamentos, caixinhas, lembretes e backup (`GET/PUT /backup` com o cabeçalho exporta e restaura **só** aquele perfil). O catálogo de categorias é de todos.
- Esvazie o cache de dados (ou inclua o perfil na chave) ao trocar, e mostre uma **faixa visível** com o perfil ativo.
- `Idempotency-Key` vale por perfil: a mesma chave em dois perfis cria duas coisas.

### 3.4 Categorias

O **catálogo** (global, igual para todos, somente leitura) **mais as categorias que o usuário criou**. Ids do catálogo: `food`, `transport`, `leisure`, `health`, `shopping`, `salary`, `invest`, `transfer`, `other`. As do usuário têm id `custom-<32 caracteres>`, gerado pelo servidor. A categoria `transfer` é **só das transferências** e a `invoice` ("Fatura do cartão") é **só dos pagamentos de fatura**: não use nenhuma das duas em transação comum (`400`). O app deve **escondê-las** das listas de escolha.

**Objeto categoria:**
```json
{ "id": "custom-3f2a9c1e4b7d4e0f8a6b5c2d1e0f9a8b", "name": "Pets", "icon": "pets", "color": "#E67E22", "bg": "rgba(230,126,34,0.12)", "custom": true }
```
`custom` é `false` no catálogo e `true` nas do usuário.

| Rota | Corpo | Resposta | Observações |
| --- | --- | --- | --- |
| `GET /v1/categories` | — | `200 [categoria]` | O catálogo primeiro (por nome) e depois as do usuário **na ordem em que ele as criou**. Busque uma vez, guarde em memória e invalide ao criar, editar ou excluir. |
| `POST /v1/categories` | `{ name (≤30), icon (≤40), color (hex), bg (≤40) }` | `201 categoria` | `bg` é o fundo suave que o app monta (`rgba(r,g,b,0.12)`). O id é gerado no servidor: **não envie id**. Aceita `Idempotency-Key`. |
| `PATCH /v1/categories/:id` | `{ name?, icon?, color?, bg? }` | `200 categoria` | **Só as suas.** O catálogo e as de outras pessoas respondem `404`. Renomear reflete nas transações já lançadas. |
| `DELETE /v1/categories/:id` | — | `204` | **Só as suas.** Com transações ou recorrências usando, `409` `category_in_use` (mostre a mensagem). Os limites por categoria dela saem junto. |

**Usar uma categoria:** `categoryId` de transação, recorrência e limite aceita uma do **catálogo ou sua**. O id de uma categoria de outra pessoa responde `400` "Categoria inexistente.".

### 3.5 Contas (`cards`)

No app a "conta" é um lugar onde está o dinheiro (banco, cartão, carteira). O saldo atual é **sempre calculado**: saldo inicial + soma das transações **que saem do saldo**. As compras no crédito (`paymentMethod: "credit"`) **não entram**: vão para a fatura, e o saldo só cai quando a fatura é paga.

**Objeto conta:**
```json
{ "id": 3, "name": "Nubank", "number": "1234", "color": "#820AD1", "lightColor": "#A04FE0", "balance": 960.63, "startingBalance": 500,
  "credit": { "lastDigits": "0001", "limit": 6000, "closingDay": 3, "dueDay": 10 } }
```

| Rota | Corpo | Resposta | Observações |
| --- | --- | --- | --- |
| `GET /v1/cards` | — | `200 [conta]` ordenadas por id | Gera antes as recorrências vencidas, então o saldo já sai certo. |
| `POST /v1/cards` | `{ name (≤60), number? (≤8, padrão ""), color, lightColor, startingBalance? (padrão 0, pode ser negativo), credit? }` | `201 conta` | `color`/`lightColor` são hexadecimais (`#3161B2`). `credit` é `{ lastDigits? (até 4 dígitos, padrão ""), limit? (≥ 0 ou null), closingDay (1 a 31), dueDay (1 a 31) }`. Aceita `Idempotency-Key`. |
| `GET /v1/cards/:id` | — | `200 conta` | `404` se não for sua. |
| `PATCH /v1/cards/:id` | `{ name?, number?, color?, lightColor?, credit? }` | `200 conta` | **Não** muda o saldo inicial. `credit` com os mesmos campos liga ou troca o cartão; `credit: null` o tira (`409` `credit_in_use` se a conta tem compras no crédito ou recorrências no crédito ainda valendo). Mudar `closingDay`/`dueDay` vale para **todas** as faturas, também as passadas. |
| `GET /v1/cards/:id/usage` | — | `200 { "transactions": 12, "recurrences": 1 }` | Use para a confirmação de excluir: é o que vai junto. |
| `DELETE /v1/cards/:id` | — | `204` | Apaga as transações e recorrências da conta **e a outra perna** das transferências em que ela participou. `409` `last_card` se for a última conta. |
| `POST /v1/cards/:id/invoice-payments` | `{ month, amount, occurredAt }` | `201 transação` | Paga (parte de) uma fatura com o saldo **desta** conta. Ver abaixo. Aceita `Idempotency-Key`. |

**Pagar a fatura.** `month` é a **chave da fatura** (`AAAA-MM`, o mês em que ela fecha); `amount` é positivo; `occurredAt` é o dia do pagamento, ao meio-dia UTC (como as transações). A resposta é a transação criada: despesa na conta, `categoryId: "invoice"`, `name: "Fatura Nubank dez/2026"`, `amount` negativo, `paymentMethod: null`, `invoiceMonth: "2026-11"`. O **nome** usa o mês do **vencimento** (a fatura que fecha em 25/11 e vence em 05/12 é "dez/2026"), enquanto `invoiceMonth` continua sendo a chave do **fechamento**. Mexe no saldo, mas **não é gasto do mês**. O servidor **não** limita o valor ao total da fatura (o app limita na tela); pagar a mais fica registrado. Para desfazer, `DELETE /v1/transactions/:id` (a fatura volta a ficar em aberto). Erros: `404` conta que não é sua · `400` `validation_failed` (conta sem cartão, `month` inválido, valor zero ou negativo).

**A fatura não é guardada: o app a calcula** (`utils/invoice.ts`) a partir das compras no crédito (`GET /transactions?paymentMethod=credit`) e dos pagamentos (`invoiceMonth`). Com `C` o dia de fechamento e `D` o de vencimento: uma compra do dia `d` entra na fatura do mês de `d` se `dia(d) <= C`, senão na do mês seguinte (dias 29 a 31 num mês mais curto valem o último dia); o vencimento é o dia `D` do mês da fatura se `D > C`, ou do mês seguinte se `D <= C`. Exemplo (`C = 3`, `D = 10`): compra em 07/10 entra na fatura `2026-11` (04/10 a 03/11), que vence em 10/11.

### 3.6 Transações

**Objeto transação:**
```json
{
  "id": 41, "cardId": 3, "cardName": "Nubank",
  "categoryId": "food", "categoryName": "Alimentação", "categoryIcon": "restaurant", "categoryColor": "#E67E22",
  "name": "Mercado", "description": "Compras da semana",
  "amount": -120.5, "type": "expense",
  "occurredAt": "2026-10-05T12:00:00.000Z", "createdAt": "2026-10-05T18:02:11.000Z",
  "recurrence": { "id": 7, "installment": 2, "total": 10 },
  "transferId": null,
  "paymentMethod": "credit", "invoiceMonth": null,
  "spendingMonth": "2026-12"
}
```
- `amount` **com sinal** (despesa negativa, receita positiva).
- `recurrence` é `null` numa transação comum. Numa recorrência mensal sem fim, `installment` e `total` são `null`.
- `transferId` só vem preenchido nas duas pernas de uma transferência.
- `paymentMethod`: `"pix"`, `"debit"`, `"credit"` ou `null` (as antigas, receitas, transferências e pagamentos de fatura: saem do saldo). Uma saída no **crédito não mexe no saldo** da conta.
- `invoiceMonth` (`AAAA-MM`) só vem nos **pagamentos de fatura** (categoria `invoice`); `null` nas demais. É a **chave** da fatura: o mês em que ela **fecha**.
- `spendingMonth` (`AAAA-MM`, sempre presente) é o **mês em que o gasto conta**. Numa despesa no **crédito** é o mês do **vencimento** da fatura que recebe a compra; em todo o resto (Pix, débito, sem forma de pagamento, receitas, transferências, pagamento de fatura) é o mês da `occurredAt`. A API o calcula e o refaz sozinha ao editar a transação ou mudar os dias do cartão: o app não envia esse campo. Exemplo (`C = 25`, `D = 5`): compra em 27/10 → fatura que fecha em 25/11 e vence em 05/12 → `spendingMonth: "2026-12"`.

#### `GET /v1/transactions` — listar
Do mais novo ao mais antigo (`occurredAt` e `id` decrescentes). Gera antes as recorrências vencidas.

| Parâmetro | Significado |
| --- | --- |
| `month=2026-10` | Só transações **da data** desse mês. **Sem `month`, busca em qualquer mês.** |
| `spendingMonth=2026-12` | Só as que **contam** nesse mês (compras no crédito: o mês do vencimento da fatura). Combinado com `month`, valem os dois. Inválido responde `400`. |
| `cardId=3` | Só dessa conta |
| `categoryId=food` | Só dessa categoria |
| `paymentMethod=credit` | Só as pagas dessa forma (`pix`, `debit` ou `credit`) |
| `type=income\|expense` | Só receitas ou só despesas |
| `q=pao queijo` | Busca de texto, até 100 caracteres. Ignora acento e caixa. **Cada palavra** precisa estar no nome, descrição, categoria ou conta |
| `limit=200` | De 1 a 500 (padrão 200) |
| `cursor=...` | O `nextCursor` da página anterior |

**Resposta `200`:** `{ "items": [transação], "nextCursor": string | null }`. Se `nextCursor` não for `null`, há mais: chame de novo com `cursor=<nextCursor>` e **os mesmos filtros**. Para as telas de mês, 200 costuma bastar; trate o cursor para meses com muitos lançamentos.

> A busca (`q`) vai na URL. Prefira buscar **depois que a pessoa para de digitar** (debounce de ~300 ms) e cancele a requisição anterior.

#### `POST /v1/transactions` — criar
- **Corpo:**
```json
{
  "cardId": 3, "categoryId": "food", "name": "Mercado", "description": "opcional",
  "amount": 120.5, "type": "expense", "occurredAt": "2026-10-05T12:00:00.000Z",
  "repeat": { "mode": "monthly" },
  "paymentMethod": "credit"
}
```
- `name` até 100, `description` até 500 (vazio vira `null`), `amount` **positivo**, `type` `income` ou `expense`.
- **`repeat` (opcional, só para despesa):**
  - `{ "mode": "monthly" }` — repete todo mês, sem fim.
  - `{ "mode": "installments", "total": 10, "current": 1 }` — plano de parcelas. `total` de 2 a 99; `current` (a parcela que esta é) de 1 até `total`, padrão 1.
  - A transação criada é a **primeira ocorrência**; as seguintes são geradas pelo servidor quando vencem (e aparecem na previsão pelo `GET /recurrences`). O dia do mês da recorrência é o dia de `occurredAt`.
- **`paymentMethod` (opcional):** `"pix"`, `"debit"` ou `"credit"`; sem ele (ou `null`), a saída sai do saldo, como sempre foi. **Só vale em despesa**, e `credit` exige uma conta com cartão (`400` em `fields[].path = "paymentMethod"`, "Esta conta não tem cartão de crédito."). Com `repeat`, a recorrência guarda o método e cada ocorrência gerada o herda (um parcelado no crédito vira uma parcela por fatura).
- **Resposta `201`:** a transação criada. Aceita `Idempotency-Key`.
- **Erros:** `400` (categoria inexistente ou de outra pessoa, valor zero/negativo, `repeat` em receita, categoria `transfer` ou `invoice`, `paymentMethod` em receita ou em conta sem cartão) · `404` (conta que não é sua).

#### `GET /v1/transactions/:id`
**Resposta `200`:** a transação. `404` se não for sua.

#### `PATCH /v1/transactions/:id` — editar
- **Corpo (todos opcionais):** `{ cardId, categoryId, name, description (string ou null), amount (positivo), type, occurredAt, paymentMethod (string ou null), applyToNext (boolean) }`
- **Resposta `200`:** a transação atualizada. O sinal do `amount` sempre acompanha o `type`, mesmo que só um deles mude.
- **`applyToNext: true`** (só vale em transação que veio de uma recorrência): também altera a recorrência, então as **próximas** ocorrências saem com os novos conta, categoria, nome, descrição e valor. As já feitas não mudam.
- **Mudar o tipo para `income`** em transação de recorrência **encerra** a recorrência (só despesa se repete). A mensagem do app para isso já existe (`RECURRENCE_ENDED_BY_TYPE`).
- **`paymentMethod`:** troca a forma de pagamento (ou `null`). Se uma despesa **vira receita**, o método vira `null` sozinho; pedir um método numa receita é `400`. Trocar o `cardId` de uma compra no crédito para uma conta sem cartão também é `400`. Com `applyToNext: true`, a recorrência de origem também muda.
- **Erros:** `409` `transfer_not_editable` (uma transferência não se edita: exclua e crie outra) · `409` `invoice_payment_not_editable` (um **pagamento de fatura** não se edita: ofereça excluir) · `404`.

#### `DELETE /v1/transactions/:id`
**Resposta `204`.** Se for uma perna de transferência, **apaga as duas**. Excluir uma transação gerada por recorrência **não** a gera de novo.

### 3.7 Transferências

#### `POST /v1/transfers` — mover dinheiro entre contas
- **Corpo:** `{ "fromCardId", "toCardId", "amount" (positivo), "description"?, "occurredAt" }` — as contas precisam ser **diferentes** e suas.
- **Resposta `201`:** `{ "transferId": 55, "legs": [ perna_de_saída, perna_de_entrada ] }`
  - Saída: despesa na conta de origem, nome `Para <conta destino>`. Entrada: receita na de destino, nome `De <conta origem>`. As duas com `categoryId: "transfer"` e o mesmo `transferId`.
  - **Mudam os saldos**, mas **não** entram em "entradas" e "saídas" do mês (`/reports/*` as ignora).
- Aceita `Idempotency-Key`. Para excluir, use `DELETE /transactions/:id` em qualquer perna.
- **Erros:** `400` (mesma conta, valor inválido) · `404` (conta que não é sua).

### 3.8 Recorrências

Despesas que se repetem (mensais ou parceladas). **Criar** é feito por `POST /transactions` com `repeat`; aqui só se lê e se encerra.

**Objeto recorrência:**
```json
{
  "id": 7, "cardId": 3, "cardName": "Nubank",
  "categoryId": "shopping", "categoryName": "Shopping", "categoryIcon": "shopping-bag", "categoryColor": "#9B59B6",
  "name": "Celular", "description": null,
  "amount": 150, "day": 20, "startMonth": "2026-08",
  "firstInstallment": 1, "total": 10, "endMonth": null, "generatedUntil": "2026-10",
  "paymentMethod": "credit"
}
```
- `amount` é a **magnitude positiva** de uma ocorrência. `total` é `null` numa mensal sem fim.
- `paymentMethod` (`pix`, `debit`, `credit` ou `null`): cada ocorrência gerada o herda.
- `generatedUntil` é o último mês já transformado em transação. As ocorrências **depois** dele são só previstas: o app as calcula (`occurrenceIn`, `plannedTransactions`) para a previsão e os lembretes.

| Rota | Resposta | Observações |
| --- | --- | --- |
| `GET /v1/recurrences` | `200 [recorrência]` | Gera as vencidas antes. O app usa para previsão e lembretes. |
| `GET /v1/recurrences/:id` | `200 recorrência` | `404` se não for sua. |
| `POST /v1/recurrences/:id/end` | `200 recorrência` | Encerra: nada depois do que já foi gerado é criado. O que foi gerado fica. |
| `POST /v1/recurrences/materialize` | `200 { "created": 2 }` | Força a geração das vencidas. Opcional (as leituras já fazem). |

### 3.9 Caixinhas (`goals`)

Reservam dinheiro que **continua nas contas**: **não** mexem em saldo, nem em `/reports/*`, nem nos totais do mês, nem na lista de transações. O valor guardado (`saved`) é **calculado** (soma das movimentações).

**Objeto caixinha:**
```json
{ "id": 9, "name": "Viagem", "targetAmount": 3000, "targetMonth": "2027-06", "color": "#3161B2", "icon": "flight", "saved": 1000 }
```
**Objeto movimentação:**
```json
{ "id": 31, "goalId": 9, "amount": -200, "occurredAt": "2026-10-08T18:40:00.000Z" }
```

| Rota | Corpo | Resposta | Observações |
| --- | --- | --- | --- |
| `GET /v1/goals` | — | `200 [caixinha]` do menor id ao maior | Cada uma com `saved`. |
| `POST /v1/goals` | `{ name (≤30), targetAmount (>0), targetMonth? ("AAAA-MM" ou null), color, icon (≤40) }` | `201 caixinha` | `targetMonth` pode ser mês passado, mas **no máximo 120 meses à frente**. Aceita `Idempotency-Key`. |
| `GET /v1/goals/:id` | — | `200 caixinha` | |
| `PATCH /v1/goals/:id` | qualquer de `name`, `targetAmount`, `targetMonth` (use `null` para tirar o prazo), `color`, `icon` | `200 caixinha` | |
| `DELETE /v1/goals/:id` | — | `204` | Apaga a caixinha **e o histórico**. Nenhuma conta nem transação muda. |
| `GET /v1/goals/:id/entries` | — | `200 [movimentação]` | Do mais novo ao mais antigo. |
| `POST /v1/goals/:id/entries` | `{ amount, occurredAt? }` | `201 movimentação` | **`amount` com sinal**: positivo guarda, negativo retira. Diferente de zero. `occurredAt` opcional (padrão: agora). Aceita `Idempotency-Key`. |
| `DELETE /v1/goals/:id/entries/:entryId` | — | `204` | |

**Regras de saldo (409 `goal_insufficient`):**
- **Retirar mais do que há** na caixinha é recusado. A `message` traz o valor disponível ("Só há R$ 80,00 nessa caixinha para retirar.").
- **Apagar um depósito** que deixaria a caixinha negativa também é recusado (ex.: depositou 100, retirou 60: não dá para apagar o depósito).
- Apagar uma **retirada** sempre pode.
- Duas retiradas simultâneas nunca passam do saldo (o servidor serializa por caixinha).

> O **progresso** (percentual, meses restantes, sugestão por mês, atraso) **não vem da API**: calcule no app com `goalProgress(goal, now)`.

### 3.10 Orçamentos

Valem **a partir de um mês**, até a próxima mudança. O app calcula o vigente com `budgetForMonth` / `limitsForMonth`.

| Rota | Corpo | Resposta |
| --- | --- | --- |
| `GET /v1/budgets/monthly` | — | `200 [ { "month": "2026-10", "amount": 3000 } ]` ordenado por mês. Pode vir `"0000-00"` (o valor herdado da v1, que vale para tudo até então). `amount: null` = sem orçamento daquele mês em diante |
| `PUT /v1/budgets/monthly/:month` | `{ "amount": number ≥ 0 \| null }` | `200 { "month", "amount" }` |
| `GET /v1/budgets/categories` | — | `200 [ { "categoryId": "food", "month": "2026-10", "amount": 800 } ]` |
| `PUT /v1/budgets/categories/:categoryId/:month` | `{ "amount": number ≥ 0 \| null }` | `200 { "categoryId", "month", "amount" }` |

`:month` precisa ser `AAAA-MM`; `categoryId` precisa existir no catálogo (senão `400`). Use `PUT` com `amount: null` para remover.

### 3.11 Relatórios

Sempre **sem transferências** e **sem pagamentos de fatura** (categoria `invoice`: pagar a fatura não é gasto). **Incluem** as compras no crédito, **na data da compra** (é quando o gasto aconteceu). Geram antes as recorrências vencidas.

| Rota | Resposta |
| --- | --- |
| `GET /v1/reports/monthly-totals` | `200 [ { "month": "2026-10", "income": 3500, "expense": 1200 } ]` — só meses com lançamentos, do mais novo ao mais antigo. Valores **positivos**. Base do histórico. `?by=date` (padrão) agrupa pela data; `?by=spending` pelo **mês em que o gasto conta** (no crédito, o do vencimento da fatura). Outro valor de `by` responde `400`. Pagamentos de fatura e transferências ficam de fora nos dois modos. |
| `GET /v1/reports/category-totals?month=2026-10` | `200 [ { "categoryId", "categoryName", "icon", "color", "bg", "total" } ]` — despesas por categoria no mês, da maior para a menor (`total` positivo). `month` é **obrigatório** (`400` sem ele). Aceita `by=date` (padrão) ou `by=spending`, como acima. |

### 3.12 Backup

Mesmo formato do backup do app (`app: "sobro"`, `schemaVersion` 9).

#### `GET /v1/backup`
Devolve **tudo** da conta como JSON, no formato do backup do app. Serve para o usuário guardar uma cópia e para a LGPD. Traz `categories` (o catálogo e as **suas** categorias, ids `custom-...`), `cards`, `recurrences`, `transactions`, `profile`, `monthly_budgets`, `category_budgets`, `goals` e `goal_entries`.

#### `PUT /v1/backup` — restaurar (**destrutivo**)
- **Corpo:** o JSON de um backup (até 10 MB). Aceita arquivos de **qualquer versão de 1 a 9** do app (os campos novos de cartão e forma de pagamento entram como `null`).
- **Resposta `204`.** **Substitui tudo** da conta (contas, categorias próprias, transações, recorrências, orçamentos, caixinhas, perfil) numa única transação: se algo falhar, **nada muda**. Os **ids são refeitos**: depois do restore, busque tudo de novo.
- **Peça confirmação** ao usuário antes, mostrando as contagens do arquivo. Datas antigas gravadas como instante UTC são normalizadas para o dia de calendário de São Paulo.
- `theme`, `avatar_uri` e `monthly_budget` do perfil são aceitos e **descartados**.
- **Categorias próprias** (ids `custom-*`) vêm no arquivo e são recriadas **com ids novos**, com transações, recorrências e limites remapeados. As do catálogo que vierem no arquivo são ignoradas. Um backup da v1 com categoria criada pelo usuário entra normalmente.
- **Cartão de crédito (v9):** `cards` traz `credit_last_digits`, `credit_limit`, `closing_day` e `due_day`; `transactions` traz `payment_method` e `invoice_month`; `recurrences` traz `payment_method`. A API recusa forma de pagamento em receita ou nas categorias `transfer`/`invoice`, `credit` em conta sem `closing_day`, dias fora de 1 a 31, e pagamento de fatura sem `invoice_month` ou com valor positivo.
- **Erros:** `400` `invalid_backup` com a `message` explicando (arquivo que não é do Sobrô, versão mais nova que a API entende, referência quebrada, valor zero, sinal errado, caixinha com saldo negativo, etc.) · `413` corpo grande demais.

---

## 4. Tabela de erros

| Status | `code` | Quando | O que o app faz |
| --- | --- | --- | --- |
| 400 | `validation_failed` | Corpo/parâmetro inválido (`fields` diz qual) | Mostra a mensagem em cada campo |
| 400 | `invalid_backup` | Arquivo de backup recusado | Mostra a `message` |
| 400 | `invalid_cursor` | `cursor` adulterado | Reinicia a listagem |
| 400 | `invalid_idempotency_key` | Chave malformada | Bug do app: gere um UUID |
| 400 | `bad_request` | JSON quebrado ou requisição malformada | Bug do app |
| 401 | `unauthorized` | Token ausente, inválido ou expirado | Renova o token; se falhar, login |
| 401 | `invalid_credentials` | E-mail/senha (ou senha da exclusão) errados | Mostra "E-mail ou senha incorretos" |
| 401 | `invalid_refresh_token` | Token de renovação inválido | Volta ao login |
| 401 | `invalid_reset_token` | Link de redefinição inválido/expirado/usado | Pede um novo link |
| 403 | `profile_forbidden` | `X-Profile-Id` de um perfil que a conta não gerencia, ou que não existe (mais) | Volta para o próprio perfil e avisa |
| 404 | `not_found` | Não existe ou é de outra pessoa | Atualiza a tela |
| 409 | `email_taken` | E-mail já cadastrado | Sugere entrar |
| 409 | `last_card` | Excluir a última conta | Mostra a mensagem |
| 409 | `transfer_not_editable` | Editar perna de transferência | Oferece excluir e criar outra |
| 409 | `goal_insufficient` | Retirada acima do saldo / apagar depósito que deixa saldo negativo | Mostra a mensagem (traz o valor) |
| 409 | `category_in_use` | Excluir categoria com transações ou recorrências | Mostra a mensagem |
| 409 | `profile_limit` | Criar um perfil gerenciado além do limite | Mostra a mensagem |
| 409 | `credit_in_use` | Tirar o cartão de uma conta que tem compras no crédito (ou recorrências no crédito ainda valendo) | Mostra a mensagem |
| 409 | `invoice_payment_not_editable` | Editar um pagamento de fatura | Oferece excluir |
| 413 | `payload_too_large` | Corpo grande demais | Avisa |
| 426 | `upgrade_required` | Versão do app abaixo do mínimo | Tela "Atualize o app" |
| 429 | `rate_limited` | Muitas tentativas | Pede para esperar |
| 500 | `internal_error` | Erro do servidor | "Tente de novo" |
| 503 | — | `/ready` com o banco fora | Só no monitoramento |

---

## 5. Cliente HTTP de exemplo

Esboço do `api/client.ts` do app (Expo/React Native). Faz o que a [seção 2](#2-como-o-app-deve-consumir) pede: token em `SecureStore`, **renovação única compartilhada**, repetição da chamada uma vez, `X-App-Version`, `Idempotency-Key` e erros tipados.

```ts
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL!; 
const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';
const TIMEOUT_MS = 20_000;

export class NetworkError extends Error {}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: { path: string; message: string }[]
  ) {
    super(message);
  }
}

// ---- sessão ----
interface Session { accessToken: string; refreshToken: string }
let onSessionExpired: () => void = () => {};
export const setOnSessionExpired = (fn: () => void) => (onSessionExpired = fn);

export async function saveSession(s: Session) {
  await SecureStore.setItemAsync('accessToken', s.accessToken);
  await SecureStore.setItemAsync('refreshToken', s.refreshToken);
}
export async function clearSession() {
  await SecureStore.deleteItemAsync('accessToken');
  await SecureStore.deleteItemAsync('refreshToken');
}

// ---- transporte ----
async function send(method: string, path: string, body?: unknown, extra: Record<string, string> = {}, token?: string | null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${BASE_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-App-Version': APP_VERSION,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new NetworkError('Sem conexão. Tente de novo.'); // rede ou timeout
  } finally {
    clearTimeout(timer);
  }
}

// Uma renovação só: chamadas simultâneas esperam a mesma promessa.
let refreshing: Promise<boolean> | null = null;
function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    const refreshToken = await SecureStore.getItemAsync('refreshToken');
    if (!refreshToken) return false;
    const res = await send('POST', '/v1/auth/refresh', { refreshToken }); // NetworkError sobe: não desloga por rede
    if (res.status === 401) { await clearSession(); return false; }
    if (!res.ok) throw new ApiError(res.status, 'refresh_failed', 'Não foi possível renovar a sessão.');
    await saveSession(await res.json()); // salva os DOIS tokens novos antes de usar
    return true;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// ---- chamada pública ----
interface Options { body?: unknown; idempotencyKey?: string; auth?: boolean }

export async function api<T>(method: string, path: string, opts: Options = {}, retried = false): Promise<T> {
  const { body, idempotencyKey, auth = true } = opts;
  const token = auth ? await SecureStore.getItemAsync('accessToken') : null;
  const res = await send(method, path, body, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}, token);

  if (res.status === 401 && auth && !retried) {
    if (await refreshSession()) return api<T>(method, path, opts, true);
    onSessionExpired(); // volta para a tela de entrar
  }
  if (res.status === 204) return undefined as T;

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, json?.error?.code ?? 'unknown', json?.error?.message ?? 'Erro inesperado.', json?.error?.fields);
  }
  return json as T;
}

export const newIdempotencyKey = () => Crypto.randomUUID();
```

**Uso — criar uma transação com "Tentar de novo" seguro:**

```ts
// Gere a chave UMA vez por tentativa de salvar (quando a pessoa toca em "Salvar") e reaproveite nos retries.
const key = newIdempotencyKey();

async function save() {
  try {
    const t = await api<Transaction>('POST', '/v1/transactions', {
      idempotencyKey: key,
      body: {
        cardId, categoryId, name, description,
        amount: cents / 100,                 // positivo; o tipo define o sinal
        type: 'expense',
        occurredAt: `${localDay}T12:00:00.000Z`, // AAAA-MM-DD do dia que a pessoa vê
        ...(repeat ? { repeat } : {}),
      },
    });
    notifyDataChanged();
  } catch (e) {
    if (e instanceof NetworkError) showToast({ type: 'error', title: e.message }); // botão "Tentar de novo" chama save() de novo, com a MESMA key
    else if (e instanceof ApiError && e.code === 'validation_failed') mostrarErrosNosCampos(e.fields);
    else if (e instanceof ApiError) showToast({ type: 'error', title: e.message });
  }
}
```

**Uso — buscar o Dashboard em paralelo:**

```ts
const [cards, tx, byCategory, budgets, categoryBudgets, recurrences, goals] = await Promise.all([
  api<Card[]>('GET', '/v1/cards'),
  api<{ items: Transaction[]; nextCursor: string | null }>('GET', `/v1/transactions?month=${month}`),
  api<CategoryTotal[]>('GET', `/v1/reports/category-totals?month=${month}`),
  api<BudgetEntry[]>('GET', '/v1/budgets/monthly'),
  api<CategoryBudgetEntry[]>('GET', '/v1/budgets/categories'),
  api<Recurrence[]>('GET', '/v1/recurrences'),
  api<Goal[]>('GET', '/v1/goals'),
]);
// Com as linhas na mão, calcule com utils/: buildSummary, generateInsights, plannedTransactions, goalProgress...
```

---

### Checklist rápido para o desenvolvedor do app

- [ ] Tokens em `expo-secure-store`; renovação **única** e compartilhada; 401 na renovação → login.
- [ ] `X-App-Version` em toda requisição; tela para o **426**.
- [ ] `Idempotency-Key` (UUID por tentativa) em todo `POST` que cria; reusar a chave ao tentar de novo.
- [ ] Valor **positivo** nas transações/transferências; **com sinal** só nas movimentações de caixinha.
- [ ] `occurredAt` das transações ao **meio-dia UTC** do dia local (`AAAA-MM-DDT12:00:00.000Z`).
- [ ] Buscar tudo de uma tela **em paralelo**; refetch depois de gravar e ao focar a tela.
- [ ] Seguir o `nextCursor` quando houver mais de uma página de transações.
- [ ] Erro de rede: aviso + "Tentar de novo", formulário preservado, nada mostrado como salvo.
- [ ] Depois de `PUT /backup`, buscar tudo de novo (os ids mudam).
- [ ] Nada financeiro gravado em disco além dos tokens; nada sensível em log.

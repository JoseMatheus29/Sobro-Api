# Plano: migrar o app do SQLite para a API (v2)

Este documento tem **o plano** (partes 1 a 6) e **dois prompts prontos para colar em sessões do Claude** (partes 7 e 8): um para a API (pré-requisito) e um para o app. Complementa o [api-requisitos-e-hospedagem.md](api-requisitos-e-hospedagem.md) (seção 9) e o [api-rotas-e-consumo-mobile.md](api-rotas-e-consumo-mobile.md) (contrato e cliente de exemplo).

## 1. Onde estamos

| | API (`Sobro - Api`) | App (`jm`) |
| --- | --- | --- |
| Estado | No ar no Heroku, 131 testes, esquema/backup v8 | v1.0.0, **local-first**, SQLite no aparelho, sem login |
| Dados | Postgres, tudo por usuário | `expo-sqlite` (`sobro.db`), migração v8 |
| Falta | Categorias do usuário (ver 3.1) | Tudo da v2: login, cliente HTTP, camada de dados, backup, migração |

**O que o app tem hoje e vai mudar** (levantado no código):

- **15 arquivos usam o SQLite diretamente** (`useSQLiteContext` / funções de `db/` que recebem `db`): `app/_layout.tsx`, `RecurrenceSync`, `GoalFormModal`, `detailsSpend/[id]`, `TransferDetails`, `editAcount/index`, `BackupCard`, `goal/[id]`, `MovementModal`, `myDetailing`, `NewCategoryModal`, `registrationSpent`, `transfer`, `CardFormModal`, `wallet`. Mais os 12 módulos de `db/` e os hooks de `db/hooks.ts` (`useCards`, `useTransactions`, `useGoals`, `useInsights` etc.).
- `app/index.tsx` redireciona direto para `/dashboard` (sem sessão).
- `db/events.ts` (`notifyDataChanged`) e `useFocusEffect` são o gatilho de nova busca dos hooks.
- `RecurrenceSync` gera as recorrências vencidas e agenda lembretes; `db/reminders.ts` lê o perfil e as recorrências do SQLite.
- O **tema** mora em `profile.theme` no SQLite e é aplicado **antes** de desenhar (`initDatabase` em `_layout.tsx`).
- O backup (`BackupCard`, `db/backup.ts`, `utils/backup.ts`) exporta/importa o banco local.
- **O app permite criar categorias** (`NewCategoryModal` → `createCategory`, ids `custom-<timestamp>`).
- Dependências que **não existem** e vão ser necessárias: `expo-secure-store`, `expo-crypto`, `@react-native-async-storage/async-storage`, `@tanstack/react-query`. As duas primeiras (e o AsyncStorage) são **módulos nativos: exigem novo build** (`expo-dev-client`).
- O repositório do app tem **alterações não commitadas** (`CLAUDE.md`, `ThemeProvider.tsx`, `package.json`, `package-lock.json`, `docs/...`). Resolva isso antes (commit ou stash).

## 2. Princípios da migração

1. **Online-first, sem sincronização.** Toda tela lê e grava pela API; sem rede, aviso e "Tentar de novo". Nada é guardado para enviar depois.
2. **A API é a única fonte de verdade.** O app calcula só o que são funções puras (`utils/`): resumo, insights, histórico, previsão, progresso das caixinhas.
3. **Manter os hooks.** As telas continuam chamando `useCards()`, `useTransactions()`..., com o mesmo formato de retorno. Muda o que há por baixo.
4. **Nunca perder dado de testador.** O arquivo `sobro.db` local **não é apagado** até o servidor confirmar o recebimento (204 do `PUT /backup`).
5. **App quebrado no meio é normal.** Não dá para misturar SQLite e API na mesma entidade (os ids de conta, por exemplo, seriam de dois mundos). Trabalhe numa **branch**, com commits pequenos que mantêm o `tsc` verde; o app só volta a rodar de ponta a ponta na Etapa 4.

## 3. Decisões a tomar antes de começar

Cada uma tem uma recomendação. Se discordar, **edite os prompts das partes 7 e 8 antes de colar**.

### 3.1 Categorias personalizadas (BLOQUEIO)

A API só tem o **catálogo fixo** de 9 categorias. O app cria categorias próprias. Consequências se nada for feito:

- A tela de nova categoria não tem onde gravar.
- **Um backup da v1 de quem criou categoria própria é recusado** pelo `PUT /backup` (`400`, "categoria aponta para algo que não existe"). É justamente o caminho de migração dos testadores.

| Opção | Custo | Efeito |
| --- | --- | --- |
| **A. Categorias por usuário na API (recomendada)** | Médio: coluna `user_id` opcional em `categories`, `POST/PATCH/DELETE /categories`, validação "do catálogo ou minha" em transações, recorrências e orçamentos, e backup importando as `custom-*` | Mantém o app como está e preserva os dados dos testadores |
| B. Remover "nova categoria" na v2 | Baixo na API, mas tira uma função | Dados de testadores com categoria própria precisariam ser remapeados para `Outros` na importação |

**Recomendação: A.** Está especificada no prompt da parte 7.

### 3.2 Dados locais dos testadores

| Opção | Experiência |
| --- | --- |
| **Manter o `expo-sqlite` por mais uma versão, só leitura, e oferecer "Enviar meus dados antigos" (recomendada)** | Depois do primeiro login o app detecta o `sobro.db` com dados, monta o backup com o `exportBackup` que **já existe e já é testado**, mostra as contagens, pede confirmação e envia por `PUT /backup`. Só depois do 204 marca como migrado. |
| Pedir só o JSON exportado | Mais simples, mas depende de o testador exportar na v1 **antes** de atualizar, e de importar à mão. Quem esquecer perde a facilidade (o arquivo continua no aparelho, mas inacessível). |

**Recomendação:** a primeira. O `expo-sqlite` é removido de vez na **v2.1**, depois da janela de migração.

### 3.3 Cache e carregamento

**TanStack Query** (recomendado): o servidor está nos EUA, então sem cache cada volta a uma tela mostraria um carregamento. Mantém os hooks com a mesma assinatura (`{ cards, loading, refetch }`) e troca `notifyDataChanged` por invalidação de consultas. É só JavaScript (sem novo build por causa dele). Cache **só em memória**: nenhum dado financeiro em disco.

### 3.4 Tema

Fica **só no app** (precisa valer antes do login). Sai do SQLite e vai para o `@react-native-async-storage/async-storage`, lido na abertura antes de desenhar. `useProfile` junta os campos de `GET /me` com o tema local.

### 3.5 Ambientes

`EXPO_PUBLIC_API_URL` por perfil de build (EAS): desenvolvimento aponta para a API local ou para o Heroku, produção para o Heroku. Em desenvolvimento com API local por `http://`, o Android exige tráfego em texto claro liberado (só no build de desenvolvimento).

## 4. Pré-requisito na API (Etapa 0)

Categorias por usuário (decisão 3.1-A). Resumo do contrato novo, que o prompt da parte 7 detalha:

- `categories` ganha `user_id` (nulo = catálogo global). Nenhuma mudança no que existe.
- `GET /categories` devolve o **catálogo + as do usuário**.
- `POST /categories`, `PATCH /categories/:id`, `DELETE /categories/:id` (só das do usuário; `409 category_in_use` se houver transação ou recorrência usando; os limites por categoria saem junto, como o app já faz).
- Transações, recorrências e orçamentos aceitam categoria **do catálogo ou do próprio usuário**; a de outra pessoa responde como inexistente.
- Backup: exporta as categorias do usuário; importa as `custom-*` do arquivo refazendo ids.

## 5. Etapas do app

| # | Etapa | Entrega | Verificação |
| --- | --- | --- | --- |
| 0 | **API: categorias do usuário (concluída)** | Parte 7 | `npm test` da API |
| 1 | **Base** | Branch; dependências; `EXPO_PUBLIC_API_URL`; pasta `api/` com o cliente (renovação única, `Idempotency-Key`, erros tipados, `X-App-Version`) e tipos das respostas; testes do cliente | `npx tsc --noEmit`, `npm test` |
| 2 | **Sessão** | `AuthProvider` acima do `Stack`; telas entrar, criar conta, recuperar e redefinir senha; `app/index.tsx` decide pela sessão; sair da conta e excluir conta no Perfil; tela "Atualize o app" (426) | Fluxo manual no aparelho |
| 3 | **Camada de dados** | Módulos `api/*` e `db/*` reescritos sobre eles **sem o parâmetro `db`**, com os mesmos hooks (TanStack Query); os 15 arquivos de tela ajustados; `RecurrenceSync` passa a só agendar lembretes; tema local; categorias editáveis | `tsc`, `npm test`, `npm run lint` |
| 4 | **Estados e primeira execução ponta a ponta** | Carregando/erro/sem conexão em todas as telas, preservando formulários; `Idempotency-Key` em toda criação; paginação por `nextCursor` | Roteiro manual completo (parte 6) |
| 5 | **Backup e migração dos dados locais** | `BackupCard` com `GET/PUT /backup`; "Enviar meus dados antigos" a partir do `sobro.db` | Teste com banco de testador real (cópia) |
| 6 | **Fechamento** | `CLAUDE.md` atualizado (deixa de ser local-first); build de teste interno (EAS); versão 2.0.0 | Checklist final |
| 7 | **v2.1 (depois)** | Remover `expo-sqlite`, `SQLiteProvider`, `migrateDbIfNeeded`, `seedIfEmpty` | Após a janela de migração |

**Ordem dentro da Etapa 3** (cada item em um commit, com `tsc` verde): categorias e contas → transações, transferências e busca → recorrências e lembretes → orçamentos e limites → caixinhas → relatórios (histórico, totais por categoria) → perfil (`/me` + tema local).

**Mapa de equivalência (SQLite → API):**

| Hoje (`db/`) | Depois |
| --- | --- |
| `getCards`, `createCard`, `updateCard`, `getCardUsage`, `deleteCard` | `GET/POST/PATCH /cards`, `GET /cards/:id/usage`, `DELETE /cards/:id` |
| `getTransactions` (filtros `cardId`, `month`, `limit`) | `GET /transactions?...` (o `limit` vira paginação por cursor) |
| `createTransaction` + `createRecurrence` | **um** `POST /transactions` com `repeat` |
| `updateTransaction` + `updateRecurrence` + `endRecurrence` | `PATCH /transactions/:id` com `applyToNext` (e `POST /recurrences/:id/end`) |
| `createTransfer`, `deleteTransfer` | `POST /transfers`; `DELETE /transactions/:id` (apaga as duas pernas) |
| `getMonthlyTotals`, `getCategoryTotals` | `GET /reports/monthly-totals`, `GET /reports/category-totals?month=` |
| `materializeDueRecurrences` | **some do app**: o servidor gera ao ler (`GET /cards`, `/transactions`, `/recurrences`, `/reports/*`) |
| `getBudgetEntries`, `setBudgetFrom` | `GET /budgets/monthly`, `PUT /budgets/monthly/:month` |
| `getCategoryBudgetEntries`, `setCategoryBudgetFrom` | `GET /budgets/categories`, `PUT /budgets/categories/:categoryId/:month` |
| `getGoals`, `createGoal`... `addGoalEntry`, `deleteGoalEntry` | `GET/POST /goals`..., `POST /goals/:id/entries` (valor **com sinal**) |
| `getProfile`, `updateProfile` | `GET/PATCH /me` (+ tema no armazenamento local) |
| `exportBackup`, `restoreBackup` | `GET /backup`, `PUT /backup` |
| `seedIfEmpty`, `migrateDbIfNeeded` | somem (o cadastro cria perfil e "Conta Principal") |

## 6. Riscos e roteiro de verificação

| Risco | Como evitar |
| --- | --- |
| Perder dados de testador | Não apagar `sobro.db`; marcar migrado só após o 204; testar com **cópia** de um banco real |
| Renovação de token em corrida derrubando a sessão | Promessa única compartilhada; teste automatizado do cliente |
| Transação duplicada ao tentar de novo | `Idempotency-Key` por tentativa, reaproveitada nos retries; teste do cliente |
| Mês errado em lançamento à noite | Enviar `occurredAt` ao meio-dia UTC do dia local; nunca `new Date().toISOString()` direto |
| Valor com sinal errado nas caixinhas | Tipos separados para entrada de transação (positivo) e de movimentação (com sinal) |
| Telas lentas por latência (servidor nos EUA) | Buscas em paralelo e cache em memória; medir no aparelho real |
| Lembretes deixarem de funcionar | Reagendar a partir de `GET /recurrences` ao abrir e ao voltar ao primeiro plano |
| Build sem os módulos nativos novos | Gerar novo build de desenvolvimento antes de testar a Etapa 2 |

**Roteiro manual (Etapa 4):** cadastrar; sair e entrar; derrubar a rede e tentar salvar (formulário preservado, nada mostrado como salvo) e tentar de novo (sem duplicar); criar despesa, receita, mensal e parcelada; transferir entre contas; editar com e sem "aplicar às próximas"; criar, guardar e retirar de caixinha (incluindo retirar demais); orçamento e limite por categoria; histórico e previsão; busca; exportar e importar backup; trocar de aparelho (entrar e ver tudo); excluir a conta.

**Pronto quando:** `npx tsc --noEmit`, `npm run lint` e `npm test` passam; o roteiro acima passa em um aparelho real contra o Heroku; um banco de testador real migra e os saldos, totais do mês e valores das caixinhas batem antes e depois; nenhum dado financeiro fica em disco além do `sobro.db` antigo.

---

## 7. Prompt para a sessão da API (Etapa 0)

> **Concluída** na branch `feat/categorias-por-usuario` (migração `0005`). Ajustes em relação ao texto abaixo: o id é `custom-` + 32 caracteres hexadecimais (cabe nos 40 que as rotas aceitam); uma coluna `seq` guarda a ordem de criação; e a exclusão só é bloqueada por **transações ou recorrências**, e os limites por categoria saem junto (é o que o app já fazia, e o texto abaixo dizia o contrário). O contrato final está no [api-rotas-e-consumo-mobile.md](api-rotas-e-consumo-mobile.md#34-categorias).

Cole o texto abaixo, a partir da linha de baixo do `---`, numa sessão do Claude aberta em `C:\Users\Jmatheus\Desktop\Sobro - Api`.

---

Você vai acrescentar à API do Sobrô? (este repositório) **categorias personalizadas por usuário**, porque o app permite criar categorias (`custom-<timestamp>`) e a API só conhece o catálogo fixo. Sem isso, o backup de um testador da v1 com categoria própria é recusado. Não refatore o que já funciona e não mude contratos existentes.

### 1. Leia antes de escrever
`README.md`; `src/db/schema.ts` e `drizzle/` (migrações 0000 a 0004); `src/services/categories.ts` e `src/controllers/categories.controller.ts`; `src/services/transactions.ts`, `src/services/recurrences.ts`, `src/services/reports.ts` (orçamentos por categoria) e os pontos que usam `assertCategory` e `categoryIds`; `src/shared/backup.ts`, `src/services/backup.ts`, `test/reports-backup.test.ts`, `test/isolation.test.ts`, `test/helpers.ts`. No app (somente leitura, `C:\Users\Jmatheus\Desktop\jm`): `db/categories.ts` e `app/registrationSpent/components/NewCategoryModal.tsx` (o que o app cria e como são os campos: `name`, `icon`, `color`, `bg`).

### 2. O que fazer, em commits pequenos e nesta ordem

**Etapa 1: banco.** Em `categories`, acrescente `user_id uuid` **nulo** (referência a `users`, `on delete cascade`) e um índice em `user_id`. Linhas com `user_id` nulo são o catálogo global (as 9 existentes não mudam). Gere com `npx drizzle-kit generate --name user_categories`. Nunca edite uma migração já aplicada.

**Etapa 2: serviço e rotas.**
- `GET /categories` passa a devolver o catálogo **mais** as categorias do usuário (cada item ganha `custom: boolean`; mantenha os campos atuais). Ordem: catálogo primeiro, depois as do usuário por id.
- `POST /categories` `{ name (até 30), icon (até 40), color (hex), bg (até 40) }` → `201`. O id é gerado pelo servidor como `custom-<uuid curto>` (texto, único). Aceita `Idempotency-Key` (escopo `POST /categories`).
- `PATCH /categories/:id` (`name`, `icon`, `color`, `bg` opcionais) e `DELETE /categories/:id` → `204`. **Só as do próprio usuário**: id do catálogo ou de outra pessoa responde `404`.
- `DELETE` de categoria em uso (transação ou recorrência; os limites por categoria saem junto, como no app) responde `409` com `code: 'category_in_use'`, mensagem em português (como a do app: "Não é possível excluir uma categoria com transações registradas.").
- `assertCategory` passa a receber o `userId` e aceitar categoria **do catálogo ou do próprio usuário**; a de outra pessoa responde `400` "Categoria inexistente." Aplique em transações (criar e editar), recorrências e orçamentos por categoria. Não mude as mensagens existentes.
- A categoria `transfer` continua só das transferências.

**Etapa 3: backup.** `exportBackup` inclui na tabela `categories` o catálogo **e** as do usuário. `validateBackup` passa a aceitar referências a categorias que estejam **no próprio arquivo** com id começando por `custom-` (além do catálogo); ids `custom-*` repetidos no arquivo são recusados; categorias do catálogo vindas no arquivo continuam ignoradas. `restoreBackup` apaga as categorias do usuário antes (depois de transações, recorrências e orçamentos), recria as `custom-*` do arquivo **refazendo o id** (mapa antigo → novo) e remapeia `category_id` em transações, recorrências e `category_budgets`. Continua uma única transação SQL.

**Etapa 4: testes.** `npm run test:db` antes. Novos casos: criar/editar/listar/excluir; `409 category_in_use` (por transação e por recorrência) e limites saindo junto; isolamento (outro usuário recebe 404 ao editar/excluir, `400` ao usar a categoria alheia, e não a vê na listagem); `Idempotency-Key` repetida não duplica; ida e volta de backup com categoria própria (ids refeitos, mesmos totais); um backup da v1 com `custom-*` entra; recusas novas (`custom-*` repetido, referência a categoria `custom-*` que não está no arquivo). Os testes antigos continuam passando.

**Etapa 5: documentação e coleção.** Linhas de `categories`, rotas e o backup no `api-requisitos-e-hospedagem.md`; seção de categorias no `api-rotas-e-consumo-mobile.md`; README (convenções); pasta no Postman (criar, listar, editar, excluir) mantendo o Runner passando de ponta a ponta.

### 3. Como trabalhar
Mensagens de erro em português do Brasil; código e comentários no estilo do repositório. Não invente endpoint, campo ou regra fora do que está aqui. Em dúvida, pergunte com uma recomendação. Um commit por etapa, rodando `npm run typecheck` e `npm test` antes de cada um. Não comite `.env`. Não toque em `dist/`. Não use dado real nos testes.

### 4. Pronto quando
`typecheck` e `npm test` passam; `npx drizzle-kit generate` não gera mais nada; o Runner do Postman termina sem falhas. No final, diga o que foi feito, o que ficou de fora e as decisões que tomou sozinho.

---

## 8. Prompt para a sessão do app (Etapas 1 a 6)

Cole o texto abaixo, a partir da linha de baixo do `---`, numa sessão do Claude aberta em `C:\Users\Jmatheus\Desktop\jm`. A sessão precisa de **leitura** em `C:\Users\Jmatheus\Desktop\Sobro - Api` (a API e os guias); se não tiver acesso, adicione a pasta à sessão. **Só cole depois da Etapa 0 da API (parte 7) estar pronta.**

---

Você vai migrar o app Sobrô? (este repositório, Expo/React Native) do SQLite local para a **API online** (Fastify + Postgres, já no ar no Heroku). O app passa a exigir login, ler e gravar tudo pela API e **não guarda dados financeiros no aparelho**. Não há sincronização nem fila: sem rede, o app avisa e deixa tentar de novo. **Faça só isso**: não redesenhe telas, não mude regras de negócio, não mexa no visual e não mude o que já funciona além do necessário.

### 1. Leia antes de escrever
No app:
- `CLAUDE.md` (convenções: nunca `Alert.alert` e sim `showToast`/`confirm`; textos em `-type.ts`; telas novas entram no `_layout.tsx` pelo **nome completo** da rota, como `login/index`; armadilha do NativeWind com classes que mudam depois da primeira renderização).
- `app/_layout.tsx`, `app/index.tsx`, `db/hooks.ts`, `db/events.ts`, `db/` inteiro (`schema`, `cards`, `transactions`, `recurrences`, `budgets`, `categoryBudgets`, `categories`, `goals`, `profile`, `backup`, `backupFile`, `reminders`, `seed`), `utils/` (as funções puras continuam), `app/components/RecurrenceSync.tsx`, `app/components/theme/ThemeProvider.tsx`, `utils/applyTheme.ts`, `app/editAcount/components/BackupCard.tsx`, `app/registrationSpent/index.tsx`, `app/detailsSpend/[id].tsx` e as demais telas que usam `useSQLiteContext`.
- `docs/api-requisitos-e-hospedagem.md` (seções 5 e 9).

Na API (somente leitura, `C:\Users\Jmatheus\Desktop\Sobro - Api`): **`api-rotas-e-consumo-mobile.md`** (o contrato de todas as rotas, as regras de consumo e um cliente HTTP de exemplo) e **`plano-migracao-app-v2.md`** (este plano). O contrato manda: formatos de corpo e resposta, sinal dos valores, datas, erros e idempotência estão lá.

### 2. Antes de começar
O repositório tem alterações não commitadas (`CLAUDE.md`, `ThemeProvider.tsx`, `package.json`, `package-lock.json`, `docs/...`). **Pare e me pergunte** como tratá-las (commit ou stash) antes de criar a branch `feat/api-v2`.

### 3. O que fazer, em commits pequenos e nesta ordem
Mantenha `npx tsc --noEmit` verde em **cada** commit. O app só roda de ponta a ponta a partir da Etapa 4; avise-me quando chegar nela.

**Etapa 1: base.**
- Dependências: `expo-secure-store`, `expo-crypto`, `@react-native-async-storage/async-storage`, `@tanstack/react-query`. Diga-me que é preciso um **novo build de desenvolvimento** (módulos nativos).
- `EXPO_PUBLIC_API_URL` lida num único lugar; `.env.example` documentando.
- Pasta `api/`: cliente HTTP a partir do exemplo do guia (seção 5): token em `SecureStore`; **uma renovação só, compartilhada**, e uma repetição da chamada; não renovar em `/auth/*`; erro de rede **não** desloga; timeout; `X-App-Version` (versão do `expo-constants`) em toda requisição; `Idempotency-Key` opcional; `ApiError` e `NetworkError` tipados. Tipos das respostas (conta, transação, recorrência, caixinha, movimentação, orçamento, relatórios) fiéis ao guia.
- **Testes do cliente** (jest, `fetch` simulado): renovação única com várias chamadas simultâneas, repetição de uma vez só, 401 de `/auth/*` não renova, erro de rede não desloga, `Idempotency-Key` reaproveitada, mapeamento de erros.
- Funções puras que formatam entrada (data de calendário ao meio-dia UTC, centavos para número) em `utils/`, **com testes**.

**Etapa 2: sessão.**
- `AuthProvider` acima do `Stack`, ao lado do `FeedbackProvider`: restaura a sessão do `SecureStore`, expõe entrar, cadastrar, sair e excluir conta, e avisa o cliente quando a sessão expira (volta ao login).
- Telas (pastas em `app/`, com `-type.ts`, e registradas no `_layout.tsx` pelo nome completo): `login/index`, `register/index`, `forgot/index`, `reset/index`. Mesmo estilo visual das telas existentes (`ui/Field`, `GradientButton`). Validação de senha (8 a 128) e e-mail; mensagens do servidor mostradas por `showToast`.
- `app/index.tsx` decide: sem sessão → login; com sessão → `/dashboard`. Enquanto restaura a sessão, o fundo/splash atual (sem piscar o login).
- Perfil (`editAcount`): **Sair da conta** e **Excluir conta** (`DELETE /me` pedindo a senha, com `confirm` destrutivo).
- Tela "Atualize o app" quando qualquer chamada responder 426.

**Etapa 3: camada de dados.** Um commit por item, nesta ordem: (a) categorias e contas, (b) transações, transferências e busca, (c) recorrências e lembretes, (d) orçamentos e limites por categoria, (e) caixinhas, (f) relatórios (histórico e totais por categoria), (g) perfil.
- Reescreva os módulos de `db/` **mantendo os nomes exportados e os tipos de registro** (`CardRecord`, `TransactionRecord`...), mas **sem o parâmetro `db`**, chamando os módulos de `api/`. Ajuste todas as telas que usam `useSQLiteContext` para chamar sem `db`.
- Os hooks de `db/hooks.ts` mantêm a **mesma assinatura de retorno** (`{ dados, loading, refetch }`), implementados com TanStack Query: `QueryClientProvider` acima do `Stack`, `staleTime` curto, refetch ao focar a tela. `notifyDataChanged` continua existindo e passa a invalidar as consultas. **Cache só em memória.**
- Telas que precisam de várias consultas buscam **em paralelo**.
- **Equivalências** (mapa completo no plano, seção 5): `createTransaction`+`createRecurrence` viram **um** `POST /transactions` com `repeat`; `updateTransaction`+`updateRecurrence` viram `PATCH` com `applyToNext`; `materializeDueRecurrences` **some** (o servidor gera ao ler); `getMonthlyTotals`/`getCategoryTotals` viram `/reports/*`; transferência é `POST /transfers`.
- **Sinal e data:** transação, transferência e recorrência vão com `amount` **positivo**; **só a movimentação de caixinha** vai com sinal. `occurredAt` de transação/transferência = dia local às 12:00 UTC (`AAAA-MM-DDT12:00:00.000Z`), **nunca** `new Date().toISOString()` direto.
- **Toda criação** (`POST` de contas, transações, transferências, caixinhas, movimentações e categorias) envia `Idempotency-Key`: um UUID por tentativa de salvar, **reaproveitado** quando a pessoa toca em "Tentar de novo".
- `useCategories` usa `GET /categories` (catálogo + as do usuário); `NewCategoryModal` usa `POST /categories`.
- `RecurrenceSync` passa a só **reagendar lembretes** (ao abrir e ao voltar ao primeiro plano), lendo de `GET /recurrences` e `GET /me`; `db/reminders.ts` deixa de receber `db`.
- **Tema:** sai do SQLite e vai para o `AsyncStorage`, lido **antes** de desenhar (o que `initDatabase` fazia). `useProfile` junta `GET /me` com o tema local. Não envie tema à API.
- Tire de `_layout.tsx` o `SQLiteProvider` **apenas do fluxo normal** (a Etapa 5 ainda precisa ler o `sobro.db` antigo, em separado). `seedIfEmpty` e `migrateDbIfNeeded` deixam de rodar para os dados novos.

**Etapa 4: estados e primeira execução.**
- Toda tela que lê dados mostra **carregando** e, em erro de rede, o aviso com **Tentar de novo**, sem mostrar nada como salvo e **sem limpar o formulário**. Erros 400 mostram a mensagem junto do campo (`fields`). Os outros erros por `showToast` (tabela de erros do guia, seção 2.7 e 4).
- Siga o `nextCursor` quando houver mais páginas de transações.
- **Pare aqui e me avise** para eu rodar o roteiro manual no aparelho (o roteiro está no plano, parte 6).

**Etapa 5: backup e dados locais.**
- `BackupCard`: exportar usa `GET /backup` e compartilha o arquivo; importar valida a **forma** do arquivo, mostra as contagens (`summarizeBackup`), pede confirmação destrutiva e chama `PUT /backup`; erro 400 mostra a mensagem do servidor. Depois do restore, invalide tudo e busque de novo (os ids mudam).
- **Migração do `sobro.db` antigo:** `expo-sqlite` continua instalado **só leitura** nesta versão. Depois do primeiro login, se existir `sobro.db` com dados e não houver o marcador "migrado", ofereça "Enviar meus dados antigos": monte o backup com o `exportBackup` que já existe, mostre as contagens, peça confirmação e envie por `PUT /backup`. **Só depois do 204** grave o marcador "migrado" (no `AsyncStorage`). Em falha, nada é marcado e o arquivo local fica intacto. **Nunca apague o `sobro.db`.** Se a conta já tiver dados, avise que serão substituídos.

**Etapa 6: fechamento.**
- Atualize o `CLAUDE.md`: o app deixa de ser local-first; descreva `api/`, `AuthProvider`, os hooks sobre TanStack Query, a regra do sinal/data e a idempotência.
- Versão `2.0.0` em `app.json`/`package.json` e perfis do `eas.json` com `EXPO_PUBLIC_API_URL`.
- Liste o que precisa de novo build e como gerar um build de teste interno.

### 4. Como trabalhar
- Textos para o usuário em português do Brasil, em `-type.ts`. Comentários curtos, no estilo do repositório, só onde o motivo não é óbvio.
- **Não invente rota, campo ou regra** fora do contrato do guia. Se faltar algo na API, **pare e me diga** (não contorne no app).
- Um commit por etapa/item, rodando `npx tsc --noEmit`, `npm run lint` e `npm test` antes de cada um. As funções puras de `utils/` e seus testes **não mudam**.
- Não comite `.env`, não registre valores financeiros nem tokens em log, e não grave dado financeiro em disco além do `sobro.db` antigo.
- Para qualquer decisão fora do que está aqui, pergunte com uma recomendação.

### 5. Pronto quando
`npx tsc --noEmit`, `npm run lint` e `npm test` passam; nenhuma tela usa SQLite para dados novos; o roteiro manual passa no aparelho contra o Heroku; uma **cópia** de um banco de testador real migra e os saldos, os totais do mês e os valores das caixinhas batem antes e depois. No final, diga o que foi feito, o que ficou de fora (inclusive a remoção do `expo-sqlite`, que fica para a v2.1) e as decisões que tomou sozinho.

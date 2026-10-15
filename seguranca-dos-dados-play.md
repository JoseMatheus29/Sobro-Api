# Play Console: respostas para "Segurança dos dados" e links obrigatórios

Rascunho preparado a partir do que a **API** realmente faz (código desta pasta). **Você preenche o formulário no Play Console**, e as respostas precisam refletir também o que o **app** coleta (ver o final). Confira as definições vigentes da Play antes de enviar: as categorias e as regras mudam.

## 1. Links para a ficha do app

Substitua `<seu-app>` pelo endereço do Heroku (ou pelo seu domínio, se tiver um).

| Campo na Play | URL |
| --- | --- |
| **Política de Privacidade** | `https://<seu-app>.herokuapp.com/privacidade` |
| **Exclusão de conta** (URL do recurso na web para pedir a exclusão da conta e dos dados) | `https://<seu-app>.herokuapp.com/excluir-conta` |

A exclusão **dentro do app** (Perfil > Excluir conta, `DELETE /v1/me`) precisa existir na versão enviada. A página da web é o segundo caminho que a Play exige.

## 2. Formulário "Segurança dos dados"

### Coleta e compartilhamento
| Pergunta | Resposta | Por quê |
| --- | --- | --- |
| O app coleta ou compartilha algum dos tipos de dados necessários? | **Sim** | Há conta e registros financeiros no servidor. |
| Os dados do usuário são **compartilhados** com terceiros? | **Não** | Heroku (hospedagem) e Resend (e-mail de redefinição) tratam os dados **em nome do desenvolvedor**, como prestadores de serviço. Confirme na orientação da Play que isso não conta como "compartilhamento". |
| Os dados são **vendidos**? | **Não** | |

### Tipos de dados coletados

| Categoria na Play | Tipo | Coletado? | Obrigatório ou opcional | Finalidades |
| --- | --- | --- | --- | --- |
| Informações pessoais | **Endereço de e-mail** | Sim | Obrigatório | Funcionalidade do app; Gerenciamento de conta |
| Informações pessoais | **Nome** | Sim | **Opcional** | Funcionalidade do app (personalização) |
| Informações financeiras | **Outras informações financeiras** (contas, transações, orçamentos e caixinhas que o usuário lança) | Sim | Obrigatório (é o uso do app) | Funcionalidade do app |
| Informações financeiras | Informações de pagamento, histórico de compras, pontuação de crédito | **Não** | | O app não processa pagamentos nem se conecta a bancos |
| Localização, contatos, fotos e vídeos, áudio, arquivos, calendário, mensagens, saúde e condicionamento físico | **Não** | | |
| Atividade no app, navegação na web, pesquisas | **Não** | | Sem análise nem rastreamento de terceiros |
| Dispositivo ou outros IDs | **Não pelo app** | | Veja a nota sobre o endereço IP abaixo |

> **Endereço IP:** o servidor registra o IP, a data e a rota de cada requisição, por um período curto, para segurança e prevenção de abuso. Verifique, na orientação da Play, se isso exige declarar "Dispositivo ou outros IDs" ou localização aproximada. Na dúvida, declare.

### Práticas de segurança
| Pergunta | Resposta |
| --- | --- |
| Os dados são **criptografados em trânsito**? | **Sim** (HTTPS em toda comunicação) |
| Os usuários podem **pedir a exclusão** dos dados? | **Sim** |
| URL para o pedido de exclusão | `https://<seu-app>.herokuapp.com/excluir-conta` |
| Revisão de segurança independente | **Não** |
| Segue a política de Famílias | Não se aplica (o app não é direcionado a crianças) |

## 3. O que está por trás de cada resposta (para você conferir)

- **Senha:** só o hash argon2id fica no banco; a senha nunca é registrada em log.
- **Exclusão:** `DELETE /v1/me` apaga o usuário e tudo dele de verdade (chaves estrangeiras em cascata: contas, transações, categorias, recorrências, orçamentos, caixinhas, sessões).
- **Logs:** não carregam valores nem descrições de transações; tokens e termos de busca são ocultados.
- **Sem anúncios nem rastreadores** na API.
- **Dados fora do Brasil:** servidores nos EUA (Heroku). A política de privacidade diz isso.
- **Cópias de segurança:** a política afirma que cópias do banco podem reter dados por até **7 dias**. **Confira se isso é verdade na sua configuração** (backups agendados no Heroku) e ajuste o texto em `src/pages/privacy.ts` e `src/pages/deleteAccount.ts` se for diferente.

## 4. O que o app (não a API) também precisa declarar

Estas respostas valem **só para a API**. Antes de enviar, some o que o app pode coletar por conta própria: se a v2 incluir **relatório de falhas** (Crashlytics, Sentry), **análise de uso** ou qualquer SDK de terceiros, isso entra no formulário e na política. Hoje o app usa notificações **locais** (nada sai do aparelho por isso).

## 5. Antes de publicar

1. **Revisão jurídica** do texto em `/privacidade`. É um ponto de partida técnico.
2. O prazo de **15 dias** para pedidos por e-mail (`SITE.emailDeadlineDays`) e o **e-mail de contato** são compromissos seus: confirme que consegue cumprir.
3. Se usar um **domínio próprio**, troque os links acima e ajuste, se quiser, os textos.
4. Para a redefinição de senha funcionar, configure `RESEND_API_KEY`, `MAIL_FROM` e `RESET_PASSWORD_URL` no Heroku. A política cita o Resend como prestador de e-mail; se você decidir não usá-lo, retire essa linha do texto.

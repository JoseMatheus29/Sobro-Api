import { SITE, layout } from './layout.js';

// Política de privacidade. Descreve o que a API de fato faz (dados guardados, onde, por quanto tempo).
// Ponto de partida técnico: vale uma revisão jurídica antes de publicar na loja.
export function privacyPage(): string {
  return layout(
    'Política de privacidade',
    `<h1>Política de privacidade</h1>
<p class="suave">Atualizada em ${SITE.updatedAt}.</p>

<p>Esta política explica como o aplicativo <strong>${SITE.appName}</strong> (controle de finanças pessoais) trata os seus dados pessoais, em conformidade com a Lei Geral de Proteção de Dados (LGPD, Lei 13.709/2018).</p>

<h2>1. Quem é o responsável</h2>
<p>O responsável pelo tratamento dos dados (controlador) é <strong>${SITE.controller}</strong>. Para qualquer assunto sobre seus dados, escreva para <a href="mailto:${SITE.contactEmail}">${SITE.contactEmail}</a>.</p>

<h2>2. Quais dados guardamos</h2>
<table>
<thead><tr><th>Dado</th><th>Para quê</th></tr></thead>
<tbody>
<tr><td>E-mail e senha (a senha é guardada apenas como um resumo criptográfico, nunca em texto)</td><td>Criar sua conta e entrar no aplicativo</td></tr>
<tr><td>Nome e moeda (opcionais)</td><td>Personalizar o aplicativo</td></tr>
<tr><td>Seus registros financeiros: contas, transações, categorias, transferências, despesas recorrentes, orçamentos e caixinhas</td><td>É o que o aplicativo faz: mostrar saldos, resumos e histórico em qualquer aparelho em que você entrar</td></tr>
<tr><td>Dados técnicos de acesso (endereço IP, data e rota acessada)</td><td>Segurança, prevenção de abuso e correção de falhas</td></tr>
</tbody>
</table>
<p>Não pedimos acesso a contas bancárias, cartões, contatos, localização, câmera nem microfone. Os valores que você digita são lançados por você, manualmente. Os lembretes de vencimento são notificações geradas <strong>no seu aparelho</strong>.</p>

<h2>3. Como usamos os dados</h2>
<p>Usamos os dados somente para fornecer o aplicativo: autenticar você, guardar e mostrar seus registros e, quando você pede, enviar o e-mail de redefinição de senha. <strong>Não vendemos seus dados, não exibimos anúncios e não usamos ferramentas de análise ou rastreamento de terceiros.</strong></p>
<p>A base legal é a execução do serviço que você pediu ao criar a conta (LGPD, art. 7º, V).</p>

<h2>4. Com quem os dados passam</h2>
<p>Usamos prestadores que tratam os dados em nosso nome, apenas para o funcionamento do serviço:</p>
<ul>
<li><strong>Heroku (Salesforce)</strong>: hospedagem da API e do banco de dados.</li>
<li><strong>Resend</strong>: envio do e-mail de redefinição de senha (recebe apenas o seu e-mail e o link, quando você pede a redefinição).</li>
</ul>
<p>Não compartilhamos seus dados com mais ninguém, exceto se a lei ou uma ordem judicial exigir.</p>

<h2>5. Transferência internacional</h2>
<p>Os servidores ficam nos <strong>Estados Unidos</strong>. Seus dados, portanto, são transferidos e armazenados fora do Brasil, em prestadores que adotam medidas de segurança e proteção de dados. A transferência é necessária para a execução do serviço (LGPD, art. 33).</p>

<h2>6. Segurança</h2>
<ul>
<li>Toda comunicação usa HTTPS.</li>
<li>A senha é guardada com o algoritmo argon2id, e as sessões usam chaves de curta duração.</li>
<li>Cada pessoa só acessa os próprios dados: o servidor confere o dono de cada registro em toda consulta.</li>
<li>Os registros técnicos do servidor <strong>não</strong> contêm valores nem descrições das suas transações, e tokens e termos de busca são ocultados.</li>
</ul>
<p>Nenhum sistema é totalmente imune a falhas. Em caso de incidente que possa causar dano relevante, avisaremos você e a autoridade competente, como a lei determina.</p>

<h2>7. Por quanto tempo guardamos</h2>
<p>Guardamos seus dados enquanto sua conta existir. Quando você exclui a conta, <strong>todos os seus dados são apagados do banco de dados de forma definitiva e imediata</strong>. Cópias de segurança do banco mantidas pelo provedor podem reter os dados por até 7 dias antes de serem descartadas. Os registros técnicos de acesso ficam por um período curto, apenas o necessário para segurança.</p>

<h2>8. Seus direitos</h2>
<p>Você pode, a qualquer momento (LGPD, art. 18): confirmar que tratamos seus dados e acessá-los, corrigi-los, obter uma cópia, pedir a exclusão e revogar o consentimento.</p>
<ul>
<li><strong>No aplicativo:</strong> em Perfil você edita seus dados, exporta uma cópia completa (arquivo de backup) e exclui a conta.</li>
<li><strong>Pela web:</strong> em <a href="/excluir-conta">${'/excluir-conta'}</a> você exclui a conta e todos os dados, sem precisar do aplicativo.</li>
<li><strong>Por e-mail:</strong> escreva para <a href="mailto:${SITE.contactEmail}">${SITE.contactEmail}</a>. Respondemos em até ${SITE.emailDeadlineDays} dias.</li>
</ul>
<p>Você também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).</p>

<h2>9. Crianças e adolescentes</h2>
<p>O aplicativo não é direcionado a crianças, e não coletamos dados de menores de forma intencional.</p>

<h2>10. Mudanças nesta política</h2>
<p>Se esta política mudar, atualizaremos a data no topo desta página. Mudanças relevantes serão avisadas no aplicativo.</p>`
  );
}

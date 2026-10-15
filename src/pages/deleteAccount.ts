import { SITE, layout } from './layout.js';

// Página para excluir a conta e os dados sem precisar do aplicativo (exigência da loja, além da exclusão
// dentro do app). Quem confirma e-mail e senha apaga tudo na hora, pela própria API.
export function deleteAccountPage(): string {
  return layout(
    'Excluir minha conta',
    `<h1>Excluir minha conta e meus dados</h1>
<p class="suave">Aplicativo ${SITE.appName} · responsável: ${SITE.controller}</p>

<p>Use esta página para excluir a sua conta do ${SITE.appName} e todos os dados dela, sem precisar abrir o aplicativo.</p>

<h2>O que será apagado</h2>
<ul>
<li>Sua conta (e-mail e senha) e o seu perfil.</li>
<li>Todos os registros: contas, transações, transferências, categorias, despesas recorrentes, orçamentos e caixinhas.</li>
<li>Todas as sessões abertas em qualquer aparelho.</li>
</ul>
<p><strong>A exclusão é imediata e não pode ser desfeita.</strong> Se quiser guardar uma cópia, exporte um backup em Perfil, no aplicativo, antes de continuar. Cópias de segurança do banco mantidas pelo provedor podem reter os dados por até 7 dias antes de serem descartadas.</p>

<h2>Como excluir</h2>
<form id="form" novalidate>
<label for="email">E-mail da conta</label>
<input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Senha</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<label class="confirma"><input id="confirmar" name="confirmar" type="checkbox"> <span>Entendo que minha conta e todos os meus dados serão apagados de forma definitiva.</span></label>
<button id="apagar" type="submit">Excluir minha conta</button>
<p id="status" role="status" aria-live="polite"></p>
</form>

<h2>Não consigo entrar</h2>
<p>Se você esqueceu a senha ou perdeu o acesso, escreva para <a href="mailto:${SITE.contactEmail}">${SITE.contactEmail}</a> <strong>a partir do e-mail cadastrado na conta</strong>, com o assunto "Excluir conta". Confirmamos que o pedido veio do dono do e-mail e excluímos a conta e os dados em até ${SITE.emailDeadlineDays} dias.</p>

<p class="suave">Veja também a <a href="/privacidade">política de privacidade</a>.</p>`,
    '/assets/excluir-conta.js'
  );
}

// O script da página: entra com e-mail e senha (para provar que a conta é da pessoa) e chama DELETE /v1/me.
// Nada fica guardado no navegador: o token vive só na memória, e a senha é apagada do campo ao terminar.
export const DELETE_ACCOUNT_JS = `(() => {
  const form = document.getElementById('form');
  const button = document.getElementById('apagar');
  const status = document.getElementById('status');
  const show = (text, kind) => { status.textContent = text; status.className = kind; };
  const json = (headers) => ({ 'Content-Type': 'application/json', ...headers });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) return show('Informe o e-mail e a senha da conta.', 'erro');
    if (!form.confirmar.checked) return show('Marque a confirmação para continuar.', 'erro');

    button.disabled = true;
    show('Verificando...', 'info');
    try {
      const login = await fetch('/v1/auth/login', { method: 'POST', headers: json(), body: JSON.stringify({ email, password }) });
      const session = await login.json().catch(() => null);
      if (!login.ok) return show((session && session.error && session.error.message) || 'Não foi possível entrar.', 'erro');

      const removal = await fetch('/v1/me', {
        method: 'DELETE',
        headers: json({ Authorization: 'Bearer ' + session.accessToken }),
        body: JSON.stringify({ password }),
      });
      if (removal.status === 204) {
        form.hidden = true;
        return show('Pronto: sua conta e todos os seus dados foram excluídos.', 'ok');
      }
      const failure = await removal.json().catch(() => null);
      show((failure && failure.error && failure.error.message) || 'Não foi possível excluir. Tente de novo.', 'erro');
    } catch (error) {
      show('Sem conexão. Tente de novo.', 'erro');
    } finally {
      form.password.value = '';
      button.disabled = false;
    }
  });
})();
`;

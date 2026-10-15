import type { FastifyInstance } from 'fastify';

import { deleteAccountPage, DELETE_ACCOUNT_JS } from '../pages/deleteAccount.js';
import { PAGE_CSS } from '../pages/layout.js';
import { privacyPage } from '../pages/privacy.js';

// Páginas públicas, fora de /v1 e sem autenticação: a política de privacidade e a exclusão de conta que a
// loja pede. O HTML é fixo (não tem dado de usuário), então é montado uma vez.
const HTML = { privacidade: privacyPage(), excluirConta: deleteAccountPage() };

// Só carrega estilo e script do próprio endereço, só chama a própria API, e ninguém pode embutir a página.
const CSP = "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export async function pageRoutes(app: FastifyInstance) {
  app.addHook('onSend', async (_req, reply) => {
    reply
      .header('Content-Security-Policy', CSP)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', 'public, max-age=300');
  });

  app.get('/privacidade', async (_req, reply) => reply.type('text/html; charset=utf-8').send(HTML.privacidade));
  app.get('/excluir-conta', async (_req, reply) => reply.type('text/html; charset=utf-8').send(HTML.excluirConta));
  app.get('/assets/pagina.css', async (_req, reply) => reply.type('text/css; charset=utf-8').send(PAGE_CSS));
  app.get('/assets/excluir-conta.js', async (_req, reply) =>
    reply.type('application/javascript; charset=utf-8').send(DELETE_ACCOUNT_JS)
  );
}

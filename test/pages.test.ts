import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DELETE_ACCOUNT_JS } from '../src/pages/deleteAccount.js';
import { SITE } from '../src/pages/layout.js';
import { PASSWORD, makeApp, rawRequest, signup, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(() => t.close());

const get = (url: string) => t.app.inject({ method: 'GET', url });

describe('política de privacidade', () => {
  it('é pública, em HTML, e diz quem responde pelos dados e onde eles ficam', async () => {
    const res = await get('/privacidade');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('<html lang="pt-BR">');
    expect(res.body).toContain(SITE.controller);
    expect(res.body).toContain(SITE.contactEmail);
    expect(res.body).toContain('Estados Unidos');
    expect(res.body).toContain('Heroku');
    expect(res.body).toContain('/excluir-conta');
  });

  it('não promete o que a API não faz: sem anúncios, sem rastreadores, sem acesso a bancos', async () => {
    const { body } = await get('/privacidade');
    expect(body).toContain('não exibimos anúncios');
    expect(body).toContain('Não pedimos acesso a contas bancárias');
  });
});

describe('página de exclusão de conta', () => {
  it('é pública e explica o que será apagado, com o contato para quem não consegue entrar', async () => {
    const res = await get('/excluir-conta');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('Excluir minha conta e meus dados');
    expect(res.body).toContain('id="form"');
    expect(res.body).toContain(`mailto:${SITE.contactEmail}`);
    expect(res.body).toContain(`${SITE.emailDeadlineDays} dias`);
    expect(res.body).toContain('/assets/excluir-conta.js');
  });
});

describe('segurança das páginas', () => {
  it('carrega só do próprio endereço, sem script nem estilo inline', async () => {
    for (const url of ['/privacidade', '/excluir-conta']) {
      const res = await get(url);
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.headers['content-security-policy']).toContain("style-src 'self'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body).not.toMatch(/<script(?![^>]*\ssrc=)/);
      expect(res.body).not.toMatch(/<style|\sstyle=|\sonclick=/);
    }
  });

  it('serve o CSS e o JavaScript com o tipo certo', async () => {
    const css = await get('/assets/pagina.css');
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    const js = await get('/assets/excluir-conta.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(js.body).toContain("'/v1/me'");
    expect((await get('/assets/outro.js')).statusCode).toBe(404);
  });

  it('não interfere na API: /v1 continua exigindo login e /health segue respondendo', async () => {
    expect((await rawRequest(t.app, 'GET', '/cards')).status).toBe(401);
    expect((await get('/health')).statusCode).toBe(200);
  });
});

// Roda o script real da página contra a API de verdade, com um DOM e um fetch mínimos.
describe('o script de exclusão (o que o botão faz)', () => {
  interface Field { value: string; checked?: boolean }
  function mount(app: FastifyInstance, fields: { email: string; password: string; confirmar: boolean }, options: { offline?: boolean } = {}) {
    const calls: string[] = [];
    const status = { textContent: '', className: '' };
    const button = { disabled: false };
    let submit: (event: { preventDefault: () => void }) => Promise<void> = async () => {};
    const form: Record<string, unknown> = {
      email: { value: fields.email } as Field,
      password: { value: fields.password } as Field,
      confirmar: { checked: fields.confirmar } as Field,
      hidden: false,
      addEventListener: (_type: string, fn: typeof submit) => (submit = fn),
    };
    const elements: Record<string, unknown> = { form, apagar: button, status };
    const document = { getElementById: (id: string) => elements[id] };

    const fakeFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      calls.push(`${init.method} ${url}`);
      if (options.offline) throw new TypeError('Failed to fetch');
      const res = await app.inject({ method: init.method as 'POST', url, headers: init.headers, payload: init.body });
      return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.body) };
    };

    new Function('document', 'fetch', DELETE_ACCOUNT_JS)(document, fakeFetch);
    return { calls, status, button, form, submit: () => submit({ preventDefault: () => {} }) };
  }

  it('exclui a conta e tudo dela com e-mail e senha corretos', async () => {
    const me = await signup(t.app);
    await me.post('/transactions', {
      cardId: (await me.get('/cards')).body[0].id,
      categoryId: 'food',
      name: 'Pão',
      amount: 5,
      type: 'expense',
      occurredAt: '2026-10-05T12:00:00.000Z',
    });

    const page = mount(t.app, { email: me.email, password: PASSWORD, confirmar: true });
    await page.submit();

    expect(page.calls).toEqual(['POST /v1/auth/login', 'DELETE /v1/me']);
    expect(page.status.className).toBe('ok');
    expect(page.status.textContent).toContain('excluídos');
    expect(page.form.hidden).toBe(true);
    expect(page.button.disabled).toBe(false);
    expect((await rawRequest(t.app, 'POST', '/auth/login', { body: { email: me.email, password: PASSWORD } })).status).toBe(401);
  });

  it('com senha errada mostra a mensagem do servidor e não apaga nada', async () => {
    const me = await signup(t.app);
    const page = mount(t.app, { email: me.email, password: 'senha-errada-123', confirmar: true });
    await page.submit();

    expect(page.calls).toEqual(['POST /v1/auth/login']);
    expect(page.status.className).toBe('erro');
    expect(page.status.textContent).toBe('E-mail ou senha incorretos.');
    expect((await rawRequest(t.app, 'POST', '/auth/login', { body: { email: me.email, password: PASSWORD } })).status).toBe(200);
  });

  it('sem marcar a confirmação não chama a API', async () => {
    const me = await signup(t.app);
    const page = mount(t.app, { email: me.email, password: PASSWORD, confirmar: false });
    await page.submit();

    expect(page.calls).toEqual([]);
    expect(page.status.className).toBe('erro');
    expect(page.status.textContent).toContain('confirmação');
  });

  it('sem rede avisa e libera o botão; a senha é apagada do campo', async () => {
    const me = await signup(t.app);
    const page = mount(t.app, { email: me.email, password: PASSWORD, confirmar: true }, { offline: true });
    await page.submit();

    expect(page.status.textContent).toBe('Sem conexão. Tente de novo.');
    expect(page.button.disabled).toBe(false);
    expect((page.form.password as Field).value).toBe('');
  });
});

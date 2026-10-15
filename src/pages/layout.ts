// Páginas públicas da API (política de privacidade e exclusão de conta). São HTML estático, sem banco e sem
// login. O CSS e o JavaScript são arquivos próprios (/assets/...) para a política de segurança do navegador
// não precisar permitir estilo nem script inline.

// Quem responde pelos dados. Aparece na política e na página de exclusão.
export const SITE = {
  appName: 'Sobrô?',
  controller: 'José Matheus de Lima',
  contactEmail: 'josematheusdev@gmail.com',
  updatedAt: '15 de outubro de 2026',
  // Prazo para atender um pedido feito por e-mail (a LGPD fixa até 15 dias para a resposta completa).
  emailDeadlineDays: 15,
} as const;

export function layout(title: string, body: string, script?: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index, follow">
<title>${title} · ${SITE.appName}</title>
<link rel="stylesheet" href="/assets/pagina.css">
</head>
<body>
<main>
<header><p class="marca">${SITE.appName}</p></header>
${body}
<footer>
<p>${SITE.appName} · responsável pelos dados: ${SITE.controller} · <a href="mailto:${SITE.contactEmail}">${SITE.contactEmail}</a></p>
<p><a href="/privacidade">Política de privacidade</a> · <a href="/excluir-conta">Excluir minha conta</a></p>
</footer>
</main>
${script ? `<script src="${script}" defer></script>` : ''}
</body>
</html>
`;
}

export const PAGE_CSS = `:root{--fundo:#f6f8fc;--texto:#1a202c;--suave:#4a5568;--linha:#d9e0ec;--cartao:#fff;--primaria:#3161b2;--erro:#a83636;--ok:#277f2b}
@media (prefers-color-scheme:dark){:root{--fundo:#10151d;--texto:#e8edf5;--suave:#a9b4c6;--linha:#2a3445;--cartao:#171e29;--primaria:#7998cd;--erro:#f08a8a;--ok:#7bd480}}
*{box-sizing:border-box}
body{margin:0;background:var(--fundo);color:var(--texto);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 3rem}
.marca{font-weight:700;font-size:1.25rem;color:var(--primaria);margin:0 0 1rem}
h1{font-size:1.75rem;line-height:1.25;margin:.25rem 0 .5rem}
h2{font-size:1.2rem;margin:2rem 0 .5rem}
p,li{margin:.5rem 0}
ul{padding-left:1.25rem}
a{color:var(--primaria)}
.suave{color:var(--suave);font-size:.9rem}
table{width:100%;border-collapse:collapse;margin:.75rem 0;background:var(--cartao)}
th,td{border:1px solid var(--linha);padding:.5rem .6rem;text-align:left;vertical-align:top;font-size:.95rem}
th{background:var(--fundo)}
form{background:var(--cartao);border:1px solid var(--linha);border-radius:.75rem;padding:1rem;margin:1rem 0}
label{display:block;font-weight:600;margin:.75rem 0 .25rem}
input[type=email],input[type=password]{width:100%;padding:.65rem .75rem;border:1px solid var(--linha);border-radius:.5rem;font:inherit;background:var(--fundo);color:var(--texto)}
.confirma{display:flex;gap:.5rem;align-items:flex-start;font-weight:400;margin:1rem 0}
.confirma input{margin-top:.35rem}
button{width:100%;padding:.8rem 1rem;border:0;border-radius:.5rem;background:var(--erro);color:#fff;font:inherit;font-weight:700;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
#status{min-height:1.5rem;margin:.75rem 0 0;font-weight:600}
#status.erro{color:var(--erro)}#status.ok{color:var(--ok)}#status.info{color:var(--suave)}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--linha);color:var(--suave);font-size:.9rem}
`;

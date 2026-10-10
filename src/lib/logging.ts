// Os logs não podem carregar o termo buscado (`q`) nem tokens que viajem na URL.
const SENSITIVE_PARAMS = ['q', 'token', 'password', 'refreshToken'];

export function maskUrl(url: string): string {
  const index = url.indexOf('?');
  if (index === -1) return url;
  const params = new URLSearchParams(url.slice(index + 1));
  for (const name of SENSITIVE_PARAMS) {
    if (params.has(name)) params.set(name, '[redacted]');
  }
  return `${url.slice(0, index)}?${params.toString()}`;
}

export function loggerOptions(level: string) {
  return {
    level,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    serializers: {
      req(req: { method: string; url: string; id: string }) {
        return { method: req.method, url: maskUrl(req.url), id: req.id };
      },
    },
  };
}

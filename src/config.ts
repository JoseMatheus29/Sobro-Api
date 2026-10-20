import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

// Lista de origens separadas por vírgula. Cada uma é só esquema + host (+ porta), sem caminho: "*" não vale.
const origins = z
  .string()
  .default('')
  .transform((value, ctx) => {
    const list: string[] = [];
    for (const item of value.split(',')) {
      const raw = item.trim().replace(/\/+$/, '');
      if (!raw) continue;
      let origin: string | null = null;
      try {
        const url = new URL(raw);
        if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === raw) origin = raw;
      } catch {
        // cai no erro abaixo
      }
      if (!origin) {
        ctx.addIssue({ code: 'custom', message: `origem inválida: "${raw}" (use http://host:porta ou https://host)` });
        return z.NEVER;
      }
      if (!list.includes(origin)) list.push(origin);
    }
    return list;
  });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa ter pelo menos 32 caracteres'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  // Heroku Postgres exige TLS com certificado autoassinado: DB_SSL=true liga o TLS sem validar a cadeia.
  DB_SSL: bool,
  TRUST_PROXY: bool,
  // Origens web autorizadas a chamar a API pelo navegador (CORS). Vazio = nenhuma. O app nativo não passa por CORS.
  CORS_ORIGINS: origins,
  MIN_APP_VERSION: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  MAIL_FROM: z.string().default('Sobrô? <nao-responda@exemplo.com>'),
  RESET_PASSWORD_URL: z.string().default('http://localhost:3000/redefinir-senha'),
  APP_TIMEZONE: z.string().default('America/Sao_Paulo'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(60),
  // Janela em que um token de renovação já trocado ainda é aceito (resposta perdida).
  REFRESH_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(30),
  RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_ENABLED: bool.default('true'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${problems}`);
  }
  return parsed.data;
}

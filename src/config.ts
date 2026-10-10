import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa ter pelo menos 32 caracteres'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  // Heroku Postgres exige TLS com certificado autoassinado: DB_SSL=true liga o TLS sem validar a cadeia.
  DB_SSL: bool,
  TRUST_PROXY: bool,
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

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { purgeIdempotencyKeys } from './lib/idempotency.js';
import { loggerOptions } from './lib/logging.js';
import { createConsoleMailer, createDisabledMailer, createResendMailer } from './lib/mailer.js';

const config = loadConfig();
const handle = createDb(config.DATABASE_URL, config.DB_POOL_MAX, config.DB_SSL);

// As migrações rodam antes de aceitar tráfego. Com mais de uma instância, rode `npm run db:migrate`
// como passo de release (no Heroku, a release phase) e tire isto daqui.
await runMigrations(handle.db);

const app = await buildApp({
  db: handle.db,
  config,
  logger: loggerOptions(config.NODE_ENV === 'production' ? 'info' : 'debug'),
  mailer: config.RESEND_API_KEY
    ? createResendMailer(config.RESEND_API_KEY, config.MAIL_FROM)
    : config.NODE_ENV === 'production'
      ? createDisabledMailer((message) => app.log.warn(message))
      : createConsoleMailer((message) => app.log.info(message)),
});

// Chaves de idempotência com mais de 24 horas não servem mais.
const purge = setInterval(() => {
  purgeIdempotencyKeys(handle.db).catch((err) => app.log.error({ err }, 'falha ao limpar chaves de idempotência'));
}, 60 * 60 * 1000);
purge.unref();

const shutdown = async () => {
  clearInterval(purge);
  await app.close();
  await handle.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.PORT, host: '0.0.0.0' });

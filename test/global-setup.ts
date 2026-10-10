import { TEST_DATABASE_URL } from './db-url.js';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

// Aplica as migrações uma vez no banco de teste antes de qualquer arquivo de teste.
export default async function setup() {
  const url = TEST_DATABASE_URL;
  const handle = createDb(url, 2);
  try {
    await runMigrations(handle.db);
  } catch (error) {
    throw new Error(
      `Não foi possível preparar o banco de teste em ${url.replace(/:[^:@/]*@/, ':***@')}. ` +
        `Suba o Postgres com "npm run test:db" (Docker) ou defina TEST_DATABASE_URL. Causa: ${(error as Error).message}`
    );
  } finally {
    await handle.close();
  }
}

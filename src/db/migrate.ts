import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createDb, type Db } from './client.js';

// Roda as migrações versionadas em ./drizzle. Os arquivos ficam fora de src/ e dist/.
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}

// `npm run db:migrate`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definida');
  const handle = createDb(url, 2, process.env.DB_SSL === 'true');
  await runMigrations(handle.db);
  await handle.close();
  console.log('Migrações aplicadas.');
}

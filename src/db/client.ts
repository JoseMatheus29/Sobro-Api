import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
// A transação tem a mesma interface de consulta do banco.
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export function createDb(url: string, poolMax: number, ssl = false): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: poolMax, ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}) });
  // Um erro em conexão ociosa não pode derrubar o processo.
  pool.on('error', () => {});
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}

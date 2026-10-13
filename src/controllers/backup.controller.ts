import type { Ctx } from '../context.js';
import { exportBackup, importBackup } from '../services/backup.js';
import type { Handler } from './support.js';

export function createBackupController(ctx: Ctx) {
  // Tudo da pessoa no formato de backup do app (serve também para a LGPD).
  const download: Handler = async (req) => exportBackup(ctx.db, req.userId, ctx.now());

  // Destrutivo: substitui tudo numa única transação. A rota aumenta o limite do corpo.
  const restore: Handler = async (req, reply) => {
    await importBackup(ctx.db, req.userId, req.body, ctx.config.APP_TIMEZONE);
    return reply.code(204).send();
  };

  return { download, restore };
}

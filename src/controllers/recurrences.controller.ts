import type { Ctx } from '../context.js';
import { idParam } from '../lib/schemas.js';
import { endRecurrence, getRecurrence, listRecurrences } from '../services/recurrences.js';
import { materialize, type Handler } from './support.js';

export function createRecurrencesController(ctx: Ctx) {
  const list: Handler = async (req) => {
    await materialize(ctx, req.userId);
    return listRecurrences(ctx.db, req.userId);
  };

  const get: Handler = async (req) => getRecurrence(ctx.db, req.userId, idParam.parse(req.params).id);

  // Encerra: o que já foi gerado fica.
  const end: Handler = async (req) => {
    const { id } = idParam.parse(req.params);
    await endRecurrence(ctx.db, req.userId, id);
    return getRecurrence(ctx.db, req.userId, id);
  };

  // Alternativa explícita à geração dentro dos GET: o app pode chamar ao abrir.
  const generateDue: Handler = async (req) => ({ created: await materialize(ctx, req.userId) });

  return { list, get, end, generateDue };
}

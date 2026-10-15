import { z } from 'zod';

import type { Ctx } from '../context.js';
import { hexColor, requiredText } from '../lib/schemas.js';
import { createCategory, deleteCategory, listCategories, updateCategory } from '../services/categories.js';
import { sendCreated, type Handler } from './support.js';

const categoryBody = z.object({
  name: requiredText(30),
  icon: requiredText(40),
  color: hexColor,
  // O fundo suave da categoria, como o app o monta (`rgba(r,g,b,0.12)`).
  bg: requiredText(40),
});
const categoryPatch = categoryBody.partial();

// Os ids são texto (`food`, `custom-...`), ao contrário dos outros recursos.
const categoryParam = z.object({ id: z.string().trim().min(1).max(40) });

export function createCategoriesController(ctx: Ctx) {
  // O catálogo global e as categorias do usuário.
  const list: Handler = async (req) => listCategories(ctx.db, req.userId);

  const create: Handler = async (req, reply) => {
    const body = categoryBody.parse(req.body);
    return sendCreated(reply, await createCategory(ctx.db, req.userId, body, req.headers['idempotency-key']));
  };

  const update: Handler = async (req) => {
    const { id } = categoryParam.parse(req.params);
    return updateCategory(ctx.db, req.userId, id, categoryPatch.parse(req.body));
  };

  const remove: Handler = async (req, reply) => {
    await deleteCategory(ctx.db, req.userId, categoryParam.parse(req.params).id);
    return reply.code(204).send();
  };

  return { list, create, update, remove };
}

import type { Ctx } from '../context.js';
import { listCategories } from '../services/categories.js';
import type { Handler } from './support.js';

export function createCategoriesController(ctx: Ctx) {
  const list: Handler = async () => listCategories(ctx.db);
  return { list };
}

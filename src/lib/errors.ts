import { ZodError } from 'zod';

export interface FieldIssue {
  path: string;
  message: string;
}

// Formato único de erro: { error: { code, message, fields? } }
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fields?: FieldIssue[]
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'validation_failed', fields?: FieldIssue[]) =>
  new AppError(400, code, message, fields);
export const unauthorized = (message = 'Sessão inválida ou expirada.', code = 'unauthorized') =>
  new AppError(401, code, message);
export const notFound = (message = 'Não encontrado.') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

export function zodFields(error: ZodError): FieldIssue[] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

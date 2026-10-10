import { z } from 'zod';

import { MONTH_RE } from '../shared/month.js';

export const idParam = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });

export const month = z.string().regex(MONTH_RE, 'Use o formato AAAA-MM.');

// Magnitude de um valor em dinheiro (numeric(14,2) guarda até 999.999.999.999,99).
export const positiveMoney = z.number().finite().min(0.01, 'O valor precisa ser maior que zero.').max(99_999_999_999.99);
export const signedMoney = z.number().finite().min(-99_999_999_999.99).max(99_999_999_999.99);

export const requiredText = (max: number) => z.string().trim().min(1, 'Obrigatório.').max(max);

// Texto opcional: vazio vira null, como o app faz com a descrição.
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const isoDate = z
  .string()
  .datetime({ offset: true, message: 'Use uma data ISO 8601.' })
  .transform((s) => new Date(s));

export const hexColor = z.string().regex(/^#[0-9A-Fa-f]{3,8}$/, 'Use uma cor hexadecimal.');

export const email = z.string().trim().toLowerCase().email('E-mail inválido.').max(254);
export const newPassword = z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.').max(128);

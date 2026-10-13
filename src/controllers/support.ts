import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Ctx } from '../context.js';
import type { Idempotent } from '../lib/idempotency.js';
import { materializeDue } from '../services/recurrences.js';

// Um controller é uma fábrica que recebe o contexto (banco, config, relógio) e devolve os handlers
// de um recurso. O handler lê e valida a requisição, chama o serviço e escolhe a resposta HTTP;
// as regras e as consultas ficam nos serviços.
export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

// Gera as recorrências que venceram antes de ler (docs, seção 5): as listas e os saldos já saem certos.
export function materialize(ctx: Ctx, userId: string): Promise<number> {
  return materializeDue(ctx.db, userId, ctx.config.APP_TIMEZONE, ctx.now());
}

// Resposta de um POST que cria algo. Se a chave de idempotência já tinha sido usada, o serviço devolve o
// resultado guardado e o cabeçalho avisa que nada foi gravado de novo.
export function sendCreated(reply: FastifyReply, result: Idempotent<unknown>) {
  if (result.replayed) reply.header('Idempotent-Replayed', 'true');
  return reply.code(201).send(result.value);
}

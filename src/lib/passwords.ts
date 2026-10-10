import { hash, verify } from '@node-rs/argon2';

// argon2id é o padrão do @node-rs/argon2 (algorithm 2).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Hash descartável para gastar o mesmo tempo quando o e-mail não existe (evita revelar contas pelo tempo).
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('senha-que-nao-existe');
  return dummy;
}

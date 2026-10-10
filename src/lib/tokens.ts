import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

// Tokens opacos (renovação, redefinição): 32 bytes aleatórios; só o hash SHA-256 vai para o banco.
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const ISSUER = 'sobro-api';

export interface AccessTokenSigner {
  sign(userId: string): Promise<string>;
  verify(token: string): Promise<string>; // devolve o id do usuário
}

export function createAccessTokenSigner(secret: string, ttlSeconds: number): AccessTokenSigner {
  const key = new TextEncoder().encode(secret);
  return {
    sign: (userId) =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .sign(key),
    verify: async (token) => {
      const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string') throw new Error('token sem sub');
      return payload.sub;
    },
  };
}

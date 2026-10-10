import { AppError } from './errors.js';

// Contador de falhas em memória (uma instância só): trava um e-mail depois de muitas tentativas erradas,
// além do limite por IP, contra força bruta vinda de vários endereços.
export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly enabled = true
  ) {}

  assertAllowed(key: string): void {
    if (!this.enabled) return;
    const entry = this.hits.get(key);
    if (entry && entry.resetAt > Date.now() && entry.count >= this.max) {
      throw new AppError(429, 'rate_limited', 'Muitas tentativas. Tente de novo em alguns minutos.');
    }
  }

  fail(key: string): void {
    if (!this.enabled) return;
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count += 1;
    if (this.hits.size > 10_000) this.sweep(now);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}

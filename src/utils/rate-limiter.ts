/**
 * Token-bucket rate limiter with a FIFO queue.
 *
 * Multiple concurrent callers wait in order; only one drain() loop runs
 * at a time, dispatching callers as tokens refill.
 */
export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly msPerToken: number;
  private lastRefill: number = Date.now();
  private readonly queue: Array<() => void> = [];
  private draining = false;

  constructor(requestsPerMinute: number) {
    this.maxTokens = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.msPerToken = (60 * 1000) / requestsPerMinute;
  }

  private refill(): void {
    const now = Date.now();
    const newTokens = Math.floor((now - this.lastRefill) / this.msPerToken);
    if (newTokens > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
      this.lastRefill += newTokens * this.msPerToken;
    }
  }

  /** Resolves when a token is available. Callers are served FIFO. */
  throttle(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length > 0) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens--;
        this.queue.shift()!();
      } else {
        const msUntilToken = this.msPerToken - ((Date.now() - this.lastRefill) % this.msPerToken);
        await new Promise<void>((r) => setTimeout(r, Math.max(1, msUntilToken)));
      }
    }
    this.draining = false;
  }
}

export const austliiRateLimiter = new RateLimiter(10); // 10 req/min
export const lawciteRateLimiter = new RateLimiter(5);  // 5 req/min

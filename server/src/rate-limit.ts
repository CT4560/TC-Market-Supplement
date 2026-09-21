export interface TakeResult {
  allowed: boolean;
  /** 被拒絕時，最快多久後有名額（毫秒）。 */
  retryAfterMs: number;
}

/** 每個 IP 一個 token bucket：每秒補 ratePerSecond 個、最多存 burst 個，一次請求用 cost 個。 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string, cost = 1): TakeResult {
    const current = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: current };

    const refilled = Math.min(this.burst, bucket.tokens + ((current - bucket.at) / 1000) * this.ratePerSecond);
    if (refilled >= cost) {
      this.buckets.set(key, { tokens: refilled - cost, at: current });
      this.prune(current);
      return { allowed: true, retryAfterMs: 0 };
    }

    this.buckets.set(key, { tokens: refilled, at: current });
    return { allowed: false, retryAfterMs: Math.ceil(((cost - refilled) / this.ratePerSecond) * 1000) };
  }

  private prune(current: number): void {
    if (this.buckets.size < 1000) return;
    for (const [key, bucket] of this.buckets) {
      if (current - bucket.at > 60_000) this.buckets.delete(key);
    }
  }
}

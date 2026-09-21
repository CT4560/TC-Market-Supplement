export interface TakeResult {
  allowed: boolean;
  /** 不允許時，最快多久之後才有名額，毫秒（給 Retry-After 用）。 */
  retryAfterMs: number;
}

/**
 * 每個來源 IP 一個 token bucket：每秒補 ratePerSecond 個名額、最多存 burst 個。
 * 一個請求用掉一個；名額用完就拒絕，等補回來再放行。只記每個 IP 的「剩幾個、上次何時」，記憶體很小。
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): TakeResult {
    const current = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: current };

    // 依經過時間補名額（不超過上限）
    const refilled = Math.min(this.burst, bucket.tokens + ((current - bucket.at) / 1000) * this.ratePerSecond);
    if (refilled >= 1) {
      this.buckets.set(key, { tokens: refilled - 1, at: current });
      this.prune(current);
      return { allowed: true, retryAfterMs: 0 };
    }

    this.buckets.set(key, { tokens: refilled, at: current });
    return { allowed: false, retryAfterMs: Math.ceil(((1 - refilled) / this.ratePerSecond) * 1000) };
  }

  /** 名額已經補滿、超過一分鐘沒動靜的 IP 不需要再記，避免 Map 無限成長。 */
  private prune(current: number): void {
    if (this.buckets.size < 1000) return;
    for (const [key, bucket] of this.buckets) {
      if (current - bucket.at > 60_000) this.buckets.delete(key);
    }
  }
}

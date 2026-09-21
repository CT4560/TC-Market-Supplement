import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TokenBucketLimiter } from "../src/rate-limit.js";

describe("TokenBucketLimiter", () => {
  test("突發用光後被擋，Retry-After 是補回一個名額要等的時間；過了時間恢復", () => {
    let t = 1_000_000;
    const limiter = new TokenBucketLimiter(20, 40, () => t);
    for (let i = 0; i < 40; i++) assert.equal(limiter.take("a").allowed, true, `第 ${i + 1} 次`);

    const blocked = limiter.take("a");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterMs, 50, "每秒 20 個名額，補一個要 50ms");

    t += 50;
    assert.equal(limiter.take("a").allowed, true);
    assert.equal(limiter.take("a").allowed, false);
  });

  test("一次可以扣多個名額；不夠就拒絕，Retry-After 依缺的量算", () => {
    let t = 0;
    const limiter = new TokenBucketLimiter(20, 40, () => t);
    assert.equal(limiter.take("a", 12).allowed, true);
    assert.equal(limiter.take("a", 12).allowed, true);
    assert.equal(limiter.take("a", 12).allowed, true); // 用掉 36，剩 4
    const blocked = limiter.take("a", 12);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterMs, 400, "缺 8 個、每秒補 20 個 → 400ms");
    t += 400;
    assert.equal(limiter.take("a", 12).allowed, true);
  });

  test("補名額不超過上限；不同 key 互不影響", () => {
    let t = 0;
    const limiter = new TokenBucketLimiter(20, 40, () => t);
    for (let i = 0; i < 40; i++) limiter.take("a");
    t += 60_000; // 很久之後也只補到 40
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (limiter.take("a").allowed) allowed++;
    assert.equal(allowed, 40);
    assert.equal(limiter.take("b").allowed, true);
  });

  test("很多不同 IP 之後，久沒動靜的會被清掉", () => {
    let t = 0;
    const limiter = new TokenBucketLimiter(20, 40, () => t);
    for (let i = 0; i < 1000; i++) limiter.take(`ip-${i}`);
    t += 61_000;
    limiter.take("fresh");
    assert.equal((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size, 1);
  });
});

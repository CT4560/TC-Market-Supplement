import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import http from "node:http";
import Database from "better-sqlite3";
import { TW_WORLDS } from "../src/worlds.js";
import { CollectorStore } from "../src/store.js";
import { createApp } from "../src/server.js";
import { UploadRateLimiter } from "../src/community.js";

const ITEM = 920001;
const W = TW_WORLDS[6].id;

describe("HTTP 端點", () => {
  const store = new CollectorStore(new Database(":memory:"));
  store.replaceItems([{ id: ITEM, name: "端對端測試舊染劑" }]);
  let server: http.Server;
  let base = "";
  let enabled = true;
  let ipCounter = 0;

  before(async () => {
    const env = new Proxy({}, { get: (_target, key) => (key === "COMMUNITY_UPLOAD_ENABLED" && enabled ? "on" : undefined) }) as NodeJS.ProcessEnv;
    server = createApp({ store, env, rateLimiter: new UploadRateLimiter(250), log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });

  // 每個請求帶不同的假來源 IP（CF-Connecting-IP），避免連續請求互相被限流；限流本身另外驗證。
  const fromNewIp = () => ({ "content-type": "application/json", "cf-connecting-ip": `203.0.113.${++ipCounter}` });
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      worldId: W,
      itemId: ITEM,
      capturedAt: Date.now() - 2000,
      listings: [
        { pricePerUnit: 480, quantity: 2, retainerName: "雇員" },
        { pricePerUnit: 450, quantity: 1, retainerName: "雇員" },
      ],
      sales: [{ pricePerUnit: 470, quantity: 3, timestamp: Date.now() - 86_400_000 }],
      ...over,
    });
  const post = (headers: Record<string, string>, payload: string) => fetch(`${base}/community/upload`, { method: "POST", headers, body: payload });

  test("/health 回 200；不存在的路徑回 404", async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  test("不需要任何金鑰標頭就能取得物品清單與上傳", async () => {
    const items: any = await (await fetch(`${base}/community/items`)).json();
    assert.deepEqual(items.itemIds, [ITEM]);
    assert.equal(items.worldIds.length, 7);

    const ok = await post(fromNewIp(), body());
    assert.equal(ok.status, 200);
    const result: any = await ok.json();
    assert.equal(result.listingsStored, 2);
    assert.equal(result.salesInserted, 1);

    const entry = store.getEntry(W, ITEM)!;
    assert.deepEqual(entry.listings.map((l) => l.pricePerUnit), [450, 480]);
  });

  test("資料檢查：壞 JSON 400、不在白名單 422、掃描時間太舊 400、內容過大 413", async () => {
    assert.equal((await post(fromNewIp(), "{not json")).status, 400);
    assert.equal((await post(fromNewIp(), body({ itemId: 1001 }))).status, 422);
    assert.equal((await post(fromNewIp(), body({ capturedAt: Date.now() - 3_600_000 }))).status, 400);
    assert.equal((await post(fromNewIp(), JSON.stringify({ pad: "x".repeat(70_000) }))).status, 413);
  });

  test("標頭宣告的內容大小超過上限：不等內容送完就直接回 413", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${base}/community/upload`);
      const request = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { ...fromNewIp(), "content-length": "10000000" } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
          request.destroy();
        },
      );
      request.on("error", (error) => {
        // 回應已經拿到之後我們自己 destroy 造成的錯誤不算
        if (!(error as NodeJS.ErrnoException).code?.startsWith("ECONN")) reject(error);
      });
      request.write("x".repeat(1000)); // 只送一點點，宣告的 10 MB 根本沒有送
    });
    assert.equal(status, 413);
  });

  test("同一個 IP 太快回 429；不同 IP 不受影響", async () => {
    const sameIp = { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" };
    assert.equal((await post(sameIp, "{not json")).status, 400, "第一次通過限流（之後才被資料檢查擋下）");
    const limited = await post(sameIp, "{not json");
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "1", "告訴插件等多久再送");
    assert.equal((await post(fromNewIp(), "{not json")).status, 400);
  });

  test("COMMUNITY_UPLOAD_ENABLED 沒開時，兩個端點都回 404", async () => {
    enabled = false;
    try {
      assert.equal((await fetch(`${base}/community/items`)).status, 404);
      assert.equal((await post(fromNewIp(), body())).status, 404);
    } finally {
      enabled = true;
    }
  });

  test("方法不對回 405", async () => {
    assert.equal((await fetch(`${base}/community/upload`, { headers: fromNewIp() })).status, 405);
  });
});

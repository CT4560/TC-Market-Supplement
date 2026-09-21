import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { serialize, deserialize } from "bson";
import { CollectorStore } from "../src/store.js";
import { createApp } from "../src/server.js";
import { TokenBucketLimiter } from "../src/rate-limit.js";
import { decode, encode } from "../site/bson.js";

const siteDir = path.join(process.cwd(), "site");

describe("文件網站（/docs/）", () => {
  const store = new CollectorStore(new Database(":memory:"));
  store.replaceItems([{ id: 5729, name: "素雪白染劑", nameEn: "Snow White Dye" }, { id: 5730, name: "蒼白灰染劑" }]);
  let server: http.Server;
  let base = "";
  let apiEnabled = true;

  before(async () => {
    const env = new Proxy({}, { get: (_target, key) => (key === "COMMUNITY_API_ENABLED" && apiEnabled ? "on" : undefined) }) as NodeJS.ProcessEnv;
    server = createApp({ store, env, siteDir, log: () => {}, apiLimiter: new TokenBucketLimiter(1000, 1000) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });

  const get = (pathname: string, init: RequestInit = {}) => fetch(`${base}${pathname}`, { redirect: "manual", ...init });

  test("/docs 導向 /docs/", async () => {
    const response = await get("/docs");
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), "/docs/");
  });

  test("首頁是 HTML，帶內容安全政策與防嗅探標頭，標題是 TC-Market Supplement", async () => {
    const response = await get("/docs/");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const html = await response.text();
    assert.match(html, /<title>TC-Market Supplement<\/title>/);
    assert.match(html, /logo\.png/);
  });

  test("靜態檔案的型別正確：css、js、png；if-none-match 相同時回 304", async () => {
    const expected: Record<string, string> = {
      "style.css": "text/css",
      "app.js": "text/javascript",
      "bson.js": "text/javascript",
      "logo.png": "image/png",
      "favicon.png": "image/png",
    };
    for (const [file, type] of Object.entries(expected)) {
      const response = await get(`/docs/${file}`);
      assert.equal(response.status, 200, file);
      assert.match(response.headers.get("content-type") ?? "", new RegExp(type), file);
    }

    const first = await get("/docs/style.css");
    const etag = first.headers.get("etag");
    assert.ok(etag);
    assert.equal((await get("/docs/style.css", { headers: { "if-none-match": etag } })).status, 304);
  });

  test("圖片檔跟磁碟上的一致", async () => {
    const response = await get("/docs/logo.png");
    const body = Buffer.from(await response.arrayBuffer());
    assert.ok(body.equals(readFileSync(path.join(siteDir, "logo.png"))));
  });

  test("config.json：帶目前的限制數字，跟程式裡的常數一致", async () => {
    const config: any = await (await get("/docs/config.json")).json();
    assert.equal(config.name, "TC-Market Supplement");
    assert.equal(config.dataCenter.name, "陸行鳥");
    assert.equal(config.worlds.length, 7);
    assert.deepEqual([config.rest.ratePerSecond, config.rest.burst, config.rest.maxItemsPerRequest, config.rest.itemsPerToken], [20, 40, 112, 10]);
    assert.deepEqual([config.websocket.maxPerIp, config.websocket.maxTotal, config.websocket.path], [4, 300, "/api/ws"]);
    assert.equal(config.data.salesRetentionDays, 365);
  });

  test("items.json：物品編號與名稱", async () => {
    const items: any[] = await (await get("/docs/items.json")).json();
    assert.deepEqual(items, [
      { id: 5729, name: "素雪白染劑", nameEn: "Snow White Dye" },
      { id: 5730, name: "蒼白灰染劑", nameEn: null },
    ]);
  });

  test("不存在的檔案回 404；路徑穿越、反斜線、編碼過的 .. 都拿不到網站以外的東西", async () => {
    assert.equal((await get("/docs/nope.js")).status, 404);
    for (const attack of ["/docs/../package.json", "/docs/%2e%2e/package.json", "/docs/..%2fpackage.json", "/docs/..\\package.json", "/docs/%2e%2e%2f%2e%2e%2fsrc%2fserver.ts", "/docs//etc/passwd"]) {
      const response = await get(attack);
      assert.ok([400, 404].includes(response.status), `${attack} → ${response.status}`);
      assert.doesNotMatch(await response.text(), /"name":|createApp/);
    }
    assert.equal((await get("/docs/%zz")).status, 400);
  });

  test("只接受 GET 與 HEAD", async () => {
    assert.equal((await get("/docs/", { method: "POST" })).status, 405);
    const head = await get("/docs/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  test("所有回應都帶 noindex，/robots.txt 禁止爬取", async () => {
    for (const target of ["/docs/", "/docs/config.json", "/api/v2/worlds", "/health", "/nope"]) {
      assert.equal((await get(target)).headers.get("x-robots-tag"), "noindex, nofollow", target);
    }
    const robots = await get("/robots.txt");
    assert.equal(robots.status, 200);
    assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
    assert.match(await (await get("/docs/")).text(), /<meta name="robots" content="noindex, nofollow">/);
  });

  test("COMMUNITY_API_ENABLED 沒開時整個 /docs 回 404", async () => {
    apiEnabled = false;
    try {
      assert.equal((await get("/docs/")).status, 404);
      assert.equal((await get("/docs/config.json")).status, 404);
    } finally {
      apiEnabled = true;
    }
  });

  test("沒有指定網站資料夾（或資料夾不存在）就沒有 /docs", async () => {
    const env = { COMMUNITY_API_ENABLED: "on" } as NodeJS.ProcessEnv;
    const bare = createApp({ store, env, log: () => {} });
    const missing = createApp({ store, env, siteDir: path.join(siteDir, "不存在"), log: () => {} });
    for (const app of [bare, missing]) {
      await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
      const port = (app.address() as AddressInfo).port;
      assert.equal((await fetch(`http://127.0.0.1:${port}/docs/`)).status, 404);
      await new Promise((resolve) => app.close(resolve));
    }
  });
});

describe("網站用的 BSON 編解碼（site/bson.js）", () => {
  const samples: Array<Record<string, unknown>> = [
    { event: "subscribe", channel: "listings/add{world=4033,item=5729}" },
    { event: "listings/add", item: 5729, world: 4033, listings: [{ lastReviewTime: 1789970000000, pricePerUnit: 350, quantity: 99, retainerName: "沐玥", hq: false, materia: [], creatorID: null, total: 34650, tax: null }] },
    { nested: { a: { b: [1, 2.5, -3, "x", true, false, null, { c: "深" }] } }, big: 1789973217442, negative: -2147483648, max: 2147483647, float: 0.1 },
    { empty: {}, emptyArray: [], text: "" },
  ];

  test("我們編碼、bson 套件解碼", () => {
    for (const sample of samples) assert.deepEqual(deserialize(Buffer.from(encode(sample))), sample);
  });

  test("bson 套件編碼、我們解碼", () => {
    for (const sample of samples) assert.deepEqual(decode(new Uint8Array(serialize(sample))), sample);
  });

  test("壞資料會丟出錯誤而不是卡住", () => {
    assert.throws(() => decode(new Uint8Array([1, 2, 3])));
    assert.throws(() => decode(new Uint8Array([9, 0, 0, 0, 0])));
  });
});

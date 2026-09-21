import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { TW_WORLDS } from "../src/worlds.js";
import { CollectorStore } from "../src/store.js";
import { createApp } from "../src/server.js";
import { applyUpload, validateUpload } from "../src/community.js";
import { TokenBucketLimiter } from "../src/rate-limit.js";
import { MAX_ITEMS_PER_REQUEST } from "../src/api-v2.js";

const shapes = JSON.parse(readFileSync(new URL("./fixtures/universalis-shapes.json", import.meta.url), "utf8")) as Record<string, string[]>;

const ITEM = 5729;
const ITEM2 = 5730;
const EMPTY_ITEM = 5731;
const BAHAMUT = 4033;
const TITAN = 4035;

describe("公開讀取 API（/api/v2）", () => {
  const store = new CollectorStore(new Database(":memory:"));
  store.replaceItems([{ id: ITEM, name: "素雪白" }, { id: ITEM2, name: "蒼白灰" }, { id: EMPTY_ITEM, name: "古卜灰" }]);
  let server: http.Server;
  let base = "";
  let apiEnabled = true;
  const clock = { now: Date.now() };
  let ipCounter = 0;
  const ip = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

  const seed = (worldId: number, itemId: number, listings: Array<Record<string, unknown>>, sales: Array<Record<string, unknown>>) => {
    const now = Date.now();
    const checked = validateUpload({ worldId, itemId, capturedAt: now - 1000, listings, sales }, { now, isAcceptedItem: store.isAcceptedItem });
    assert.ok(checked.ok, JSON.stringify(checked));
    applyUpload(store, checked.value, now);
  };

  before(async () => {
    const now = Date.now();
    seed(BAHAMUT, ITEM, [
      { pricePerUnit: 500, quantity: 3, retainerName: "雇員甲", listingId: "1001" },
      { pricePerUnit: 350, quantity: 99, retainerName: "沐玥", listingId: "1002" },
    ], [
      { pricePerUnit: 400, quantity: 40, buyerName: "夏沐", timestamp: now - 3_600_000 },
      { pricePerUnit: 399, quantity: 30, buyerName: "克里斯托", timestamp: now - 7_200_000 },
      { pricePerUnit: 300, quantity: 10, buyerName: "蓮·阿修貝爾", timestamp: now - 20 * 86_400_000 },
    ]);
    seed(TITAN, ITEM, [{ pricePerUnit: 700, quantity: 5, retainerName: "泰坦雇員", listingId: "2001" }], []);
    seed(BAHAMUT, ITEM2, [], [{ pricePerUnit: 1000, quantity: 3, buyerName: "南揚州", timestamp: now - 1_800_000 }]);

    const env = new Proxy({}, {
      get: (_target, key) => (key === "COMMUNITY_API_ENABLED" && apiEnabled ? "on" : undefined),
    }) as NodeJS.ProcessEnv;
    server = createApp({
      store,
      env,
      log: () => {},
      apiLimiter: new TokenBucketLimiter(20, 40, () => clock.now),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });

  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { "cf-connecting-ip": ip(), ...headers } });
  const json = async (path: string) => {
    const response = await get(path);
    return { status: response.status, headers: response.headers, body: (await response.json()) as any };
  };

  test("COMMUNITY_API_ENABLED 沒開時整個 /api/v2 回 404", async () => {
    apiEnabled = false;
    try {
      assert.equal((await get("/api/v2/worlds")).status, 404);
    } finally {
      apiEnabled = true;
    }
  });

  test("世界、資料中心、可交易物品清單", async () => {
    const worlds = await json("/api/v2/worlds");
    assert.equal(worlds.body.length, 7);
    assert.deepEqual(Object.keys(worlds.body[0]), shapes.world);

    const dcs = await json("/api/v2/data-centers");
    assert.deepEqual(Object.keys(dcs.body[0]), shapes.dataCenter);
    assert.equal(dcs.body[0].name, "陸行鳥");

    assert.deepEqual((await json("/api/v2/marketable")).body, [ITEM, ITEM2, EMPTY_ITEM]);
  });

  test("單一世界單一物品：鍵與順序跟 Universalis 相同、值正確、時間是毫秒", async () => {
    const { status, body } = await json(`/api/v2/${BAHAMUT}/${ITEM}?entries=10`);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body), shapes.worldItem);
    assert.deepEqual(Object.keys(body.listings[0]), shapes.listing);
    assert.deepEqual(Object.keys(body.recentHistory[0]), shapes.recentHistory);

    assert.equal(body.itemID, ITEM);
    assert.equal(body.worldName, "巴哈姆特");
    assert.deepEqual(body.listings.map((l: any) => [l.pricePerUnit, l.retainerName]), [[350, "沐玥"], [500, "雇員甲"]]);
    assert.deepEqual(body.recentHistory.map((s: any) => [s.pricePerUnit, s.buyerName]), [[400, "夏沐"], [399, "克里斯托"], [300, "蓮·阿修貝爾"]]);
    assert.ok(body.lastUploadTime > 1_700_000_000_000, "毫秒");
    assert.ok(body.recentHistory[0].timestamp > 1_700_000_000_000, "毫秒");
    assert.equal(body.minPrice, 350);
    assert.equal(body.maxPrice, 500);
    assert.equal(body.unitsForSale, 102);
    assert.equal(body.unitsSold, 70, "7 天內只有前兩筆成交：40＋30");
    assert.equal(body.listingsCount, 2);
    assert.equal(body.hasData, true);
    assert.equal(body.listings[0].total, 350 * 99);
  });

  test("世界名稱（網址編碼的中文）與資料中心名稱都能查", async () => {
    const byName = await json(`/api/v2/${encodeURIComponent("巴哈姆特")}/${ITEM}`);
    assert.equal(byName.status, 200);
    assert.equal(byName.body.worldID, BAHAMUT);

    const dc = await json(`/api/v2/${encodeURIComponent("陸行鳥")}/${ITEM}`);
    assert.equal(dc.status, 200);
    assert.deepEqual(Object.keys(dc.body), shapes.dcItem);
    assert.deepEqual(Object.keys(dc.body.listings[0]), shapes.dcListing);
    assert.deepEqual(dc.body.listings.map((l: any) => l.worldID), [BAHAMUT, BAHAMUT, TITAN]);
    assert.deepEqual(Object.keys(dc.body.worldUploadTimes).sort(), [String(BAHAMUT), String(TITAN)]);
  });

  test("多個物品：items 字典與 unresolvedItems；單一物品不在白名單回 404", async () => {
    const multi = await json(`/api/v2/${BAHAMUT}/${ITEM},${ITEM2},999`);
    assert.equal(multi.status, 200);
    assert.deepEqual(Object.keys(multi.body), shapes.multi);
    assert.deepEqual(multi.body.itemIDs, [ITEM, ITEM2, 999]);
    assert.deepEqual(Object.keys(multi.body.items), [String(ITEM), String(ITEM2)]);
    assert.deepEqual(multi.body.unresolvedItems, [999]);
    assert.equal(multi.body.items[String(ITEM2)].listingsCount, 0);

    const missing = await json(`/api/v2/${BAHAMUT}/999`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.status, 404);
    assert.equal(typeof missing.body.traceId, "string");

    const noData = await json(`/api/v2/${BAHAMUT}/${EMPTY_ITEM}`);
    assert.equal(noData.status, 200);
    assert.equal(noData.body.hasData, false);
  });

  test("查全部 112 個物品可以，113 個不行；壞的物品編號、世界、參數回 400／404", async () => {
    const ids = (count: number) => Array.from({ length: count }, (_, i) => 5000 + i).join(",");
    assert.equal(MAX_ITEMS_PER_REQUEST, 112);
    assert.equal((await get(`/api/v2/${BAHAMUT}/${ids(112)}`)).status, 200);
    assert.equal((await get(`/api/v2/${BAHAMUT}/${ids(113)}`)).status, 400);
    assert.equal((await get(`/api/v2/${BAHAMUT}/abc`)).status, 400);
    assert.equal((await get(`/api/v2/${BAHAMUT}/`)).status, 404);
    assert.equal((await get(`/api/v2/9999/${ITEM}`)).status, 404);
    for (const query of ["entries=-1", "entries=abc", "listings=x", "statsWithin=0", "statsWithin=99999999999", "hq=maybe", "fields=a..b"]) {
      assert.equal((await get(`/api/v2/${BAHAMUT}/${ITEM}?${query}`)).status, 400, query);
    }
  });

  test("listings／entries／hq／statsWithin／entriesWithin 參數", async () => {
    const limited = await json(`/api/v2/${BAHAMUT}/${ITEM}?listings=1&entries=1`);
    assert.equal(limited.body.listings.length, 1);
    assert.equal(limited.body.recentHistory.length, 1);
    assert.equal(limited.body.listingsCount, 2);

    assert.equal((await json(`/api/v2/${BAHAMUT}/${ITEM}?hq=true`)).body.listings.length, 0);
    assert.equal((await json(`/api/v2/${BAHAMUT}/${ITEM}?hq=false`)).body.listings.length, 2);

    const wide = await json(`/api/v2/${BAHAMUT}/${ITEM}?statsWithin=${30 * 86_400_000}&entries=10`);
    assert.equal(wide.body.unitsSold, 80);
    const recent = await json(`/api/v2/${BAHAMUT}/${ITEM}?entriesWithin=${5_400_000}&entries=10`);
    assert.equal(recent.body.recentHistory.length, 1, "只有 1.5 小時內的一筆");
  });

  test("fields 欄位投影：單一物品與多物品（items. 前綴）", async () => {
    const single = await json(`/api/v2/${BAHAMUT}/${ITEM}?fields=lastUploadTime,listings.pricePerUnit,listings.quantity`);
    assert.deepEqual(Object.keys(single.body).sort(), ["lastUploadTime", "listings"]);
    assert.deepEqual(single.body.listings, [{ pricePerUnit: 350, quantity: 99 }, { pricePerUnit: 500, quantity: 3 }]);

    const multi = await json(`/api/v2/${BAHAMUT}/${ITEM},${ITEM2}?fields=items.lastUploadTime,items.listings.pricePerUnit`);
    assert.deepEqual(Object.keys(multi.body), ["items"]);
    assert.deepEqual(Object.keys(multi.body.items[String(ITEM)]).sort(), ["lastUploadTime", "listings"]);
  });

  test("成交歷史端點", async () => {
    const history = await json(`/api/v2/history/${BAHAMUT}/${ITEM}`);
    assert.equal(history.status, 200);
    assert.deepEqual(Object.keys(history.body), shapes.history);
    assert.deepEqual(Object.keys(history.body.entries[0]), shapes.historyEntry);
    assert.equal(history.body.entries.length, 3);

    const filtered = await json(`/api/v2/history/${BAHAMUT}/${ITEM}?minSalePrice=350&entries=1`);
    assert.deepEqual(filtered.body.entries.map((e: any) => e.pricePerUnit), [400]);

    const dc = await json(`/api/v2/history/${encodeURIComponent("陸行鳥")}/${ITEM}`);
    assert.equal(dc.body.dcName, "陸行鳥");
    assert.equal((await get(`/api/v2/history/${BAHAMUT}/999`)).status, 404);
  });

  test("最近被回報的物品", async () => {
    const recent = await json(`/api/v2/extra/stats/most-recently-updated?world=${BAHAMUT}&entries=5`);
    assert.equal(recent.status, 200);
    assert.deepEqual(Object.keys(recent.body.items[0]), shapes.mostRecentItem);
    assert.deepEqual(recent.body.items.map((i: any) => i.worldID), [BAHAMUT, BAHAMUT]);
    assert.ok(recent.body.items[0].lastUploadTime >= recent.body.items[1].lastUploadTime);

    const all = await json(`/api/v2/extra/stats/most-recently-updated?dcName=${encodeURIComponent("陸行鳥")}`);
    assert.equal(all.body.items.length, 3);
    assert.equal((await get(`/api/v2/extra/stats/most-recently-updated?world=1`)).status, 404);
  });

  test("CORS：任何來源都能讀、預檢回 204；不允許的方法回 405；不存在的路徑回 404", async () => {
    const ok = await get(`/api/v2/worlds`, { origin: "https://example.com" });
    assert.equal(ok.headers.get("access-control-allow-origin"), "*");
    assert.match(ok.headers.get("cache-control") ?? "", /max-age=10/);

    const preflight = await fetch(`${base}/api/v2/${BAHAMUT}/${ITEM}`, { method: "OPTIONS", headers: { "cf-connecting-ip": ip(), origin: "https://example.com" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

    const post = await fetch(`${base}/api/v2/worlds`, { method: "POST", headers: { "cf-connecting-ip": ip() } });
    assert.equal(post.status, 405);
    assert.equal((await get(`/api/v2/nothing/here/at/all`)).status, 404);
  });

  test("限流：每個 IP 突發 40、每秒補 20；超過回 429＋Retry-After；不同 IP 互不影響", async () => {
    const same = { "cf-connecting-ip": "203.0.113.77" };
    const statuses: number[] = [];
    for (let i = 0; i < 41; i++) statuses.push((await fetch(`${base}/api/v2/worlds`, { headers: same })).status);
    assert.equal(statuses.filter((status) => status === 200).length, 40);
    assert.equal(statuses[40], 429);

    const limited = await fetch(`${base}/api/v2/worlds`, { headers: same });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "1");
    assert.equal(((await limited.json()) as any).status, 429);

    assert.equal((await fetch(`${base}/api/v2/worlds`, { headers: { "cf-connecting-ip": "203.0.113.78" } })).status, 200, "別的 IP 不受影響");

    clock.now += 1000; // 補回 20 個名額
    let allowed = 0;
    for (let i = 0; i < 25; i++) if ((await fetch(`${base}/api/v2/worlds`, { headers: same })).status === 200) allowed++;
    assert.equal(allowed, 20);
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DAY_MS,
  DC_NAME,
  buildDcItem,
  buildHistory,
  buildWorldItem,
  computeStats,
  formatHistoryEntry,
  formatListing,
  formatRecentSale,
  parseFields,
  projectFields,
  resolveWorld,
  type ViewOptions,
  type WorldData,
} from "../src/read-model.js";
import type { StoredListing, StoredSale } from "../src/store.js";

const shapes = JSON.parse(readFileSync(new URL("./fixtures/universalis-shapes.json", import.meta.url), "utf8")) as Record<string, string[]>;

const NOW = 1_800_000_000_000;
const W1 = { id: 4033, name: "巴哈姆特" };
const W2 = { id: 4035, name: "泰坦" };

const listing = (price: number, quantity: number, over: Partial<StoredListing> = {}): StoredListing => ({
  pricePerUnit: price,
  quantity,
  total: price * quantity,
  retainerName: "雇員",
  listingId: String(price),
  firstSeenAt: NOW - 3_600_000,
  ...over,
});
const sale = (price: number, quantity: number, ageMs: number, buyerName = "買家"): StoredSale => ({ pricePerUnit: price, quantity, buyerName, saleTimestamp: NOW - ageMs });

const options: ViewOptions = { entries: 5, statsWithinMs: 7 * DAY_MS };
const data = (world: typeof W1, listings: StoredListing[], sales: StoredSale[], uploadedAt = NOW - 1000): WorldData => ({
  world,
  entry: { listings, uploadedAt },
  sales,
});

describe("世界參數", () => {
  test("世界編號、世界名稱、資料中心名稱都認得；不認得的回 null", () => {
    assert.deepEqual(resolveWorld("4033"), { kind: "world", world: W1 });
    assert.deepEqual(resolveWorld("巴哈姆特"), { kind: "world", world: W1 });
    const dc = resolveWorld(DC_NAME);
    assert.equal(dc?.kind, "dc");
    assert.equal(dc?.kind === "dc" && dc.worlds.length, 7);
    for (const bad of ["74", "Chocobo", "", "4034", "巴哈"]) assert.equal(resolveWorld(bad), null, bad);
  });
});

describe("欄位格式跟 Universalis 一致（鍵與順序）", () => {
  test("掛單、成交、歷史項目（單一世界與資料中心版）", () => {
    assert.deepEqual(Object.keys(formatListing(listing(100, 2))), shapes.listing);
    assert.deepEqual(Object.keys(formatListing(listing(100, 2), W1)), shapes.dcListing);
    assert.deepEqual(Object.keys(formatRecentSale(sale(100, 2, 1000))), shapes.recentHistory);
    assert.deepEqual(Object.keys(formatRecentSale(sale(100, 2, 1000), W1)), shapes.dcRecentHistory);
    assert.deepEqual(Object.keys(formatHistoryEntry(sale(100, 2, 1000))), shapes.historyEntry);
  });

  test("時間是毫秒、沒收集的欄位是中性值、雇員與買家名稱有回傳", () => {
    const l = formatListing(listing(100, 2, { firstSeenAt: 1_700_000_000_123, retainerName: "菲露塔" }));
    assert.equal(l.lastReviewTime, 1_700_000_000_123);
    assert.equal(l.retainerName, "菲露塔");
    assert.equal(l.total, 200);
    assert.deepEqual([l.hq, l.stainID, l.creatorID, l.materia, l.tax], [false, 0, null, [], null]);
    const s = formatRecentSale(sale(100, 2, 1000, "夏沐"));
    assert.equal(s.timestamp, NOW - 1000);
    assert.equal(s.buyerName, "夏沐");
    assert.equal(s.total, 200);
  });

  test("單一世界與資料中心的物品頂層鍵", () => {
    const one = buildWorldItem(5729, data(W1, [listing(100, 2)], [sale(90, 1, DAY_MS)]), options, NOW);
    assert.deepEqual(Object.keys(one), shapes.worldItem);
    const dc = buildDcItem(5729, DC_NAME, [data(W1, [listing(100, 2)], []), data(W2, [], [])], options, NOW);
    assert.deepEqual(Object.keys(dc), shapes.dcItem);
  });

  test("歷史端點的頂層鍵", () => {
    const world = resolveWorld("4033")!;
    const history = buildHistory(5729, world, [data(W1, [], [sale(90, 1, DAY_MS)])], { entries: 10, statsWithinMs: 7 * DAY_MS }, NOW);
    assert.deepEqual(Object.keys(history), shapes.history);
  });
});

describe("統計", () => {
  test("最低／最高／平均價、數量總和、速度、數量分布", () => {
    const listings = [listing(300, 5), listing(100, 2), listing(200, 5)];
    const sales = [sale(150, 3, DAY_MS), sale(250, 4, 2 * DAY_MS)];
    const stats = computeStats(listings, sales, 7 * DAY_MS);

    assert.equal(stats.fields.minPrice, 100);
    assert.equal(stats.fields.maxPrice, 300);
    assert.equal(stats.fields.currentAveragePrice, 200);
    assert.equal(stats.fields.averagePrice, 200);
    assert.equal(stats.unitsForSale, 12);
    assert.equal(stats.unitsSold, 7);
    assert.equal(stats.fields.regularSaleVelocity, 1); // 7 個 ÷ 7 天
    assert.deepEqual(stats.fields.stackSizeHistogram, { "5": 2, "2": 1 });
    assert.deepEqual(stats.fields.stackSizeHistogramHQ, {});
    assert.equal(stats.fields.minPriceHQ, 0);
    assert.equal(stats.listingsCount, 3);
    assert.equal(stats.recentHistoryCount, 2);
  });

  test("沒有資料：全是 0、hasData 為 false", () => {
    const stats = computeStats([], [], 7 * DAY_MS);
    assert.deepEqual([stats.fields.minPrice, stats.fields.averagePrice, stats.unitsForSale, stats.unitsSold], [0, 0, 0, 0]);
    const empty = buildWorldItem(5729, { world: W1, entry: undefined, sales: [] }, options, NOW);
    assert.equal(empty.hasData, false);
    assert.equal(empty.lastUploadTime, 0);
    assert.deepEqual(empty.listings, []);
  });
});

describe("物品檢視", () => {
  const w1 = data(W1, [listing(300, 1), listing(100, 1)], [sale(90, 1, 1000), sale(80, 1, 2000), sale(70, 1, 20 * DAY_MS)]);

  test("掛單依單價由低到高、成交由新到舊、listings／entries 限制筆數", () => {
    const view = buildWorldItem(1, w1, { ...options, listings: 1, entries: 2 }, NOW);
    assert.deepEqual((view.listings as Array<{ pricePerUnit: number }>).map((l) => l.pricePerUnit), [100]);
    assert.deepEqual((view.recentHistory as Array<{ pricePerUnit: number }>).map((s) => s.pricePerUnit), [90, 80]);
    assert.equal(view.listingsCount, 2, "統計仍用全部掛單");
  });

  test("statsWithin 只影響統計；entriesWithin 只影響回傳的成交", () => {
    const wide = buildWorldItem(1, w1, { ...options, statsWithinMs: 30 * DAY_MS, entries: 10 }, NOW);
    const narrow = buildWorldItem(1, w1, { ...options, entries: 10, entriesWithinMs: 5000 }, NOW);
    assert.equal(wide.unitsSold, 3);
    assert.equal(wide.recentHistoryCount, 3);
    assert.equal((narrow.recentHistory as unknown[]).length, 2);
    assert.equal(narrow.unitsSold, 2, "7 天內的成交 2 筆");
  });

  test("hq=true 什麼都沒有（染劑只有 NQ）；hq=false 等於不篩", () => {
    const hqOnly = buildWorldItem(1, w1, { ...options, hq: true }, NOW);
    assert.deepEqual(hqOnly.listings, []);
    assert.equal(hqOnly.unitsForSale, 0);
    const nqOnly = buildWorldItem(1, w1, { ...options, hq: false }, NOW);
    assert.equal(nqOnly.listingsCount, 2);
  });

  test("資料中心：兩個世界合併，每筆帶世界，worldUploadTimes 分世界", () => {
    const w2 = data(W2, [listing(50, 4)], [sale(60, 1, 500)], NOW - 5000);
    const dc = buildDcItem(1, DC_NAME, [w1, w2], { ...options, entries: 10 }, NOW);
    const listings = dc.listings as Array<{ pricePerUnit: number; worldID: number; worldName: string }>;
    assert.deepEqual(listings.map((l) => [l.pricePerUnit, l.worldID]), [[50, 4035], [100, 4033], [300, 4033]]);
    assert.equal(listings[0].worldName, "泰坦");
    assert.deepEqual(dc.worldUploadTimes, { "4033": NOW - 1000, "4035": NOW - 5000 });
    assert.equal(dc.lastUploadTime, NOW - 1000);
    assert.equal((dc.recentHistory as Array<{ pricePerUnit: number }>)[0].pricePerUnit, 60, "跨世界依時間排序");
  });

  test("成交歷史：價格篩選與筆數", () => {
    const world = resolveWorld("4033")!;
    const history = buildHistory(1, world, [w1], { entries: 10, statsWithinMs: 30 * DAY_MS, minSalePrice: 75, maxSalePrice: 85 }, NOW);
    assert.deepEqual((history.entries as Array<{ pricePerUnit: number }>).map((s) => s.pricePerUnit), [80]);
    assert.equal(history.regularSaleVelocity, 1 / 30);
  });
});

describe("fields 欄位投影", () => {
  const body = {
    itemID: 1,
    listings: [
      { pricePerUnit: 10, quantity: 1, retainerName: "A" },
      { pricePerUnit: 20, quantity: 2, retainerName: "B" },
    ],
    items: { "5": { itemID: 5, listings: [{ pricePerUnit: 1, quantity: 9 }], lastUploadTime: 7 }, "6": { itemID: 6, listings: [], lastUploadTime: 8 } },
  };

  test("點路徑、陣列每個元素都套用、整個子樹", () => {
    assert.deepEqual(projectFields(body, parseFields("itemID,listings.pricePerUnit")!), {
      itemID: 1,
      listings: [{ pricePerUnit: 10 }, { pricePerUnit: 20 }],
    });
    assert.deepEqual(projectFields(body, parseFields("listings")!), { listings: body.listings });
  });

  test("items 是字典：路徑套用到每個物品", () => {
    assert.deepEqual(projectFields(body, parseFields("items.lastUploadTime,items.listings.pricePerUnit")!), {
      items: { "5": { listings: [{ pricePerUnit: 1 }], lastUploadTime: 7 }, "6": { listings: [], lastUploadTime: 8 } },
    });
  });

  test("不存在的欄位略過；空白與壞格式", () => {
    assert.deepEqual(projectFields(body, parseFields("nope,itemID")!), { itemID: 1 });
    assert.equal(parseFields(""), null);
    assert.equal(parseFields(" , "), null);
    assert.equal(parseFields("a..b"), null);
    assert.equal(parseFields(null), null);
  });
});

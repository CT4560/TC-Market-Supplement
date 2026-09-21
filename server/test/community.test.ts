import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { TW_WORLDS } from "../src/worlds.js";
import { CollectorStore } from "../src/store.js";
import {
  MAX_BUYER_NAME_CHARS,
  MAX_QUANTITY,
  UploadRateLimiter,
  applyUpload,
  getClientIp,
  isCommunityUploadEnabled,
  validateUpload,
  type ValidationContext,
} from "../src/community.js";

const ITEM = 910001; // 白名單內的物品（舊染劑）
const OTHER_ITEM = 910002; // 不在白名單
const W = TW_WORLDS[6].id; // 泰坦

const rawDb = new Database(":memory:");
const store = new CollectorStore(rawDb);
store.replaceItems([{ id: ITEM, name: "測試舊染劑" }]);
after(() => store.close());

const NOW = 1_800_000_000_000;
const ctx: ValidationContext = { now: NOW, isAcceptedItem: store.isAcceptedItem };
const upload = (over: Record<string, unknown> = {}) => ({
  worldId: W,
  itemId: ITEM,
  capturedAt: NOW - 5_000,
  listings: [{ pricePerUnit: 500, quantity: 3, retainerName: "雇員甲", listingId: "7001" }],
  sales: [{ pricePerUnit: 480, quantity: 2, timestamp: NOW - 86_400_000 }],
  ...over,
});

describe("公開上傳的開關與來源 IP", () => {
  test("COMMUNITY_UPLOAD_ENABLED 只有 on（不分大小寫）才開，沒設或其他值都是關", () => {
    assert.equal(isCommunityUploadEnabled({ COMMUNITY_UPLOAD_ENABLED: "on" }), true);
    assert.equal(isCommunityUploadEnabled({ COMMUNITY_UPLOAD_ENABLED: " ON " }), true);
    for (const off of [undefined, "", "off", "true", "1"]) {
      assert.equal(isCommunityUploadEnabled({ COMMUNITY_UPLOAD_ENABLED: off }), false, String(off));
    }
  });

  test("來源 IP：優先 CF-Connecting-IP，其次 X-Forwarded-For 第一段，最後連線位址，都沒有回 unknown", () => {
    const socket = { remoteAddress: "10.0.0.9" };
    assert.equal(getClientIp({ headers: { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" }, socket }), "1.2.3.4");
    assert.equal(getClientIp({ headers: { "x-forwarded-for": " 5.6.7.8 , 9.9.9.9" }, socket }), "5.6.7.8");
    assert.equal(getClientIp({ headers: {}, socket }), "10.0.0.9");
    assert.equal(getClientIp({ headers: { "cf-connecting-ip": "" }, socket: {} }), "unknown");
    assert.equal(getClientIp({ headers: {} }), "unknown");
  });
});

describe("上傳資料驗證", () => {
  test("正常的上傳通過，整理成內部格式", () => {
    const result = validateUpload(upload(), ctx);
    assert.ok(result.ok);
    assert.equal(result.value.listings[0].pricePerUnit, 500);
    assert.equal(result.value.sales.length, 1);
  });

  test("只接受白名單內的物品", () => {
    const result = validateUpload(upload({ itemId: OTHER_ITEM }), ctx);
    assert.ok(!result.ok);
    assert.equal(result.status, 422);
  });

  test("世界必須是繁中服七個世界之一", () => {
    assert.ok(!validateUpload(upload({ worldId: 74 }), ctx).ok);
    assert.ok(!validateUpload(upload({ worldId: "4033" }), ctx).ok);
  });

  test("掃描時間：太舊或在未來都拒絕", () => {
    assert.ok(!validateUpload(upload({ capturedAt: NOW - 20 * 60_000 }), ctx).ok);
    assert.ok(!validateUpload(upload({ capturedAt: NOW + 10 * 60_000 }), ctx).ok);
    assert.ok(validateUpload(upload({ capturedAt: NOW - 14 * 60_000 }), ctx).ok);
  });

  test("價格與數量：必須是合理的正整數，異常值整筆拒絕；單筆數量最多 99", () => {
    assert.equal(MAX_QUANTITY, 99);
    const listing = (over: Record<string, unknown>) => ({ pricePerUnit: 500, quantity: 3, ...over });
    const bads = [
      { pricePerUnit: 0 },
      { pricePerUnit: -5 },
      { pricePerUnit: 1.5 },
      { pricePerUnit: 1e12 },
      { quantity: 0 },
      { quantity: MAX_QUANTITY + 1 },
      { quantity: 1e7 },
      { pricePerUnit: "500" },
    ];
    for (const bad of bads) {
      assert.ok(!validateUpload(upload({ listings: [listing(bad)] }), ctx).ok, JSON.stringify(bad));
    }
    assert.ok(validateUpload(upload({ listings: [listing({})] }), ctx).ok);
    assert.ok(validateUpload(upload({ listings: [listing({ quantity: MAX_QUANTITY })] }), ctx).ok, "剛好等於上限可以");
  });

  test("雇員名稱含角括號（像 HTML 標籤）的掛單被略過，同一批其他合法資料照常收", () => {
    const result = validateUpload(
      upload({
        listings: [
          { pricePerUnit: 100, quantity: 1, retainerName: "<script>alert(1)</script>", listingId: "1" },
          { pricePerUnit: 200, quantity: 1, retainerName: "正常雇員", listingId: "2" },
        ],
      }),
      ctx,
    );
    assert.ok(result.ok);
    assert.deepEqual(result.value.listings.map((l) => l.listingId), ["2"]);
  });

  test("掛單編號：必須是十進位字串（64 位元整數用 JSON 數字會失真）；沒帶也可以", () => {
    const withId = (listingId: unknown) => upload({ listings: [{ pricePerUnit: 5, quantity: 1, listingId }] });
    assert.ok(validateUpload(withId("18446744073709551615"), ctx).ok);
    for (const bad of [123456, "12ab", "", "1".repeat(21), -1, "1.5"]) {
      assert.ok(!validateUpload(withId(bad), ctx).ok, String(bad));
    }
    const noId = validateUpload(upload({ listings: [{ pricePerUnit: 5, quantity: 1 }] }), ctx);
    assert.ok(noId.ok);
    assert.equal(noId.value.listings[0].listingId, undefined);
  });

  test("筆數上限與型別：掛單最多 100、成交最多 50；不是物件、不是陣列都拒絕", () => {
    const many = Array.from({ length: 101 }, () => ({ pricePerUnit: 5, quantity: 1 }));
    assert.ok(!validateUpload(upload({ listings: many }), ctx).ok);
    const manySales = Array.from({ length: 51 }, () => ({ pricePerUnit: 5, quantity: 1, timestamp: NOW - 1000 }));
    assert.ok(!validateUpload(upload({ sales: manySales }), ctx).ok);
    assert.ok(!validateUpload("x", ctx).ok);
    assert.ok(!validateUpload(null, ctx).ok);
    assert.ok(!validateUpload(upload({ listings: "nope" }), ctx).ok);
  });

  test("成交的買家名稱：整理成字串（沒帶就是空字串）、姓名加起來最多 6 字（不含空白）、超過或含角括號的成交略過", () => {
    assert.equal(MAX_BUYER_NAME_CHARS, 6);
    const result = validateUpload(
      upload({
        sales: [
          { pricePerUnit: 5, quantity: 1, timestamp: NOW - 1000, buyerName: "  買家甲  " },
          { pricePerUnit: 6, quantity: 1, timestamp: NOW - 2000 },
          { pricePerUnit: 7, quantity: 1, timestamp: NOW - 3000, buyerName: 12345 },
          { pricePerUnit: 8, quantity: 1, timestamp: NOW - 4000, buyerName: "<b>壞人</b>" },
          { pricePerUnit: 9, quantity: 1, timestamp: NOW - 5000, buyerName: "長".repeat(7) },
          { pricePerUnit: 10, quantity: 1, timestamp: NOW - 6000, buyerName: "一二三 四五六" },
          { pricePerUnit: 11, quantity: 1, timestamp: NOW - 7000, buyerName: "一二三 四五六七" },
          { pricePerUnit: 12, quantity: 1, timestamp: NOW - 8000, buyerName: "長".repeat(6) },
        ],
      }),
      ctx,
    );
    assert.ok(result.ok);
    assert.deepEqual(result.value.sales.map((sale) => sale.pricePerUnit), [5, 6, 7, 10, 12]);
    assert.deepEqual(result.value.sales.map((sale) => sale.buyerName), ["買家甲", "", "", "一二三 四五六", "長".repeat(6)]);
  });

  test("買家名稱裡的「·」算一個字：蓮·阿修貝爾 剛好 6 字通過，再多一個字就略過", () => {
    const result = validateUpload(
      upload({
        sales: [
          { pricePerUnit: 5, quantity: 1, timestamp: NOW - 1000, buyerName: "蓮·阿修貝爾" },
          { pricePerUnit: 6, quantity: 1, timestamp: NOW - 2000, buyerName: "蓮·阿修貝爾七" },
        ],
      }),
      ctx,
    );
    assert.ok(result.ok);
    assert.deepEqual(result.value.sales.map((sale) => sale.buyerName), ["蓮·阿修貝爾"]);
  });

  test("成交：太舊的略過（不整筆拒絕）、在未來的拒絕", () => {
    const result = validateUpload(
      upload({
        sales: [
          { pricePerUnit: 5, quantity: 1, timestamp: NOW - 40 * 86_400_000 },
          { pricePerUnit: 6, quantity: 1, timestamp: NOW - 1000 },
        ],
      }),
      ctx,
    );
    assert.ok(result.ok);
    assert.equal(result.value.sales.length, 1);
    assert.ok(!validateUpload(upload({ sales: [{ pricePerUnit: 6, quantity: 1, timestamp: NOW + 3_600_000 }] }), ctx).ok);
  });
});

describe("寫入資料庫", () => {
  // 「較舊的擷取不會蓋掉較新的」讓測試之間會互相影響（共用同一個物品），每個測試前清掉快照。
  beforeEach(() => {
    rawDb.prepare("DELETE FROM snapshot").run();
  });

  test("掛單整份取代、依價格排序、最多留 10 筆，上傳時間與每筆第一次看到的時間都保留", () => {
    const now = Date.now();
    const listings = Array.from({ length: 12 }, (_, i) => ({ pricePerUnit: 1000 - i * 10, quantity: 1, retainerName: "R", listingId: String(8000 + i) }));
    const checked = validateUpload(upload({ capturedAt: now - 1000, listings, sales: [] }), { ...ctx, now });
    assert.ok(checked.ok);

    const applied = applyUpload(store, checked.value, now);
    const entry = store.getEntry(W, ITEM)!;

    assert.equal(applied.listingsStored, 10);
    assert.equal(entry.listings.length, 10);
    assert.equal(entry.listings[0].pricePerUnit, 890);
    assert.equal(entry.listings[0].total, 890);
    assert.equal(entry.uploadedAt, now - 1000);
    assert.equal(entry.listings[0].firstSeenAt, now - 1000);
    assert.equal(entry.listings[0].listingId, "8011");
  });

  test("同一筆掛單（同編號）再次被掃描到：第一次看到的時間不變；新的編號用這次掃描時間", () => {
    const t0 = Date.now() - 3_600_000;
    const scan = (capturedAt: number, ids: string[]) => {
      const checked = validateUpload(
        upload({ capturedAt, listings: ids.map((id, i) => ({ pricePerUnit: 100 + i, quantity: 1, listingId: id })), sales: [] }),
        { ...ctx, now: capturedAt + 1000 },
      );
      assert.ok(checked.ok);
      applyUpload(store, checked.value, capturedAt + 1000);
    };

    scan(t0, ["10", "20"]);
    scan(t0 + 20 * 60_000, ["10", "30"]); // 10 還在，20 已賣掉，30 是新的

    const byId = new Map(store.getEntry(W, ITEM)!.listings.map((l) => [l.listingId, l.firstSeenAt]));
    assert.equal(byId.get("10"), t0);
    assert.equal(byId.get("30"), t0 + 20 * 60_000);
    assert.ok(!byId.has("20"));
  });

  test("沒帶掛單編號的資料：一律用掃描時間", () => {
    const now = Date.now();
    const checked = validateUpload(upload({ capturedAt: now - 500, listings: [{ pricePerUnit: 9, quantity: 1 }], sales: [] }), { ...ctx, now });
    assert.ok(checked.ok);
    applyUpload(store, checked.value, now);
    assert.equal(store.getEntry(W, ITEM)!.listings[0].firstSeenAt, now - 500);
  });

  test("再上傳一次空清單 ＝ 目前沒人在賣（不是保留舊掛單）", () => {
    const now = Date.now();
    const checked = validateUpload(upload({ capturedAt: now - 500, listings: [], sales: [] }), { ...ctx, now });
    assert.ok(checked.ok);
    applyUpload(store, checked.value, now);

    const entry = store.getEntry(W, ITEM)!;
    assert.deepEqual(entry.listings, []);
    assert.equal(entry.uploadedAt, now - 500);
  });

  test("較舊的擷取不能蓋掉較新的：掛單不寫入，成交仍照收；較新的照常取代", () => {
    const base = Date.now();
    const put = (over: Record<string, unknown>) => {
      const checked = validateUpload(upload(over), { ...ctx, now: base });
      assert.ok(checked.ok);
      return applyUpload(store, checked.value, base);
    };

    put({ capturedAt: base - 1_000, listings: [{ pricePerUnit: 100, quantity: 1, retainerName: "新", listingId: "9001" }], sales: [] });

    const stale = put({
      capturedAt: base - 60_000,
      listings: [{ pricePerUnit: 999, quantity: 1, retainerName: "舊", listingId: "9002" }],
      sales: [{ pricePerUnit: 90, quantity: 1, timestamp: base - 120_000 }],
    });
    assert.equal(stale.listingsIgnored, true);
    assert.equal(stale.listingsStored, 0);
    assert.equal(stale.salesInserted, 1);
    const kept = store.getEntry(W, ITEM)!;
    assert.equal(kept.listings[0].pricePerUnit, 100);
    assert.equal(kept.uploadedAt, base - 1_000);

    const newer = put({ capturedAt: base - 500, listings: [{ pricePerUnit: 80, quantity: 1, retainerName: "更新", listingId: "9003" }], sales: [] });
    assert.equal(newer.listingsIgnored, undefined);
    assert.equal(store.getEntry(W, ITEM)!.listings[0].pricePerUnit, 80);
  });

  test("成交會存買家名稱；同一時間同價格同數量但買家不同是兩筆，同買家重複上傳只算一筆", () => {
    const now = Date.now();
    const timestamp = now - 7_200_000;
    const put = (buyerName: string) => {
      const checked = validateUpload(
        upload({ capturedAt: now - 100, listings: [], sales: [{ pricePerUnit: 321, quantity: 2, timestamp, buyerName }] }),
        { ...ctx, now },
      );
      assert.ok(checked.ok);
      return applyUpload(store, checked.value, now).salesInserted;
    };

    assert.equal(put("買家甲"), 1);
    assert.equal(put("買家甲"), 0, "同買家重複上傳");
    assert.equal(put("買家乙"), 1, "買家不同是另一筆");

    const rows = rawDb.prepare("SELECT buyerName FROM sales WHERE saleTimestamp = ? ORDER BY buyerName").all(timestamp) as Array<{ buyerName: string }>;
    assert.deepEqual(rows.map((row) => row.buyerName).sort(), ["買家乙", "買家甲"].sort());
  });

  test("成交寫入成交表、重複上傳不會重複（唯一索引）、超過 30 天的會被清掉", () => {
    const now = Date.now();
    const sale = { pricePerUnit: 777, quantity: 4, timestamp: now - 3_600_000 };
    const first = validateUpload(upload({ capturedAt: now - 100, listings: [], sales: [sale] }), { ...ctx, now });
    assert.ok(first.ok);
    const before = store.countSales();

    assert.equal(applyUpload(store, first.value, now).salesInserted, 1);
    assert.equal(applyUpload(store, first.value, now).salesInserted, 0);
    assert.equal(store.countSales(), before + 1);

    assert.ok(store.pruneOldSales(now + 31 * 86_400_000) >= 1);
  });
});

describe("上傳頻率限制", () => {
  test("同一個 IP 在間隔內連續呼叫會被擋；過了間隔恢復；不同 IP 互不影響", () => {
    let t = 1_000_000;
    const limiter = new UploadRateLimiter(250, () => t);
    assert.equal(limiter.allow("1.2.3.4"), true);
    assert.equal(limiter.allow("1.2.3.4"), false);
    assert.equal(limiter.allow("5.6.7.8"), true);
    t += 249;
    assert.equal(limiter.allow("1.2.3.4"), false);
    t += 1;
    assert.equal(limiter.allow("1.2.3.4"), true);
  });

  test("預設每秒最多 4 次；被擋的請求不會延後下一次允許的時間", () => {
    const t = { now: 1_000_000 };
    const limiter = new UploadRateLimiter(undefined, () => t.now);
    assert.equal(limiter.allow("a"), true);
    t.now += 200;
    assert.equal(limiter.allow("a"), false);
    t.now += 50;
    assert.equal(limiter.allow("a"), true);
  });

  test("很多不同來源 IP 之後，久沒動靜的會被清掉（不會無限成長）", () => {
    let t = 1_000_000;
    const limiter = new UploadRateLimiter(250, () => t);
    for (let i = 0; i < 1000; i++) limiter.allow(`ip-${i}`);
    t += 61_000;
    assert.equal(limiter.allow("fresh"), true);
    assert.equal((limiter as unknown as { lastAllowedAt: Map<string, number> }).lastAllowedAt.size, 1);
  });
});

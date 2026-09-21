import { TW_WORLDS } from "./worlds.js";
import { SALES_RETENTION_MS, type CollectorStore, type StoredListing, type StoredSale } from "./store.js";

// 接收插件上傳的掛單與成交。上傳公開匿名，靠三道檢查擋濫用：
// 物品白名單（data/items.json）、逐項資料檢查、依來源 IP 限流。
/** COMMUNITY_UPLOAD_ENABLED=on 才開放上傳端點。 */
export function isCommunityUploadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMMUNITY_UPLOAD_ENABLED?.trim().toLowerCase() === "on";
}

/** 來源 IP：服務在 Cloudflare Tunnel 後面，優先讀 CF-Connecting-IP，其次 X-Forwarded-For，最後才是連線位址。 */
export function getClientIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const first = (value: string | string[] | undefined): string | undefined => {
    const text = Array.isArray(value) ? value[0] : value;
    return text?.trim() || undefined;
  };

  const cloudflare = first(req.headers["cf-connecting-ip"]);
  if (cloudflare) return cloudflare;

  const forwarded = first(req.headers["x-forwarded-for"])?.split(",")[0]?.trim();
  if (forwarded) return forwarded;

  return req.socket?.remoteAddress || "unknown";
}

export const MAX_LISTINGS_PER_UPLOAD = 100;
export const MAX_SALES_PER_UPLOAD = 50;
export const MAX_UPLOAD_BODY_BYTES = 64 * 1024;
/** 單價上限，跟 Universalis 一致。 */
const MAX_PRICE = 999_999_999;
/** 單筆掛單的數量上限，市場板一格最多 99。 */
export const MAX_QUANTITY = 99;
/** 掃描時間不能早於這麼久，也不能在未來。 */
const MAX_CAPTURE_AGE_MS = 15 * 60_000;
const MAX_CAPTURE_FUTURE_MS = 2 * 60_000;
/** 每個世界每個物品存整份掛單。 */
const STORED_LISTINGS_LIMIT = MAX_LISTINGS_PER_UPLOAD;
const MAX_NAME_LENGTH = 40;
/** 買家名稱最多 6 個字（姓名加起來，不含空白）。 */
export const MAX_BUYER_NAME_CHARS = 6;

export interface UploadListing {
  pricePerUnit: number;
  quantity: number;
  retainerName: string;
  /** 遊戲給的掛單編號，伺服器用它記住這筆掛單第一次被看到的時間。 */
  listingId?: string;
}

export interface UploadSale {
  pricePerUnit: number;
  quantity: number;
  buyerName: string;
  timestamp: number;
}

export interface NormalizedUpload {
  worldId: number;
  itemId: number;
  capturedAt: number;
  listings: UploadListing[];
  sales: UploadSale[];
  /** 被略過的項目數，只給 log 用。 */
  skipped: { staleSales: number; badNameSales: number; badNameListings: number };
}

export type ValidationResult = { ok: true; value: NormalizedUpload } | { ok: false; status: number; error: string };

export interface ValidationContext {
  now: number;
  isAcceptedItem: (itemId: number) => boolean;
}

const WORLD_IDS = new Set(TW_WORLDS.map((world) => world.id));

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

const fail = (error: string, status = 400): ValidationResult => ({ ok: false, status, error });

export function validateUpload(body: unknown, context: ValidationContext): ValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("body must be a JSON object");
  const input = body as Record<string, unknown>;

  if (!isInt(input.worldId, 1, 65535) || !WORLD_IDS.has(input.worldId)) return fail("unknown worldId");
  if (!isInt(input.itemId, 1, 10_000_000)) return fail("invalid itemId");
  if (!context.isAcceptedItem(input.itemId)) return fail("this item does not accept community reports", 422);

  if (!isInt(input.capturedAt, 1, Number.MAX_SAFE_INTEGER)) return fail("invalid capturedAt");
  const age = context.now - input.capturedAt;
  if (age > MAX_CAPTURE_AGE_MS) return fail("capturedAt is too old");
  if (age < -MAX_CAPTURE_FUTURE_MS) return fail("capturedAt is in the future");
  const capturedAt = input.capturedAt;

  const rawListings = input.listings ?? [];
  const rawSales = input.sales ?? [];
  if (!Array.isArray(rawListings) || rawListings.length > MAX_LISTINGS_PER_UPLOAD) return fail("invalid listings");
  if (!Array.isArray(rawSales) || rawSales.length > MAX_SALES_PER_UPLOAD) return fail("invalid sales");

  const skipped = { staleSales: 0, badNameSales: 0, badNameListings: 0 };
  const listings: UploadListing[] = [];
  for (const raw of rawListings as Array<Record<string, unknown>>) {
    if (typeof raw !== "object" || raw === null) return fail("invalid listing");
    if (!isInt(raw.pricePerUnit, 1, MAX_PRICE)) return fail("invalid listing price");
    if (!isInt(raw.quantity, 1, MAX_QUANTITY)) return fail("invalid listing quantity");

    // 掛單編號是 64 位元整數，用十進位字串傳
    let listingId: string | undefined;
    if (raw.listingId !== undefined && raw.listingId !== null) {
      if (typeof raw.listingId !== "string" || !/^\d{1,20}$/.test(raw.listingId)) return fail("invalid listingId");
      listingId = raw.listingId;
    }

    const retainerName = typeof raw.retainerName === "string" ? raw.retainerName.slice(0, MAX_NAME_LENGTH) : "-";
    // 雇員名稱含角括號就略過這一筆
    if (/[<>]/.test(retainerName)) {
      skipped.badNameListings++;
      continue;
    }

    listings.push({
      pricePerUnit: raw.pricePerUnit,
      quantity: raw.quantity,
      retainerName,
      listingId,
    });
  }

  const sales: UploadSale[] = [];
  for (const raw of rawSales as Array<Record<string, unknown>>) {
    if (typeof raw !== "object" || raw === null) return fail("invalid sale");
    if (!isInt(raw.pricePerUnit, 1, MAX_PRICE)) return fail("invalid sale price");
    if (!isInt(raw.quantity, 1, MAX_QUANTITY)) return fail("invalid sale quantity");
    if (!isInt(raw.timestamp, 1, Number.MAX_SAFE_INTEGER)) return fail("invalid sale timestamp");
    if (raw.timestamp > capturedAt + MAX_CAPTURE_FUTURE_MS) return fail("sale timestamp is in the future");
    const buyerName = typeof raw.buyerName === "string" ? raw.buyerName.trim() : "";
    if (context.now - raw.timestamp > SALES_RETENTION_MS) {
      skipped.staleSales++;
      continue;
    }
    // 名稱不合理的成交略過（不截斷，免得存到錯的名字）
    if (Array.from(buyerName.replace(/\s/g, "")).length > MAX_BUYER_NAME_CHARS || /[<>]/.test(buyerName)) {
      skipped.badNameSales++;
      continue;
    }

    sales.push({ pricePerUnit: raw.pricePerUnit, quantity: raw.quantity, buyerName, timestamp: raw.timestamp });
  }

  return { ok: true, value: { worldId: input.worldId, itemId: input.itemId, capturedAt, listings, sales, skipped } };
}

/** 這次上傳造成的變動，給即時推播用。 */
export interface UploadChanges {
  worldId: number;
  itemId: number;
  addedListings: StoredListing[];
  removedListings: StoredListing[];
  newSales: StoredSale[];
}

export interface ApplyResult {
  listingsStored: number;
  salesInserted: number;
  /** 已有更新的掃描，這次的掛單沒寫入。 */
  listingsIgnored?: boolean;
  changes: UploadChanges;
}

export function listingKey(listing: StoredListing): string {
  return listing.listingId ? "id:" + listing.listingId : ["c", listing.pricePerUnit, listing.quantity, listing.retainerName].join("|");
}

/** 寫入資料庫。掛單整份取代，空清單代表掃描時沒人在賣。 */
export function applyUpload(store: CollectorStore, upload: NormalizedUpload, now: number = Date.now()): ApplyResult {
  // 用掛單編號記住每筆掛單第一次被看到的時間
  const existing = store.getEntry(upload.worldId, upload.itemId);

  // 較舊的掃描不能蓋掉較新的，成交仍照收
  const listingsIgnored = existing !== undefined && existing.uploadedAt > upload.capturedAt;

  const firstSeen = new Map<string, number>();
  for (const previous of existing?.listings ?? []) {
    if (previous.listingId) firstSeen.set(previous.listingId, previous.firstSeenAt);
  }

  const stored: StoredListing[] = upload.listings
    .map((listing) => {
      const entry: StoredListing = {
        pricePerUnit: listing.pricePerUnit,
        quantity: listing.quantity,
        total: listing.pricePerUnit * listing.quantity,
        retainerName: listing.retainerName,
        firstSeenAt: Math.min(upload.capturedAt, (listing.listingId && firstSeen.get(listing.listingId)) || upload.capturedAt),
      };
      if (listing.listingId) entry.listingId = listing.listingId;
      return entry;
    })
    .sort((x, y) => x.pricePerUnit - y.pricePerUnit)
    .slice(0, STORED_LISTINGS_LIMIT);

  if (!listingsIgnored) store.setEntry(upload.worldId, upload.itemId, stored, upload.capturedAt);

  let addedListings: StoredListing[] = [];
  let removedListings: StoredListing[] = [];
  if (!listingsIgnored) {
    const before = new Set((existing?.listings ?? []).map(listingKey));
    const after = new Set(stored.map(listingKey));
    addedListings = stored.filter((listing) => !before.has(listingKey(listing)));
    removedListings = (existing?.listings ?? []).filter((listing) => !after.has(listingKey(listing)));
  }

  const sales: StoredSale[] = upload.sales.map((sale) => ({
    pricePerUnit: sale.pricePerUnit,
    quantity: sale.quantity,
    buyerName: sale.buyerName,
    saleTimestamp: sale.timestamp,
  }));
  const newSales = sales.length > 0 ? store.insertSales(upload.worldId, upload.itemId, sales, now, now) : [];
  const salesInserted = newSales.length;
  const changes: UploadChanges = { worldId: upload.worldId, itemId: upload.itemId, addedListings, removedListings, newSales };

  return listingsIgnored
    ? { listingsStored: 0, salesInserted, listingsIgnored, changes }
    : { listingsStored: stored.length, salesInserted, changes };
}

/** 每個來源 IP 每秒最多 4 次上傳（距上次被允許不到 250ms 就拒絕）。 */
export class UploadRateLimiter {
  private lastAllowedAt = new Map<string, number>();

  constructor(
    private readonly minIntervalMs = 250,
    private readonly now: () => number = Date.now,
  ) {}

  allow(ip: string): boolean {
    const current = this.now();
    const last = this.lastAllowedAt.get(ip);
    if (last !== undefined && current - last < this.minIntervalMs) return false;

    this.lastAllowedAt.set(ip, current);
    this.prune(current);
    return true;
  }

  private prune(current: number): void {
    if (this.lastAllowedAt.size < 1000) return;
    for (const [ip, at] of this.lastAllowedAt) {
      if (current - at > 60_000) this.lastAllowedAt.delete(ip);
    }
  }
}

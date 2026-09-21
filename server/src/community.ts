import { TW_WORLDS } from "./worlds.js";
import { SALES_RETENTION_MS, type CollectorStore, type StoredListing, type StoredSale } from "./store.js";

// 社群回報：繁中服可交易、但 Universalis 沒有價格資料的物品（例如 7.5 整併前的舊染劑）
// 沒有任何官方來源，價格只能靠玩家在遊戲裡掃描市場板、用外掛回報。
//
// 上傳是公開匿名的（跟 Universalis 自己的上傳器同一種模型）：不驗證身份，靠三道防線擋濫用——
//   1. 只接受物品白名單（data/items.json）裡的物品：Universalis 有資料的物品絕對不會被社群回報覆蓋。
//   2. 逐項檢查資料合理性（世界、價格、數量、掃描時間窗、單次筆數、自由文字欄位），單筆爛資料略過或整批拒絕。
//   3. 依來源 IP 限流（UploadRateLimiter），外掛出錯或有人狂送時不會打爆資料庫。
/** 公開上傳端點的總開關：環境變數 COMMUNITY_UPLOAD_ENABLED=on 才開，沒設或其他值＝端點不存在（回 404）。 */
export function isCommunityUploadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMMUNITY_UPLOAD_ENABLED?.trim().toLowerCase() === "on";
}

/**
 * 取得請求的來源 IP，給限流用。服務只綁 127.0.0.1、由 Cloudflare Tunnel 轉進來，
 * TCP 層看到的永遠是本機，所以優先讀 Cloudflare 加的 CF-Connecting-IP；本機測試或直連時退回
 * X-Forwarded-For 第一段，最後才是連線位址。
 */
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
/** 跟 Universalis 上傳檢查用的單價上限一致。 */
const MAX_PRICE = 999_999_999;
/**
 * 單筆數量上限。Universalis 用「該物品實際疊加上限」；我們只收固定的舊染劑，
 * 使用者確認單一掛單（一個雇員賣的一格）數量最大 99，超過的一定是假資料。
 */
export const MAX_QUANTITY = 99;
/** 掃描時間不能比現在早超過這麼久（外掛是掃描當下就上傳），也不能在未來。 */
const MAX_CAPTURE_AGE_MS = 15 * 60_000;
const MAX_CAPTURE_FUTURE_MS = 2 * 60_000;
/** 每個世界每個物品存整份掛單（上限同單次上傳）：統計與資料中心合併都需要完整清單。 */
const STORED_LISTINGS_LIMIT = MAX_LISTINGS_PER_UPLOAD;
/** 雇員名稱的長度上限（遊戲內雇員名稱遠短於這個數字）。 */
const MAX_NAME_LENGTH = 40;
/** 買家（角色）名稱：繁中服的姓與名加起來最多 6 個字（不含中間的空白）。 */
export const MAX_BUYER_NAME_CHARS = 6;

export interface UploadListing {
  pricePerUnit: number;
  quantity: number;
  retainerName: string;
  /**
   * 遊戲給這筆掛單的唯一編號。封包裡沒有真正的上架時間，伺服器用它記住「第一次被看到的時間」：
   * 同一個編號再次掃描到，時間維持不變；新的編號用這次掃描時間。沒帶編號的就一律用掃描時間。
   */
  listingId?: string;
}

export interface UploadSale {
  pricePerUnit: number;
  quantity: number;
  /** 買家名稱（市場板成交紀錄上本來就公開顯示的角色名稱）；沒有就是空字串。 */
  buyerName: string;
  /** 毫秒 */
  timestamp: number;
}

export interface NormalizedUpload {
  worldId: number;
  itemId: number;
  capturedAt: number;
  listings: UploadListing[];
  sales: UploadSale[];
  /** 被略過（沒有整包拒絕）的項目數，只給 log 診斷用。 */
  skipped: { staleSales: number; badNameSales: number; badNameListings: number };
}

export type ValidationResult = { ok: true; value: NormalizedUpload } | { ok: false; status: number; error: string };

export interface ValidationContext {
  now: number;
  /** 這個物品在不在白名單裡（只有白名單內的物品才接受社群回報）。 */
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

    // 遊戲給的掛單編號是 64 位元整數，JSON 數字會失真，所以一律用十進位字串傳。
    let listingId: string | undefined;
    if (raw.listingId !== undefined && raw.listingId !== null) {
      if (typeof raw.listingId !== "string" || !/^\d{1,20}$/.test(raw.listingId)) return fail("invalid listingId");
      listingId = raw.listingId;
    }

    const retainerName = typeof raw.retainerName === "string" ? raw.retainerName.slice(0, MAX_NAME_LENGTH) : "-";
    // 雇員名稱是遊戲內的自由文字，正常不會有角括號；Universalis 遇到 HTML 標籤會拒絕上傳。
    // 這裡沿用「單筆略過、不整包打回」的作法（跟太舊的成交一樣），不影響同一批其他合法資料。
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
      skipped.staleSales++; // 太舊的成交不收（會被清掉），略過而不是整筆拒絕
      continue;
    }
    // 名稱不合理（超過 6 個字，或像 HTML 標籤）的成交整筆略過，不影響同一批其他合法資料；不截斷，避免存進錯的名字。
    if (Array.from(buyerName.replace(/\s/g, "")).length > MAX_BUYER_NAME_CHARS || /[<>]/.test(buyerName)) {
      skipped.badNameSales++;
      continue;
    }

    sales.push({ pricePerUnit: raw.pricePerUnit, quantity: raw.quantity, buyerName, timestamp: raw.timestamp });
  }

  return { ok: true, value: { worldId: input.worldId, itemId: input.itemId, capturedAt, listings, sales, skipped } };
}

/** 這次上傳造成的變動，給即時推播用（不是上傳者要看的內容）。 */
export interface UploadChanges {
  worldId: number;
  itemId: number;
  /** 新出現的掛單（以掛單編號比對；沒有編號的用價格＋數量＋雇員）。 */
  addedListings: StoredListing[];
  /** 這次掃描已經不在的掛單。 */
  removedListings: StoredListing[];
  /** 真的新寫入的成交。 */
  newSales: StoredSale[];
}

export interface ApplyResult {
  listingsStored: number;
  salesInserted: number;
  /** 已經有比這次擷取更新的掛單資料（別的上傳者、或這份上傳是延遲送達的舊資料），這次的掛單沒有寫入。 */
  listingsIgnored?: boolean;
  changes: UploadChanges;
}

/** 比對新舊掛單用的鍵：有掛單編號就用編號，否則用內容。 */
export function listingKey(listing: StoredListing): string {
  return listing.listingId ? "id:" + listing.listingId : ["c", listing.pricePerUnit, listing.quantity, listing.retainerName].join("|");
}

/**
 * 寫入資料庫。掛單整份取代這個世界這個物品目前的內容（外掛送的是掃描當下的完整清單）；
 * 空清單也照寫，代表「掃描時沒有人在賣」。
 */
export function applyUpload(store: CollectorStore, upload: NormalizedUpload, now: number = Date.now()): ApplyResult {
  // 封包裡沒有真正的上架時間（Universalis 自己的上傳器也是填「現在」）。做法：記住每筆掛單「第一次被
  // 看到的時間」，用遊戲給的掛單編號比對。同一筆再被掃描到，時間維持不變；新的編號用這次掃描時間。
  const existing = store.getEntry(upload.worldId, upload.itemId);

  // 多人上傳時，較舊的擷取不能蓋掉較新的（延遲送達、或兩個人先後掃同一個物品）。成交紀錄仍照收，
  // 那是歷史資料，重複的會被唯一索引擋掉。
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

  // 新舊掛單的差異（較舊的擷取被忽略時沒有變動）。
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
  // 重複上傳會被唯一索引擋掉（買家名稱也是索引的一部分，沒有名稱存空字串）。
  const newSales = sales.length > 0 ? store.insertSales(upload.worldId, upload.itemId, sales, now, now) : [];
  const salesInserted = newSales.length;
  const changes: UploadChanges = { worldId: upload.worldId, itemId: upload.itemId, addedListings, removedListings, newSales };

  return listingsIgnored
    ? { listingsStored: 0, salesInserted, listingsIgnored, changes }
    : { listingsStored: stored.length, salesInserted, changes };
}

/**
 * 每個來源 IP 每秒最多 4 次上傳（間隔限流：距離該 IP 上次被允許不到 250ms 就拒絕，呼叫端回 429）。
 * 手動點市場板不可能這麼快，外掛出錯或有人狂送則會被擋；只記每個 IP 上次被允許的時間，記憶體很小。
 */
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

  /** 超過一分鐘沒動靜的 IP 不需要再記，避免 Map 無限成長（公開端點會看到各種來源）。 */
  private prune(current: number): void {
    if (this.lastAllowedAt.size < 1000) return;
    for (const [ip, at] of this.lastAllowedAt) {
      if (current - at > 60_000) this.lastAllowedAt.delete(ip);
    }
  }
}

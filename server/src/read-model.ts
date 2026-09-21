import { TW_WORLDS } from "./worlds.js";
import type { StoredEntry, StoredListing, StoredSale } from "./store.js";

// 把資料庫裡的資料轉成 Universalis v2 的回應格式（欄位名與結構相同，時間一律 UTC 毫秒）。
// 全部是純函式，不碰 HTTP 也不碰資料庫，方便逐項測試。

export const DC_NAME = "陸行鳥";
export const DC_REGION = "繁中服";
export const DAY_MS = 86_400_000;
export const DEFAULT_STATS_WITHIN_MS = 7 * DAY_MS;
/** 成交只保留 30 天，所以統計與歷史的時間窗上限也是 30 天。 */
export const MAX_WINDOW_MS = 30 * DAY_MS;

export type Json = Record<string, unknown>;

export interface WorldRef {
  id: number;
  name: string;
}

export type WorldTarget =
  | { kind: "world"; world: WorldRef }
  | { kind: "dc"; name: string; worlds: WorldRef[] };

/** 網址裡的 {world}：世界編號、世界名稱，或資料中心名稱。認不得回 null。 */
export function resolveWorld(param: string): WorldTarget | null {
  const trimmed = param.trim();
  if (trimmed === DC_NAME) return { kind: "dc", name: DC_NAME, worlds: TW_WORLDS.map((world) => ({ id: world.id, name: world.name })) };

  const byId = /^\d+$/.test(trimmed) ? TW_WORLDS.find((world) => world.id === Number(trimmed)) : undefined;
  const found = byId ?? TW_WORLDS.find((world) => world.name === trimmed);
  return found ? { kind: "world", world: { id: found.id, name: found.name } } : null;
}

// ---------- 掛單與成交的格式 ----------

/** Universalis 的掛單物件。我們沒有收集的欄位保留鍵、給中性值（見 README）。 */
export function formatListing(listing: StoredListing, world?: WorldRef): Json {
  const out: Json = {
    lastReviewTime: listing.firstSeenAt,
    pricePerUnit: listing.pricePerUnit,
    quantity: listing.quantity,
    stainID: 0,
  };
  if (world) {
    out.worldName = world.name;
    out.worldID = world.id;
  }
  return Object.assign(out, {
    creatorName: "",
    creatorID: null,
    hq: false,
    isCrafted: false,
    listingID: listing.listingId ?? null,
    materia: [],
    onMannequin: false,
    retainerCity: null,
    retainerID: null,
    retainerName: listing.retainerName,
    sellerID: null,
    total: listing.total,
    tax: null,
  });
}

/** 目前資料裡的 recentHistory 項目（帶 total）。 */
export function formatRecentSale(sale: StoredSale, world?: WorldRef): Json {
  const out: Json = {
    hq: false,
    pricePerUnit: sale.pricePerUnit,
    quantity: sale.quantity,
    timestamp: sale.saleTimestamp,
    onMannequin: false,
  };
  if (world) {
    out.worldName = world.name;
    out.worldID = world.id;
  }
  out.buyerName = sale.buyerName;
  out.total = sale.pricePerUnit * sale.quantity;
  return out;
}

/** /history 端點的 entries 項目（Universalis 這裡沒有 total，欄位順序也不同）。 */
export function formatHistoryEntry(sale: StoredSale, world?: WorldRef): Json {
  const out: Json = {
    hq: false,
    pricePerUnit: sale.pricePerUnit,
    quantity: sale.quantity,
    buyerName: sale.buyerName,
    onMannequin: false,
    timestamp: sale.saleTimestamp,
  };
  if (world) {
    out.worldName = world.name;
    out.worldID = world.id;
  }
  return out;
}

// ---------- 統計 ----------

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function histogram(quantities: number[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const quantity of quantities) counts[String(quantity)] = (counts[String(quantity)] ?? 0) + 1;
  return counts;
}

export interface StatsResult {
  /** 依 Universalis 的欄位順序排好，可直接展開進回應。 */
  fields: Json;
  listingsCount: number;
  recentHistoryCount: number;
  unitsForSale: number;
  unitsSold: number;
}

/**
 * 統計。listings 是目前的掛單（已篩過 HQ）、sales 是統計時間窗內的成交（已篩過 HQ）。
 * 染劑沒有 HQ，所以所有物品都算 NQ，HQ 的數字都是 0／空。
 *   min／max／currentAverage：目前掛單單價的最小／最大／平均
 *   averagePrice：時間窗內成交單價的平均
 *   *SaleVelocity：時間窗內賣出的數量 ÷ 時間窗的天數
 *   unitsForSale／unitsSold：掛單／成交的數量總和；stackSizeHistogram：{每筆的數量: 出現次數}
 */
export function computeStats(listings: StoredListing[], sales: StoredSale[], statsWithinMs: number): StatsResult {
  const listingPrices = listings.map((listing) => listing.pricePerUnit);
  const salePrices = sales.map((sale) => sale.pricePerUnit);
  const unitsSold = sales.reduce((sum, sale) => sum + sale.quantity, 0);
  const velocity = statsWithinMs > 0 ? unitsSold / (statsWithinMs / DAY_MS) : 0;
  const current = mean(listingPrices);
  const average = mean(salePrices);
  const min = listingPrices.length > 0 ? Math.min(...listingPrices) : 0;
  const max = listingPrices.length > 0 ? Math.max(...listingPrices) : 0;
  const stacks = histogram(listings.map((listing) => listing.quantity));

  return {
    fields: {
      currentAveragePrice: current,
      currentAveragePriceNQ: current,
      currentAveragePriceHQ: 0,
      regularSaleVelocity: velocity,
      nqSaleVelocity: velocity,
      hqSaleVelocity: 0,
      averagePrice: average,
      averagePriceNQ: average,
      averagePriceHQ: 0,
      minPrice: min,
      minPriceNQ: min,
      minPriceHQ: 0,
      maxPrice: max,
      maxPriceNQ: max,
      maxPriceHQ: 0,
      stackSizeHistogram: stacks,
      stackSizeHistogramNQ: stacks,
      stackSizeHistogramHQ: {},
    },
    listingsCount: listings.length,
    recentHistoryCount: sales.length,
    unitsForSale: listings.reduce((sum, listing) => sum + listing.quantity, 0),
    unitsSold,
  };
}

// ---------- 一個世界／整個資料中心的資料 ----------

export interface WorldData {
  world: WorldRef;
  entry: StoredEntry | undefined;
  /** 這個世界這個物品的成交，新到舊（最多保留期內）。 */
  sales: StoredSale[];
}

export interface ViewOptions {
  /** 回傳幾筆掛單，undefined＝全部。 */
  listings?: number;
  /** 回傳幾筆成交。 */
  entries: number;
  /** true＝只要 HQ、false＝只要 NQ、undefined＝不篩。 */
  hq?: boolean;
  statsWithinMs: number;
  entriesWithinMs?: number;
}

function hasHqFilterMismatch(hq: boolean | undefined): boolean {
  // 我們的資料全是 NQ：hq=true 什麼都沒有
  return hq === true;
}

function collect(data: WorldData[], options: ViewOptions, now: number) {
  const noMatch = hasHqFilterMismatch(options.hq);
  const listings: Array<{ listing: StoredListing; world: WorldRef }> = [];
  const sales: Array<{ sale: StoredSale; world: WorldRef }> = [];
  for (const item of data) {
    if (noMatch) continue;
    for (const listing of item.entry?.listings ?? []) listings.push({ listing, world: item.world });
    for (const sale of item.sales) sales.push({ sale, world: item.world });
  }
  listings.sort((a, b) => a.listing.pricePerUnit - b.listing.pricePerUnit);
  sales.sort((a, b) => b.sale.saleTimestamp - a.sale.saleTimestamp);

  const statsCutoff = now - options.statsWithinMs;
  const entriesCutoff = options.entriesWithinMs === undefined ? 0 : now - options.entriesWithinMs;
  return {
    listings,
    sales,
    statsSales: sales.filter(({ sale }) => sale.saleTimestamp >= statsCutoff),
    entrySales: sales.filter(({ sale }) => sale.saleTimestamp >= entriesCutoff),
  };
}

function lastUpload(data: WorldData[]): number {
  return data.reduce((latest, item) => Math.max(latest, item.entry?.uploadedAt ?? 0), 0);
}

/** 單一世界、單一物品的目前資料（Universalis 的 /api/v2/{world}/{item}）。 */
export function buildWorldItem(itemId: number, data: WorldData, options: ViewOptions, now: number): Json {
  const { listings, sales, statsSales, entrySales } = collect([data], options, now);
  const stats = computeStats(listings.map((row) => row.listing), statsSales.map((row) => row.sale), options.statsWithinMs);
  const shownListings = options.listings === undefined ? listings : listings.slice(0, options.listings);

  return {
    itemID: itemId,
    worldID: data.world.id,
    lastUploadTime: data.entry?.uploadedAt ?? 0,
    listings: shownListings.map((row) => formatListing(row.listing)),
    recentHistory: entrySales.slice(0, options.entries).map((row) => formatRecentSale(row.sale)),
    ...stats.fields,
    worldName: data.world.name,
    listingsCount: stats.listingsCount,
    recentHistoryCount: stats.recentHistoryCount,
    unitsForSale: stats.unitsForSale,
    unitsSold: stats.unitsSold,
    hasData: data.entry !== undefined || sales.length > 0,
  };
}

/** 整個資料中心（所有世界合併）的目前資料；每筆掛單與成交都帶 worldID／worldName。 */
export function buildDcItem(itemId: number, dcName: string, data: WorldData[], options: ViewOptions, now: number): Json {
  const { listings, sales, statsSales, entrySales } = collect(data, options, now);
  const stats = computeStats(listings.map((row) => row.listing), statsSales.map((row) => row.sale), options.statsWithinMs);
  const shownListings = options.listings === undefined ? listings : listings.slice(0, options.listings);
  const uploadTimes: Record<string, number> = {};
  for (const item of data) if (item.entry) uploadTimes[String(item.world.id)] = item.entry.uploadedAt;

  return {
    itemID: itemId,
    lastUploadTime: lastUpload(data),
    listings: shownListings.map((row) => formatListing(row.listing, row.world)),
    recentHistory: entrySales.slice(0, options.entries).map((row) => formatRecentSale(row.sale, row.world)),
    dcName,
    ...stats.fields,
    worldUploadTimes: uploadTimes,
    listingsCount: stats.listingsCount,
    recentHistoryCount: stats.recentHistoryCount,
    unitsForSale: stats.unitsForSale,
    unitsSold: stats.unitsSold,
    hasData: data.some((item) => item.entry !== undefined) || sales.length > 0,
  };
}

export interface HistoryOptions {
  entries: number;
  statsWithinMs: number;
  entriesWithinMs?: number;
  minSalePrice?: number;
  maxSalePrice?: number;
}

/** 成交歷史（Universalis 的 /api/v2/history/{world}/{item}）；world 為 undefined 時是資料中心版。 */
export function buildHistory(itemId: number, target: WorldTarget, data: WorldData[], options: HistoryOptions, now: number): Json {
  const withinPrice = (sale: StoredSale) =>
    (options.minSalePrice === undefined || sale.pricePerUnit >= options.minSalePrice) &&
    (options.maxSalePrice === undefined || sale.pricePerUnit <= options.maxSalePrice);
  const rows: Array<{ sale: StoredSale; world: WorldRef }> = [];
  for (const item of data) for (const sale of item.sales) if (withinPrice(sale)) rows.push({ sale, world: item.world });
  rows.sort((a, b) => b.sale.saleTimestamp - a.sale.saleTimestamp);

  const entriesCutoff = options.entriesWithinMs === undefined ? 0 : now - options.entriesWithinMs;
  const statsCutoff = now - options.statsWithinMs;
  const shown = rows.filter((row) => row.sale.saleTimestamp >= entriesCutoff).slice(0, options.entries);
  const inWindow = rows.filter((row) => row.sale.saleTimestamp >= statsCutoff).map((row) => row.sale);
  const unitsSold = inWindow.reduce((sum, sale) => sum + sale.quantity, 0);
  const velocity = options.statsWithinMs > 0 ? unitsSold / (options.statsWithinMs / DAY_MS) : 0;
  const stacks = histogram(inWindow.map((sale) => sale.quantity));
  const common = {
    stackSizeHistogram: stacks,
    stackSizeHistogramNQ: stacks,
    stackSizeHistogramHQ: {},
    regularSaleVelocity: velocity,
    nqSaleVelocity: velocity,
    hqSaleVelocity: 0,
  };

  if (target.kind === "world") {
    return {
      itemID: itemId,
      worldID: target.world.id,
      lastUploadTime: lastUpload(data),
      entries: shown.map((row) => formatHistoryEntry(row.sale)),
      ...common,
      worldName: target.world.name,
    };
  }

  const uploadTimes: Record<string, number> = {};
  for (const item of data) if (item.entry) uploadTimes[String(item.world.id)] = item.entry.uploadedAt;
  return {
    itemID: itemId,
    lastUploadTime: lastUpload(data),
    entries: shown.map((row) => formatHistoryEntry(row.sale, row.world)),
    dcName: target.name,
    ...common,
    worldUploadTimes: uploadTimes,
  };
}

// ---------- fields 欄位投影（Universalis 的 ?fields=a.b,c） ----------

/** 解析 fields 參數成「路徑陣列」。空字串或全空白回 null（＝不投影）。 */
export function parseFields(param: string | null): string[][] | null {
  if (param === null) return null;
  const paths = param
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => path.split(".").map((segment) => segment.trim()));
  if (paths.length === 0) return null;
  if (paths.some((segments) => segments.some((segment) => segment.length === 0))) return null;
  return paths;
}

/**
 * 依路徑挑出欄位。遇到陣列就對每個元素套用；`items` 是「物品編號 → 物品資料」的字典，
 * 路徑 `items.listings.pricePerUnit` 表示對字典裡每個物品取 listings.pricePerUnit。
 */
export function projectFields(source: unknown, paths: string[][]): unknown {
  if (Array.isArray(source)) return source.map((element) => projectFields(element, paths));
  if (source === null || typeof source !== "object") return source;

  const groups = new Map<string, string[][]>();
  for (const [head, ...rest] of paths) {
    const list = groups.get(head) ?? [];
    list.push(rest);
    groups.set(head, list);
  }

  const record = source as Json;
  const out: Json = {};
  for (const [key, rests] of groups) {
    if (!(key in record)) continue;
    const value = record[key];
    if (rests.some((rest) => rest.length === 0)) {
      out[key] = value; // 整個子樹都要
    } else if (key === "items" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value as Json).map(([id, item]) => [id, projectFields(item, rests)]));
    } else {
      out[key] = projectFields(value, rests);
    }
  }
  return out;
}

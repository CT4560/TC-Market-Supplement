import { TW_WORLDS } from "./worlds.js";
import type { StoredEntry, StoredListing, StoredSale } from "./store.js";

// 把資料轉成 Universalis v2 的回應格式（時間為 UTC 毫秒）。純函式，不碰 HTTP 與資料庫。

export const DC_NAME = "陸行鳥";
export const DC_REGION = "繁中服";
export const DAY_MS = 86_400_000;
export const DEFAULT_STATS_WITHIN_MS = 7 * DAY_MS;
/** API 查詢的時間窗上限。資料庫保留一年的成交，API 目前只開放最近 30 天。 */
export const MAX_WINDOW_MS = 30 * DAY_MS;

export type Json = Record<string, unknown>;

export interface WorldRef {
  id: number;
  name: string;
}

export type WorldTarget =
  | { kind: "world"; world: WorldRef }
  | { kind: "dc"; name: string; worlds: WorldRef[] };

export function resolveWorld(param: string): WorldTarget | null {
  const trimmed = param.trim();
  if (trimmed === DC_NAME) return { kind: "dc", name: DC_NAME, worlds: TW_WORLDS.map((world) => ({ id: world.id, name: world.name })) };

  const byId = /^\d+$/.test(trimmed) ? TW_WORLDS.find((world) => world.id === Number(trimmed)) : undefined;
  const found = byId ?? TW_WORLDS.find((world) => world.name === trimmed);
  return found ? { kind: "world", world: { id: found.id, name: found.name } } : null;
}

// ---------- 掛單與成交的格式 ----------

/** 掛單物件。沒收集的欄位保留鍵並給中性值。 */
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
  fields: Json;
  listingsCount: number;
  recentHistoryCount: number;
  unitsForSale: number;
  unitsSold: number;
}

/**
 * 統計：min／max／currentAverage 看目前掛單，averagePrice 與 SaleVelocity 看時間窗內的成交。
 * 染劑沒有 HQ，所以 HQ 的數字都是 0 或空。
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
  sales: StoredSale[];
}

export interface ViewOptions {
  listings?: number;
  entries: number;
  /** true 只要 HQ、false 只要 NQ、不給就不篩。 */
  hq?: boolean;
  statsWithinMs: number;
  entriesWithinMs?: number;
}

function hasHqFilterMismatch(hq: boolean | undefined): boolean {
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

/** 依路徑挑出欄位；遇到陣列逐一套用，items 是物品編號到資料的字典，路徑會套用到每個物品。 */
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
      out[key] = value;
    } else if (key === "items" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value as Json).map(([id, item]) => [id, projectFields(item, rests)]));
    } else {
      out[key] = projectFields(value, rests);
    }
  }
  return out;
}

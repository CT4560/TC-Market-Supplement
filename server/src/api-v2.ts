import type http from "node:http";
import { randomUUID } from "node:crypto";
import { TW_WORLDS } from "./worlds.js";
import type { CollectorStore } from "./store.js";
import type { TokenBucketLimiter } from "./rate-limit.js";
import {
  DC_NAME,
  DC_REGION,
  DEFAULT_STATS_WITHIN_MS,
  MAX_WINDOW_MS,
  buildDcItem,
  buildHistory,
  buildWorldItem,
  parseFields,
  projectFields,
  resolveWorld,
  type Json,
  type ViewOptions,
  type WorldData,
  type WorldRef,
  type WorldTarget,
} from "./read-model.js";

// 公開讀取 API，路徑與欄位相容 Universalis v2，時間一律是 UTC 毫秒。不需要金鑰，靠每個 IP 的限流擋濫用。

/** 讀取 API 的限流：每個 IP 每秒補 20 個名額、最多 40 個。 */
export const API_RATE_PER_SECOND = 20;
export const API_RATE_BURST = 40;

/** 單次請求最多的物品數（＝白名單物品數）。 */
export const MAX_ITEMS_PER_REQUEST = 112;
/** 每 10 個物品算一次名額，查全部 112 個算 12 次。 */
export const ITEMS_PER_TOKEN = 10;

export function requestCost(itemCount: number): number {
  return Math.max(1, Math.ceil(itemCount / ITEMS_PER_TOKEN));
}
export const MAX_ENTRIES = 1800;
export const DEFAULT_RECENT_ENTRIES = 5;
const DEFAULT_MOST_RECENT = 50;
const MAX_MOST_RECENT = 200;
const CACHE_CONTROL = "public, max-age=10";

export interface ApiContext {
  store: CollectorStore;
  limiter: TokenBucketLimiter;
  now: () => number;
}

/** COMMUNITY_API_ENABLED=on 才開放讀取端。 */
export function isCommunityApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMMUNITY_API_ENABLED?.trim().toLowerCase() === "on";
}

export function isApiV2Path(pathname: string): boolean {
  return pathname === "/api/v2" || pathname.startsWith("/api/v2/");
}

const PROBLEM_TYPES: Record<number, string> = {
  400: "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  404: "https://tools.ietf.org/html/rfc9110#section-15.5.5",
  405: "https://tools.ietf.org/html/rfc9110#section-15.5.6",
  429: "https://tools.ietf.org/html/rfc6585#section-4",
};

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "Retry-After",
  };
}

function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(),
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function problem(res: http.ServerResponse, status: number, title: string, detail?: string, extra: Record<string, string> = {}): void {
  const body: Json = { type: PROBLEM_TYPES[status] ?? "about:blank", title, status };
  if (detail) body.detail = detail;
  body.traceId = randomUUID();
  send(res, status, body, { "cache-control": "no-store", ...extra });
}

type ParsedInt = { ok: true; value: number | undefined } | { ok: false };

function intParam(params: URLSearchParams, name: string, min: number, max: number): ParsedInt {
  const raw = params.get(name);
  if (raw === null || raw === "") return { ok: true, value: undefined };
  if (!/^\d+$/.test(raw)) return { ok: false };
  const value = Number(raw);
  return value >= min && value <= max ? { ok: true, value } : { ok: false };
}

function parseItemIds(param: string): number[] | null {
  const parts = param.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > MAX_ITEMS_PER_REQUEST) return null;
  if (!parts.every((part) => /^\d{1,9}$/.test(part))) return null;
  return [...new Set(parts.map(Number))];
}

function wrapItems(target: WorldTarget, itemIds: number[], unresolved: number[], items: Record<string, Json>): Json {
  return target.kind === "world"
    ? { itemIDs: itemIds, items, worldID: target.world.id, unresolvedItems: unresolved, worldName: target.world.name }
    : { itemIDs: itemIds, items, dcName: target.name, unresolvedItems: unresolved };
}

type FieldsResult = { ok: true; paths: string[][] | null } | { ok: false };

function readFields(params: URLSearchParams): FieldsResult {
  if (!params.has("fields")) return { ok: true, paths: null };
  const paths = parseFields(params.get("fields"));
  return paths === null && params.get("fields")?.trim() ? { ok: false } : { ok: true, paths };
}

function loadWorld(store: CollectorStore, itemId: number, world: WorldRef, now: number, entriesLimit: number): WorldData {
  return {
    world,
    entry: store.getEntry(world.id, itemId),
    sales: store.getSales(world.id, itemId, { sinceMs: now - MAX_WINDOW_MS, limit: Math.max(entriesLimit, MAX_ENTRIES) }),
  };
}

function worldsOf(target: WorldTarget): WorldRef[] {
  return target.kind === "world" ? [target.world] : target.worlds;
}

export function handleApiV2(req: http.IncomingMessage, res: http.ServerResponse, url: URL, clientIp: string, ctx: ApiContext): void {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...corsHeaders(), "access-control-max-age": "86400" });
    res.end();
    return;
  }

  const taken = ctx.limiter.take(clientIp);
  if (!taken.allowed) return tooManyRequests(res, taken.retryAfterMs);

  if (req.method !== "GET" && req.method !== "HEAD") {
    problem(res, 405, "Method Not Allowed", undefined, { allow: "GET, HEAD, OPTIONS" });
    return;
  }

  let segments: string[];
  try {
    segments = url.pathname
      .slice("/api/v2".length)
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    problem(res, 400, "Bad Request", "Malformed URL encoding.");
    return;
  }

  const now = ctx.now();

  if (segments.length === 1 && segments[0] === "worlds") {
    send(res, 200, TW_WORLDS.map((world) => ({ id: world.id, name: world.name })), { "cache-control": CACHE_CONTROL });
    return;
  }
  if (segments.length === 1 && segments[0] === "data-centers") {
    send(res, 200, [{ name: DC_NAME, region: DC_REGION, worlds: TW_WORLDS.map((world) => world.id) }], { "cache-control": CACHE_CONTROL });
    return;
  }
  if (segments.length === 1 && segments[0] === "marketable") {
    send(res, 200, ctx.store.itemIds(), { "cache-control": CACHE_CONTROL });
    return;
  }
  if (segments.length === 3 && segments[0] === "extra" && segments[1] === "stats" && segments[2] === "most-recently-updated") {
    handleMostRecent(res, url, ctx);
    return;
  }
  if (segments.length === 3 && segments[0] === "history") {
    handleHistory(res, url, segments[1], segments[2], ctx, now, clientIp);
    return;
  }
  if (segments.length === 2 && segments[0] !== "history" && segments[0] !== "extra") {
    handleCurrent(res, url, segments[0], segments[1], ctx, now, clientIp);
    return;
  }

  problem(res, 404, "Not Found");
}

function handleCurrent(res: http.ServerResponse, url: URL, worldParam: string, itemParam: string, ctx: ApiContext, now: number, clientIp: string): void {
  const target = resolveWorld(worldParam);
  if (!target) return problem(res, 404, "Not Found", "Unknown world or data center.");
  const itemIds = parseItemIds(itemParam);
  if (!itemIds) return problem(res, 400, "Bad Request", `itemIds must be 1-${MAX_ITEMS_PER_REQUEST} comma-separated numbers.`);
  if (!chargeForItems(res, ctx, clientIp, itemIds.length)) return;

  const params = url.searchParams;
  const listings = intParam(params, "listings", 0, 1000);
  const entries = intParam(params, "entries", 0, MAX_ENTRIES);
  const statsWithin = intParam(params, "statsWithin", 1, MAX_WINDOW_MS);
  const entriesWithin = intParam(params, "entriesWithin", 1, MAX_WINDOW_MS);
  for (const [name, parsed] of [["listings", listings], ["entries", entries], ["statsWithin", statsWithin], ["entriesWithin", entriesWithin]] as const) {
    if (!parsed.ok) return problem(res, 400, "Bad Request", `Invalid value for '${name}'.`);
  }
  const fields = readFields(params);
  if (!fields.ok) return problem(res, 400, "Bad Request", "Invalid value for 'fields'.");
  const hqRaw = params.get("hq")?.toLowerCase();
  if (hqRaw !== undefined && hqRaw !== "true" && hqRaw !== "false") return problem(res, 400, "Bad Request", "Invalid value for 'hq'.");

  const options: ViewOptions = {
    listings: listings.ok ? listings.value : undefined,
    entries: (entries.ok ? entries.value : undefined) ?? DEFAULT_RECENT_ENTRIES,
    hq: hqRaw === undefined ? undefined : hqRaw === "true",
    statsWithinMs: (statsWithin.ok ? statsWithin.value : undefined) ?? DEFAULT_STATS_WITHIN_MS,
    entriesWithinMs: entriesWithin.ok ? entriesWithin.value : undefined,
  };

  const buildItem = (itemId: number): Json => {
    const data = worldsOf(target).map((world) => loadWorld(ctx.store, itemId, world, now, options.entries));
    return target.kind === "world" ? buildWorldItem(itemId, data[0], options, now) : buildDcItem(itemId, target.name, data, options, now);
  };

  const resolved = itemIds.filter((itemId) => ctx.store.isAcceptedItem(itemId));
  const unresolved = itemIds.filter((itemId) => !ctx.store.isAcceptedItem(itemId));

  let body: Json;
  if (itemIds.length === 1) {
    if (unresolved.length > 0) return problem(res, 404, "Not Found", "This item does not accept community data.");
    body = buildItem(itemIds[0]);
  } else {
    const items: Record<string, Json> = {};
    for (const itemId of resolved) items[String(itemId)] = buildItem(itemId);
    body = wrapItems(target, itemIds, unresolved, items);
  }

  send(res, 200, fields.paths ? projectFields(body, fields.paths) : body, { "cache-control": CACHE_CONTROL });
}

function handleHistory(res: http.ServerResponse, url: URL, worldParam: string, itemParam: string, ctx: ApiContext, now: number, clientIp: string): void {
  const target = resolveWorld(worldParam);
  if (!target) return problem(res, 404, "Not Found", "Unknown world or data center.");
  const itemIds = parseItemIds(itemParam);
  if (!itemIds) return problem(res, 400, "Bad Request", `itemIds must be 1-${MAX_ITEMS_PER_REQUEST} comma-separated numbers.`);
  if (!chargeForItems(res, ctx, clientIp, itemIds.length)) return;

  const params = url.searchParams;
  const entries = intParam(params, "entries", 0, MAX_ENTRIES);
  const statsWithin = intParam(params, "statsWithin", 1, MAX_WINDOW_MS);
  const entriesWithin = intParam(params, "entriesWithin", 1, MAX_WINDOW_MS);
  const minSalePrice = intParam(params, "minSalePrice", 0, 999_999_999);
  const maxSalePrice = intParam(params, "maxSalePrice", 0, 999_999_999);
  for (const [name, parsed] of [["entries", entries], ["statsWithin", statsWithin], ["entriesWithin", entriesWithin], ["minSalePrice", minSalePrice], ["maxSalePrice", maxSalePrice]] as const) {
    if (!parsed.ok) return problem(res, 400, "Bad Request", `Invalid value for '${name}'.`);
  }

  const fields = readFields(params);
  if (!fields.ok) return problem(res, 400, "Bad Request", "Invalid value for 'fields'.");

  const options = {
    entries: (entries.ok ? entries.value : undefined) ?? MAX_ENTRIES,
    statsWithinMs: (statsWithin.ok ? statsWithin.value : undefined) ?? DEFAULT_STATS_WITHIN_MS,
    entriesWithinMs: entriesWithin.ok ? entriesWithin.value : undefined,
    minSalePrice: minSalePrice.ok ? minSalePrice.value : undefined,
    maxSalePrice: maxSalePrice.ok ? maxSalePrice.value : undefined,
  };

  const buildItem = (itemId: number): Json => {
    const data = worldsOf(target).map((world) => loadWorld(ctx.store, itemId, world, now, options.entries));
    return buildHistory(itemId, target, data, options, now);
  };

  const resolved = itemIds.filter((itemId) => ctx.store.isAcceptedItem(itemId));
  const unresolved = itemIds.filter((itemId) => !ctx.store.isAcceptedItem(itemId));

  let body: Json;
  if (itemIds.length === 1) {
    if (unresolved.length > 0) return problem(res, 404, "Not Found", "This item does not accept community data.");
    body = buildItem(itemIds[0]);
  } else {
    const items: Record<string, Json> = {};
    for (const itemId of resolved) items[String(itemId)] = buildItem(itemId);
    body = wrapItems(target, itemIds, unresolved, items);
  }

  send(res, 200, fields.paths ? projectFields(body, fields.paths) : body, { "cache-control": CACHE_CONTROL });
}

function tooManyRequests(res: http.ServerResponse, retryAfterMs: number): void {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  problem(res, 429, "Too Many Requests", "Rate limit exceeded; slow down.", { "retry-after": String(seconds) });
}

/** 查很多物品要多扣名額，不夠就回 429 並回傳 false。 */
function chargeForItems(res: http.ServerResponse, ctx: ApiContext, clientIp: string, itemCount: number): boolean {
  const extra = requestCost(itemCount) - 1;
  if (extra <= 0) return true;
  const taken = ctx.limiter.take(clientIp, extra);
  if (taken.allowed) return true;
  tooManyRequests(res, taken.retryAfterMs);
  return false;
}

function handleMostRecent(res: http.ServerResponse, url: URL, ctx: ApiContext): void {
  const params = url.searchParams;
  const entries = intParam(params, "entries", 0, MAX_MOST_RECENT);
  if (!entries.ok) return problem(res, 400, "Bad Request", "Invalid value for 'entries'.");

  let worldId: number | null = null;
  const worldParam = params.get("world");
  if (worldParam) {
    const target = resolveWorld(worldParam);
    if (!target || target.kind !== "world") return problem(res, 404, "Not Found", "Unknown world.");
    worldId = target.world.id;
  }
  const dcParam = params.get("dcName");
  if (dcParam && dcParam !== DC_NAME) return problem(res, 404, "Not Found", "Unknown data center.");

  const names = new Map(TW_WORLDS.map((world) => [world.id, world.name]));
  const rows = ctx.store.mostRecentlyUpdated(worldId, entries.value ?? DEFAULT_MOST_RECENT);
  send(
    res,
    200,
    { items: rows.map((row) => ({ itemID: row.itemId, lastUploadTime: row.uploadedAt, worldID: row.worldId, worldName: names.get(row.worldId) ?? "" })) },
    { "cache-control": CACHE_CONTROL },
  );
}


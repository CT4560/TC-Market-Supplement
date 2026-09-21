import http from "node:http";
import { TW_WORLDS } from "./worlds.js";
import {
  MAX_UPLOAD_BODY_BYTES,
  UploadRateLimiter,
  applyUpload,
  getClientIp,
  isCommunityUploadEnabled,
  validateUpload,
} from "./community.js";
import type { CollectorStore } from "./store.js";
import { TokenBucketLimiter } from "./rate-limit.js";
import { handleApiV2, isApiV2Path, isCommunityApiEnabled } from "./api-v2.js";
import { WS_PATH, WsHub } from "./ws-hub.js";

/** 公開讀取 API 每個來源 IP 的限流：每秒 20 次、突發 40（Universalis 是 25／50）。 */
export const API_RATE_PER_SECOND = 20;
export const API_RATE_BURST = 40;

export interface AppOptions {
  store: CollectorStore;
  /** 測試用：換成假時鐘的限流器。 */
  rateLimiter?: UploadRateLimiter;
  apiLimiter?: TokenBucketLimiter;
  /** 測試用：換成自訂上限的推播中心。 */
  hub?: WsHub;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: (message: string) => void;
}

/** 有被略過的項目才印，例如 skipped(staleSales=5)。 */
function describeSkipped(skipped: Record<string, number>): string {
  const parts = Object.entries(skipped).filter(([, count]) => count > 0).map(([name, count]) => name + "=" + count);
  return parts.length > 0 ? " skipped(" + parts.join(",") + ")" : "";
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(body));
}

/**
 * 回完 413 之後把剩下的內容丟掉，但最多再收 budgetBytes 就直接斷線，不讓對方一直灌流量進來。
 * 不能一開始就 destroy：連線一斷，對方就收不到 413 了；先讓回應送出去，超過額度才斷。
 */
function discardRest(req: http.IncomingMessage, budgetBytes: number): void {
  let discarded = 0;
  req.removeAllListeners("data");
  req.on("data", (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded > budgetBytes) req.destroy();
  });
  req.resume();
}

function readBodyWithLimit(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("body too large"));
        // 停止累積內容，讓呼叫端先回 413；剩下的內容有額度地丟掉（見 discardRest）。
        chunks.length = 0;
        discardRest(req, maxBytes * 4);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * 建立 HTTP 伺服器（不負責 listen，方便測試用 port 0）。端點：
 *   GET  /health            存活與資料庫檢查
 *   GET  /community/items   哪些物品、哪些世界接受回報（外掛啟動時問）
 *   POST /community/upload  上傳一次掃描結果（公開匿名，依來源 IP 限流）
 * COMMUNITY_UPLOAD_ENABLED 沒設成 on 時，後兩個端點回 404。
 */
export function createApp(options: AppOptions): http.Server {
  const { store } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(message));
  const rateLimiter = options.rateLimiter ?? new UploadRateLimiter();
  const apiLimiter = options.apiLimiter ?? new TokenBucketLimiter(API_RATE_PER_SECOND, API_RATE_BURST);
  const hub = options.hub ?? new WsHub();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/health") {
        try {
          store.ping();
          sendJson(res, 200, { ok: true });
        } catch {
          sendJson(res, 503, { ok: false, error: "database unavailable" });
        }
        return;
      }

      if (isApiV2Path(url.pathname)) {
        if (!isCommunityApiEnabled(env)) {
          sendJson(res, 404, { ok: false, error: "not found" });
          return;
        }
        handleApiV2(req, res, url, getClientIp(req), { store, limiter: apiLimiter, now });
        return;
      }

      if (url.pathname !== "/community/upload" && url.pathname !== "/community/items") {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }

      if (!isCommunityUploadEnabled(env)) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }

      const clientIp = getClientIp(req);

      if (req.method === "GET" && url.pathname === "/community/items") {
        sendJson(res, 200, { ok: true, itemIds: store.itemIds(), worldIds: TW_WORLDS.map((world) => world.id) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/community/upload") {
        if (!rateLimiter.allow(clientIp)) {
          // 上傳限流是「每個 IP 每 250ms 一次」，等 1 秒一定夠；外掛會照這個時間等再重送。
          sendJson(res, 429, { ok: false, error: "too many uploads" }, { "retry-after": "1" });
          return;
        }

        // 標頭宣告的大小就已經超過上限：不必讀內容，直接回 413 並關閉連線，省下這份流量。
        const declaredBytes = Number(req.headers["content-length"]);
        if (Number.isFinite(declaredBytes) && declaredBytes > MAX_UPLOAD_BODY_BYTES) {
          res.setHeader("connection", "close");
          sendJson(res, 413, { ok: false, error: "body too large" });
          discardRest(req, MAX_UPLOAD_BODY_BYTES * 4);
          return;
        }

        let raw: string;
        try {
          raw = await readBodyWithLimit(req, MAX_UPLOAD_BODY_BYTES);
        } catch {
          // 沒有宣告大小（分塊傳送）卻超過上限：一樣回 413 並關閉連線。
          res.setHeader("connection", "close");
          sendJson(res, 413, { ok: false, error: "body too large" });
          return;
        }

        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid JSON" });
          return;
        }

        const checked = validateUpload(body, { now: now(), isAcceptedItem: store.isAcceptedItem });
        if (!checked.ok) {
          sendJson(res, checked.status, { ok: false, error: checked.error });
          return;
        }

        const applied = applyUpload(store, checked.value, now());
        log(
          `[community] ${clientIp}: world=${checked.value.worldId} item=${checked.value.itemId} listings=${applied.listingsStored}${applied.listingsIgnored ? "(older than stored, ignored)" : ""} salesAdded=${applied.salesInserted}${describeSkipped(checked.value.skipped)}`,
        );
        // changes 是給即時推播用的內部資料，不回給上傳者。
        const { changes, ...uploadResult } = applied;
        try {
          hub.publish(changes);
        } catch (error) {
          log(`[ws] publish failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        sendJson(res, 200, { ok: true, ...uploadResult });
        return;
      }

      sendJson(res, 405, { ok: false, error: "method not allowed" });
    } catch (error) {
      log(`[server] unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal error" });
    }
  });

  // 即時推播的 WebSocket：只有 /api/ws，且要 COMMUNITY_API_ENABLED=on。
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== WS_PATH || !isCommunityApiEnabled(env)) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    hub.handleUpgrade(req, socket, head, getClientIp(req));
  });
  // 升級後的 WebSocket 連線不會被 http.Server 當成一般連線，server.close() 會一直等它們自己離開；
  // 所以關閉伺服器時先把推播中心（含所有連線）關掉，優雅關機（SIGTERM）才不會卡住。
  const closeServer = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    hub.close();
    return closeServer(callback);
  };

  return server;
}

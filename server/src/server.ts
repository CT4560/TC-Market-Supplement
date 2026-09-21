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
import { API_RATE_BURST, API_RATE_PER_SECOND, handleApiV2, isApiV2Path, isCommunityApiEnabled } from "./api-v2.js";
import { isDocsPath, loadDocsSite } from "./docs-site.js";
import { WS_PATH, WsHub } from "./ws-hub.js";

export interface AppOptions {
  store: CollectorStore;
  rateLimiter?: UploadRateLimiter;
  apiLimiter?: TokenBucketLimiter;
  hub?: WsHub;
  /** 文件網站（/docs/）的檔案資料夾；沒給或資料夾不存在就沒有這個網站。 */
  siteDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: (message: string) => void;
}

function describeSkipped(skipped: Record<string, number>): string {
  const parts = Object.entries(skipped).filter(([, count]) => count > 0).map(([name, count]) => name + "=" + count);
  return parts.length > 0 ? " skipped(" + parts.join(",") + ")" : "";
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(body));
}

/** 回完 413 後把剩下的內容丟掉，超過 budgetBytes 就斷線；不能一開始就斷，否則對方收不到 413。 */
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
 * 建立 HTTP 伺服器（不 listen，方便測試）。端點：/health、/community/items、/community/upload、/api/v2/*、/api/ws。
 * COMMUNITY_UPLOAD_ENABLED、COMMUNITY_API_ENABLED 沒設成 on 時，對應的端點回 404。/docs/ 是文件網站，跟讀取 API 同一個開關。
 */
export function createApp(options: AppOptions): http.Server {
  const { store } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(message));
  const rateLimiter = options.rateLimiter ?? new UploadRateLimiter();
  const apiLimiter = options.apiLimiter ?? new TokenBucketLimiter(API_RATE_PER_SECOND, API_RATE_BURST);
  const hub = options.hub ?? new WsHub();
  const docs = options.siteDir ? loadDocsSite(options.siteDir, store) : null;

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

      if (isDocsPath(url.pathname)) {
        if (!docs || !isCommunityApiEnabled(env)) {
          sendJson(res, 404, { ok: false, error: "not found" });
          return;
        }
        docs.handle(req, res, url);
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
          // 告訴外掛等 1 秒再送
          sendJson(res, 429, { ok: false, error: "too many uploads" }, { "retry-after": "1" });
          return;
        }

        // 宣告的大小超過上限，不讀內容直接拒絕
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
          // 沒宣告大小的分塊傳送超過上限
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

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== WS_PATH || !isCommunityApiEnabled(env)) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    hub.handleUpgrade(req, socket, head, getClientIp(req));
  });
  // 升級後的 WebSocket 連線不會被 server.close() 關掉，所以先關推播中心。
  const closeServer = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    hub.close();
    return closeServer(callback);
  };

  return server;
}

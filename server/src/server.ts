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

export interface AppOptions {
  store: CollectorStore;
  /** 測試用：換成假時鐘的限流器。 */
  rateLimiter?: UploadRateLimiter;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: (message: string) => void;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBodyWithLimit(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("body too large"));
        // 不能在這裡 destroy 連線：連線一斷，呼叫端就回不出 413 了。停止累積內容、把剩下的丟掉，讓呼叫端先回應。
        chunks.length = 0;
        req.removeAllListeners("data");
        req.resume();
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

  return http.createServer(async (req, res) => {
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
          sendJson(res, 429, { ok: false, error: "too many uploads" });
          return;
        }

        let raw: string;
        try {
          raw = await readBodyWithLimit(req, MAX_UPLOAD_BODY_BYTES);
        } catch {
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
          `[community] ${clientIp}: world=${checked.value.worldId} item=${checked.value.itemId} listings=${applied.listingsStored}${applied.listingsIgnored ? "(older than stored, ignored)" : ""} salesAdded=${applied.salesInserted}`,
        );
        sendJson(res, 200, { ok: true, ...applied });
        return;
      }

      sendJson(res, 405, { ok: false, error: "method not allowed" });
    } catch (error) {
      log(`[server] unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal error" });
    }
  });
}

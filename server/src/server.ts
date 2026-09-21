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

/** 有被略過的項目才印，例如 skipped(staleSales=5)。 */
function describeSkipped(skipped: Record<string, number>): string {
  const parts = Object.entries(skipped).filter(([, count]) => count > 0).map(([name, count]) => name + "=" + count);
  return parts.length > 0 ? " skipped(" + parts.join(",") + ")" : "";
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
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

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type http from "node:http";
import { TW_WORLDS } from "./worlds.js";
import type { CollectorStore } from "./store.js";
import { SALES_RETENTION_MS } from "./store.js";
import {
  API_RATE_BURST,
  API_RATE_PER_SECOND,
  DEFAULT_RECENT_ENTRIES,
  ITEMS_PER_TOKEN,
  MAX_ENTRIES,
  MAX_ITEMS_PER_REQUEST,
} from "./api-v2.js";
import { DAY_MS, DC_NAME, DC_REGION, DEFAULT_STATS_WITHIN_MS, MAX_WINDOW_MS } from "./read-model.js";
import { DEFAULT_WS_OPTIONS, WS_PATH } from "./ws-hub.js";
import { MAX_LISTINGS_PER_UPLOAD } from "./community.js";

// 文件網站：把 site/ 資料夾整個讀進記憶體，從 /docs/ 提供。
// /docs/config.json 與 /docs/items.json 是動態產生的，網站用它們顯示目前的限制與物品名稱。

const PREFIX = "/docs";
const MAX_FILE_BYTES = 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

// 網站只載入自己的檔案；連線只到同一個網站與 wss（WebSocket 測試用）。
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' wss:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

interface StaticFile {
  body: Buffer;
  type: string;
  etag: string;
}

export interface DocsSite {
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void;
}

export function isDocsPath(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(PREFIX + "/");
}

function collectFiles(dir: string, base: string, out: Map<string, StaticFile>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const relative = base ? `${base}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      collectFiles(full, relative, out);
      continue;
    }

    const type = CONTENT_TYPES[path.extname(entry.name).toLowerCase()];
    if (!type) continue;
    const body = fs.readFileSync(full);
    if (body.length > MAX_FILE_BYTES) continue;
    out.set(relative, { body, type, etag: `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"` });
  }
}

function buildConfig() {
  return {
    name: "TC-Market Supplement",
    dataCenter: { name: DC_NAME, region: DC_REGION },
    worlds: TW_WORLDS.map((world) => ({ id: world.id, name: world.name })),
    rest: {
      ratePerSecond: API_RATE_PER_SECOND,
      burst: API_RATE_BURST,
      itemsPerToken: ITEMS_PER_TOKEN,
      maxItemsPerRequest: MAX_ITEMS_PER_REQUEST,
      defaultEntries: DEFAULT_RECENT_ENTRIES,
      maxEntries: MAX_ENTRIES,
      defaultStatsWithinMs: DEFAULT_STATS_WITHIN_MS,
      maxWindowMs: MAX_WINDOW_MS,
    },
    websocket: {
      path: WS_PATH,
      maxPerIp: DEFAULT_WS_OPTIONS.maxPerIp,
      maxTotal: DEFAULT_WS_OPTIONS.maxTotal,
      maxSubscriptions: DEFAULT_WS_OPTIONS.maxSubscriptions,
      maxMessageBytes: DEFAULT_WS_OPTIONS.maxMessageBytes,
      maxMessagesPerSecond: DEFAULT_WS_OPTIONS.maxMessagesPerSecond,
      idleWithoutSubscriptionMs: DEFAULT_WS_OPTIONS.idleWithoutSubscriptionMs,
      pingIntervalMs: DEFAULT_WS_OPTIONS.pingIntervalMs,
    },
    data: {
      salesRetentionDays: Math.round(SALES_RETENTION_MS / DAY_MS),
      maxListingsPerItem: MAX_LISTINGS_PER_UPLOAD,
    },
  };
}

/** 讀取 siteDir 裡的檔案。資料夾不存在就回傳 null（沒有這個網站）。 */
export function loadDocsSite(siteDir: string, store: CollectorStore): DocsSite | null {
  if (!fs.existsSync(siteDir) || !fs.statSync(siteDir).isDirectory()) return null;

  const files = new Map<string, StaticFile>();
  collectFiles(siteDir, "", files);
  if (!files.has("index.html")) return null;

  const send = (req: http.IncomingMessage, res: http.ServerResponse, file: StaticFile, cacheControl: string): void => {
    const headers: Record<string, string | number> = {
      "content-type": file.type,
      "cache-control": cacheControl,
      etag: file.etag,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    if (file.type.startsWith("text/html")) headers["content-security-policy"] = CSP;

    if (req.headers["if-none-match"] === file.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, "content-length": file.body.length });
    res.end(req.method === "HEAD" ? undefined : file.body);
  };

  const sendJson = (req: http.IncomingMessage, res: http.ServerResponse, body: unknown): void => {
    const text = Buffer.from(JSON.stringify(body));
    send(req, res, { body: text, type: CONTENT_TYPES[".json"], etag: `"${createHash("sha1").update(text).digest("hex").slice(0, 16)}"` }, "public, max-age=60");
  };

  return {
    handle(req, res, url) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" });
        res.end();
        return;
      }

      if (url.pathname === PREFIX) {
        res.writeHead(301, { location: PREFIX + "/" });
        res.end();
        return;
      }

      let relative: string;
      try {
        relative = decodeURIComponent(url.pathname.slice(PREFIX.length + 1));
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (relative === "") relative = "index.html";

      if (relative === "config.json") return sendJson(req, res, buildConfig());
      if (relative === "items.json") return sendJson(req, res, store.listItems().map((item) => ({ id: item.id, name: item.name, nameEn: item.nameEn ?? null })));

      // 只提供載入過的檔案：不存在的路徑（含 ..、反斜線）一律 404
      const file = files.get(relative);
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      send(req, res, file, relative === "index.html" ? "public, max-age=60" : "public, max-age=300");
    },
  };
}

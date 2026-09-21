import fs from "node:fs";
import path from "node:path";
import { createApp } from "./server.js";
import { openStore, type CollectorItem } from "./store.js";

// 環境變數：
//   PORT                       監聽埠，預設 8787
//   HOST                       監聽位址，預設 127.0.0.1（只給同一台機器上的反向代理／Cloudflare Tunnel 連；容器內請設 0.0.0.0）
//   DATA_DIR                   資料庫所在資料夾，預設 ./data（資料庫檔名 collector.db）
//   ITEMS_FILE                 物品白名單，預設 ./data/items.json（scripts/build-items.mjs 產生）
//   COMMUNITY_UPLOAD_ENABLED   設成 on 才開放上傳端點，沒設＝端點回 404
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const itemsFile = process.env.ITEMS_FILE ?? path.join(process.cwd(), "data", "items.json");

fs.mkdirSync(dataDir, { recursive: true });
const store = openStore(path.join(dataDir, "collector.db"));

const items = JSON.parse(fs.readFileSync(itemsFile, "utf8")) as { items?: CollectorItem[] };
if (!Array.isArray(items.items) || items.items.length === 0) {
  throw new Error(`${itemsFile} 裡沒有物品清單（items 應該是非空陣列），請先執行 scripts/build-items.mjs`);
}
store.replaceItems(items.items);
console.log(`[collector] item whitelist: ${items.items.length} items`);

const server = createApp({ store });
server.listen(port, host, () => console.log(`[collector] listening on ${host}:${port}`));

// 成交只留 30 天：每小時清一次，啟動一分鐘後也清一次。
const prune = () => {
  const removed = store.pruneOldSales();
  if (removed > 0) console.log(`[collector] pruned ${removed} old sales`);
};
setInterval(prune, 3_600_000).unref();
setTimeout(prune, 60_000).unref();

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

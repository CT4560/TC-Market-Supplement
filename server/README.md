# 社群回報伺服器

接收 Market Board Collector 外掛的匿名上傳，存進自己的 SQLite 資料庫，並提供公開、免金鑰的 REST API 與 WebSocket 即時推播（相容 Universalis v2，時間用 UTC 毫秒）。完全獨立：不依賴任何其他專案的程式碼或資料庫。

## 做什麼

- `POST /community/upload`：外掛上傳一次市場板掃描（該物品目前的掛單與最近成交）。公開匿名，不需要金鑰。
- `GET /community/items`：告訴外掛哪些物品、哪些世界接受回報（外掛啟動時問，約每 30 分鐘更新）。
- `GET /api/v2/…`：公開讀取 API（見下方「公開 API」）。
- `wss://…/api/ws`：即時推播（見下方「WebSocket」）。
- `GET /health`：存活與資料庫檢查。

## 公開 API（`/api/v2`）

路徑、查詢參數與回應欄位跟 [Universalis v2](https://docs.universalis.app/) 相同，現有的 Universalis 用戶端改一下網址就能用；資料是玩家用外掛回報的社群資料，不是即時的（`lastUploadTime` 是最近一次有人掃描的時間）。全部端點都是 `GET`，回 JSON，允許任何來源的瀏覽器跨網域呼叫（`Access-Control-Allow-Origin: *`）。

| 端點 | 說明 |
| --- | --- |
| `/api/v2/{world}/{itemIds}` | 目前的掛單、近期成交與統計。`{world}` 可以是世界編號（`4033`）、世界名稱（`巴哈姆特`）或資料中心名稱（`陸行鳥`，七個世界合併，每筆掛單與成交帶 `worldID`、`worldName`）。`{itemIds}` 逗號分隔，一次最多 112 個 |
| `/api/v2/history/{world}/{itemIds}` | 成交歷史（資料庫保留一年，API 目前開放最近 30 天） |
| `/api/v2/worlds` | 世界清單 |
| `/api/v2/data-centers` | 資料中心清單 |
| `/api/v2/marketable` | 接受回報的物品編號（目前 112 個） |
| `/api/v2/extra/stats/most-recently-updated?world=&entries=` | 最近被回報的物品 |

查詢參數（`/{world}/{itemIds}`）：`listings`（回傳幾筆掛單，預設全部）、`entries`（回傳幾筆成交，預設 5）、`hq`（`true`／`false`，染劑沒有 HQ，`hq=true` 會是空的）、`statsWithin`（統計的時間窗，毫秒，預設 7 天、最長 30 天）、`entriesWithin`（只回這段時間內的成交，毫秒）、`fields`（只要哪些欄位，逗號分隔的點路徑，例如 `fields=lastUploadTime,listings.pricePerUnit`；查多個物品時要加 `items.` 前綴，例如 `items.listings.pricePerUnit`）。`/history` 另有 `minSalePrice`、`maxSalePrice`。

```bash
curl "https://api-ffxiv-bot.epicurean-expedition.com/api/v2/巴哈姆特/5729?listings=3&entries=3"
curl "https://api-ffxiv-bot.epicurean-expedition.com/api/v2/陸行鳥/5729,5730?fields=items.minPrice,items.lastUploadTime"
```

單一物品回傳物件；查多個物品回 `{ itemIDs, items: { "<id>": {…} }, worldID, unresolvedItems, worldName }`（資料中心版是 `dcName`、沒有 `worldID`）。不在白名單的物品：單一物品回 404，多個物品時列在 `unresolvedItems`。錯誤回應是 ASP.NET 的 problem details（`{ type, title, status, detail?, traceId }`）。

### 資料的性質

這裡的資料完全來自玩家順便在市場板查價時，外掛被動回報的結果，沒有人被要求去掃描，也沒有任何程式會主動抓取。所以：

- 有些物品可能一直沒有人查過：回應的 `hasData` 是 `false`、`lastUploadTime` 是 0，掛單與成交都是空的。這代表「沒有人回報過」，不代表「沒有人在賣」。
- 每個物品、每個世界的資料新舊不一，請用 `lastUploadTime`（該世界最近一次被掃描的時間，UTC 毫秒）判斷要不要採用；資料中心版另有 `worldUploadTimes` 分世界。
- 完整度、新鮮度要不要滿足你的用途，由使用資料的人自行判斷。

### 跟 Universalis 的差異

- 時間一律是 UTC 毫秒：掛單的 `lastReviewTime`、成交的 `timestamp`、`lastUploadTime`、`worldUploadTimes` 都是毫秒（Universalis 的前兩者是秒）。請求參數裡的時間長度也是毫秒（`statsWithin`、`entriesWithin`；Universalis 的 `entriesWithin` 是秒）。
- `lastReviewTime` 的意思：封包裡沒有真正的上架時間，這裡是「伺服器第一次看到這筆掛單的時間」。
- 沒有收集的欄位保留了鍵，值是中性值：`hq: false`、`stainID: 0`、`creatorName: ""`、`creatorID`／`sellerID`／`retainerID`／`retainerCity`／`tax` 是 `null`、`isCrafted: false`、`materia: []`、`onMannequin: false`。
- 統計是用我們存的資料算的：`minPrice`／`maxPrice`／`currentAveragePrice` 是目前掛單單價的最小／最大／平均；`averagePrice` 是 `statsWithin` 內成交單價的平均；`regularSaleVelocity` 是時間窗內賣出的數量 ÷ 天數。
- 資料中心只有 7 個世界（Universalis 的陸行鳥多一個「拉姆」）；只支援上表的端點，其餘 Universalis 端點回 404。
- 雇員名稱與買家名稱都會回傳（都是市場板上本來就公開顯示的名稱）。

### 限流

每個來源 IP：每秒補 20 個名額、最多存 40 個（Universalis 是每秒 25、突發 50），一個請求用 1 個，超過回 `429` 與 `Retry-After`（秒）。查很多物品的請求多扣名額，每 10 個物品算 1 個：查 1～10 個物品算 1 次，一次查全部 112 個算 12 次，因為回應大小大致跟物品數成正比（全部 112 個約 90 KB）。回應帶 `Cache-Control: public, max-age=10`，前面放 CDN 的話可以快取（見下方「Cloudflare 快取」）。

## WebSocket 即時推播（`/api/ws`）

協定跟 Universalis 相同：BSON 二進位訊息。連上 `wss://api-ffxiv-bot.epicurean-expedition.com/api/ws` 後送訂閱：

```js
import WebSocket from "ws";
import { serialize, deserialize } from "bson";

const ws = new WebSocket("wss://api-ffxiv-bot.epicurean-expedition.com/api/ws");
ws.on("open", () => {
  ws.send(serialize({ event: "subscribe", channel: "listings/add{world=4033}" }));
  ws.send(serialize({ event: "subscribe", channel: "sales/add{world=4033,item=5729}" }));
});
ws.on("message", (data) => console.log(deserialize(data)));
```

頻道有三種：`listings/add`（新出現的掛單）、`listings/remove`（消失的掛單）、`sales/add`（新的成交）。頻道後面可以加篩選 `{world=4033}`、`{item=5729}` 或 `{world=4033,item=5729}`，都省略就是該頻道全部。取消訂閱送 `{ event: "unsubscribe", channel: … }`。

伺服器推送 `{ event: "listings/add", item, world, listings: […] }`、`{ event: "listings/remove", … }`、`{ event: "sales/add", item, world, sales: […] }`，項目的欄位跟 REST 一樣（帶 `worldID`、`worldName`，時間是毫秒）。事件在每次有人上傳掃描結果時產生：新舊掛單以掛單編號比對得出新增與消失的，成交只推「真的新寫入」的，內容沒變就不推。出錯時收到 `{ event: "error", code, message }`（`invalid_message`、`unknown_event`、`invalid_channel`、`too_many_subscriptions`、`rate_limited`）。

限制（都比 Universalis 保守）：每個 IP 最多同時 4 條連線（Universalis 是 8；超過的升級請求回 `429`），全站最多 300 條；每條連線最多 30 個訂閱；客戶端訊息最大 1 KB、每秒最多 5 則；連上後 60 秒內沒訂閱任何頻道會被關；伺服器每 30 秒送一次 ping，沒回 pong 的連線會被終止；讀得太慢（送出緩衝超過 1 MB）的連線會被關。

## 防濫用（上傳端沒有身份驗證，靠這三道）

1. 物品白名單（`data/items.json`）：只收「繁中服可交易、但 Universalis 沒有價格資料」的物品，目前 112 個（7.5 整併前的舊染劑與色素）。
2. 資料檢查（`src/community.ts`）：世界必須是繁中服七個世界、單價 1～999,999,999、單筆數量 1～99（染劑一格最多 99）、掃描時間不能太舊或在未來、單次掛單最多 100 筆／成交最多 50 筆、內容最大 64 KB（標頭宣告的大小超過就不讀內容、直接回 413 並關閉連線；沒宣告大小的分塊傳送超過也一樣，多餘的內容最多再收 256 KB 就斷線）、雇員名稱含 `<` `>` 的掛單略過、買家名稱最多 6 個字。單價與數量的上限對照 Universalis 上傳端的檢查。
3. 依來源 IP 限流：每個 IP 每秒最多 4 次（距離上次被允許不到 250ms 就回 429）。來源 IP 優先讀 Cloudflare 加的 `CF-Connecting-IP`，其次 `X-Forwarded-For` 第一段，最後才是連線位址。

上傳端點預設關閉：環境變數 `COMMUNITY_UPLOAD_ENABLED` 沒設成 `on` 時，`/community/upload`、`/community/items` 回 404；讀取端同理，`COMMUNITY_API_ENABLED` 沒設成 `on` 時，`/api/v2/*` 與 `/api/ws` 回 404。

## 資料

- 掛單：每個世界每個物品存「最近一次掃描」的完整清單（最多 100 筆，新的掃描整份取代舊的；較舊的擷取不會蓋掉較新的）。每筆掛單記錄「伺服器第一次看到它的時間」，因為封包裡沒有真正的上架時間。
- 成交：保留一年（依成交發生的時間；公開 API 的查詢時間窗目前最長 30 天），重複上傳會被唯一索引擋掉。會存買家名稱（市場板成交紀錄上本來就公開顯示）；繁中服的姓與名加起來最多 6 個字（中間的「·」也算一個字，只有空白不算），超過或含 `<` `>` 的成交略過。
- 雇員名稱（賣家在遊戲內自訂、公開顯示在市場板上）會跟掛單一起存。
- 不存：上傳者的角色名稱、角色編號、上傳者身份。
- 這些資料（含雇員名稱與買家名稱）都會經由公開 API 與 WebSocket 提供給任何人。

## 執行

需要 Node.js 22 以上。

```bash
cd server
npm install
npm run build-items      # 產生/更新 data/items.json（讀取 Universalis 與繁中資料表的公開資料）；repo 裡已附一份
npm run build && COMMUNITY_UPLOAD_ENABLED=on COMMUNITY_API_ENABLED=on npm start
```

環境變數：

| 名稱 | 預設 | 說明 |
| --- | --- | --- |
| `PORT` | `8787` | 監聽埠 |
| `HOST` | `127.0.0.1` | 監聽位址。只給同一台機器的反向代理／Cloudflare Tunnel 連；放進容器時設 `0.0.0.0` |
| `DATA_DIR` | `./data` | 資料庫所在資料夾（檔名 `collector.db`） |
| `ITEMS_FILE` | `./data/items.json` | 物品白名單 |
| `COMMUNITY_UPLOAD_ENABLED` | （未設＝關） | 設成 `on` 才開放上傳端點 |
| `COMMUNITY_API_ENABLED` | （未設＝關） | 設成 `on` 才開放公開 REST API 與 WebSocket |

開發時 `npm run dev` 會監看檔案變更重啟。

## 用 Docker 執行

```bash
cd server
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

- `Dockerfile` 分兩階段：先編譯 TypeScript，執行階段只帶正式環境的相依套件與編譯結果，以非 root 的 `node` 使用者執行，內建健康檢查（打 `/health`）。
- `docker-compose.yml` 只把埠綁在 `127.0.0.1`（主機端的埠可用 `COLLECTOR_PORT` 調整，預設 8787），不直接對外；請用同一台機器上的反向代理或 Cloudflare Tunnel 連進來（限流靠 `CF-Connecting-IP` 判斷來源 IP；Cloudflare Tunnel 支援 WebSocket，閒置 100 秒會斷，伺服器每 30 秒的 ping 會維持連線）。
- 資料庫放在具名資料卷 `collector-data`（容器內 `/data/collector.db`）。備份請備份整個資料卷（SQLite 是 WAL 模式，會有 `-wal`、`-shm` 檔）。
- 備份：`scripts/backup.sh` 用 SQLite 的 backup API 複製資料庫（服務執行中也安全）、驗證完整性、壓縮成 `collector-<UTC 時間>.db.gz`，預設放 `/root/backups/collector`（可用 `BACKUP_DIR`、`VOLUME` 環境變數調整），然後由 `scripts/rotate-backups.sh` 依保留規則整理。用 cron 每天跑一次，例如 `10 20 * * * /opt/database-dalamud-collector/scripts/backup.sh`。還原步驟寫在腳本檔頭。
  - 保留規則：每日備份保留最近 60 天；一年分成六組（1～2 月、3～4 月……11～12 月，UTC），每組結束後把該組最後一份備份封存到 `archive/` 資料夾，封存的保留 365 天（約 6 份）。備份只是複製，不會動到正在使用的資料庫；成交紀錄在資料庫裡本身保留一年（見「資料」），所以每份封存備份都包含當時往前一年的成交。
  - `scripts/test-rotate.sh` 模擬兩年的每日備份來驗證這套規則（約 2 分鐘，不碰資料庫與 docker）。
  - 備份和資料庫在同一台機器，防得了誤刪與資料損壞，防不了整台機器遺失，重要的話請另外把備份檔（尤其 `archive/`）複製到別處。
- 容器以唯讀根檔案系統、丟掉所有 capability、禁止提權、記憶體上限 384 MB 執行。
- 物品白名單 `data/items.json` 打包在映像檔裡；要更新清單就重新執行 `npm run build-items`、再重新建置映像檔。
- 建議加上 Cloudflare 快取，見下一節。

## Cloudflare 快取

Cloudflare 預設不會快取 JSON（回應會顯示 `cf-cache-status: DYNAMIC`），要自己加一條 Cache Rule，相同網址的重複請求才會由 Cloudflare 邊緣直接回，不用回到這台伺服器（也不佔用這裡的限流名額）。在 Cloudflare 後台選這個網域 → Caching → Cache Rules → Create rule：

- When incoming requests match：自訂篩選，`URI Path` starts with `/api/v2/`（不要包含 `/api/ws`，WebSocket 不能快取；上傳 `/community/*` 也不要）。
- Hostname 也要限定：加一個條件 `Hostname` equals `api-ffxiv-bot.epicurean-expedition.com`（跟上面的 URI Path 用 AND 組合），避免這條規則影響同一個網域底下的其他網站。
- Then：Cache eligibility 選 Eligible for cache；Edge TTL 選 Use cache-control header if present, bypass cache if not（伺服器對成功的回應會送 `Cache-Control: public, max-age=10`，錯誤回應是 `no-store`，所以只有成功的查詢會被快取 10 秒）。
- 不要選「Ignore cache-control header and use this TTL」來填 10 秒：依 Cloudflare 文件，Edge TTL 覆寫有最短限制（Free 方案 2 小時、Pro 1 小時，Business／Enterprise 才能到 1 秒），在 Free／Pro 上會讓價格資料過期好幾個小時。
- Cache key 維持預設。

設定後驗證（連續打兩次同一個網址）：

```bash
curl -sI "https://api-ffxiv-bot.epicurean-expedition.com/api/v2/worlds" | grep -iE "cf-cache-status|^age"
```

第一次應該是 `cf-cache-status: MISS`，10 秒內的第二次是 `HIT` 並帶 `age`（秒）。如果一直是 `DYNAMIC`，代表規則沒有生效（條件沒符合，或該方案不接受這個設定）；那就不要勉強，直接靠伺服器端的限流即可。

快取只擋「完全相同網址」的重複請求；有人每次加不同的查詢字串來繞過快取時，靠上面依物品數加權的限流擋住。

## 測試

```bash
npm test
```

測試全部用記憶體資料庫，不碰網路、不碰任何正式資料。`test/fixtures/universalis-shapes.json` 是對 Universalis 真實回應取得的欄位名稱與順序，相容性測試用它確認我們的回應鍵集合與順序跟 Universalis 一致。

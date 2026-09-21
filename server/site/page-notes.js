import { h, duration, table } from "./ui.js";

export async function notesPage({ config }) {
  const rest = config.rest;
  const code = (text) => h("code", { text });

  const element = h(
    "div",
    null,
    h("h1", { text: "說明" }),

    h("h2", { text: "資料從哪裡來" }),
    h("p", { text: "繁中服有一批舊染劑與色素，Universalis 沒有它們的價格資料。這裡的資料來自玩家使用 Market Board Collector 插件：玩家在市場板查看這些物品時，插件會把看到的掛單與成交紀錄匿名回報到這裡。沒有任何程式會主動去抓資料，也沒有人被要求去查價。" }),
    h("p", { text: "插件只讀取市場板傳來的封包，不會操作遊戲。回報的內容只有市場板上本來就公開顯示的資料：世界、物品、掛單的單價／數量／雇員名稱，以及成交紀錄的單價／數量／買家名稱／成交時間。" }),

    h("h2", { text: "資料的性質" }),
    h(
      "ul",
      null,
      h("li", null, "有些物品可能一直沒有人查過：", code("hasData"), " 是 ", code("false"), "、", code("lastUploadTime"), " 是 0。這代表沒有人回報過，不代表沒有人在賣。"),
      h("li", null, "每個世界每個物品的新舊不同，請用 ", code("lastUploadTime"), " 判斷；查資料中心時 ", code("worldUploadTimes"), " 分世界列出。"),
      h("li", null, `掛單是最近一次掃描的完整清單（最多 ${config.data.maxListingsPerItem} 筆），新的掃描整份取代舊的。成交保留 ${config.data.salesRetentionDays} 天。`),
      h("li", null, "資料完整度與新鮮度夠不夠用，由使用資料的人自己判斷。"),
    ),

    h("h2", { text: "跟 Universalis 的差異" }),
    table(
      ["項目", "說明"],
      [
        ["時間單位", "時間一律是 UTC 毫秒（lastReviewTime、timestamp、lastUploadTime）。Universalis 的 lastReviewTime 與成交 timestamp 是秒。"],
        ["時間長度參數", "statsWithin、entriesWithin 都是毫秒。Universalis 的 entriesWithin 是秒。"],
        ["lastReviewTime", "封包裡沒有真正的上架時間，這裡是伺服器第一次看到這筆掛單的時間。"],
        ["沒有收集的欄位", "hq、stainID、creatorName、creatorID、isCrafted、materia、onMannequin、retainerCity、retainerID、sellerID、tax 保留鍵，值是 false、0、空字串、null 或空陣列。"],
        ["統計", "用這裡存的資料計算：minPrice／maxPrice／currentAveragePrice 看目前掛單，averagePrice 與 regularSaleVelocity 看統計時間窗內的成交。"],
        ["資料中心", `只有 ${config.worlds.length} 個世界（Universalis 的 ${config.dataCenter.name} 多一個拉姆）。`],
        ["端點", "只支援 REST 頁面列出的端點，其他 Universalis 端點回 404。"],
        ["名稱", "雇員名稱與買家名稱都會回傳。"],
      ],
    ),

    h("h2", { text: "限流" }),
    h("p", { text: `每個來源 IP 每秒補 ${rest.ratePerSecond} 個名額、最多累積 ${rest.burst} 個。一般請求用 1 個；查很多物品的請求依物品數多扣，每 ${rest.itemsPerToken} 個物品算 1 個，所以一次查全部 ${rest.maxItemsPerRequest} 個算 ${Math.ceil(rest.maxItemsPerRequest / rest.itemsPerToken)} 個。名額不夠回 429，Retry-After 標頭是要等的秒數。` }),
    h("p", { text: "需要很多物品時，用 fields 只取需要的欄位，並且把物品放在同一次請求裡，比分很多次請求划算。" }),

    h("h2", { text: "快取" }),
    h("p", null, "成功的查詢回應帶 ", code("Cache-Control: public, max-age=10"), "，相同網址在 10 秒內可能由 CDN 直接回應，所以資料最多會晚 10 秒。錯誤回應不會被快取。想要最新資料，可以在網址加一個沒用的查詢參數。"),

    h("h2", { text: "錯誤" }),
    h("p", null, "4xx 與 429 的內容是 problem details：", code('{ "type", "title", "status", "detail", "traceId" }'), "。常見的："),
    table(
      ["狀態", "原因"],
      [
        ["400", "物品編號不合法、超過一次可查的數量、參數格式不對（例如 entries=abc）"],
        ["404", "不認得的世界、單一物品不在接受回報的清單、不存在的路徑"],
        ["429", "超過限流，看 Retry-After"],
      ],
    ),

    h("h2", { text: "使用建議" }),
    h(
      "ul",
      null,
      h("li", null, "用 Universalis 的用戶端程式時，把網址換成這裡，並把三個時間欄位從毫秒換成你程式要的單位。"),
      h("li", null, `想知道哪些物品有新資料，輪詢 most-recently-updated，不需要輪詢全部物品；即時通知用 WebSocket。`),
      h("li", null, "顯示資料時請標明來源是社群回報、不是即時資料，並顯示 lastUploadTime。"),
      h("li", null, `一次請求最多 ${rest.maxItemsPerRequest} 個物品；要全部物品時，一次請求就夠。`),
    ),
    h("p", { class: "muted small" }, `統計與成交的時間窗最長 ${duration(rest.maxWindowMs)}。`),
  );
  return { element };
}

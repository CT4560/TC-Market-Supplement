import { h, ago, callApi, codeBlock, copyText, duration, formatTime, table } from "./ui.js";

export async function overviewPage({ config, items, origin }) {
  const base = origin;
  const stats = h("div", { class: "stats-row" });

  const statCard = (label, value) => h("div", { class: "card stat" }, h("div", { class: "value", text: value }), h("div", { class: "label", text: label }));
  stats.append(statCard("接受回報的物品", `${items.length} 個`), statCard("世界", `${config.worlds.length} 個（${config.dataCenter.name}）`));

  const recentCard = h("div", { class: "card stat" }, h("div", { class: "value", text: "…" }), h("div", { class: "label", text: "最近一次回報" }));
  const coverageCard = h("div", { class: "card stat" }, h("div", { class: "value", text: "…" }), h("div", { class: "label", text: "最近有被回報過的物品" }));
  stats.append(recentCard, coverageCard);

  callApi("/api/v2/extra/stats/most-recently-updated?entries=200").then((result) => {
    const rows = result.json?.items;
    if (!result.ok || !Array.isArray(rows)) {
      recentCard.querySelector(".value").textContent = "—";
      coverageCard.querySelector(".value").textContent = "—";
      return;
    }
    recentCard.querySelector(".value").textContent = rows.length ? ago(rows[0].lastUploadTime) : "還沒有資料";
    recentCard.querySelector(".label").textContent = rows.length ? `最近一次回報（${formatTime(rows[0].lastUploadTime)}）` : "最近一次回報";
    coverageCard.querySelector(".value").textContent = `${new Set(rows.map((row) => row.itemID)).size} 個`;
  });

  const rest = config.rest;
  const ws = config.websocket;
  const example = `curl "${base}/api/v2/${config.worlds[0].name}/${items[0]?.id ?? 5729}?listings=3&entries=3"`;

  const element = h(
    "div",
    null,
    h(
      "section",
      { class: "hero" },
      h("img", { src: "logo.png", alt: "TC-Market Supplement", width: 120, height: 120 }),
      h(
        "div",
        null,
        h("h1", { text: "TC-Market Supplement" }),
        h("p", { text: "繁中服市場補充資料" }),
        h("p", { text: "繁中服上 Universalis 沒有價格資料的物品（主要是舊染劑與色素），由玩家使用外掛在市場板查價時順便回報。這裡提供公開、免金鑰的 REST API 與 WebSocket，格式與 Universalis v2 相容，時間一律是 UTC 毫秒。" }),
        h(
          "div",
          { class: "button-row" },
          h("a", { class: "button primary", href: "#/rest", text: "試用 API" }),
          h("a", { class: "button", href: "#/explorer", text: "看資料" }),
          h("a", { class: "button", href: "#/websocket", text: "即時推播" }),
        ),
      ),
    ),
    stats,
    h("h2", { text: "快速開始" }),
    h("p", null, "不需要註冊、不需要金鑰，直接呼叫。位址："),
    h("div", { class: "toolbar" }, h("code", { text: base }), h("button", { class: "small", type: "button", text: "複製", onclick: (event) => copyText(base, event.target) })),
    codeBlock(example),
    h("p", null, "回應是 Universalis v2 的格式：", h("code", { text: "listings" }), "（目前掛單）、", h("code", { text: "recentHistory" }), "（近期成交）與統計欄位。查多個物品用逗號分隔，", h("code", { text: "陸行鳥" }), " 會合併七個世界。"),
    h("h2", { text: "限制" }),
    table(
      ["項目", "限制"],
      [
        ["REST 請求速率", `每個 IP 每秒補 ${rest.ratePerSecond} 個名額，最多累積 ${rest.burst} 個；一次請求用 1 個，查很多物品會多扣（每 ${rest.itemsPerToken} 個物品算 1 個）。超過回 429 與 Retry-After。`],
        ["單次物品數", `最多 ${rest.maxItemsPerRequest} 個（＝目前全部的物品）`],
        ["WebSocket 連線", `每個 IP 最多 ${ws.maxPerIp} 條、全站最多 ${ws.maxTotal} 條；每條最多 ${ws.maxSubscriptions} 個訂閱`],
        ["查詢時間窗", `統計與成交最長 ${duration(rest.maxWindowMs)}（資料庫保留 ${config.data.salesRetentionDays} 天的成交）`],
        ["快取", "成功的查詢回應帶 Cache-Control: public, max-age=10，相同網址 10 秒內可能由 CDN 回應"],
      ],
    ),
    h("div", { class: "notice" }, h("strong", { text: "資料是被動回報的。" }), " 沒有人查過的物品 hasData 是 false，不代表沒有人在賣；請用 lastUploadTime 判斷資料的新舊。細節見「說明」。"),
  );

  return { element };
}

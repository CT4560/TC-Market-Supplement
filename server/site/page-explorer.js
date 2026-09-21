import { h, ago, callApi, codeBlock, formatTime, gil, itemPicker, table } from "./ui.js";

const REFRESH_MS = 10_000;

function hashParams() {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}

function updateHash(worldKey, itemId) {
  const params = new URLSearchParams({ world: worldKey, item: String(itemId) });
  history.replaceState(null, "", `#/explorer?${params}`);
}

function statCard(label, value) {
  return h("div", { class: "card stat" }, h("div", { class: "value", text: value }), h("div", { class: "label", text: label }));
}

function renderItem(data, config, item, isDataCenter) {
  const listings = data.listings ?? [];
  const sales = data.recentHistory ?? [];
  const worldNames = new Map(config.worlds.map((world) => [world.id, world.name]));
  const shortDay = (value) => (Number.isFinite(value) ? value.toFixed(2) : "—");

  const listingRows = listings.map((listing) => [
    gil(listing.pricePerUnit),
    gil(listing.quantity),
    gil(listing.total),
    listing.retainerName,
    ...(isDataCenter ? [listing.worldName ?? worldNames.get(listing.worldID) ?? ""] : []),
    formatTime(listing.lastReviewTime),
  ]);
  const listingHeaders = ["單價", "數量", "總價", "雇員", ...(isDataCenter ? ["世界"] : []), "首次看到"];

  const saleRows = sales.map((sale) => [
    formatTime(sale.timestamp),
    gil(sale.pricePerUnit),
    gil(sale.quantity),
    gil(sale.total),
    sale.buyerName || "—",
    ...(isDataCenter ? [sale.worldName ?? worldNames.get(sale.worldID) ?? ""] : []),
  ]);
  const saleHeaders = ["時間", "單價", "數量", "總價", "買家", ...(isDataCenter ? ["世界"] : [])];

  return h(
    "div",
    null,
    h("h2", null, item.name, h("span", { class: "muted small", text: `  ${item.id}${item.nameEn ? ` · ${item.nameEn}` : ""}` })),
    h(
      "p",
      { class: "muted" },
      data.hasData ? `最近回報：${ago(data.lastUploadTime)}（${formatTime(data.lastUploadTime)}）` : "還沒有人回報過這個物品，沒有資料。這代表沒人查過，不代表沒有人在賣。",
    ),
    data.hasData
      ? h(
          "div",
          { class: "stats-row" },
          statCard("最低單價", gil(data.minPrice)),
          statCard("目前掛單平均單價", gil(Math.round(data.currentAveragePrice))),
          statCard("成交平均單價（7 天）", gil(Math.round(data.averagePrice))),
          statCard("每天賣出數量（7 天）", shortDay(data.regularSaleVelocity)),
          statCard("目前掛單數量", `${gil(data.unitsForSale)}（${gil(data.listingsCount)} 筆）`),
          statCard("7 天內成交數量", gil(data.unitsSold)),
        )
      : null,
    h("h3", { text: `掛單（${listings.length} 筆）` }),
    listings.length ? table(listingHeaders, listingRows, [0, 1, 2]) : h("p", { class: "muted", text: "目前沒有掛單。" }),
    h("h3", { text: `最近成交（${sales.length} 筆）` }),
    sales.length ? table(saleHeaders, saleRows, [1, 2, 3]) : h("p", { class: "muted", text: "沒有成交紀錄。" }),
  );
}

export async function explorerPage({ config, items, itemsById }) {
  const params = hashParams();
  const dcName = config.dataCenter.name;
  const validWorlds = new Set([dcName, ...config.worlds.map((world) => String(world.id))]);
  let worldKey = validWorlds.has(params.get("world") ?? "") ? params.get("world") : dcName;
  let itemId = itemsById.has(Number(params.get("item"))) ? Number(params.get("item")) : null;
  let timer = null;
  let alive = true;

  const worldSelect = h(
    "select",
    { "aria-label": "世界" },
    h("option", { value: dcName, text: `${dcName}（全部世界）` }),
    config.worlds.map((world) => h("option", { value: String(world.id), text: `${world.name}（${world.id}）` })),
  );
  worldSelect.value = worldKey;

  const result = h("div", { class: "result" });
  const recent = h("div", { class: "subs" });
  const refreshBox = h("input", { type: "checkbox", id: "auto-refresh" });
  const raw = h("div");

  const load = async () => {
    if (itemId === null) {
      result.replaceChildren(h("p", { class: "muted", text: "請先選擇一個物品。" }));
      return;
    }
    const item = itemsById.get(itemId);
    const response = await callApi(`/api/v2/${encodeURIComponent(worldKey)}/${itemId}?entries=20`);
    if (!alive) return;
    if (!response.ok || !response.json) {
      result.replaceChildren(h("div", { class: "notice" }, `查詢失敗（HTTP ${response.status || "連線錯誤"}）`, response.status === 429 ? "，請稍後再試。" : ""));
      return;
    }
    result.replaceChildren(renderItem(response.json, config, item, worldKey === dcName));
    raw.replaceChildren(h("details", null, h("summary", { text: "原始 JSON" }), codeBlock(JSON.stringify(response.json, null, 2), { json: true })));
    result.append(raw);
  };

  const choose = (id) => {
    itemId = id;
    updateHash(worldKey, itemId);
    load();
  };

  const loadRecent = async () => {
    const query = worldKey === dcName ? "" : `&world=${worldKey}`;
    const response = await callApi(`/api/v2/extra/stats/most-recently-updated?entries=12${query}`);
    if (!alive) return;
    recent.replaceChildren();
    const rows = response.json?.items;
    if (!response.ok || !Array.isArray(rows) || rows.length === 0) {
      recent.append(h("span", { class: "muted small", text: "還沒有資料" }));
      return;
    }
    for (const row of rows) {
      const item = itemsById.get(row.itemID);
      if (!item) continue;
      recent.append(h("button", { class: "small", type: "button", title: `${row.worldName} · ${ago(row.lastUploadTime)}`, onclick: () => choose(row.itemID) }, item.name));
    }
    if (itemId === null && rows[0]) choose(rows[0].itemID);
  };

  worldSelect.addEventListener("change", () => {
    worldKey = worldSelect.value;
    if (itemId !== null) updateHash(worldKey, itemId);
    load();
    loadRecent();
  });

  refreshBox.addEventListener("change", () => {
    clearInterval(timer);
    if (refreshBox.checked) timer = setInterval(load, REFRESH_MS);
  });

  const picker = itemPicker(items, (item) => choose(item.id), "搜尋物品名稱或編號");

  const element = h(
    "div",
    null,
    h("h1", { text: "資料檢視" }),
    h("p", { class: "muted", text: "選世界和物品，看目前的掛單、近期成交與統計。資料來自這個網站自己的 API，跟 REST 頁面看到的是同一份。" }),
    h("div", { class: "toolbar" }, worldSelect, h("div", { class: "grow" }, picker), h("label", null, refreshBox, " 每 10 秒更新")),
    h("p", { class: "muted small", text: "最近被回報的物品：" }),
    recent,
    result,
  );

  load();
  loadRecent();
  return {
    element,
    cleanup: () => {
      alive = false;
      clearInterval(timer);
    },
  };
}

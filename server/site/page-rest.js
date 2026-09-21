import { h, callApi, codeBlock, copyText, duration, itemPicker, table } from "./ui.js";

const MAX_SHOWN_CHARS = 200_000;

function buildEndpoints(config) {
  const rest = config.rest;
  const idsText = `逗號分隔的物品編號，最多 ${rest.maxItemsPerRequest} 個。`;
  const worldText = `世界編號（例如 ${config.worlds[0].id}）、世界名稱（例如 ${config.worlds[0].name}）或資料中心名稱（${config.dataCenter.name}，七個世界合併）。`;
  const fieldsText = "只回傳指定的欄位，逗號分隔的點路徑，例如 lastUploadTime,listings.pricePerUnit；查多個物品時要加 items. 前綴。";
  const withinText = `毫秒，最長 ${duration(rest.maxWindowMs)}。`;

  return [
    {
      id: "item",
      title: "目前的掛單、近期成交與統計",
      path: "/api/v2/{world}/{itemIds}",
      description: "回傳這些物品目前的掛單、最近的成交和統計。一個物品回傳物件；多個物品回傳 { itemIDs, items, unresolvedItems, … }。不在接受回報清單的物品：單一物品回 404，多個物品時列在 unresolvedItems。",
      params: [
        { name: "world", in: "path", kind: "world", required: true, example: config.dataCenter.name, desc: worldText },
        { name: "itemIds", in: "path", kind: "items", required: true, example: "5729", desc: idsText },
        { name: "listings", in: "query", kind: "number", example: "5", desc: "最多回傳幾筆掛單（由低價到高價），不給就是全部。" },
        { name: "entries", in: "query", kind: "number", example: "5", desc: `最多回傳幾筆近期成交，預設 ${rest.defaultEntries}，最多 ${rest.maxEntries}。` },
        { name: "hq", in: "query", kind: "bool", desc: "true 只要 HQ、false 只要 NQ。染劑沒有 HQ，所以 hq=true 會是空的。" },
        { name: "statsWithin", in: "query", kind: "number", desc: `統計用的時間窗，${withinText}預設 ${duration(rest.defaultStatsWithinMs)}。` },
        { name: "entriesWithin", in: "query", kind: "number", desc: `只回傳這段時間內的成交，${withinText}` },
        { name: "fields", in: "query", kind: "text", desc: fieldsText },
      ],
    },
    {
      id: "history",
      title: "成交歷史",
      path: "/api/v2/history/{world}/{itemIds}",
      description: `回傳這些物品的成交歷史（新到舊）。資料庫保留 ${config.data.salesRetentionDays} 天的成交，查詢的時間窗最長 ${duration(rest.maxWindowMs)}。`,
      params: [
        { name: "world", in: "path", kind: "world", required: true, example: config.dataCenter.name, desc: worldText },
        { name: "itemIds", in: "path", kind: "items", required: true, example: "5729", desc: idsText },
        { name: "entries", in: "query", kind: "number", example: "10", desc: `最多回傳幾筆，預設與上限都是 ${rest.maxEntries}。` },
        { name: "statsWithin", in: "query", kind: "number", desc: `統計用的時間窗，${withinText}` },
        { name: "entriesWithin", in: "query", kind: "number", desc: `只回傳這段時間內的成交，${withinText}` },
        { name: "minSalePrice", in: "query", kind: "number", desc: "只回傳單價不低於這個值的成交。" },
        { name: "maxSalePrice", in: "query", kind: "number", desc: "只回傳單價不高於這個值的成交。" },
        { name: "fields", in: "query", kind: "text", desc: fieldsText },
      ],
    },
    {
      id: "worlds",
      title: "世界清單",
      path: "/api/v2/worlds",
      description: "回傳接受回報的世界。",
      params: [],
    },
    {
      id: "data-centers",
      title: "資料中心清單",
      path: "/api/v2/data-centers",
      description: "回傳資料中心與它的世界編號。",
      params: [],
    },
    {
      id: "marketable",
      title: "接受回報的物品",
      path: "/api/v2/marketable",
      description: "回傳接受回報的物品編號（＝可以查詢的物品）。",
      params: [],
    },
    {
      id: "recent",
      title: "最近被回報的物品",
      path: "/api/v2/extra/stats/most-recently-updated",
      description: "回傳最近被回報的物品，新到舊。可以用來知道哪些物品有新資料。",
      params: [
        { name: "world", in: "query", kind: "worldOptional", desc: "只看這個世界，不給就是全部。" },
        { name: "entries", in: "query", kind: "number", example: "10", desc: "回傳幾筆，預設 50，最多 200。" },
      ],
    },
  ];
}

function worldOptions(config, includeDataCenter, includeBlank) {
  const options = [];
  if (includeBlank) options.push(h("option", { value: "", text: "（不指定）" }));
  if (includeDataCenter) options.push(h("option", { value: config.dataCenter.name, text: `${config.dataCenter.name}（全部世界）` }));
  for (const world of config.worlds) options.push(h("option", { value: String(world.id), text: `${world.name}（${world.id}）` }));
  return options;
}

function buildInput(param, config, items) {
  if (param.kind === "world" || param.kind === "worldOptional") {
    const select = h("select", { name: param.name }, worldOptions(config, param.kind === "world", param.kind === "worldOptional"));
    return { control: select, wrapper: select };
  }
  if (param.kind === "bool") {
    const select = h("select", { name: param.name }, h("option", { value: "", text: "（不指定）" }), h("option", { value: "true", text: "true" }), h("option", { value: "false", text: "false" }));
    return { control: select, wrapper: select };
  }
  const input = h("input", { name: param.name, type: param.kind === "number" ? "number" : "text", min: param.kind === "number" ? 0 : undefined, placeholder: param.example ?? "", autocomplete: "off" });
  if (param.example && param.required) input.value = param.example;
  if (param.kind === "items") {
    const picker = itemPicker(items, (item) => {
      input.value = input.value.trim() ? `${input.value.trim().replace(/,$/, "")},${item.id}` : String(item.id);
    });
    return { control: input, wrapper: h("div", null, input, h("div", { class: "small muted" }, "從清單加入："), picker) };
  }
  return { control: input, wrapper: input };
}

function buildUrl(endpoint, controls) {
  let pathText = endpoint.path;
  const query = [];
  for (const param of endpoint.params) {
    const value = controls.get(param.name).value.trim();
    if (param.in === "path") pathText = pathText.replace(`{${param.name}}`, encodeURIComponent(value || `{${param.name}}`));
    else if (value !== "") query.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(value)}`);
  }
  return query.length ? `${pathText}?${query.join("&")}` : pathText;
}

function statusClass(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 400 && status < 500) return "warn";
  return "bad";
}

function renderResult(container, result, requestPath) {
  container.replaceChildren();
  const meta = h(
    "div",
    { class: "result-meta" },
    h("span", { class: `pill ${statusClass(result.status)}`, text: result.status ? String(result.status) : "連線失敗" }),
    h("span", { class: "muted", text: `${result.ms} ms` }),
    h("span", { class: "muted", text: `${result.bytes.toLocaleString("zh-TW")} 位元組` }),
  );
  for (const [name, value] of Object.entries(result.headers)) {
    if (name !== "content-type") meta.append(h("span", { class: "muted small", text: `${name}: ${value}` }));
  }
  container.append(meta);

  let text = result.text;
  if (result.json !== undefined) text = JSON.stringify(result.json, null, 2);
  const truncated = text.length > MAX_SHOWN_CHARS;
  const shown = truncated ? text.slice(0, MAX_SHOWN_CHARS) : text;

  container.append(codeBlock(shown, { json: result.json !== undefined && !truncated }));
  if (truncated) container.append(h("p", { class: "muted small", text: `內容很長，只顯示前 ${MAX_SHOWN_CHARS.toLocaleString("zh-TW")} 個字元。可以用 fields 參數只取需要的欄位。` }));
  container.append(h("p", { class: "muted small" }, "網址：", h("code", { text: requestPath })));
}

function endpointCard(endpoint, config, items, origin, open) {
  const controls = new Map();
  const form = h("div", { class: "tryit" });

  for (const param of endpoint.params) {
    const { control, wrapper } = buildInput(param, config, items);
    controls.set(param.name, control);
    form.append(
      h(
        "div",
        { class: "field" },
        h("label", { for: `${endpoint.id}-${param.name}` }, h("code", { text: param.name }), param.required ? h("span", { class: "muted", text: " *" }) : null),
        wrapper,
        h("div", { class: "hint", text: `${param.in === "path" ? "路徑" : "查詢"} · ${param.desc}` }),
      ),
    );
    control.id = `${endpoint.id}-${param.name}`;
  }

  const result = h("div", { class: "result" });
  const urlPreview = h("code", { class: "nowrap" });
  const refreshPreview = () => (urlPreview.textContent = buildUrl(endpoint, controls));
  form.addEventListener("input", refreshPreview);
  form.addEventListener("change", refreshPreview);
  refreshPreview();

  const send = h("button", { class: "primary", type: "button", text: "送出" });
  send.addEventListener("click", async () => {
    const path = buildUrl(endpoint, controls);
    send.disabled = true;
    send.textContent = "查詢中…";
    const response = await callApi(path);
    send.disabled = false;
    send.textContent = "送出";
    renderResult(result, response, `${origin}${path}`);
  });
  const copyCurl = h("button", { type: "button", text: "複製 curl" });
  copyCurl.addEventListener("click", () => copyText(`curl "${origin}${buildUrl(endpoint, controls)}"`, copyCurl));

  form.append(h("div", { class: "toolbar" }, send, copyCurl, urlPreview));
  form.append(result);

  return h(
    "details",
    { class: "endpoint", open },
    h("summary", null, h("span", { class: "method", text: "GET" }), h("span", { class: "path", text: endpoint.path }), h("span", { class: "summary-text", text: endpoint.title })),
    h(
      "div",
      { class: "body" },
      h("p", { text: endpoint.description }),
      endpoint.params.length ? table(["參數", "位置", "說明"], endpoint.params.map((param) => [h("code", { text: param.name }), param.in === "path" ? "路徑" : "查詢", param.desc])) : null,
      h("h3", { text: "試用" }),
      form,
    ),
  );
}

function referenceSection() {
  const code = (text) => h("code", { text });
  return h(
    "section",
    null,
    h("h2", { text: "回應欄位" }),
    h("p", { text: "欄位名稱與結構和 Universalis v2 相同。時間一律是 UTC 毫秒；我們沒有收集的欄位保留了鍵並給中性值。" }),
    h("h3", { text: "物品（單一世界）" }),
    table(
      ["欄位", "說明"],
      [
        [code("itemID / worldID / worldName"), "物品編號、世界編號與名稱。"],
        [code("lastUploadTime"), "這個世界最近一次被回報的時間（毫秒）。沒有資料是 0。"],
        [code("listings"), "目前的掛單，單價由低到高。"],
        [code("recentHistory"), "最近的成交，新到舊。"],
        [code("hasData"), "有人回報過這個世界這個物品時是 true。"],
        [code("minPrice / maxPrice"), "目前掛單單價的最小與最大值（NQ、HQ 各有一組，HQ 恆為 0）。"],
        [code("currentAveragePrice"), "目前掛單單價的平均。"],
        [code("averagePrice"), "統計時間窗內成交單價的平均。"],
        [code("regularSaleVelocity"), "統計時間窗內每天賣出的數量。"],
        [code("unitsForSale / unitsSold"), "目前掛單的數量總和／時間窗內成交的數量總和。"],
        [code("listingsCount / recentHistoryCount"), "計算統計用的掛單與成交筆數。"],
        [code("stackSizeHistogram"), "{ 每筆的數量: 出現次數 }。"],
      ],
    ),
    h("p", null, "查資料中心（", code("陸行鳥"), "）時，物品沒有 worldID／worldName，改成 ", code("dcName"), " 與 ", code("worldUploadTimes"), "（各世界最近回報時間）；每筆掛單與成交各自帶 ", code("worldID"), "、", code("worldName"), "。"),
    h("h3", { text: "掛單 listings[]" }),
    table(
      ["欄位", "說明"],
      [
        [code("pricePerUnit / quantity / total"), "單價、數量、總價。"],
        [code("retainerName"), "雇員名稱（市場板上公開顯示）。"],
        [code("listingID"), "遊戲給的掛單編號（字串）。"],
        [code("lastReviewTime"), "伺服器第一次看到這筆掛單的時間（毫秒）。封包裡沒有真正的上架時間，所以用這個代替。"],
        [code("hq / stainID / creatorName / creatorID / isCrafted / materia / onMannequin / retainerCity / retainerID / sellerID / tax"), "沒有收集，固定是 false、0、空字串、null 或空陣列。"],
      ],
    ),
    h("h3", { text: "成交 recentHistory[] 與 history 的 entries[]" }),
    table(
      ["欄位", "說明"],
      [
        [code("pricePerUnit / quantity"), "單價、數量。recentHistory 另有 total（總價），history 的 entries 沒有。"],
        [code("timestamp"), "成交時間（毫秒）。"],
        [code("buyerName"), "買家名稱（市場板成交紀錄上公開顯示）。"],
        [code("hq / onMannequin"), "固定是 false。"],
      ],
    ),
    h("h3", { text: "多個物品與錯誤" }),
    table(
      ["欄位", "說明"],
      [
        [code("itemIDs / items / unresolvedItems"), "請求的物品編號、每個物品的資料（以編號為鍵）、不在接受回報清單的編號。"],
        [code("type / title / status / detail / traceId"), "錯誤回應（4xx、429）的格式，跟 Universalis 相同（ASP.NET problem details）。"],
      ],
    ),
  );
}

export async function restPage({ config, items, origin }) {
  const endpoints = buildEndpoints(config);
  const element = h(
    "div",
    null,
    h("h1", { text: "REST API" }),
    h("p", null, "全部是 GET，回傳 JSON，允許任何來源的瀏覽器跨網域呼叫。位址是 ", h("code", { text: origin }), "。每個端點下面可以直接試用，請求會送到這個網站自己的 API。"),
    h("div", { class: "notice" }, "試用的請求會計入你的來源 IP 的限流。查很多物品會多扣名額，見「概覽」的限制。"),
    endpoints.map((endpoint, index) => endpointCard(endpoint, config, items, origin, index === 0)),
    referenceSection(),
  );
  return { element };
}

export function h(tag, props, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value);
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

const numberFormat = new Intl.NumberFormat("zh-TW");

export const gil = (value) => (typeof value === "number" ? numberFormat.format(value) : "—");

export function formatTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-TW", { hour12: false });
}

export function ago(ms) {
  if (!ms) return "沒有資料";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分鐘前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小時前`;
  return `${Math.round(seconds / 86400)} 天前`;
}

export function duration(ms) {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} 天`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小時`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分鐘`;
  return `${ms / 1000} 秒`;
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const original = button.textContent;
      button.textContent = "已複製";
      setTimeout(() => (button.textContent = original), 1200);
    }
  } catch {
    if (button) button.textContent = "無法複製";
  }
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** 把 JSON 文字轉成上色的節點，不使用 innerHTML。 */
export function highlightJson(text) {
  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    if (match.index > last) fragment.append(text.slice(last, match.index));
    let className = "tok-number";
    if (match[1] !== undefined) className = match[2] ? "tok-key" : "tok-string";
    else if (match[3] !== undefined) className = "tok-bool";
    else if (match[0] === "null") className = "tok-null";
    fragment.append(h("span", { class: className, text: match[0] }));
    last = match.index + match[0].length;
  }
  if (last < text.length) fragment.append(text.slice(last));
  return fragment;
}

export function codeBlock(text, options = {}) {
  const code = h("code");
  if (options.json) code.append(highlightJson(text));
  else code.textContent = text;
  const button = h("button", { class: "copy small", type: "button", text: "複製" });
  button.addEventListener("click", () => copyText(text, button));
  return h("div", { class: "codeblock" }, h("pre", null, code), button);
}

export function table(headers, rows, numericColumns = []) {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      null,
      h("thead", null, h("tr", null, headers.map((title, index) => h("th", { class: numericColumns.includes(index) ? "num" : "", text: title })))),
      h("tbody", null, rows.map((row) => h("tr", null, row.map((cell, index) => h("td", { class: numericColumns.includes(index) ? "num" : "" }, cell))))),
    ),
  );
}

/** 依名稱、英文名稱或編號搜尋物品的下拉選單；選到時呼叫 onPick(item)。 */
export function itemPicker(items, onPick, placeholder = "搜尋物品名稱或編號") {
  const input = h("input", { type: "search", placeholder, autocomplete: "off", "aria-label": placeholder });
  const list = h("div", { class: "picker-list", hidden: true });

  const render = () => {
    const query = input.value.trim().toLowerCase();
    list.replaceChildren();
    if (!query) {
      list.hidden = true;
      return;
    }
    const found = items
      .filter((item) => item.name.toLowerCase().includes(query) || (item.nameEn ?? "").toLowerCase().includes(query) || String(item.id).startsWith(query))
      .slice(0, 30);
    for (const item of found) {
      list.append(
        h("button", {
          type: "button",
          onclick: () => {
            onPick(item);
            input.value = "";
            list.hidden = true;
          },
        }, h("span", { text: item.name }), h("span", { class: "muted", text: `${item.id}${item.nameEn ? ` · ${item.nameEn}` : ""}` })),
      );
    }
    list.hidden = found.length === 0;
  };

  input.addEventListener("input", render);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") list.hidden = true;
  });
  document.addEventListener("click", (event) => {
    if (!list.contains(event.target) && event.target !== input) list.hidden = true;
  });
  return h("div", { class: "picker" }, input, list);
}

/** 呼叫同一個網站的 API，回傳狀態、耗時、標頭與內容。 */
export async function callApi(path) {
  const started = performance.now();
  try {
    const response = await fetch(path, { headers: { accept: "application/json" } });
    const text = await response.text();
    const kept = {};
    for (const name of ["content-type", "cache-control", "cf-cache-status", "age", "retry-after"]) {
      const value = response.headers.get(name);
      if (value !== null) kept[name] = value;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ok: response.ok, status: response.status, ms: Math.round(performance.now() - started), headers: kept, text, json, bytes: new TextEncoder().encode(text).length };
  } catch (error) {
    return { ok: false, status: 0, ms: Math.round(performance.now() - started), headers: {}, text: String(error), json: undefined, bytes: 0 };
  }
}

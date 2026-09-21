import { h } from "./ui.js";
import { overviewPage } from "./page-overview.js";
import { restPage } from "./page-rest.js";
import { websocketPage } from "./page-websocket.js";
import { explorerPage } from "./page-explorer.js";
import { notesPage } from "./page-notes.js";

const routes = {
  "": { title: "概覽", render: overviewPage },
  rest: { title: "REST API", render: restPage },
  websocket: { title: "WebSocket", render: websocketPage },
  explorer: { title: "資料檢視", render: explorerPage },
  notes: { title: "說明", render: notesPage },
};

const app = document.getElementById("app");
const context = { config: null, items: [], itemsById: new Map(), origin: location.origin };
let activeCleanup = null;

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}：HTTP ${response.status}`);
  return response.json();
}

function currentRoute() {
  const key = location.hash.replace(/^#\/?/, "").split("?")[0];
  return key in routes ? key : "";
}

function markActive(key) {
  for (const link of document.querySelectorAll(".nav a")) {
    link.classList.toggle("active", link.dataset.route === key);
  }
}

async function render() {
  const key = currentRoute();
  const route = routes[key];
  markActive(key);
  document.title = key ? `${route.title} · TC-Market Supplement` : "TC-Market Supplement";

  if (typeof activeCleanup === "function") activeCleanup();
  activeCleanup = null;

  app.replaceChildren(h("p", { class: "muted", text: "載入中…" }));
  try {
    const page = await route.render(context);
    app.replaceChildren(page.element);
    activeCleanup = page.cleanup ?? null;
    window.scrollTo(0, 0);
  } catch (error) {
    app.replaceChildren(h("div", { class: "notice" }, h("strong", { text: "頁面載入失敗" }), h("p", { text: String(error) })));
  }
}

async function start() {
  try {
    const [config, items] = await Promise.all([loadJson("config.json"), loadJson("items.json")]);
    context.config = config;
    context.items = items;
    context.itemsById = new Map(items.map((item) => [item.id, item]));
  } catch (error) {
    app.replaceChildren(h("div", { class: "notice" }, h("strong", { text: "無法載入網站設定" }), h("p", { text: String(error) })));
    return;
  }

  window.addEventListener("hashchange", render);
  render();
}

start();

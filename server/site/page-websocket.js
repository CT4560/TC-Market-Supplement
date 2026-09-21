import { decode, encode } from "./bson.js";
import { h, codeBlock, duration, itemPicker, table } from "./ui.js";

const MAX_LOG_LINES = 300;
const EVENTS = ["listings/add", "listings/remove", "sales/add"];

const NODE_EXAMPLE = `import WebSocket from "ws";
import { serialize, deserialize } from "bson";

const ws = new WebSocket("wss://HOST/api/ws");
ws.on("open", () => {
  ws.send(serialize({ event: "subscribe", channel: "listings/add{world=4033}" }));
  ws.send(serialize({ event: "subscribe", channel: "sales/add{world=4033,item=5729}" }));
});
ws.on("message", (data) => console.log(deserialize(data)));`;

const EVENT_EXAMPLE = `{
  "event": "listings/add",
  "item": 5729,
  "world": 4033,
  "listings": [
    { "lastReviewTime": 1789970000000, "pricePerUnit": 350, "quantity": 99, "worldName": "巴哈姆特", "worldID": 4033, "retainerName": "…", "total": 34650, "…": "…" }
  ]
}`;

function referenceSection(config, origin) {
  const ws = config.websocket;
  const url = `${origin.replace(/^http/, "ws")}${ws.path}`;
  return h(
    "div",
    null,
    h("h1", { text: "WebSocket 即時推播" }),
    h("p", null, "連線位址 ", h("code", { text: url }), "。訊息是 BSON 二進位，訂閱協定和 Universalis 相同。每次有人上傳新的掃描結果，伺服器會把新出現的掛單、消失的掛單與新的成交推給符合訂閱的連線；內容沒變就不推。"),
    h("h2", { text: "訂閱" }),
    h("p", null, "連線後送 BSON 文件 ", h("code", { text: '{ event: "subscribe", channel: "…" }' }), "，取消訂閱把 event 換成 ", h("code", { text: "unsubscribe" }), "。訂閱成功沒有回應。"),
    table(
      ["頻道", "推送的內容"],
      [
        [h("code", { text: "listings/add" }), "新出現的掛單"],
        [h("code", { text: "listings/remove" }), "這次掃描已經不在的掛單"],
        [h("code", { text: "sales/add" }), "新寫入的成交"],
      ],
    ),
    h("p", null, "頻道後面可以加篩選，", h("code", { text: "listings/add{world=4033}" }), "、", h("code", { text: "listings/add{item=5729}" }), " 或 ", h("code", { text: "listings/add{world=4033,item=5729}" }), "；不加就是該頻道的全部。"),
    h("h2", { text: "收到的訊息" }),
    codeBlock(EVENT_EXAMPLE, { json: true }),
    h("p", null, "sales/add 的欄位是 ", h("code", { text: "sales" }), " 陣列，項目格式與 REST 的 recentHistory 相同。出錯時收到 ", h("code", { text: '{ event: "error", code, message }' }), "：", h("code", { text: "invalid_message" }), "、", h("code", { text: "unknown_event" }), "、", h("code", { text: "invalid_channel" }), "、", h("code", { text: "too_many_subscriptions" }), "、", h("code", { text: "rate_limited" }), "。"),
    h("h2", { text: "限制" }),
    table(
      ["項目", "限制"],
      [
        ["連線數", `每個 IP 最多 ${ws.maxPerIp} 條，全站最多 ${ws.maxTotal} 條；超過的連線請求回 429`],
        ["訂閱數", `每條連線最多 ${ws.maxSubscriptions} 個`],
        ["客戶端訊息", `最大 ${ws.maxMessageBytes} 位元組，每秒最多 ${ws.maxMessagesPerSecond} 則`],
        ["閒置", `連上後 ${duration(ws.idleWithoutSubscriptionMs)}內沒有訂閱就會被關閉`],
        ["心跳", `伺服器每 ${duration(ws.pingIntervalMs)}送一次 ping，連線需要回 pong（一般的 WebSocket 函式庫會自動回）`],
      ],
    ),
    h("h2", { text: "Node.js 範例" }),
    codeBlock(NODE_EXAMPLE.replace("HOST", location.host)),
  );
}

export async function websocketPage({ config, items, origin }) {
  const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${config.websocket.path}`;
  let socket = null;
  const subscriptions = new Set();

  const log = h("div", { class: "log", role: "log", "aria-live": "polite" });
  const status = h("span", { class: "pill", text: "未連線" });
  const subsList = h("div", { class: "subs" });

  const addLine = (kind, text) => {
    const line = h("div", { class: "line" }, h("span", { class: "time", text: new Date().toLocaleTimeString("zh-TW", { hour12: false }) }), h("span", { class: `dir-${kind}`, text }));
    log.append(line);
    while (log.childElementCount > MAX_LOG_LINES) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  };

  const setStatus = (text, kind) => {
    status.textContent = text;
    status.className = `pill ${kind}`;
  };

  const renderSubs = () => {
    subsList.replaceChildren();
    if (subscriptions.size === 0) {
      subsList.append(h("span", { class: "muted small", text: "目前沒有訂閱" }));
      return;
    }
    for (const channel of subscriptions) {
      subsList.append(h("span", { class: "chip" }, channel, h("button", { class: "small", type: "button", text: "取消", onclick: () => unsubscribe(channel) })));
    }
  };

  const send = (message) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      addLine("err", "尚未連線");
      return false;
    }
    socket.send(encode(message));
    addLine("out", JSON.stringify(message));
    return true;
  };

  const unsubscribe = (channel) => {
    if (send({ event: "unsubscribe", channel })) {
      subscriptions.delete(channel);
      renderSubs();
    }
  };

  const connectButton = h("button", { class: "primary", type: "button", text: "連線" });
  const disconnectButton = h("button", { type: "button", text: "中斷連線", disabled: true });

  connectButton.addEventListener("click", () => {
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    addLine("sys", `連線到 ${wsUrl}`);
    setStatus("連線中", "warn");
    socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      setStatus("已連線", "ok");
      connectButton.disabled = true;
      disconnectButton.disabled = false;
      addLine("sys", "已連線");
    });
    socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        addLine("err", `收到非 BSON 訊息：${String(event.data).slice(0, 200)}`);
        return;
      }
      try {
        const text = JSON.stringify(decode(new Uint8Array(event.data)));
        addLine("in", text.length > 1500 ? `${text.slice(0, 1500)}…（共 ${text.length} 字元）` : text);
      } catch (error) {
        addLine("err", `無法解析訊息：${error.message}`);
      }
    });
    socket.addEventListener("close", (event) => {
      setStatus("未連線", "");
      connectButton.disabled = false;
      disconnectButton.disabled = true;
      subscriptions.clear();
      renderSubs();
      addLine("sys", `連線已關閉（代碼 ${event.code}${event.reason ? `，${event.reason}` : ""}）`);
    });
    socket.addEventListener("error", () => addLine("err", "連線錯誤（可能是連線數已達上限，或網路無法連到）"));
  });
  disconnectButton.addEventListener("click", () => socket?.close(1000));

  const eventSelect = h("select", { "aria-label": "頻道" }, EVENTS.map((name) => h("option", { value: name, text: name })));
  const worldSelect = h("select", { "aria-label": "世界" }, h("option", { value: "", text: "全部世界" }), config.worlds.map((world) => h("option", { value: String(world.id), text: `${world.name}（${world.id}）` })));
  const itemInput = h("input", { type: "number", min: 1, placeholder: "物品編號（可省略）", "aria-label": "物品編號" });
  const picker = itemPicker(items, (item) => (itemInput.value = String(item.id)));

  const subscribeButton = h("button", { type: "button", text: "訂閱" });
  subscribeButton.addEventListener("click", () => {
    const filters = [];
    if (worldSelect.value) filters.push(`world=${worldSelect.value}`);
    if (itemInput.value.trim()) filters.push(`item=${itemInput.value.trim()}`);
    const channel = filters.length ? `${eventSelect.value}{${filters.join(",")}}` : eventSelect.value;
    if (send({ event: "subscribe", channel })) {
      subscriptions.add(channel);
      renderSubs();
    }
  });

  const clearButton = h("button", { class: "small", type: "button", text: "清除紀錄", onclick: () => log.replaceChildren() });
  renderSubs();

  const tester = h(
    "section",
    null,
    h("h2", { text: "測試" }),
    h("p", { class: "muted", text: "在這個頁面直接連線、訂閱並看收到的訊息（BSON 由頁面自己解碼）。有人上傳新的掃描結果時才會有事件。" }),
    h("div", { class: "toolbar" }, connectButton, disconnectButton, status),
    h("div", { class: "toolbar" }, eventSelect, worldSelect, itemInput, subscribeButton),
    picker,
    subsList,
    h("div", { class: "toolbar" }, h("strong", { text: "紀錄" }), clearButton),
    log,
  );

  const element = h("div", null, referenceSection(config, origin), tester);
  return { element, cleanup: () => socket?.close(1000) };
}

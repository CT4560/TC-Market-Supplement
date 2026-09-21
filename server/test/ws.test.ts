import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { serialize, deserialize } from "bson";
import Database from "better-sqlite3";
import { CollectorStore } from "../src/store.js";
import { createApp } from "../src/server.js";
import { WsHub, parseChannel, type WsHubOptions } from "../src/ws-hub.js";
import { UploadRateLimiter } from "../src/community.js";

const ITEM = 5729;
const ITEM2 = 5730;
const W = 4033;

interface App {
  wsUrl: string;
  base: string;
  hub: WsHub;
  close: () => Promise<void>;
}

const apps: App[] = [];
after(async () => {
  for (const app of apps) await app.close();
});

async function startApp(hubOptions: Partial<WsHubOptions> = {}, env: Record<string, string> = { COMMUNITY_UPLOAD_ENABLED: "on", COMMUNITY_API_ENABLED: "on" }): Promise<App> {
  const store = new CollectorStore(new Database(":memory:"));
  store.replaceItems([{ id: ITEM, name: "素雪白" }, { id: ITEM2, name: "蒼白灰" }]);
  const hub = new WsHub(hubOptions);
  const server = createApp({
    store,
    hub,
    env: env as NodeJS.ProcessEnv,
    rateLimiter: new UploadRateLimiter(0),
    log: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const app: App = {
    wsUrl: `ws://127.0.0.1:${port}/api/ws`,
    base: `http://127.0.0.1:${port}`,
    hub,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
  apps.push(app);
  return app;
}

class Client {
  readonly messages: Array<Record<string, any>> = [];
  private waiters: Array<(message: Record<string, any>) => void> = [];
  closed: Promise<number>;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      assert.ok(isBinary, "伺服器只送二進位（BSON）訊息");
      const message = deserialize(data) as Record<string, any>;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
    this.closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  }

  send(message: unknown): void {
    this.ws.send(serialize(message as Record<string, unknown>));
  }

  next(timeoutMs = 1500): Promise<Record<string, any>> {
    const queued = this.messages.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等不到訊息")), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  async expectSilence(ms = 250): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    assert.deepEqual(this.messages, [], "不該收到訊息");
  }
}

function connect(app: App, ip: string, options: WebSocket.ClientOptions = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(app.wsUrl, { headers: { "cf-connecting-ip": ip }, ...options });
    ws.once("open", () => resolve(new Client(ws)));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode })));
  });
}

let uploadCounter = 0;
async function upload(app: App, body: Record<string, unknown>): Promise<number> {
  const now = Date.now();
  const response = await fetch(`${app.base}/community/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `192.0.2.${(uploadCounter++ % 250) + 1}` },
    body: JSON.stringify({ worldId: W, itemId: ITEM, capturedAt: now - 500, listings: [], sales: [], ...body }),
  });
  return response.status;
}

const listing = (price: number, id: string, retainer = "雇員") => ({ pricePerUnit: price, quantity: 2, retainerName: retainer, listingId: id });

describe("頻道字串", () => {
  test("合法的頻道", () => {
    assert.deepEqual(parseChannel("listings/add"), { event: "listings/add" });
    assert.deepEqual(parseChannel("listings/remove{world=4033}"), { event: "listings/remove", world: 4033 });
    assert.deepEqual(parseChannel("sales/add{world=4033,item=5729}"), { event: "sales/add", world: 4033, item: 5729 });
    assert.deepEqual(parseChannel("sales/add{ item = 5729 , world = 4033 }"), { event: "sales/add", world: 4033, item: 5729 });
    assert.deepEqual(parseChannel("listings/add{}"), { event: "listings/add" });
  });

  test("壞的頻道", () => {
    for (const bad of ["", "listings", "sales/remove", "listings/add{world=74}", "listings/add{world=abc}", "listings/add{foo=1}", "listings/add{world=4033,world=4035}", "listings/add{world=4033", "x".repeat(300), 5, null]) {
      assert.equal(parseChannel(bad), null, String(bad));
    }
  });
});

describe("即時推播（WebSocket）", () => {
  test("訂閱後，上傳造成的新掛單與新成交會推過來；欄位跟 REST 一致、時間是毫秒", async () => {
    const app = await startApp();
    const client = await connect(app, "203.0.113.1");
    client.send({ event: "subscribe", channel: `listings/add{world=${W},item=${ITEM}}` });
    client.send({ event: "subscribe", channel: `sales/add{world=${W}}` });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const now = Date.now();
    assert.equal(await upload(app, { listings: [listing(350, "1001", "沐玥")], sales: [{ pricePerUnit: 400, quantity: 5, buyerName: "夏沐", timestamp: now - 60_000 }] }), 200);

    const events = [await client.next(), await client.next()];
    const added = events.find((e) => e.event === "listings/add")!;
    const sales = events.find((e) => e.event === "sales/add")!;
    assert.equal(added.item, ITEM);
    assert.equal(added.world, W);
    assert.equal(added.listings.length, 1);
    assert.equal(added.listings[0].retainerName, "沐玥");
    assert.equal(added.listings[0].worldName, "巴哈姆特");
    assert.ok(added.listings[0].lastReviewTime > 1_700_000_000_000);
    assert.equal(sales.sales[0].buyerName, "夏沐");
    assert.equal(sales.sales[0].total, 2000);
    assert.equal(sales.sales[0].timestamp, now - 60_000);
    await client.expectSilence();
  });

  test("listings/remove：掛單消失時推送；內容沒變就不推", async () => {
    const app = await startApp();
    const client = await connect(app, "203.0.113.2");
    client.send({ event: "subscribe", channel: "listings/remove" });
    client.send({ event: "subscribe", channel: "listings/add" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await upload(app, { listings: [listing(100, "1"), listing(200, "2")] });
    assert.equal((await client.next()).event, "listings/add");

    await upload(app, { listings: [listing(100, "1"), listing(200, "2")] }); // 完全沒變
    await client.expectSilence();

    await upload(app, { listings: [listing(100, "1")] }); // 2 賣掉了
    const removed = await client.next();
    assert.equal(removed.event, "listings/remove");
    assert.deepEqual(removed.listings.map((l: any) => l.listingID), ["2"]);
  });

  test("篩選：只收訂閱的物品／世界；unsubscribe 之後不再收", async () => {
    const app = await startApp();
    const client = await connect(app, "203.0.113.3");
    client.send({ event: "subscribe", channel: `listings/add{item=${ITEM2}}` });
    client.send({ event: "subscribe", channel: `listings/add{world=4035}` });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await upload(app, { itemId: ITEM, listings: [listing(100, "1")] }); // 物品與世界都不符
    await client.expectSilence();

    await upload(app, { itemId: ITEM2, listings: [listing(100, "2")] });
    assert.equal((await client.next()).item, ITEM2);

    client.send({ event: "unsubscribe", channel: `listings/add{item=${ITEM2}}` });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await upload(app, { itemId: ITEM2, listings: [listing(100, "2"), listing(150, "3")] });
    await client.expectSilence();
  });

  test("多個連線各自收到；同一連線同一事件不重複收", async () => {
    const app = await startApp();
    const a = await connect(app, "203.0.113.4");
    const b = await connect(app, "203.0.113.5");
    for (const client of [a, b]) {
      client.send({ event: "subscribe", channel: "listings/add" });
      client.send({ event: "subscribe", channel: `listings/add{world=${W}}` }); // 兩個訂閱都符合
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    await upload(app, { listings: [listing(100, "1")] });
    assert.equal((await a.next()).event, "listings/add");
    assert.equal((await b.next()).event, "listings/add");
    await a.expectSilence();
    await b.expectSilence();
  });

  test("壞訊息：文字訊息、不是 BSON、未知事件、壞頻道都回 error 事件，連線保持", async () => {
    const app = await startApp();
    const client = await connect(app, "203.0.113.6");

    client.ws.send("subscribe please");
    assert.equal((await client.next()).code, "invalid_message");
    client.ws.send(Buffer.from([1, 2, 3]));
    assert.equal((await client.next()).code, "invalid_message");
    client.send({ event: "hello" });
    assert.equal((await client.next()).code, "unknown_event");
    client.send({ event: "subscribe", channel: "listings/add{world=1}" });
    const error = await client.next();
    assert.equal(error.event, "error");
    assert.equal(error.code, "invalid_channel");
    assert.equal(client.ws.readyState, WebSocket.OPEN);
  });

  test("每條連線最多 30 個訂閱（測試用 3）", async () => {
    const app = await startApp({ maxSubscriptions: 3 });
    const client = await connect(app, "203.0.113.7");
    for (const item of [1, 2, 3]) client.send({ event: "subscribe", channel: `listings/add{item=${item}}` });
    client.send({ event: "subscribe", channel: "listings/add{item=1}" }); // 重複訂閱不算新增
    client.send({ event: "subscribe", channel: "listings/add{item=4}" });
    const error = await client.next();
    assert.equal(error.code, "too_many_subscriptions");
    assert.equal(app.hub.stats().subscriptions, 3);
  });

  test("每個 IP 最多 4 條連線，第 5 條回 429；別的 IP 不受影響；關掉一條就能再連", async () => {
    const app = await startApp();
    const clients: Client[] = [];
    for (let i = 0; i < 4; i++) clients.push(await connect(app, "203.0.113.8"));

    await assert.rejects(connect(app, "203.0.113.8"), (error: any) => error.statusCode === 429);
    const other = await connect(app, "203.0.113.9");
    assert.equal(other.ws.readyState, WebSocket.OPEN);

    clients[0].ws.close();
    await clients[0].closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await connect(app, "203.0.113.8");
    assert.equal(again.ws.readyState, WebSocket.OPEN);
    assert.equal(app.hub.stats().connections, 5);
  });

  test("全站連線上限（測試用 2）", async () => {
    const app = await startApp({ maxTotal: 2 });
    await connect(app, "203.0.113.10");
    await connect(app, "203.0.113.11");
    await assert.rejects(connect(app, "203.0.113.12"), (error: any) => error.statusCode === 429);
  });

  test("客戶端訊息太快（每秒超過 5 則）：回 rate_limited 並關線", async () => {
    const app = await startApp();
    const client = await connect(app, "203.0.113.13");
    for (let i = 0; i < 8; i++) client.send({ event: "subscribe", channel: "listings/add{item=1}" });
    assert.equal(await client.closed, 1008);
  });

  test("客戶端訊息太大（超過 1 KB）：連線被關（1009）", async () => {
    const app = await startApp();
    const client = await connect(app, "203.0.113.14");
    client.ws.send(Buffer.alloc(4096, 1));
    assert.equal(await client.closed, 1009);
  });

  test("連上後一直沒有訂閱就會被關", async () => {
    const app = await startApp({ idleWithoutSubscriptionMs: 150 });
    const idle = await connect(app, "203.0.113.15");
    const active = await connect(app, "203.0.113.16");
    active.send({ event: "subscribe", channel: "sales/add" });
    assert.equal(await idle.closed, 1008);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(active.ws.readyState, WebSocket.OPEN);
  });

  test("心跳：會回 pong 的連線留著；不回 pong 的被終止", async () => {
    const app = await startApp({ pingIntervalMs: 80 });
    const good = await connect(app, "203.0.113.17");
    good.send({ event: "subscribe", channel: "sales/add" });
    const dead = await connect(app, "203.0.113.18", { autoPong: false });
    dead.send({ event: "subscribe", channel: "sales/add" });

    await dead.closed;
    for (let i = 0; i < 20 && app.hub.stats().connections !== 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(good.ws.readyState, WebSocket.OPEN);
    assert.equal(app.hub.stats().connections, 1);
  });

  test("COMMUNITY_API_ENABLED 沒開、或路徑不是 /api/ws：升級被拒（404）", async () => {
    const off = await startApp({}, { COMMUNITY_UPLOAD_ENABLED: "on" });
    await assert.rejects(connect(off, "203.0.113.19"), (error: any) => error.statusCode === 404);

    const on = await startApp();
    const wrongPath = new WebSocket(on.wsUrl.replace("/api/ws", "/nope"), { headers: { "cf-connecting-ip": "203.0.113.20" } });
    await new Promise<void>((resolve) => {
      wrongPath.once("unexpected-response", (_req, res) => {
        assert.equal(res.statusCode, 404);
        resolve();
      });
      wrongPath.once("error", () => undefined);
    });
  });
});

import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { serialize, deserialize } from "bson";
import { TW_WORLDS } from "./worlds.js";
import { formatListing, formatRecentSale, type WorldRef } from "./read-model.js";
import type { UploadChanges } from "./community.js";

// 即時推播：WebSocket，訊息是 BSON，訂閱協定跟 Universalis 相同。
//   客戶端 → 伺服器  {event:"subscribe", channel:"listings/add{world=4033,item=5729}"}（unsubscribe 同格式）
//   伺服器 → 客戶端  {event:"listings/add", item, world, listings:[…]}、{event:"listings/remove", …}、{event:"sales/add", item, world, sales:[…]}
//   錯誤            {event:"error", code, message}
// 頻道的篩選 world、item 都可以省略（省略＝該頻道全部），但只會有這個服務接受的世界與物品的資料。

export const WS_PATH = "/api/ws";

export interface WsHubOptions {
  /** 每個來源 IP 最多同時幾條連線（Universalis 是 8）。 */
  maxPerIp: number;
  /** 全站最多同時幾條連線。 */
  maxTotal: number;
  /** 每條連線最多幾個訂閱。 */
  maxSubscriptions: number;
  /** 客戶端單一訊息的大小上限（位元組），超過由 ws 直接關線（1009）。 */
  maxMessageBytes: number;
  /** 客戶端每秒最多幾則訊息。 */
  maxMessagesPerSecond: number;
  /** 連上後多久內沒有訂閱任何頻道就關掉。 */
  idleWithoutSubscriptionMs: number;
  /** 協定層 ping 的間隔（Cloudflare 閒置 100 秒會斷，所以要比這個短很多）。 */
  pingIntervalMs: number;
  /** 送出緩衝超過這個量（客戶端太慢）就關線，位元組。 */
  maxBufferedBytes: number;
}

export const DEFAULT_WS_OPTIONS: WsHubOptions = {
  maxPerIp: 4,
  maxTotal: 300,
  maxSubscriptions: 30,
  maxMessageBytes: 1024,
  maxMessagesPerSecond: 5,
  idleWithoutSubscriptionMs: 60_000,
  pingIntervalMs: 30_000,
  maxBufferedBytes: 1024 * 1024,
};

const EVENTS = ["listings/add", "listings/remove", "sales/add"] as const;
type EventName = (typeof EVENTS)[number];

interface Subscription {
  event: EventName;
  world?: number;
  item?: number;
}

const WORLD_IDS = new Set(TW_WORLDS.map((world) => world.id));
const WORLD_BY_ID = new Map<number, WorldRef>(TW_WORLDS.map((world) => [world.id, { id: world.id, name: world.name }]));

/** 解析頻道字串，例如 `listings/add{world=4033,item=5729}`。格式不對回 null。 */
export function parseChannel(channel: unknown): Subscription | null {
  if (typeof channel !== "string" || channel.length > 200) return null;
  const match = /^(listings\/add|listings\/remove|sales\/add)(?:\{([^{}]*)\})?$/.exec(channel);
  if (!match) return null;

  const subscription: Subscription = { event: match[1] as EventName };
  const filter = match[2];
  if (filter === undefined || filter.trim() === "") return subscription;

  for (const part of filter.split(",")) {
    const pair = /^\s*(world|item)\s*=\s*(\d{1,9})\s*$/.exec(part);
    if (!pair) return null;
    const key = pair[1] as "world" | "item";
    if (subscription[key] !== undefined) return null;
    subscription[key] = Number(pair[2]);
  }
  if (subscription.world !== undefined && !WORLD_IDS.has(subscription.world)) return null;
  return subscription;
}

const channelKey = (s: Subscription): string => `${s.event}|${s.world ?? "*"}|${s.item ?? "*"}`;

function matches(subscription: Subscription, event: EventName, worldId: number, itemId: number): boolean {
  return (
    subscription.event === event &&
    (subscription.world === undefined || subscription.world === worldId) &&
    (subscription.item === undefined || subscription.item === itemId)
  );
}

interface Connection {
  ip: string;
  socket: WebSocket;
  subscriptions: Map<string, Subscription>;
  alive: boolean;
  recentMessages: number[];
  idleTimer: ReturnType<typeof setTimeout>;
}

export class WsHub {
  private readonly options: WsHubOptions;
  private readonly wss: WebSocketServer;
  private readonly connections = new Set<Connection>();
  private readonly perIp = new Map<string, number>();
  private readonly pingTimer: ReturnType<typeof setInterval>;

  constructor(options: Partial<WsHubOptions> = {}, private readonly now: () => number = Date.now) {
    this.options = { ...DEFAULT_WS_OPTIONS, ...options };
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.options.maxMessageBytes });
    this.pingTimer = setInterval(() => this.heartbeat(), this.options.pingIntervalMs);
    this.pingTimer.unref();
  }

  stats(): { connections: number; subscriptions: number } {
    let subscriptions = 0;
    for (const connection of this.connections) subscriptions += connection.subscriptions.size;
    return { connections: this.connections.size, subscriptions };
  }

  /** 處理 HTTP 的 upgrade 請求：超過連線上限就回 429 並關掉，否則升級成 WebSocket。 */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, ip: string): void {
    if (this.connections.size >= this.options.maxTotal || (this.perIp.get(ip) ?? 0) >= this.options.maxPerIp) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
  }

  private onConnection(socket: WebSocket, ip: string): void {
    const connection: Connection = {
      ip,
      socket,
      subscriptions: new Map(),
      alive: true,
      recentMessages: [],
      idleTimer: setTimeout(() => this.closeIdle(connection), this.options.idleWithoutSubscriptionMs),
    };
    connection.idleTimer.unref();
    this.connections.add(connection);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);

    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("message", (data: RawData, isBinary: boolean) => this.onMessage(connection, data, isBinary));
    socket.on("close", () => this.remove(connection));
    socket.on("error", () => socket.terminate());
  }

  private remove(connection: Connection): void {
    clearTimeout(connection.idleTimer);
    if (!this.connections.delete(connection)) return;
    const left = (this.perIp.get(connection.ip) ?? 1) - 1;
    if (left <= 0) this.perIp.delete(connection.ip);
    else this.perIp.set(connection.ip, left);
  }

  private closeIdle(connection: Connection): void {
    if (connection.subscriptions.size === 0) connection.socket.close(1008, "no subscription");
  }

  private sendError(connection: Connection, code: string, message: string): void {
    this.sendRaw(connection, serialize({ event: "error", code, message }));
  }

  private sendRaw(connection: Connection, payload: Uint8Array): void {
    const socket = connection.socket;
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > this.options.maxBufferedBytes) {
      socket.terminate(); // 客戶端讀太慢，不能讓緩衝一直長大
      return;
    }
    socket.send(payload, { binary: true });
  }

  private onMessage(connection: Connection, data: RawData, isBinary: boolean): void {
    // 速率：滑動一秒視窗內最多 maxMessagesPerSecond 則
    const current = this.now();
    connection.recentMessages = connection.recentMessages.filter((at) => current - at < 1000);
    if (connection.recentMessages.length >= this.options.maxMessagesPerSecond) {
      this.sendError(connection, "rate_limited", "Too many messages.");
      connection.socket.close(1008, "rate limited");
      return;
    }
    connection.recentMessages.push(current);

    let message: Record<string, unknown>;
    try {
      if (!isBinary) throw new Error("text frame");
      const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      message = deserialize(buffer) as Record<string, unknown>;
    } catch {
      this.sendError(connection, "invalid_message", "Messages must be BSON documents.");
      return;
    }

    const event = message.event;
    if (event !== "subscribe" && event !== "unsubscribe") {
      this.sendError(connection, "unknown_event", "Unknown event; use subscribe or unsubscribe.");
      return;
    }

    const subscription = parseChannel(message.channel);
    if (!subscription) {
      this.sendError(connection, "invalid_channel", "Invalid channel. Example: listings/add{world=4033,item=5729}");
      return;
    }

    const key = channelKey(subscription);
    if (event === "unsubscribe") {
      connection.subscriptions.delete(key);
      return;
    }

    if (!connection.subscriptions.has(key) && connection.subscriptions.size >= this.options.maxSubscriptions) {
      this.sendError(connection, "too_many_subscriptions", `At most ${this.options.maxSubscriptions} subscriptions per connection.`);
      return;
    }
    connection.subscriptions.set(key, subscription);
    clearTimeout(connection.idleTimer);
  }

  /** 上傳寫入成功後呼叫：把這次的變動推給符合訂閱的連線。內容沒變的（三個清單都空）不推。 */
  publish(changes: UploadChanges): void {
    if (this.connections.size === 0) return;
    const world = WORLD_BY_ID.get(changes.worldId);
    if (!world) return;

    // 每種事件的 BSON 只做一次，發給所有符合的連線
    const payloads: Array<[EventName, () => Uint8Array]> = [];
    if (changes.addedListings.length > 0) {
      payloads.push(["listings/add", () => serialize({ event: "listings/add", item: changes.itemId, world: changes.worldId, listings: changes.addedListings.map((l) => formatListing(l, world)) })]);
    }
    if (changes.removedListings.length > 0) {
      payloads.push(["listings/remove", () => serialize({ event: "listings/remove", item: changes.itemId, world: changes.worldId, listings: changes.removedListings.map((l) => formatListing(l, world)) })]);
    }
    if (changes.newSales.length > 0) {
      payloads.push(["sales/add", () => serialize({ event: "sales/add", item: changes.itemId, world: changes.worldId, sales: changes.newSales.map((s) => formatRecentSale(s, world)) })]);
    }

    for (const [event, build] of payloads) {
      let encoded: Uint8Array | undefined;
      for (const connection of this.connections) {
        for (const subscription of connection.subscriptions.values()) {
          if (!matches(subscription, event, changes.worldId, changes.itemId)) continue;
          encoded ??= build();
          this.sendRaw(connection, encoded);
          break; // 同一個連線同一個事件只送一次
        }
      }
    }
  }

  private heartbeat(): void {
    for (const connection of this.connections) {
      if (!connection.alive) {
        connection.socket.terminate(); // 上一輪 ping 都沒回 pong
        continue;
      }
      connection.alive = false;
      try {
        connection.socket.ping();
      } catch {
        connection.socket.terminate();
      }
    }
  }

  close(): void {
    clearInterval(this.pingTimer);
    for (const connection of [...this.connections]) {
      clearTimeout(connection.idleTimer);
      connection.socket.terminate();
    }
    this.connections.clear();
    this.perIp.clear();
    this.wss.close();
  }
}

import Database from "better-sqlite3";

/** 成交只留 30 天（依成交發生的時間，不是收到的時間）。 */
export const SALES_RETENTION_MS = 30 * 86_400_000;

/** 一筆目前的掛單。 */
export interface StoredListing {
  pricePerUnit: number;
  quantity: number;
  total: number;
  retainerName: string;
  /** 遊戲給的掛單編號（十進位字串）。沒有的資料就沒有這個欄位。 */
  listingId?: string;
  /** 伺服器「第一次看到這筆掛單」的時間，毫秒。封包裡沒有真正的上架時間，所以用這個代替。 */
  firstSeenAt: number;
}

export interface StoredEntry {
  listings: StoredListing[];
  /** 最近一次掃描（外掛擷取封包）的時間，毫秒。 */
  uploadedAt: number;
}

export interface StoredSale {
  pricePerUnit: number;
  quantity: number;
  /** 買家名稱；沒有就是空字串。 */
  buyerName: string;
  /** 成交發生的時間，毫秒。 */
  saleTimestamp: number;
}

/** 最近一次被回報的物品（給 most-recently-updated 用）。 */
export interface RecentUpdate {
  worldId: number;
  itemId: number;
  uploadedAt: number;
}

export interface CollectorItem {
  id: number;
  name: string;
  nameEn?: string | null;
}

function prepareStatements(db: Database.Database) {
  return {
    getSnapshot: db.prepare(`SELECT listings, uploadedAt FROM snapshot WHERE worldId = ? AND itemId = ?`),
    upsertSnapshot: db.prepare(`
      INSERT INTO snapshot (worldId, itemId, listings, uploadedAt) VALUES (@worldId, @itemId, @listings, @uploadedAt)
      ON CONFLICT (worldId, itemId) DO UPDATE SET listings = excluded.listings, uploadedAt = excluded.uploadedAt
    `),
    insertSale: db.prepare(`
      INSERT OR IGNORE INTO sales (worldId, itemId, pricePerUnit, quantity, buyerName, saleTimestamp, capturedAt)
      VALUES (@worldId, @itemId, @pricePerUnit, @quantity, @buyerName, @saleTimestamp, @capturedAt)
    `),
    deleteOldSales: db.prepare(`DELETE FROM sales WHERE saleTimestamp < ?`),
    countSales: db.prepare(`SELECT COUNT(*) AS n FROM sales`),
    itemIds: db.prepare(`SELECT id FROM items ORDER BY id`),
    hasItem: db.prepare(`SELECT 1 FROM items WHERE id = ?`),
    deleteItems: db.prepare(`DELETE FROM items`),
    insertItem: db.prepare(`INSERT INTO items (id, name, name_en) VALUES (@id, @name, @nameEn)`),
    getSales: db.prepare(`
      SELECT pricePerUnit, quantity, buyerName, saleTimestamp FROM sales
      WHERE worldId = ? AND itemId = ? AND saleTimestamp >= ?
      ORDER BY saleTimestamp DESC, id DESC LIMIT ?
    `),
    mostRecent: db.prepare(`
      SELECT worldId, itemId, uploadedAt FROM snapshot
      WHERE (? IS NULL OR worldId = ?)
      ORDER BY uploadedAt DESC LIMIT ?
    `),
  };
}

type Statements = ReturnType<typeof prepareStatements>;

/**
 * 這個服務自己的資料庫（SQLite），跟任何其他專案的資料庫都沒有關係。
 * 資料表：
 *   items    可接受回報的物品清單（白名單）
 *   snapshot 每個世界每個物品「目前的掛單」
 *   sales    成交紀錄（含買家名稱，市場板成交紀錄上本來就公開顯示）
 */
export class CollectorStore {
  private readonly stmts: Statements;

  constructor(private readonly db: Database.Database) {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        name_en TEXT
      );

      CREATE TABLE IF NOT EXISTS snapshot (
        worldId INTEGER NOT NULL,
        itemId INTEGER NOT NULL,
        listings TEXT NOT NULL,
        uploadedAt INTEGER NOT NULL,
        PRIMARY KEY (worldId, itemId)
      );

      CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worldId INTEGER NOT NULL,
        itemId INTEGER NOT NULL,
        pricePerUnit INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        buyerName TEXT NOT NULL DEFAULT '',
        saleTimestamp INTEGER NOT NULL,
        capturedAt INTEGER NOT NULL,
        UNIQUE (worldId, itemId, saleTimestamp, pricePerUnit, quantity, buyerName)
      );
      CREATE INDEX IF NOT EXISTS idx_sales_world_item_ts ON sales (worldId, itemId, saleTimestamp);
      CREATE INDEX IF NOT EXISTS idx_sales_saleTimestamp ON sales (saleTimestamp);
    `);
    this.stmts = prepareStatements(db);
  }

  // ---------- 物品白名單 ----------

  /** 用給定的清單整份取代白名單（啟動時從 data/items.json 讀進來）。 */
  replaceItems(items: CollectorItem[]): void {
    this.db.transaction(() => {
      this.stmts.deleteItems.run();
      for (const item of items) this.stmts.insertItem.run({ id: item.id, name: item.name, nameEn: item.nameEn ?? null });
    })();
  }

  isAcceptedItem = (itemId: number): boolean => this.stmts.hasItem.get(itemId) !== undefined;

  itemIds(): number[] {
    return (this.stmts.itemIds.all() as Array<{ id: number }>).map((row) => row.id);
  }

  // ---------- 掛單 ----------

  getEntry(worldId: number, itemId: number): StoredEntry | undefined {
    const row = this.stmts.getSnapshot.get(worldId, itemId) as { listings: string; uploadedAt: number } | undefined;
    if (!row) return undefined;

    let listings: StoredListing[] = [];
    try {
      const parsed: unknown = JSON.parse(row.listings);
      if (Array.isArray(parsed)) listings = parsed as StoredListing[];
    } catch {
      // 壞掉的內容當作沒有掛單，下一次上傳會整份取代
    }
    return { listings, uploadedAt: row.uploadedAt };
  }

  setEntry(worldId: number, itemId: number, listings: StoredListing[], uploadedAt: number): void {
    this.stmts.upsertSnapshot.run({ worldId, itemId, listings: JSON.stringify(listings), uploadedAt });
  }

  // ---------- 成交 ----------

  /**
   * 一批成交包成一個交易寫入；回傳「真的新增」的那幾筆（重複的會被唯一索引擋掉，超過保留期的略過）。
   * 呼叫端拿它當即時推播的內容，所以只能回真的寫進去的。
   */
  insertSales = (worldId: number, itemId: number, sales: StoredSale[], capturedAt: number, now: number = Date.now()): StoredSale[] => {
    return this.db.transaction((): StoredSale[] => {
      const inserted: StoredSale[] = [];
      const oldestKept = now - SALES_RETENTION_MS;
      for (const sale of sales) {
        if (sale.saleTimestamp < oldestKept) continue;
        if (this.stmts.insertSale.run({ worldId, itemId, ...sale, capturedAt }).changes > 0) inserted.push(sale);
      }
      return inserted;
    })();
  };

  /** 某世界某物品的成交，新到舊；sinceMs 以前的不回（毫秒時間戳記）。 */
  getSales(worldId: number, itemId: number, options: { sinceMs?: number; limit?: number } = {}): StoredSale[] {
    const rows = this.stmts.getSales.all(worldId, itemId, options.sinceMs ?? 0, options.limit ?? 1800) as StoredSale[];
    return rows;
  }

  /** 最近被回報的物品，新到舊；worldId 給了就只看那個世界。 */
  mostRecentlyUpdated(worldId: number | null, limit: number): RecentUpdate[] {
    return this.stmts.mostRecent.all(worldId, worldId, limit) as RecentUpdate[];
  }

  pruneOldSales(now: number = Date.now()): number {
    return this.stmts.deleteOldSales.run(now - SALES_RETENTION_MS).changes;
  }

  countSales(): number {
    return (this.stmts.countSales.get() as { n: number }).n;
  }

  /** 連線探測，給 /health 用；資料庫壞了會丟出例外。 */
  ping(): void {
    this.db.prepare("SELECT 1").get();
  }

  close(): void {
    this.db.close();
  }
}

export function openStore(file: string): CollectorStore {
  return new CollectorStore(new Database(file));
}

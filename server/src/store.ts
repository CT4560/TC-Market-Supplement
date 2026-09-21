import Database from "better-sqlite3";

/** 成交保留一年。 */
export const SALES_RETENTION_MS = 365 * 86_400_000;

export interface StoredListing {
  pricePerUnit: number;
  quantity: number;
  total: number;
  retainerName: string;
  listingId?: string;
  /** 伺服器第一次看到這筆掛單的時間（毫秒），因為封包沒有真正的上架時間。 */
  firstSeenAt: number;
}

export interface StoredEntry {
  listings: StoredListing[];
  uploadedAt: number;
}

export interface StoredSale {
  pricePerUnit: number;
  quantity: number;
  buyerName: string;
  saleTimestamp: number;
}

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

/** SQLite：items（白名單）、snapshot（目前掛單）、sales（成交，含買家名稱）。 */
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
    }
    return { listings, uploadedAt: row.uploadedAt };
  }

  setEntry(worldId: number, itemId: number, listings: StoredListing[], uploadedAt: number): void {
    this.stmts.upsertSnapshot.run({ worldId, itemId, listings: JSON.stringify(listings), uploadedAt });
  }

  // ---------- 成交 ----------

  /** 一批成交寫成一個交易，回傳真的新增的（重複的、過期的不算）。 */
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

  getSales(worldId: number, itemId: number, options: { sinceMs?: number; limit?: number } = {}): StoredSale[] {
    const rows = this.stmts.getSales.all(worldId, itemId, options.sinceMs ?? 0, options.limit ?? 1800) as StoredSale[];
    return rows;
  }

  mostRecentlyUpdated(worldId: number | null, limit: number): RecentUpdate[] {
    return this.stmts.mostRecent.all(worldId, worldId, limit) as RecentUpdate[];
  }

  pruneOldSales(now: number = Date.now()): number {
    return this.stmts.deleteOldSales.run(now - SALES_RETENTION_MS).changes;
  }

  countSales(): number {
    return (this.stmts.countSales.get() as { n: number }).n;
  }

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

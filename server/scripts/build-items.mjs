// 產生 data/items.json：「繁中服可以在市場板交易、但 Universalis 沒有價格資料」的物品清單，
// 也就是這個服務接受社群回報的物品白名單（目前約 112 個，例如 7.5 整併前的舊染劑與色素）。
//
// 資料來源（都是公開資料，只讀取）：
//   - https://universalis.app/api/v2/marketable            Universalis 有市場資料的物品編號
//   - thewakingsands/ffxiv-datamining-tc 的 Item.csv       繁中服的物品資料表（名稱、可否交易）
//   - https://v2.xivapi.com                                英文名稱（失敗不致命）
//
// 判斷方式：繁中服資料標示可交易（ItemSearchCategory 非 0 且不是 IsUntradable），而且不在 Universalis 的
// marketable 清單裡。Universalis 跟著全球最新版，繁中服版本較舊，所以舊染劑在繁中服仍可交易、Universalis 卻沒有。
//
// 用法（在 server 資料夾）：  node scripts/build-items.mjs

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "thewakingsands/ffxiv-datamining-tc";
const BRANCH = "main";
const CSV_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/Item.csv`;
const COMMIT_API_URL = `https://api.github.com/repos/${REPO}/commits/${BRANCH}`;
const MARKETABLE_URL = "https://universalis.app/api/v2/marketable";
const USER_AGENT = "database-dalamud-collector-build-items";

// Universalis 目前列出約 16800 筆；拿到明顯偏少的清單代表 API 故障，中止而不是把一堆物品當成「沒資料」。
const MIN_MARKETABLE_COUNT = 10000;
// 無價格資料的物品預期約 112 個；超過這個上限代表欄位判讀出了問題，中止。
const MAX_ITEMS = 1000;

const OUTPUT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "items.json");

/** 解析 SaintCoinach 匯出的 CSV（含引號、逃脫引號、跨行欄位）。 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // 交由 \n 結束該行
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 從繁中 Item.csv 挑出「繁中服可交易、但不在 marketableIds 裡」的物品。 */
export function extractItems(csvText, marketableIds) {
  const rows = parseCsv(csvText);
  // 前三行是 SaintCoinach 的 header：欄位索引 / 欄位名稱 / 資料型別。
  const header = rows[1];
  const nameIndex = header.indexOf("Name");
  const categoryIndex = header.indexOf("ItemSearchCategory");
  const untradableIndex = header.indexOf("IsUntradable");
  if (nameIndex === -1 || categoryIndex === -1 || untradableIndex === -1) {
    throw new Error("Item.csv 找不到 Name / ItemSearchCategory / IsUntradable 欄位，資料格式可能已變更");
  }

  const items = [];
  for (const row of rows.slice(3)) {
    if (row.length <= nameIndex) continue;
    const id = Number.parseInt(row[0], 10);
    const name = row[nameIndex]?.trim();
    if (!Number.isInteger(id) || id <= 0 || !name) continue;

    const category = row[categoryIndex]?.trim();
    const tradableInTaiwan = !!category && category !== "0" && row[untradableIndex]?.trim() !== "True";
    if (tradableInTaiwan && !marketableIds.has(id)) items.push({ id, name });
  }

  if (items.length > MAX_ITEMS) {
    throw new Error(`符合條件的物品有 ${items.length} 個（上限 ${MAX_ITEMS}），欄位判讀可能出問題，中止`);
  }
  return items.sort((a, b) => a.id - b.id);
}

async function getJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${url} 失敗：HTTP ${response.status}`);
  return response.json();
}

async function fetchMarketableIds() {
  const raw = await getJson(MARKETABLE_URL);
  if (!Array.isArray(raw)) throw new Error("marketable 清單格式不是陣列，Universalis API 可能已變更");
  const ids = new Set(raw.filter((id) => Number.isInteger(id) && id > 0));
  if (ids.size < MIN_MARKETABLE_COUNT) {
    throw new Error(`marketable 清單只有 ${ids.size} 筆（低於安全下限 ${MIN_MARKETABLE_COUNT}），中止`);
  }
  return ids;
}

async function fetchEnglishNames(ids) {
  const names = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const data = await getJson(`https://v2.xivapi.com/api/sheet/Item?rows=${chunk.join(",")}&fields=Name&limit=${chunk.length}`);
    for (const row of data.rows ?? []) {
      const name = row.fields?.Name?.trim();
      if (name) names.set(row.row_id, name);
    }
  }
  return names;
}

async function main() {
  console.log(`下載 Universalis 可交易清單：${MARKETABLE_URL}`);
  const marketableIds = await fetchMarketableIds();
  console.log(`Universalis 列出 ${marketableIds.size} 筆`);

  const commit = (await getJson(COMMIT_API_URL)).sha.slice(0, 7);
  console.log(`下載繁中 Item.csv：${REPO}@${commit}`);
  const csvResponse = await fetch(CSV_URL);
  if (!csvResponse.ok) throw new Error(`下載 Item.csv 失敗：HTTP ${csvResponse.status}`);
  const csvText = (await csvResponse.text()).replace(/^﻿/, "");

  const items = extractItems(csvText, marketableIds);
  console.log(`繁中服可交易、Universalis 沒有價格資料的物品：${items.length} 個`);
  if (items.length === 0) throw new Error("一個都沒有，資料來源可能有問題，中止");

  try {
    const english = await fetchEnglishNames(items.map((item) => item.id));
    for (const item of items) item.nameEn = english.get(item.id) ?? null;
    console.log(`取得 ${english.size}/${items.length} 個英文名稱`);
  } catch (error) {
    console.warn(`取得英文名稱失敗（不影響運作）：${error instanceof Error ? error.message : error}`);
  }

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(
    OUTPUT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), source: `${REPO}@${commit} + Universalis marketable`, items }, null, 2) + "\n",
  );
  console.log(`已寫入 ${OUTPUT_PATH}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

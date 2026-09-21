#!/usr/bin/env bash
# 備份社群回報伺服器的資料庫（SQLite）。在跑 Docker 的那台機器上執行，通常由 cron 每天呼叫一次。
#
# 做法：從 Docker 資料卷讀出 collector.db，用 SQLite 的 backup API 複製（服務執行中也安全，
# 不會複製到寫到一半的頁面），驗證備份檔的完整性，壓縮，最後刪掉超過保留天數的舊備份。
#
# 環境變數（都有預設值）：
#   VOLUME       Docker 資料卷名稱      預設 database-dalamud-collector_collector-data
#   BACKUP_DIR   備份放哪裡            預設 /root/backups/collector
#   KEEP_DAYS    保留幾天             預設 14
#
# 還原：停掉容器，`gunzip -k` 想還原的備份檔，把 .db 複製成資料卷裡的 collector.db（並刪掉舊的 -wal、-shm），
# 確認檔案擁有者是 uid 1000（容器內的 node 使用者），再啟動容器。
# 需要：docker、python3（標準庫的 sqlite3）、flock。

set -euo pipefail

VOLUME="${VOLUME:-database-dalamud-collector_collector-data}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups/collector}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

# 同一時間只跑一份（上一次還沒跑完就跳過）。
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || { echo "$(date -Is) another backup is still running, skipping" >> "$BACKUP_DIR/backup.log"; exit 0; }

SOURCE="$(docker volume inspect "$VOLUME" --format '{{ .Mountpoint }}')/collector.db"
STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
OUT="$BACKUP_DIR/collector-$STAMP.db"

python3 - "$SOURCE" "$OUT" <<'PY'
import sqlite3
import sys

source_path, out_path = sys.argv[1], sys.argv[2]
source = sqlite3.connect(source_path, timeout=30)
target = sqlite3.connect(out_path)
try:
    source.backup(target)
    result = target.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok":
        raise SystemExit("integrity_check failed: " + result)
    rows = {
        name: target.execute("SELECT COUNT(*) FROM " + name).fetchone()[0]
        for name in ("items", "snapshot", "sales")
    }
    print("rows " + " ".join(f"{k}={v}" for k, v in rows.items()))
finally:
    target.close()
    source.close()
PY

gzip -f "$OUT"
SIZE="$(stat -c %s "$OUT.gz")"
echo "$(date -Is) backup ok $(basename "$OUT.gz") ${SIZE} bytes" >> "$BACKUP_DIR/backup.log"

# 刪掉超過保留天數的舊備份。
find "$BACKUP_DIR" -maxdepth 1 -name 'collector-*.db.gz' -mtime "+$KEEP_DAYS" -delete

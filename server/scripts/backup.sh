#!/usr/bin/env bash
# 備份資料庫：用 SQLite backup API 複製資料卷裡的 collector.db（服務執行中也安全），驗證完整性後壓縮，
# 再交給 rotate-backups.sh 整理舊備份。通常由 cron 每天跑一次。
# 環境變數：VOLUME（Docker 資料卷名稱）、BACKUP_DIR（預設 /root/backups/collector）。
# 還原：停掉容器，gunzip 備份檔，複製成資料卷裡的 collector.db（刪掉 -wal、-shm，擁有者 uid 1000），再啟動。
# 需要 docker、python3、flock。

set -euo pipefail

VOLUME="${VOLUME:-database-dalamud-collector_collector-data}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups/collector}"

mkdir -p "$BACKUP_DIR"

# 同時只跑一份
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

BACKUP_DIR="$BACKUP_DIR" bash "$(dirname "$0")/rotate-backups.sh"

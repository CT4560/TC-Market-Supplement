#!/usr/bin/env bash
# 備份檔的保留規則。由 backup.sh 在每次備份之後呼叫，也可以單獨執行。
#
#   每日備份       全部保留最近 KEEP_DAILY_DAYS 天（預設 60），更舊的刪掉。
#   兩個月一組     一年分成六組：1～2 月、3～4 月、5～6 月、7～8 月、9～10 月、11～12 月（UTC）。
#                  一組結束之後，把那一組「最後一份」備份封存到 archive/ 資料夾。
#   封存備份       保留 KEEP_ARCHIVE_DAYS 天（預設 365），也就是最多約 6 份；更舊的刪掉。
#
# 只動備份檔，不碰資料庫。先封存、再刪除每日備份，所以封存用的那一份不會在封存前被刪掉。
#
# 環境變數：BACKUP_DIR（預設 /root/backups/collector）、KEEP_DAILY_DAYS、KEEP_ARCHIVE_DAYS、
# ROTATE_NOW（測試用，指定「今天」，格式 YYYY-MM-DD）。
# 檔名格式：collector-YYYYmmdd-HHMMSSZ.db.gz（每日）、archive/collector-YYYY-MM_MM-YYYYmmdd-HHMMSSZ.db.gz（封存）。

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/root/backups/collector}"
KEEP_DAILY_DAYS="${KEEP_DAILY_DAYS:-60}"
KEEP_ARCHIVE_DAYS="${KEEP_ARCHIVE_DAYS:-365}"
TODAY="${ROTATE_NOW:-$(date -u +%Y-%m-%d)}"
ARCHIVE_DIR="$BACKUP_DIR/archive"
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$ARCHIVE_DIR"

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"
}

# 日期（YYYYmmdd）→ 兩個月一組的名稱，例如 20260921 → 2026-09_10、20260305 → 2026-03_04
group_label() {
  local ymd="$1"
  local year="${ymd:0:4}"
  local month=$((10#${ymd:4:2}))
  local start=$(( month % 2 == 1 ? month : month - 1 ))
  printf '%s-%02d_%02d' "$year" "$start" "$((start + 1))"
}

current_label="$(group_label "$(date -u -d "$TODAY" +%Y%m%d)")"

# ---- 1. 封存：已經結束的每一組，把該組最後一份備份留下來 ----
declare -A newest_of_group=()
shopt -s nullglob
for file in "$BACKUP_DIR"/collector-2*.db.gz; do   # 檔名字典序＝時間序，後面的會蓋掉前面的
  base="${file##*/}"
  stamp="${base#collector-}"
  label="$(group_label "${stamp:0:8}")"
  newest_of_group["$label"]="$file"
done

for label in "${!newest_of_group[@]}"; do
  [ "$label" = "$current_label" ] && continue        # 這一組還沒結束
  existing=("$ARCHIVE_DIR"/collector-"$label"-*.db.gz)
  [ "${#existing[@]}" -gt 0 ] && continue             # 已經封存過
  source_file="${newest_of_group[$label]}"
  source_base="${source_file##*/}"
  target="$ARCHIVE_DIR/collector-$label-${source_base#collector-}"
  cp -p "$source_file" "$target"
  log "sealed $source_base as archive/${target##*/}"
done

# ---- 2. 刪掉超過保留天數的每日備份 ----
daily_cutoff="$(date -u -d "$TODAY -$KEEP_DAILY_DAYS days" +%Y%m%d)"
for file in "$BACKUP_DIR"/collector-2*.db.gz; do
  stamp="${file##*/}"
  stamp="${stamp#collector-}"
  if [[ "${stamp:0:8}" < "$daily_cutoff" ]]; then
    rm -f "$file"
    log "removed old daily backup ${file##*/}"
  fi
done

# ---- 3. 刪掉超過保留天數的封存備份（依備份當天的日期，檔名裡的最後一段） ----
archive_cutoff="$(date -u -d "$TODAY -$KEEP_ARCHIVE_DAYS days" +%Y%m%d)"
for file in "$ARCHIVE_DIR"/collector-*.db.gz; do
  name="${file##*/}"
  rest="${name#collector-}"           # 2026-09_10-20261031-200000Z.db.gz
  backup_date="${rest:11:8}"          # 標籤 10 個字元＋一個連字號之後就是備份日期
  if [[ "$backup_date" < "$archive_cutoff" ]]; then
    rm -f "$file"
    log "removed old archived backup archive/$name"
  fi
done

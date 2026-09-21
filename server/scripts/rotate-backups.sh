#!/usr/bin/env bash
# 備份保留規則，由 backup.sh 在備份後呼叫：
#   每日備份留最近 KEEP_DAILY_DAYS 天（預設 60）。
#   一年分六組（1～2 月、3～4 月……11～12 月，UTC），每組結束後把該組最後一份封存到 archive/，留 KEEP_ARCHIVE_DAYS 天（預設 365）。
# 只動備份檔。環境變數：BACKUP_DIR、KEEP_DAILY_DAYS、KEEP_ARCHIVE_DAYS、ROTATE_NOW（測試用，YYYY-MM-DD）。

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

# 20260921 → 2026-09_10
group_label() {
  local ymd="$1"
  local year="${ymd:0:4}"
  local month=$((10#${ymd:4:2}))
  local start=$(( month % 2 == 1 ? month : month - 1 ))
  printf '%s-%02d_%02d' "$year" "$start" "$((start + 1))"
}

current_label="$(group_label "$(date -u -d "$TODAY" +%Y%m%d)")"

# 封存已結束的組別的最後一份備份
declare -A newest_of_group=()
shopt -s nullglob
for file in "$BACKUP_DIR"/collector-2*.db.gz; do
  base="${file##*/}"
  stamp="${base#collector-}"
  label="$(group_label "${stamp:0:8}")"
  newest_of_group["$label"]="$file"
done

for label in "${!newest_of_group[@]}"; do
  [ "$label" = "$current_label" ] && continue
  existing=("$ARCHIVE_DIR"/collector-"$label"-*.db.gz)
  [ "${#existing[@]}" -gt 0 ] && continue
  source_file="${newest_of_group[$label]}"
  source_base="${source_file##*/}"
  target="$ARCHIVE_DIR/collector-$label-${source_base#collector-}"
  cp -p "$source_file" "$target"
  log "sealed $source_base as archive/${target##*/}"
done

# 刪除過期的每日備份
daily_cutoff="$(date -u -d "$TODAY -$KEEP_DAILY_DAYS days" +%Y%m%d)"
for file in "$BACKUP_DIR"/collector-2*.db.gz; do
  stamp="${file##*/}"
  stamp="${stamp#collector-}"
  if [[ "${stamp:0:8}" < "$daily_cutoff" ]]; then
    rm -f "$file"
    log "removed old daily backup ${file##*/}"
  fi
done

# 刪除過期的封存備份
archive_cutoff="$(date -u -d "$TODAY -$KEEP_ARCHIVE_DAYS days" +%Y%m%d)"
for file in "$ARCHIVE_DIR"/collector-*.db.gz; do
  name="${file##*/}"
  rest="${name#collector-}"
  backup_date="${rest:11:8}"
  if [[ "$backup_date" < "$archive_cutoff" ]]; then
    rm -f "$file"
    log "removed old archived backup archive/$name"
  fi
done

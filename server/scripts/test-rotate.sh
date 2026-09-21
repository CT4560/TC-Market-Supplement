#!/usr/bin/env bash
# rotate-backups.sh 的測試：模擬「每天備份一次、每天跑一次保留規則」兩年，檢查最後留下什麼。
# 不碰 docker 也不碰資料庫，只在暫存資料夾裡建立空的假備份檔。  用法：bash scripts/test-rotate.sh

set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
export BACKUP_DIR="$dir"

failures=0
check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "ok   - $name"
  else
    echo "FAIL - $name"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    failures=$((failures + 1))
  fi
}

# 從 2026-01-01 到 2027-12-31，每天都有一份備份；保留規則每 15 天跑一次（跟每天跑的結果一樣，只是比較快），最後一天一定跑。
# 日期一次全部算好（只叫一次 date），逐天建立當天的空備份檔，遇到要跑的日子就先補建到那一天再執行。
mapfile -t days < <(for i in $(seq 0 729); do echo "2026-01-01 +$i days"; done | date -u -f - +%Y-%m-%d)
mapfile -t stamps < <(printf '%s
' "${days[@]}" | date -u -f - +%Y%m%d)
last=$((${#days[@]} - 1))
created=-1
for ((i = 0; i <= last; i++)); do
  if (( i % 15 == 14 )) || (( i == last )); then
    for ((j = created + 1; j <= i; j++)); do : > "$dir/collector-${stamps[j]}-201000Z.db.gz"; done
    created=$i
    ROTATE_NOW="${days[i]}" bash "$here/rotate-backups.sh"
  fi
done
echo "模擬結束日：${days[last]}"

# 到 2027-12-31 為止：
# 每日備份 → 只剩最近 60 天（2027-11-01 之前的都刪掉；截止日是 12-31 往前 60 天＝11-01，比它早的刪）
daily_count="$(ls "$dir"/collector-2*.db.gz | wc -l)"
oldest_daily="$(ls "$dir"/collector-2*.db.gz | head -1 | xargs basename)"
check "每日備份的數量" "61" "$daily_count"
check "最舊的每日備份" "collector-20271101-201000Z.db.gz" "$oldest_daily"

# 封存備份 → 每組最後一份，只留 365 天內（12-31 往前 365 天＝2026-12-31，比它早的刪）
# 保留的是備份日期 ≥ 2026-12-31 的封存：2026-11_12 那組（最後一份 2026-12-31）與 2027 年的五組（2027-01_02 … 2027-09_10）；
# 2027-11_12 這組還沒結束，所以還沒封存。
archives="$(ls "$dir/archive" | sed -e 's/^collector-//' -e 's/\.db\.gz$//' | tr '\n' ' ')"
check "封存備份" "2026-11_12-20261231-201000Z 2027-01_02-20270228-201000Z 2027-03_04-20270430-201000Z 2027-05_06-20270630-201000Z 2027-07_08-20270831-201000Z 2027-09_10-20271031-201000Z " "$archives"

# 冪等：再跑一次不會改變任何東西
before="$(ls -R "$dir" | grep -v backup.log | md5sum)"
ROTATE_NOW="2027-12-31" bash "$here/rotate-backups.sh"
after="$(ls -R "$dir" | grep -v backup.log | md5sum)"
check "重複執行不會改變結果" "$before" "$after"

# 錯過幾天沒備份：組別最後一份用「該組最新存在的」那份
rm -rf "$dir"/* "$dir"/.lock 2>/dev/null || true
for d in 2026-03-01 2026-04-27 2026-05-01; do : > "$dir/collector-$(date -u -d "$d" +%Y%m%d)-201000Z.db.gz"; done
ROTATE_NOW="2026-05-01" bash "$here/rotate-backups.sh"
check "缺了最後幾天：封存該組最新的一份" "2026-03_04-20260427-201000Z " "$(ls "$dir/archive" | sed -e 's/^collector-//' -e 's/\.db\.gz$//' | tr '\n' ' ')"

if [ "$failures" -ne 0 ]; then
  echo "$failures 項失敗"
  exit 1
fi
echo "全部通過"

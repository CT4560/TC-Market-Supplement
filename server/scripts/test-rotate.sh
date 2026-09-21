#!/usr/bin/env bash
# rotate-backups.sh 的測試：模擬兩年每天備份，檢查留下的每日與封存備份。用法：bash scripts/test-rotate.sh

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

# 2026-01-01 到 2027-12-31 每天一份備份，每 15 天跑一次保留規則（結果跟每天跑一樣，只是比較快）
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

# 到 2027-12-31：每日備份只剩最近 60 天
daily_count="$(ls "$dir"/collector-2*.db.gz | wc -l)"
oldest_daily="$(ls "$dir"/collector-2*.db.gz | head -1 | xargs basename)"
check "每日備份的數量" "61" "$daily_count"
check "最舊的每日備份" "collector-20271101-201000Z.db.gz" "$oldest_daily"

# 封存只剩一年內的六組（2026-11_12 到 2027-09_10），2027-11_12 還沒結束
archives="$(ls "$dir/archive" | sed -e 's/^collector-//' -e 's/\.db\.gz$//' | tr '\n' ' ')"
check "封存備份" "2026-11_12-20261231-201000Z 2027-01_02-20270228-201000Z 2027-03_04-20270430-201000Z 2027-05_06-20270630-201000Z 2027-07_08-20270831-201000Z 2027-09_10-20271031-201000Z " "$archives"

# 重複執行結果不變
before="$(ls -R "$dir" | grep -v backup.log | md5sum)"
ROTATE_NOW="2027-12-31" bash "$here/rotate-backups.sh"
after="$(ls -R "$dir" | grep -v backup.log | md5sum)"
check "重複執行不會改變結果" "$before" "$after"

# 缺了幾天備份時，封存該組現存最新的一份
rm -rf "$dir"/* "$dir"/.lock 2>/dev/null || true
for d in 2026-03-01 2026-04-27 2026-05-01; do : > "$dir/collector-$(date -u -d "$d" +%Y%m%d)-201000Z.db.gz"; done
ROTATE_NOW="2026-05-01" bash "$here/rotate-backups.sh"
check "缺了最後幾天：封存該組最新的一份" "2026-03_04-20260427-201000Z " "$(ls "$dir/archive" | sed -e 's/^collector-//' -e 's/\.db\.gz$//' | tr '\n' ' ')"

if [ "$failures" -ne 0 ]; then
  echo "$failures 項失敗"
  exit 1
fi
echo "全部通過"

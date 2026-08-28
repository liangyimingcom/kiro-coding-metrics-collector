#!/usr/bin/env bash
# 生成/校验交付包指纹。
#
# 为什么要有这个脚本：升级手册 §0 / §6.3 里有两张"参考 md5"表和一串 `grep -c` 期望值，
# 手工维护过一次就脱钩过一次（代码改了、表没跟着改），直接后果是运维照手册复核会得到
# "md5 对不上 → 停下"的错误结论。所以这些数字一律由本脚本生成，不要手抄。
#
# 用法：
#   bash scripts/fingerprint.sh            # 打印指纹（md5 表 + grep 计数 + sha256）
#   bash scripts/fingerprint.sh --write    # 另外把 sha256 写进 ./SHA256SUMS
#   bash scripts/fingerprint.sh --check    # 用 ./SHA256SUMS 校验当前文件（现场用这个）
#   bash scripts/fingerprint.sh --md       # 输出 Markdown 表格，可直接贴回手册
#
# 必须在 kiro-dashboard 目录下（或它的任一副本，如 /opt/kiro/kiro-dashboard）执行。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# 本次交付要替换的文件（顺序与手册 §6.3 一致）
FILES=(
  src/store.js
  src/ingest.js
  src/creditSync.js
  src/dashboard.js
  public/index.html
  scripts/verify-display-name.js
)

# 特征串计数：文件|模式|期望值。期望值为空表示"只报告实际值、不做判定"。
# 这些是 V3（分支 fix/display-name-hardening，含 M1–M11）的实测值。
PATTERNS=(
  "src/store.js|display_name|16"
  "src/store.js|idc_user_name|11"
  "src/store.js|DISPLAY_NAME_JOIN|5"
  "src/store.js|DISPLAY_NAME_SRC|3"
  "src/store.js|DISPLAY_NAME_EXPR|3"
  "src/store.js|uq_kiro_user_lower_name|6"
  "src/store.js|getUserCaseInsensitive|4"
  "src/store.js|SAVEPOINT|4"
  "src/store.js|lock_timeout|6"
  "src/ingest.js|normalizeUserIdentity|4"
  "src/ingest.js|idc_user_name|2"
  "src/dashboard.js|u.display_name|1"
  "src/dashboard.js|toLowerCase|2"
  "public/index.html|display_name|2"
)

mode="${1:-}"
rc=0

missing=0
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "缺文件: $f"; missing=1; }
done
[ "$missing" -eq 0 ] || { echo "!! 上面的文件不存在，指纹不完整"; exit 1; }

case "$mode" in
--check)
  [ -f SHA256SUMS ] || { echo "!! 当前目录没有 SHA256SUMS，无法校验"; exit 1; }
  sha256sum -c SHA256SUMS || rc=1
  echo
  echo "=== 特征串计数复核 ==="
  ;;
--write)
  sha256sum "${FILES[@]}" > SHA256SUMS
  echo "已写入 $(pwd)/SHA256SUMS："
  cat SHA256SUMS
  echo
  ;;
--md)
  echo "| 文件 | md5 | sha256（前 16 位） |"
  echo "|---|---|---|"
  for f in "${FILES[@]}"; do
    printf '| `%s` | `%s` | `%s…` |\n' "$f" \
      "$(md5sum "$f" | cut -d' ' -f1)" "$(sha256sum "$f" | cut -c1-16)"
  done
  echo
  echo '| 文件 | 特征串 | 期望 `grep -c` |'
  echo "|---|---|---|"
  for p in "${PATTERNS[@]}"; do
    IFS='|' read -r f pat exp <<<"$p"
    printf '| `%s` | `%s` | %s |\n' "$f" "$pat" "${exp:-—}"
  done
  exit 0
  ;;
esac

if [ "$mode" != "--check" ]; then
  echo "=== md5 / sha256 ==="
  for f in "${FILES[@]}"; do
    printf '  %-32s md5=%s  sha256=%s\n' "$f" \
      "$(md5sum "$f" | cut -d' ' -f1)" "$(sha256sum "$f" | cut -c1-16)…"
  done
  echo
  echo "=== 特征串计数 ==="
fi

for p in "${PATTERNS[@]}"; do
  IFS='|' read -r f pat exp <<<"$p"
  got="$(grep -c -- "$pat" "$f")"
  if [ -n "$exp" ] && [ "$got" != "$exp" ]; then
    printf '  MISMATCH  %-24s %-24s 实际 %s，期望 %s\n' "$f" "$pat" "$got" "$exp"
    rc=1
  else
    printf '  ok        %-24s %-24s %s\n' "$f" "$pat" "$got"
  fi
done

echo
echo "=== 语法自检（node --check）==="
for f in "${FILES[@]}"; do
  case "$f" in
    *.js) node --check "$f" >/dev/null 2>&1 && printf '  ok    %s\n' "$f" \
            || { printf '  FAIL  %s\n' "$f"; rc=1; } ;;
    *)    printf '  skip  %s（非 js）\n' "$f" ;;
  esac
done

echo
if [ "$rc" -eq 0 ]; then
  echo "=== 结论：指纹全部匹配 ==="
else
  echo "=== 结论：有不匹配项（见上面的 MISMATCH / FAIL）==="
  echo "    若你确实故意改了代码，请重跑 --write 更新 SHA256SUMS，"
  echo "    并把 --md 的输出贴回 02-升级手册.md 的 §0 与 §6.3，不要只改一处。"
fi
exit "$rc"

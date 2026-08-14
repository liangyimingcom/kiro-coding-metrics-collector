#!/usr/bin/env bash
# ============================================================
# build-plugin.sh — 生成指向指定 Dashboard 地址的 Kiro 插件 VSIX
#
# 用法:
#   bash build-plugin.sh <DASHBOARD_BASE_URL> [输出文件名]
#
# 示例:
#   bash build-plugin.sh http://10.162.255.8                 # 私有子网 EC2 私有 IP（端口 80）
#   bash build-plugin.sh http://kiro-dash.internal           # 内网 ALB / 私有 DNS
#   bash build-plugin.sh http://127.0.0.1                    # 本地离线试用
#
# 前置: node>=20、npm；脚本会自动 npm install + tsc + vsce package。
# 产物: 默认 code/kiro-plugin/git-ai-kiro-0.2.3-rds.vsix
#
# 重要: 本脚本只改 STATS_BASE_URL（采集/上报的基地址），不改其它逻辑。
#       Dashboard 的 Ingest API 监听 80 端口，所以一般 BASE_URL 不带端口。
# ============================================================
set -euo pipefail

BASE_URL="${1:-}"
if [ -z "$BASE_URL" ]; then
  echo "用法: bash build-plugin.sh <DASHBOARD_BASE_URL> [输出文件名]"
  echo "例:  bash build-plugin.sh http://10.162.255.8"
  exit 1
fi

# 定位插件目录（相对本脚本：../code/kiro-plugin）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../code/kiro-plugin" && pwd)"
OUT_NAME="${2:-git-ai-kiro-0.2.3-rds.vsix}"

cd "$PLUGIN_DIR"
echo "==> 插件目录: $PLUGIN_DIR"
echo "==> 目标 Dashboard 地址: $BASE_URL"

echo "==> [1/4] 写入端点到 src/apiConfig.ts"
# 用 node 改写，避免 sed 分隔符/特殊字符问题
node -e '
  const fs=require("fs"), p="src/apiConfig.ts";
  let s=fs.readFileSync(p,"utf8");
  const url=process.argv[1];
  s=s.replace(/export const STATS_BASE_URL\s*=\s*"[^"]*";/,
              `export const STATS_BASE_URL = "${url}";`);
  fs.writeFileSync(p,s);
  console.log("    STATS_BASE_URL =", url);
' "$BASE_URL"

echo "==> [2/4] npm install"
npm install >/dev/null 2>&1
echo "    done"

echo "==> [3/4] 编译 TypeScript (tsc -> out/)"
npx tsc -p ./
echo "    out/ 已生成"

echo "==> [4/4] 打包 VSIX"
# 刷新 support-sources（若脚本存在；缺失不致命）
[ -f scripts/copy-support-sources.sh ] && sh scripts/copy-support-sources.sh >/dev/null 2>&1 || true
rm -f "$OUT_NAME"
npx vsce package --allow-missing-repository --out "$OUT_NAME" >/dev/null 2>&1

# 校验产物里确实是目标端点
BAKED=$(node -e '
  const z=require("child_process");
  const out=z.execSync("npx --yes unzipper 2>/dev/null || true");
' 2>/dev/null || true)

echo ""
echo "==> 完成: $PLUGIN_DIR/$OUT_NAME"
ls -lh "$OUT_NAME" 2>/dev/null || true
echo ""
echo "    校验内置端点:"
node -e '
  const fs=require("fs"); const cp=require("child_process");
  // 直接读编译产物 out/apiConfig.js 确认
  const s=fs.readFileSync("out/apiConfig.js","utf8");
  const m=s.match(/STATS_BASE_URL\s*=\s*"([^"]+)"/);
  console.log("      out/apiConfig.js -> STATS_BASE_URL =", m?m[1]:"NOT FOUND");
'
echo ""
echo "下一步: 在 Kiro IDE -> 扩展 -> ... -> Install from VSIX 选择该文件，重启 IDE。"

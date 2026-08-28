#!/usr/bin/env bash
# ============================================================
# build-plugin.sh — 生成指向指定 Dashboard 地址的 Kiro 插件 VSIX
#
# 用法:
#   bash build-plugin.sh <DASHBOARD_BASE_URL> [输出文件名] [插件树]
#
#   插件树: latest（默认，仓库顶层 kiro-plugin/，当前 0.3.5）
#           legacy（code/kiro-plugin/，当前 0.2.3）
#   也可用环境变量 PLUGIN_TREE=legacy 指定。
#
# 示例:
#   bash build-plugin.sh http://10.162.255.8                    # 私有子网 EC2 私有 IP（端口 80）
#   bash build-plugin.sh http://kiro-dash.internal              # 内网 ALB / 私有 DNS
#   bash build-plugin.sh http://127.0.0.1 "" legacy             # 打旧版 0.2.3
#
# ★ 两棵插件树是不同代码，不是同一份的拷贝：apiConfig / commitWatcher /
#   gitUtils / statsUploader / userSync / sessionLog* / workspacePathEncoder 都有差异，
#   且各自的默认 STATS_BASE_URL 不同（0.3.5=10.162.255.100，0.2.3=10.162.255.8）。
#   给客户升级前必须先确认现场装的是哪一代，否则测出来的结论对不上现场。
#
# 前置: node>=20、npm；脚本会自动 npm install + vsce package
#       （vsce 的 vscode:prepublish 钩子会自己跑 tsc + copy:support-sources）。
#
# 重要: 本脚本只改 STATS_BASE_URL（采集/上报的基地址），不改其它逻辑；
#       打包完成后会把 src/apiConfig.ts 还原，避免把客户内网 IP 留在工作区/提交进 git。
#       Dashboard 的 Ingest API 监听 80 端口，所以一般 BASE_URL 不带端口。
# ============================================================
set -euo pipefail

BASE_URL="${1:-}"
if [ -z "$BASE_URL" ]; then
  echo "用法: bash build-plugin.sh <DASHBOARD_BASE_URL> [输出文件名] [latest|legacy]"
  echo "例:  bash build-plugin.sh http://10.162.255.8"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TREE="${3:-${PLUGIN_TREE:-latest}}"
case "$TREE" in
  latest) REL="../kiro-plugin" ;;
  legacy) REL="../code/kiro-plugin" ;;
  *) echo "[ERROR] 插件树只能是 latest 或 legacy，收到: $TREE"; exit 1 ;;
esac
PLUGIN_DIR="$(cd "$SCRIPT_DIR/$REL" && pwd)"
cd "$PLUGIN_DIR"

VERSION=$(node -p "require('./package.json').version")
OUT_NAME="${2:-git-ai-kiro-${VERSION}-rds.vsix}"
BUILD_LOG="$(mktemp)"

echo "==> 插件树: $TREE  ($PLUGIN_DIR)"
echo "==> 插件版本: $VERSION"
echo "==> 目标 Dashboard 地址: $BASE_URL"

# apiConfig.ts 是 git 跟踪文件，改完必须还原：否则工作区里留着客户内网 IP，
# 一次 `git add .` 就把客户地址提交上去了。
cp src/apiConfig.ts "$BUILD_LOG.apiConfig.bak"
# 还原两处：① src/apiConfig.ts 本体；② 构建期间 copy:support-sources 复制出的
# support-sources/ 副本——它是在写入客户地址【之后】生成的，同样带着客户内网 IP，
# 且属于生成物，删掉即可（下次构建会重建）。漏掉②曾在真实构建中留下过含 IP 的副本。
restore() {
  cp "$BUILD_LOG.apiConfig.bak" src/apiConfig.ts 2>/dev/null || true
  rm -rf "$PLUGIN_DIR/support-sources" 2>/dev/null || true
}
trap restore EXIT

echo "==> [1/4] 写入端点到 src/apiConfig.ts"
node -e '
  const fs=require("fs"), p="src/apiConfig.ts";
  let s=fs.readFileSync(p,"utf8");
  const url=process.argv[1];
  const re=/export const STATS_BASE_URL\s*=\s*"[^"]*";/;
  if (!re.test(s)) { console.error("    [ERROR] 未找到 STATS_BASE_URL 声明，apiConfig.ts 结构已变"); process.exit(1); }
  fs.writeFileSync(p, s.replace(re, `export const STATS_BASE_URL = "${url}";`));
  console.log("    STATS_BASE_URL =", url);
' "$BASE_URL"

# 失败时把日志尾部打出来 —— 原来这里把 npm/vsce 的输出全丢进 /dev/null，
# 一旦编译报错只能看到一行 set -e 退出，无法定位。
run() { if ! "$@" >>"$BUILD_LOG" 2>&1; then echo "    [ERROR] 失败: $*"; tail -30 "$BUILD_LOG"; exit 1; fi; }

echo "==> [2/4] npm install"
run npm install
echo "    done"

echo "==> [3/4] 编译 TypeScript (tsc -> out/)"
run npx tsc -p ./
echo "    out/ 已生成"

# support-sources 是 VSIX 里的支持诊断产物（.vscodeignore 不排除它）。
# latest 树靠 vscode:prepublish 钩子在 vsce package 时自动复制；
# legacy 树（code/kiro-plugin）**没有** prepublish 钩子，不显式跑这步的话
# 打出的 0.2.3 包会缺失（或带上陈旧的）support-sources。--if-present 两树通吃。
run npm run copy:support-sources --if-present

echo "==> [4/4] 打包 VSIX"
rm -f "$OUT_NAME"
run npx vsce package --allow-missing-repository --out "$OUT_NAME"

echo ""
echo "==> 完成: $PLUGIN_DIR/$OUT_NAME"
ls -lh "$OUT_NAME"

# 校验必须读 VSIX 内部，而不是本地 out/apiConfig.js：
# vsce 可能因 .vscodeignore / 缓存打进与本地不一致的内容，只查本地文件会给出假绿。
echo ""
echo "    校验 VSIX 内置端点:"
node -e '
  const fs=require("fs"), zlib=require("zlib"), cp=require("child_process");
  const vsix=process.argv[1], want=process.argv[2], ENTRY="extension/out/apiConfig.js";

  // 优先用 unzip（若有）。否则解析【中央目录】——不能扫 local file header：
  // vsce(yazl) 是流式写入，local header 里 compressedSize=0，真实长度在 data
  // descriptor 里，按 local header 扫会一个条目都读不出来（旧实现就静默退化成
  // 只查本地 out/apiConfig.js，等于没校验 VSIX）。
  function readEntry() {
    try {
      return cp.execFileSync("unzip", ["-p", vsix, ENTRY], {maxBuffer: 1<<24}).toString("utf8");
    } catch (e) { /* 没有 unzip 或条目不存在，走下面的解析 */ }
    const buf=fs.readFileSync(vsix);
    // 从尾部找 EOCD (0x06054b50)
    let eocd=-1;
    for (let i=buf.length-22; i>=0 && i>buf.length-70000; i--) {
      if (buf.readUInt32LE(i)===0x06054b50) { eocd=i; break; }
    }
    if (eocd<0) throw new Error("VSIX 不是合法 zip：未找到 EOCD");
    let n=buf.readUInt16LE(eocd+10), off=buf.readUInt32LE(eocd+16);
    for (let k=0; k<n; k++) {
      if (buf.readUInt32LE(off)!==0x02014b50) throw new Error("中央目录条目签名错误");
      const method=buf.readUInt16LE(off+10);
      const csize=buf.readUInt32LE(off+20);
      const nlen=buf.readUInt16LE(off+28), elen=buf.readUInt16LE(off+30), clen=buf.readUInt16LE(off+32);
      const lho=buf.readUInt32LE(off+42);
      const name=buf.slice(off+46, off+46+nlen).toString("utf8");
      if (name===ENTRY) {
        const lnlen=buf.readUInt16LE(lho+26), lelen=buf.readUInt16LE(lho+28);
        const dataOff=lho+30+lnlen+lelen;
        const raw=buf.slice(dataOff, dataOff+csize);
        return (method===8 ? zlib.inflateRawSync(raw) : raw).toString("utf8");
      }
      off += 46+nlen+elen+clen;
    }
    throw new Error(`VSIX 内未找到 ${ENTRY}`);
  }

  const content=readEntry();
  const m=content.match(/STATS_BASE_URL\s*=\s*"([^"]+)"/);
  if (!m) { console.error("      [ERROR] 未能从 VSIX 产物中读出 STATS_BASE_URL"); process.exit(1); }
  console.log("      VSIX 内 " + ENTRY + " -> STATS_BASE_URL =", m[1]);
  if (m[1] !== want) { console.error(`      [ERROR] 与期望不一致！期望 ${want}`); process.exit(1); }
  console.log("      ✓ 与目标地址一致");
' "$OUT_NAME" "$BASE_URL"

echo ""
echo "    src/apiConfig.ts 已还原（工作区不残留客户地址）"
echo ""
echo "下一步: 在 Kiro IDE -> 扩展 -> ... -> Install from VSIX 选择该文件，重启 IDE。"

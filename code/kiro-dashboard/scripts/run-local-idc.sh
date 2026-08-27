#!/usr/bin/env bash
# 本地起一份 dashboard，并接到真实的 IAM Identity Center。
# 用于验证 display_name 全链路（IdC ListUsers -> kiro_user.display_name -> 仓库指标页）。
#
# 用法: bash scripts/run-local-idc.sh <IDENTITY_STORE_ID>
#
# 注意 pkill 不能用 -f 匹配 "node src/main.js"：调用方的 shell 命令行里
# 往往含同样字符串，会把自己一起杀掉（exit 144）。这里按 -x node 精确匹配进程名。
set -uo pipefail
STORE_ID="${1:?用法: bash scripts/run-local-idc.sh <IDENTITY_STORE_ID>}"
cd "$(dirname "$0")/.."

pkill -x node 2>/dev/null || true
sleep 1
: > /tmp/kiro-dash.log

DB_HOST=127.0.0.1 DB_PORT=5432 DB_NAME=kiro DB_USER=kiro DB_PASSWORD=kiro \
AWS_REGION="${AWS_REGION:-us-east-1}" IDENTITY_STORE_ID="$STORE_ID" \
INGEST_PORT=8080 DASHBOARD_PORT=3500 \
  nohup node src/main.js > /tmp/kiro-dash.log 2>&1 &

# 判断"起来了"的依据必须是端口在听 + schema ready 日志，不能只看进程活着
for _ in $(seq 1 30); do
  if grep -q 'Dashboard listening' /tmp/kiro-dash.log 2>/dev/null; then break; fi
  sleep 1
done
echo "--- 启动日志 ---"
cat /tmp/kiro-dash.log
echo "--- 端口 ---"
ss -ltn 2>/dev/null | grep -E ':3500|:8080' || echo "  ✗ 端口未监听"

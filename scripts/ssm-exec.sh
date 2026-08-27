#!/usr/bin/env bash
# ============================================================
# ssm-exec.sh — 在实例上执行一段 shell 并把 stdout/stderr 取回来
#
# 用法:
#   bash ssm-exec.sh <instance-id> <<'EOF'
#   systemctl is-active kiro-dashboard
#   ss -ltn | grep -E ':80 |:3500 '
#   EOF
#
# 为什么要用 --cli-input-json 而不是 --parameters "commands=[...]"：
# shorthand 语法不处理嵌入的换行/转义，多行脚本会被拼成一行，
# 上一行结尾的 \n 和下一行的 echo 粘成 "necho: command not found"。
# 这里把整段脚本按行放进 JSON 数组，交给 AWS-RunShellScript 逐行执行。
# ============================================================
set -uo pipefail
IID="${1:?用法: bash ssm-exec.sh <instance-id> < script}"
REGION="${AWS_REGION:-us-east-1}"

# 脚本从 stdin 读进来后必须走环境变量传给 python：
# `python3 - <<'PY' ... PY <<<"$SCRIPT"` 里两个 stdin 重定向只有最后一个生效，
# python 会把待执行的 shell 脚本当成自己的程序源码，产出空 JSON，
# 表现为 SendCommand 报 "Parameters provided in document are invalid"。
SCRIPT=$(cat)
JSON=$(SSM_SCRIPT="$SCRIPT" SSM_IID="$IID" python3 -c '
import json, os
print(json.dumps({
    "InstanceIds": [os.environ["SSM_IID"]],
    "DocumentName": "AWS-RunShellScript",
    "Parameters": {"commands": os.environ["SSM_SCRIPT"].splitlines()},
}))')

CID=$(aws ssm send-command --region "$REGION" --cli-input-json "$JSON" \
      --query 'Command.CommandId' --output text) || { echo "[ERROR] send-command 失败"; exit 1; }

for _ in $(seq 1 120); do
  ST=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CID" \
       --instance-id "$IID" --query 'Status' --output text 2>/dev/null || echo Pending)
  case "$ST" in Success|Failed|Cancelled|TimedOut) break ;; esac
  sleep 5
done

echo "[ssm status=$ST]"
aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$IID" \
  --query 'StandardOutputContent' --output text
ERR=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$IID" \
      --query 'StandardErrorContent' --output text)
if [ -n "$ERR" ] && [ "$ERR" != "None" ]; then echo "--- stderr ---"; echo "$ERR"; fi
[ "$ST" = "Success" ]

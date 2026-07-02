#!/usr/bin/env bash
# ssm-run.sh <instance-id> <commands-file> [timeout-seconds]
# 通过 SSM RunShellScript 在实例上执行脚本文件内容，轮询并打印 stdout/stderr。
#
# 关键：用 --cli-input-json + jq 构造请求体，把脚本作为「单个数组元素」传给 commands，
# 完整保留换行/引号（避免 shorthand 语法把 \n 损坏成字面量 n）。
set -uo pipefail
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
IID="$1"; CMD_FILE="$2"; TIMEOUT="${3:-3600}"

REQ=$(mktemp)
jq -n --rawfile script "$CMD_FILE" --arg iid "$IID" --argjson to "$TIMEOUT" '{
  InstanceIds: [$iid],
  DocumentName: "AWS-RunShellScript",
  Comment: "kiro deploy",
  TimeoutSeconds: $to,
  Parameters: { commands: [$script] }
}' > "$REQ"

CID=$(aws ssm send-command --cli-input-json "file://$REQ" --query 'Command.CommandId' --output text)
rm -f "$REQ"
echo "[ssm] CommandId=$CID  (instance $IID)"

# SSM 需要一点时间注册 invocation
sleep 3
while true; do
  ST=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query 'Status' --output text 2>/dev/null || echo "Pending")
  case "$ST" in
    Success|Failed|Cancelled|TimedOut) break;;
  esac
  sleep 5
done

echo "[ssm] Status=$ST"
echo "----- STDOUT -----"
aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query 'StandardOutputContent' --output text
ERR=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query 'StandardErrorContent' --output text)
if [ -n "$ERR" ] && [ "$ERR" != "None" ]; then
  echo "----- STDERR -----"; echo "$ERR"
fi
echo "[ssm] CommandId=$CID Status=$ST"
[ "$ST" = "Success" ]

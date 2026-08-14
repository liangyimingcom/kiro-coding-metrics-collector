#!/usr/bin/env bash
# 本地冒烟测试：用 Docker Postgres 验证迁移后的 dashboard 端到端契约。
set -uo pipefail
APP=/home/ubuntu/workspace/sample-kiro-coding-metrics-collector/kiro-dashboard
cd "$APP"

export DB_HOST=127.0.0.1 DB_PORT=5433 DB_NAME=kiro DB_USER=kiro DB_PASSWORD=kirolocal DB_SSL=false
export AWS_REGION=us-east-1
export INGEST_PORT=8080 DASHBOARD_PORT=8085
# 不配置 IDENTITY_STORE_ID/S3 → credit/session sync 自动跳过

echo "===== 重置本地库 ====="
docker exec kiro-pg-local psql -U kiro -d kiro -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null 2>&1

echo "===== 启动服务 (main.js) ====="
node src/main.js > /tmp/kiro-local.log 2>&1 &
SVC_PID=$!
trap "kill $SVC_PID 2>/dev/null" EXIT
sleep 4
echo "--- 启动日志 ---"; sed 's/^/  /' /tmp/kiro-local.log | head -25

H_ING="http://127.0.0.1:8080"
H_DASH="http://127.0.0.1:8085"

echo ""; echo "===== POST /api/v1/stats (模拟 git-ai 上报) ====="
curl -s -X POST "$H_ING/api/v1/stats" \
  -H 'Content-Type: application/json' -H 'X-Idempotency-Key: smoke-key-1' \
  -d '{
    "repo_name":"demo-repo","repo_remote_url":"https://example.com/demo-repo.git",
    "branch":"main","commit_sha":"abc123def456","machine_id":"m-1",
    "user_name":"Alice","user_email":"alice@example.com","reported_at":"2026-06-29T10:00:00Z",
    "commit_msg":"feat: add login","commit_stats":{
      "human_additions":40,"ai_additions":60,"mixed_additions":10,"ai_accepted":55,
      "total_ai_additions":70,"total_ai_deletions":5,"time_waiting_for_ai":1200,
      "git_diff_added_lines":100,"git_diff_deleted_lines":8,"ai_deletions":3,"human_deletions":2,
      "tool_model_breakdown":{"Kiro/claude-sonnet-4":{"ai_additions":60,"mixed_additions":10,"ai_accepted":55,"total_ai_additions":70,"total_ai_deletions":5,"time_waiting_for_ai":1200}}
    }}'
echo ""
echo "--- 重复幂等 (同 key, 期望 ok 且不重复入库) ---"
curl -s -X POST "$H_ING/api/v1/stats" -H 'Content-Type: application/json' -H 'X-Idempotency-Key: smoke-key-1' -d '{"repo_name":"demo-repo","commit_sha":"abc123def456"}'; echo ""
echo "--- 第二个 commit (不同用户) ---"
curl -s -X POST "$H_ING/api/v1/stats" -H 'Content-Type: application/json' -H 'X-Idempotency-Key: smoke-key-2' \
  -d '{"repo_name":"demo-repo","branch":"main","commit_sha":"sha-2","machine_id":"m-2","user_name":"Bob","user_email":"bob@example.com","reported_at":"2026-06-29T11:00:00Z","commit_msg":"fix","commit_stats":{"human_additions":20,"ai_additions":5,"mixed_additions":0,"ai_accepted":5,"total_ai_additions":5,"total_ai_deletions":0,"time_waiting_for_ai":100,"git_diff_added_lines":25,"git_diff_deleted_lines":1,"ai_deletions":0,"human_deletions":0,"tool_model_breakdown":{}}}'; echo ""

echo ""; echo "===== POST /api/v1/userSync (模拟插件用户上报) ====="
curl -s -X POST "$H_ING/api/v1/userSync" -H 'Content-Type: application/json' \
  -d '{"user_name":"alice@example.com","user_ip":"10.162.255.10","hostname":"alice-mac","credit_used":{"2026-06-29":12.5}}'; echo ""

echo ""; echo "===== GET /api/repos ====="; curl -s "$H_DASH/api/repos" | jq .
echo ""; echo "===== GET /api/repos/demo-repo/aggregate ====="; curl -s "$H_DASH/api/repos/demo-repo/aggregate" | jq '{repo_name,totals,by_user_keys:(.by_user|keys),by_tool_model}'
echo ""; echo "===== GET /api/repos/demo-repo (raw) ====="; curl -s "$H_DASH/api/repos/demo-repo" | jq 'length as $n | {records:$n, first:(.[0]|{commit_sha,user_name,commit_msg,ai:.commit_stats.ai_additions, tmb:(.commit_stats.tool_model_breakdown|keys)})}'
echo ""; echo "===== GET /api/repos/demo-repo/ai-ratio-history ====="; curl -s "$H_DASH/api/repos/demo-repo/ai-ratio-history" | jq .
echo ""; echo "===== GET /api/users (无 IdC: 期望 500 或空, 不应崩溃) ====="; curl -s -o /tmp/users.json -w "HTTP %{http_code}\n" "$H_DASH/api/users"; head -c 300 /tmp/users.json; echo ""

echo ""; echo "===== 直接查 RDS(本地pg) 校验落库 ====="
docker exec kiro-pg-local psql -U kiro -d kiro -c "SELECT repo_name,user_name,commit_sha,ai_additions,human_additions FROM commits ORDER BY id;"
docker exec kiro-pg-local psql -U kiro -d kiro -c "SELECT count(*) AS idem_keys FROM idempotency_keys;"
docker exec kiro-pg-local psql -U kiro -d kiro -c "SELECT user_name,credit_used,plugin_added FROM kiro_user;"
docker exec kiro-pg-local psql -U kiro -d kiro -c "SELECT hostname,user_name,ip FROM plugins;"

echo ""; echo "===== 服务运行日志(尾部) ====="; tail -15 /tmp/kiro-local.log
echo "DONE"

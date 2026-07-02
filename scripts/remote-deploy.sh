#!/usr/bin/env bash
# 在 EC2 上执行（经 SSM）：安装 Node20 → 拉取代码 → npm install → 写 .env → systemd 启动
set -euo pipefail
exec 2>&1
echo "===== [remote] whoami / env ====="; whoami; uname -a

echo "===== [remote] Install Node.js 20 (nodesource) ====="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  dnf install -y nodejs gcc-c++ make
fi
node -v; npm -v

echo "===== [remote] Fetch dashboard source from S3 ====="
mkdir -p /opt/kiro
aws s3 cp "s3://__DEPLOY_BUCKET__/kiro-dashboard-src.tgz" /opt/kiro/src.tgz --region us-east-1
tar -xzf /opt/kiro/src.tgz -C /opt/kiro
APP=/opt/kiro/kiro-dashboard
cd "$APP"

echo "===== [remote] npm install (production) ====="
npm install --omit=dev 2>&1 | tail -8

echo "===== [remote] Write .env (points at RDS) ====="
cat > "$APP/.env" <<EOF
DB_HOST=__DB_HOST__
DB_PORT=__DB_PORT__
DB_NAME=__DB_NAME__
DB_USER=__DB_USER__
DB_PASSWORD=__DB_PASSWORD__
DB_SSL=require
AWS_REGION=us-east-1
IDENTITY_STORE_ID=__IDENTITY_STORE_ID__
INGEST_PORT=80
DASHBOARD_PORT=3500
EOF
chmod 600 "$APP/.env"
echo "(.env written, DB_HOST=__DB_HOST__)"

echo "===== [remote] systemd service ====="
cat > /etc/systemd/system/kiro-dashboard.service <<EOF
[Unit]
Description=Kiro Coding Metrics Dashboard (RDS PostgreSQL)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP
ExecStart=/usr/bin/node $APP/src/main.js
Restart=always
RestartSec=5
# 80 端口需要 root 或 CAP_NET_BIND_SERVICE；此处以 root 运行（演示环境）
User=root
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable kiro-dashboard
systemctl restart kiro-dashboard
sleep 6
echo "===== [remote] service status ====="
systemctl is-active kiro-dashboard || true
journalctl -u kiro-dashboard --no-pager -n 30

echo "===== [remote] local self-test (loopback) ====="
sleep 2
echo "--- POST /api/v1/stats ---"
curl -s -X POST http://127.0.0.1/api/v1/stats -H 'Content-Type: application/json' -H 'X-Idempotency-Key: ec2-smoke-1' \
  -d '{"repo_name":"vpc-demo","branch":"main","commit_sha":"ec2sha001","machine_id":"ec2m","user_name":"Deployer","user_email":"deployer@corp.example","reported_at":"2026-06-29T12:00:00Z","commit_msg":"deploy test","commit_stats":{"human_additions":30,"ai_additions":70,"mixed_additions":5,"ai_accepted":68,"total_ai_additions":75,"total_ai_deletions":2,"time_waiting_for_ai":900,"git_diff_added_lines":100,"git_diff_deleted_lines":3,"ai_deletions":1,"human_deletions":1,"tool_model_breakdown":{"Kiro/claude-opus-4":{"ai_additions":70,"mixed_additions":5,"ai_accepted":68,"total_ai_additions":75,"total_ai_deletions":2,"time_waiting_for_ai":900}}}}'
echo ""
echo "--- GET /api/repos (dashboard:3500) ---"
curl -s http://127.0.0.1:3500/api/repos
echo ""
echo "--- GET /api/repos/vpc-demo/aggregate ---"
curl -s http://127.0.0.1:3500/api/repos/vpc-demo/aggregate
echo ""
echo "===== [remote] DONE ====="

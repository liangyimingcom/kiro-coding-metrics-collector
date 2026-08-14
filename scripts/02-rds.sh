#!/usr/bin/env bash
# ============================================================
# 02-rds.sh — 在私有子网创建 RDS PostgreSQL
#   - DB 子网组横跨两个私有子网 (kiro-ai-us-east-1 A/B)
#   - 引擎 PostgreSQL 16, db.t4g.micro, 20GB gp3
#   - 不公网可达 (--no-publicly-accessible)
#   - 仅 app SG 可访问 5432 (kiro-db-sg)
# 凭据写入 state/rds.env （含明文口令，仅限本演示环境）。
# ============================================================
set -euo pipefail
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
STATE_DIR="$(cd "$(dirname "$0")/.." && pwd)/state"
source "$STATE_DIR/network.env"
RDS_ENV="$STATE_DIR/rds.env"
PROJ="kiro-metrics-rds"

DB_ID="kiro-metrics-pg"
DB_NAME="kiro"
DB_USER="kiroadmin"
# 生成一个无特殊字符的随机口令（避免 URL 转义问题）
DB_PASS="Kiro$(openssl rand -hex 12)Pg1"
SUBNET_GROUP="kiro-db-subnet-group"

echo "==> [1/3] Create DB subnet group (private A + B)"
if aws rds describe-db-subnet-groups --db-subnet-group-name "$SUBNET_GROUP" >/dev/null 2>&1; then
  echo "  reuse subnet group $SUBNET_GROUP"
else
  aws rds create-db-subnet-group \
    --db-subnet-group-name "$SUBNET_GROUP" \
    --db-subnet-group-description "Kiro metrics private subnets" \
    --subnet-ids "$PRIV_SUBNET_A" "$PRIV_SUBNET_B" \
    --tags "Key=Project,Value=$PROJ" >/dev/null
fi

echo "==> [2/3] Create RDS PostgreSQL instance ($DB_ID)"
if aws rds describe-db-instances --db-instance-identifier "$DB_ID" >/dev/null 2>&1; then
  echo "  instance already exists, skipping create"
else
  aws rds create-db-instance \
    --db-instance-identifier "$DB_ID" \
    --db-name "$DB_NAME" \
    --engine postgres \
    --engine-version 16.14 \
    --db-instance-class db.t4g.micro \
    --allocated-storage 20 \
    --storage-type gp3 \
    --master-username "$DB_USER" \
    --master-user-password "$DB_PASS" \
    --vpc-security-group-ids "$SG_DB" \
    --db-subnet-group-name "$SUBNET_GROUP" \
    --no-publicly-accessible \
    --backup-retention-period 1 \
    --no-multi-az \
    --no-auto-minor-version-upgrade \
    --tags "Key=Project,Value=$PROJ" >/dev/null

  # 仅在“本次新建”时写入口令（避免重复运行覆盖成新口令而实例没改）
  cat > "$RDS_ENV" <<EOF
DB_ID=$DB_ID
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
SUBNET_GROUP=$SUBNET_GROUP
EOF
  echo "  credentials saved to $RDS_ENV"
fi

echo "==> [3/3] Waiting for RDS to become available (~6-10 min)..."
aws rds wait db-instance-available --db-instance-identifier "$DB_ID"

ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier "$DB_ID" \
  --query 'DBInstances[0].Endpoint.Address' --output text)
PORT=$(aws rds describe-db-instances --db-instance-identifier "$DB_ID" \
  --query 'DBInstances[0].Endpoint.Port' --output text)
echo "DB_HOST=$ENDPOINT" >> "$RDS_ENV"
echo "DB_PORT=$PORT" >> "$RDS_ENV"
echo "==> RDS available at $ENDPOINT:$PORT"
cat "$RDS_ENV"

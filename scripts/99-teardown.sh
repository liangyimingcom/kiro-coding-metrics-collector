#!/usr/bin/env bash
# ============================================================
# 99-teardown.sh — 清理本演示创建的所有 AWS 资源
#   顺序：EC2 → RDS → NAT/EIP → IGW → 子网 → 路由表 → 安全组 → VPC → S3
#   依赖 state/*.env 中保存的资源 ID。
#   用法：bash 99-teardown.sh         # 交互确认
#         bash 99-teardown.sh --yes   # 跳过确认
# ============================================================
set -uo pipefail
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
STATE_DIR="$(cd "$(dirname "$0")/.." && pwd)/state"
source "$STATE_DIR/network.env" 2>/dev/null || true
source "$STATE_DIR/rds.env"     2>/dev/null || true
source "$STATE_DIR/ec2.env"     2>/dev/null || true
source "$STATE_DIR/windows.env" 2>/dev/null || true

if [ "${1:-}" != "--yes" ]; then
  echo "将删除以下资源（不可恢复）："
  echo "  Windows测试机: ${WIN_EC2_ID:-<none>}  SG: ${SG_WIN:-<none>}"
  echo "  Dashboard EC2: ${EC2_ID:-<none>}"
  echo "  RDS:   ${DB_ID:-<none>}"
  echo "  NAT:   ${NAT_ID:-<none>}  EIP: ${EIP_ALLOC:-<none>}"
  echo "  VPC:   ${VPC_ID:-<none>}  + 子网/路由表/安全组/IGW"
  echo "  S3:    ${DEPLOY_BUCKET:-<none>}"
  read -r -p "确认删除？输入 yes 继续: " ans
  [ "$ans" = "yes" ] || { echo "已取消"; exit 0; }
fi

q() { "$@" 2>/dev/null || true; }

echo "==> 终止 Windows 测试机（若有）"
[ -n "${WIN_EC2_ID:-}" ] && { q aws ec2 terminate-instances --instance-ids "$WIN_EC2_ID"; q aws ec2 wait instance-terminated --instance-ids "$WIN_EC2_ID"; }

echo "==> 终止 Dashboard EC2"
[ -n "${EC2_ID:-}" ] && { q aws ec2 terminate-instances --instance-ids "$EC2_ID"; q aws ec2 wait instance-terminated --instance-ids "$EC2_ID"; }

echo "==> 删除 RDS（跳过最终快照）"
if [ -n "${DB_ID:-}" ]; then
  q aws rds delete-db-instance --db-instance-identifier "$DB_ID" --skip-final-snapshot --delete-automated-backups
  q aws rds wait db-instance-deleted --db-instance-identifier "$DB_ID"
  q aws rds delete-db-subnet-group --db-subnet-group-name "${SUBNET_GROUP:-kiro-db-subnet-group}"
fi

echo "==> 删除 NAT 网关并释放 EIP"
[ -n "${NAT_ID:-}" ] && { q aws ec2 delete-nat-gateway --nat-gateway-id "$NAT_ID"; q aws ec2 wait nat-gateway-deleted --nat-gateway-ids "$NAT_ID"; }
[ -n "${EIP_ALLOC:-}" ] && q aws ec2 release-address --allocation-id "$EIP_ALLOC"

echo "==> 分离并删除 IGW"
[ -n "${IGW_ID:-}" ] && [ -n "${VPC_ID:-}" ] && { q aws ec2 detach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID"; q aws ec2 delete-internet-gateway --internet-gateway-id "$IGW_ID"; }

echo "==> 删除子网"
for s in "${PRIV_SUBNET_A:-}" "${PRIV_SUBNET_B:-}" "${PUB_SUBNET:-}"; do [ -n "$s" ] && q aws ec2 delete-subnet --subnet-id "$s"; done

echo "==> 删除自定义路由表"
for r in "${RT_PUB:-}" "${RT_PRIV:-}"; do [ -n "$r" ] && q aws ec2 delete-route-table --route-table-id "$r"; done

echo "==> 删除安全组（先 win/db 再 app，因 db 引用 app）"
[ -n "${SG_WIN:-}" ] && q aws ec2 delete-security-group --group-id "$SG_WIN"
[ -n "${SG_DB:-}" ]  && q aws ec2 delete-security-group --group-id "$SG_DB"
[ -n "${SG_APP:-}" ] && q aws ec2 delete-security-group --group-id "$SG_APP"

echo "==> 删除 VPC"
[ -n "${VPC_ID:-}" ] && q aws ec2 delete-vpc --vpc-id "$VPC_ID"

echo "==> 清空并删除 S3 部署桶"
[ -n "${DEPLOY_BUCKET:-}" ] && { q aws s3 rm "s3://$DEPLOY_BUCKET" --recursive; q aws s3api delete-bucket --bucket "$DEPLOY_BUCKET"; }

echo "==> Teardown 完成。"

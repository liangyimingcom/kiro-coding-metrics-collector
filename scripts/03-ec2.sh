#!/usr/bin/env bash
# ============================================================
# 03-ec2.sh — 在私有子网 A 启动 AL2023 EC2，使用 SSM 实例配置文件
#   - 复用现成实例配置文件 AmazonSSMRoleForInstancesQuickSetup
#     (含 AmazonSSMManagedInstanceCore，支持 SSM 管理，无需 SSH/堡垒机)
#   - 私有子网无公网 IP，出网经 NAT（用于 SSM agent 注册 + yum/npm）
#   - 安全组 kiro-app-sg
# ============================================================
set -euo pipefail
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
STATE_DIR="$(cd "$(dirname "$0")/.." && pwd)/state"
source "$STATE_DIR/network.env"
EC2_ENV="$STATE_DIR/ec2.env"
PROJ="kiro-metrics-rds"

AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query 'Parameter.Value' --output text)
INSTANCE_PROFILE="AmazonSSMRoleForInstancesQuickSetup"
ROLE_NAME="${INSTANCE_PROFILE}"   # 该实例配置文件对应的角色同名

# ★ 复用现成 SSM 角色时，它默认【没有】应用运行所需的 AWS 权限 —— 会导致
#   用户管理拿不到 IdC 真实用户、session/credit 同步失败而降级。
#   这里幂等地补一个只读内联策略，覆盖代码里全部 AWS 调用（不影响 SSM 本职）：
#     identitystore:ListUsers/DescribeUser  —— 用户同步
#     cloudtrail:LookupEvents               —— session 同步
#     s3:GetObject/ListBucket               —— credit 同步读 Kiro 活动报告桶
echo "==> 为实例角色补应用只读权限（IdC + CloudTrail + S3）"
cat > /tmp/kiro-app-readonly.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "KiroIdc",        "Effect": "Allow", "Action": ["identitystore:ListUsers","identitystore:DescribeUser"], "Resource": "*" },
    { "Sid": "KiroCloudTrail", "Effect": "Allow", "Action": ["cloudtrail:LookupEvents"], "Resource": "*" },
    { "Sid": "KiroS3Read",     "Effect": "Allow", "Action": ["s3:GetObject","s3:ListBucket"], "Resource": "*" }
  ]
}
JSON
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name kiro-app-readonly \
  --policy-document file:///tmp/kiro-app-readonly.json 2>/dev/null \
  && echo "  ✓ 已加 kiro-app-readonly 到 $ROLE_NAME" \
  || echo "  (跳过：无权改该角色或已存在；若功能受限请手动加 identitystore:ListUsers / cloudtrail:LookupEvents / s3:GetObject)"

echo "==> Launching EC2 (AMI=$AMI) in private subnet A ($PRIV_SUBNET_A)"
IID=$(aws ec2 run-instances \
  --image-id "$AMI" \
  --instance-type t3.small \
  --subnet-id "$PRIV_SUBNET_A" \
  --security-group-ids "$SG_APP" \
  --iam-instance-profile "Name=$INSTANCE_PROFILE" \
  --no-associate-public-ip-address \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Project,Value=$PROJ},{Key=Name,Value=kiro-dashboard-ec2}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "EC2_ID=$IID" > "$EC2_ENV"
echo "  EC2_ID=$IID"

echo "==> Waiting for instance running..."
aws ec2 wait instance-running --instance-ids "$IID"
PRIV_IP=$(aws ec2 describe-instances --instance-ids "$IID" \
  --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)
echo "EC2_PRIVATE_IP=$PRIV_IP" >> "$EC2_ENV"
echo "  EC2_PRIVATE_IP=$PRIV_IP"

echo "==> Waiting for SSM agent to register (up to ~3 min)..."
for i in $(seq 1 36); do
  PING=$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$IID" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo "None")
  if [ "$PING" = "Online" ]; then echo "  SSM Online."; break; fi
  sleep 5
done
[ "$PING" = "Online" ] || { echo "  [ERROR] SSM agent did not come online"; exit 1; }

echo "==> EC2 ready."
cat "$EC2_ENV"

#!/usr/bin/env bash
# ============================================================
# 01-network.sh — 模拟客户 VPC 网络布局
#   VPC:            10.162.255.0/24
#   私有子网 A:     10.162.255.0/26   (us-east-1a)  kiro-ai-us-east-1
#   私有子网 B:     10.162.255.64/26  (us-east-1b)  kiro-ai-us-east-1
#   公有子网:       10.162.255.128/26 (us-east-1a)
#   + IGW + NAT GW(公有子网) + 路由表 + 安全组(app/db)
# 所有资源打 tag: Project=kiro-metrics-rds  便于统一清理
# 幂等：状态写入 state/*.env，重复运行不会重复创建
# ============================================================
set -euo pipefail
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
STATE_DIR="$(cd "$(dirname "$0")/.." && pwd)/state"
mkdir -p "$STATE_DIR"
NET="$STATE_DIR/network.env"
PROJ="kiro-metrics-rds"
AZ_A="us-east-1a"; AZ_B="us-east-1b"

tag() { echo "Key=Project,Value=$PROJ Key=Name,Value=$1"; }
save() { echo "$1=$2" >> "$NET"; echo "  -> $1=$2"; }

# 读取已有状态（幂等）
[ -f "$NET" ] && source "$NET" || true
: > "$NET"  # 重新生成，下面逐步写入

echo "==> [1/9] Create VPC 10.162.255.0/24"
if [ -n "${VPC_ID:-}" ] && aws ec2 describe-vpcs --vpc-ids "$VPC_ID" >/dev/null 2>&1; then
  echo "  reuse VPC_ID=$VPC_ID"
else
  VPC_ID=$(aws ec2 create-vpc --cidr-block 10.162.255.0/24 \
    --tag-specifications "ResourceType=vpc,Tags=[{Key=Project,Value=$PROJ},{Key=Name,Value=kiro-vpc}]" \
    --query 'Vpc.VpcId' --output text)
  aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-hostnames '{"Value":true}'
  aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-support '{"Value":true}'
fi
save VPC_ID "$VPC_ID"

mk_subnet() { # $1=cidr $2=az $3=name
  aws ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block "$1" --availability-zone "$2" \
    --tag-specifications "ResourceType=subnet,Tags=[{Key=Project,Value=$PROJ},{Key=Name,Value=$3}]" \
    --query 'Subnet.SubnetId' --output text
}

echo "==> [2/9] Private subnet A 10.162.255.0/26 ($AZ_A) kiro-ai-us-east-1"
PRIV_A=$(mk_subnet 10.162.255.0/26 "$AZ_A" kiro-ai-us-east-1-a); save PRIV_SUBNET_A "$PRIV_A"
echo "==> [3/9] Private subnet B 10.162.255.64/26 ($AZ_B) kiro-ai-us-east-1"
PRIV_B=$(mk_subnet 10.162.255.64/26 "$AZ_B" kiro-ai-us-east-1-b); save PRIV_SUBNET_B "$PRIV_B"
echo "==> [4/9] Public subnet 10.162.255.128/26 ($AZ_A)"
PUB=$(mk_subnet 10.162.255.128/26 "$AZ_A" kiro-public); save PUB_SUBNET "$PUB"
aws ec2 modify-subnet-attribute --subnet-id "$PUB" --map-public-ip-on-launch >/dev/null

echo "==> [5/9] Internet Gateway"
IGW=$(aws ec2 create-internet-gateway \
  --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Project,Value=$PROJ},{Key=Name,Value=kiro-igw}]" \
  --query 'InternetGateway.InternetGatewayId' --output text); save IGW_ID "$IGW"
aws ec2 attach-internet-gateway --internet-gateway-id "$IGW" --vpc-id "$VPC_ID"

echo "==> [6/9] EIP + NAT Gateway (in public subnet)"
EIP_ALLOC=$(aws ec2 allocate-address --domain vpc \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Project,Value=$PROJ},{Key=Name,Value=kiro-nat-eip}]" \
  --query 'AllocationId' --output text); save EIP_ALLOC "$EIP_ALLOC"
NAT=$(aws ec2 create-nat-gateway --subnet-id "$PUB" --allocation-id "$EIP_ALLOC" \
  --tag-specifications "ResourceType=natgateway,Tags=[{Key=Project,Value=$PROJ},{Key=Name,Value=kiro-nat}]" \
  --query 'NatGateway.NatGatewayId' --output text); save NAT_ID "$NAT"
echo "  waiting for NAT gateway to become available (may take ~1-2 min)..."
aws ec2 wait nat-gateway-available --nat-gateway-ids "$NAT"
echo "  NAT available."

echo "==> [7/9] Route tables"
# public RT -> IGW
RT_PUB=$(aws ec2 create-route-table --vpc-id "$VPC_ID" \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Project,Value=$PROJ},{Key=Name,Value=kiro-rt-public}]" \
  --query 'RouteTable.RouteTableId' --output text); save RT_PUB "$RT_PUB"
aws ec2 create-route --route-table-id "$RT_PUB" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW" >/dev/null
aws ec2 associate-route-table --route-table-id "$RT_PUB" --subnet-id "$PUB" >/dev/null
# private RT -> NAT
RT_PRIV=$(aws ec2 create-route-table --vpc-id "$VPC_ID" \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Project,Value=$PROJ},{Key=Name,Value=kiro-rt-private}]" \
  --query 'RouteTable.RouteTableId' --output text); save RT_PRIV "$RT_PRIV"
aws ec2 create-route --route-table-id "$RT_PRIV" --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$NAT" >/dev/null
aws ec2 associate-route-table --route-table-id "$RT_PRIV" --subnet-id "$PRIV_A" >/dev/null
aws ec2 associate-route-table --route-table-id "$RT_PRIV" --subnet-id "$PRIV_B" >/dev/null

echo "==> [8/9] Security groups"
# app SG (EC2): allow ingress 3500/80 from within VPC; egress all
SG_APP=$(aws ec2 create-security-group --group-name kiro-app-sg --description "Kiro dashboard app SG" \
  --vpc-id "$VPC_ID" \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=$PROJ},{Key=Name,Value=kiro-app-sg}]" \
  --query 'GroupId' --output text); save SG_APP "$SG_APP"
aws ec2 authorize-security-group-ingress --group-id "$SG_APP" --protocol tcp --port 3500 --cidr 10.162.255.0/24 >/dev/null
aws ec2 authorize-security-group-ingress --group-id "$SG_APP" --protocol tcp --port 80   --cidr 10.162.255.0/24 >/dev/null
# db SG (RDS): allow 5432 only from app SG
SG_DB=$(aws ec2 create-security-group --group-name kiro-db-sg --description "Kiro RDS SG" \
  --vpc-id "$VPC_ID" \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=$PROJ},{Key=Name,Value=kiro-db-sg}]" \
  --query 'GroupId' --output text); save SG_DB "$SG_DB"
aws ec2 authorize-security-group-ingress --group-id "$SG_DB" --protocol tcp --port 5432 \
  --source-group "$SG_APP" >/dev/null

echo "==> [9/9] Done. State saved to $NET"
cat "$NET"

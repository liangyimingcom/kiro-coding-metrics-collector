#!/usr/bin/env bash
# ============================================================
# 04-windows-test-ec2.sh — 在公有子网建一台 Windows Server 测试机
#   目的: 装 Kiro IDE + 插件，真跑 AI coding→commit→上报到私有子网的 dashboard
#   连接: SSM 端口转发 RDP（不开任何公网入站端口）
#   网络: 公有子网 10.162.255.128/26（同 VPC，天然能连 dashboard 10.162.255.8）
#   出网: 公网 IP + IGW（SSM 注册 + 下载 Kiro/浏览器）
# ============================================================
set -euo pipefail
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
STATE_DIR="$(cd "$(dirname "$0")/.." && pwd)/state"
source "$STATE_DIR/network.env"
WIN_ENV="$STATE_DIR/windows.env"
PROJ="kiro-metrics-rds"

AMI=$(aws ssm get-parameter --name /aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base --query 'Parameter.Value' --output text)
INSTANCE_PROFILE="AmazonSSMRoleForInstancesQuickSetup"   # 含 AmazonSSMManagedInstanceCore
# 随机 RDP 管理员口令（满足 Windows 复杂度：大小写+数字+符号）
RDP_PASS="Kiro!$(openssl rand -hex 8)Aa1"

echo "==> [1/4] 测试机安全组（无公网入站；出站全开，用于连 dashboard + 出网）"
if [ -n "${SG_WIN:-}" ] && aws ec2 describe-security-groups --group-ids "$SG_WIN" >/dev/null 2>&1; then
  echo "  reuse SG_WIN=$SG_WIN"
else
  SG_WIN=$(aws ec2 create-security-group --group-name kiro-win-test-sg \
    --description "Kiro Windows test box (RDP via SSM only, no public ingress)" \
    --vpc-id "$VPC_ID" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=$PROJ},{Key=Name,Value=kiro-win-test-sg}]" \
    --query 'GroupId' --output text)
  # 不加任何 ingress（RDP 走 SSM 转发）。egress 默认全开。
fi

echo "==> [2/4] user-data：设置管理员口令 + 确保 SSM agent 运行"
USERDATA=$(cat <<PS
<powershell>
# 设置内置 Administrator 口令并启用账户（仅用于 RDP 登录）
net user Administrator "$RDP_PASS"
wmic useraccount where "name='Administrator'" set PasswordExpires=false
# 确保 RDP 服务开启（监听 3389，仅经 SSM 转发可达）
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
Enable-NetFirewallRule -DisplayGroup "Remote Desktop"
# SSM Agent 在 Windows AMI 默认已装；确保运行
Set-Service AmazonSSMAgent -StartupType Automatic
Start-Service AmazonSSMAgent
</powershell>
PS
)

echo "==> [3/4] 启动 Windows EC2（公有子网，t3.large 跑 IDE 更顺）"
IID=$(aws ec2 run-instances \
  --image-id "$AMI" \
  --instance-type t3.large \
  --subnet-id "$PUB_SUBNET" \
  --security-group-ids "$SG_WIN" \
  --iam-instance-profile "Name=$INSTANCE_PROFILE" \
  --associate-public-ip-address \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=50,VolumeType=gp3}' \
  --user-data "$USERDATA" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Project,Value=$PROJ},{Key=Name,Value=kiro-win-test}]" \
  --query 'Instances[0].InstanceId' --output text)

cat > "$WIN_ENV" <<EOF
SG_WIN=$SG_WIN
WIN_EC2_ID=$IID
RDP_USER=Administrator
RDP_PASS=$RDP_PASS
EOF
echo "  WIN_EC2_ID=$IID  (凭据写入 $WIN_ENV)"

echo "==> [4/4] 等待 running + SSM Online（Windows 启动较慢，约 3-5 分钟）"
aws ec2 wait instance-running --instance-ids "$IID"
PRIV_IP=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)
echo "WIN_PRIVATE_IP=$PRIV_IP" >> "$WIN_ENV"
echo "  private IP=$PRIV_IP（在 10.162.255.128/26，可连 dashboard 10.162.255.8）"

for i in $(seq 1 60); do
  PING=$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$IID" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo None)
  [ "$PING" = "Online" ] && { echo "  SSM Online."; break; }
  sleep 6
done
[ "$PING" = "Online" ] || { echo "  [警告] SSM 暂未 Online，可稍后再查"; }

echo ""
echo "================= 完成 ================="
echo "实例: $IID    私有IP: $PRIV_IP"
echo "RDP 账号: Administrator"
echo "RDP 口令: $RDP_PASS"
echo "（口令也存于 $WIN_ENV）"

# Kiro Coding Metrics Collector — VPC 私有子网 + RDS PostgreSQL 部署手册

> **本手册目标**：让你拿着本包（代码 + 脚本 + 模板），在 AWS 上部署出一套
> **Kiro 编码指标采集系统**，安装生成的 **Kiro 插件**后，它能统计 Kiro 的 AI 代码生成情况
> 并上传到 **RDS PostgreSQL 数据库**，再通过看板查看。
>
> **可被 Kiro CLI 阅读后执行**：每步都给出可复制命令，带 `⚠️` 的需替换占位符。
>
> **无论客户是否已有 VPC，本手册都适配**（§3 提供「新建 VPC」与「复用现有 VPC」两条路）。
>
> **已在 AWS（账号 `774868049561` / `us-east-1`）实测跑通端到端**，证据见 `evidence/` 与附录 D。

---

## 0. 全局流程（必须按此顺序）

这套系统由「先有 Dashboard、后有指向它的插件」组成，**顺序不能颠倒**——因为插件里要写死（或配置）Dashboard 的地址，而这个地址（EC2 私有 IP）要等 Dashboard 部署出来才知道。

```
① 准备网络        →  ② 部署 Dashboard      →  ③ 记录 EC2 私有 IP
  (新建/复用 VPC)      (EC2 + RDS PostgreSQL)     (例如 10.162.255.8)
                                                        │
                                                        ▼
⑥ 看板查看数据   ←  ⑤ 用 Kiro 写代码并 commit  ←  ④ 用该 IP 生成插件并安装
  (浏览器)            (插件统计 AI 行数并上传)       (build-plugin.sh + Install from VSIX)
```

| 步骤 | 章节 | 产出 |
|------|------|------|
| ① 网络 | §3 | VPC / 两个私有子网（可新建或复用） |
| ② 部署 Dashboard | §4 | 私有子网内的 EC2(服务) + RDS(数据库) |
| ③ 记录私有 IP | §4 末 | `EC2_PRIVATE_IP`，供插件使用 |
| ④ 生成并安装插件 | §6 | `git-ai-kiro-*.vsix`，装进 Kiro IDE |
| ⑤ 产生数据 | §7 | 用 Kiro AI 写代码→commit→插件上传 |
| ⑥ 看板查看 | §5 / §7 | 浏览器看 AI 占比、按人/按模型明细 |

---

## 1. 系统组成与数据流

| 组件 | 说明 | 部署位置 |
|------|------|----------|
| `kiro-plugin`（git-ai-kiro VSIX） | Kiro IDE 插件：检测 AI 编码、commit 时算行级归因并 POST 上报 | 开发者机器上的 Kiro IDE |
| `kiro-dashboard`（Node.js） | Ingest API（采集，:80）+ Dashboard（看板与查询 API，:3500） | **VPC 私有子网内的 EC2** |
| 数据库 | **原 SQLite → 本次改造为 RDS PostgreSQL** | **VPC 私有子网内的 RDS** |

```
Kiro IDE 插件 ──POST /api/v1/stats────▶ Ingest(EC2:80) ──▶ RDS PostgreSQL
              ──POST /api/v1/userSync─▶                        ▲
                                                               │
浏览器 ──GET /api/repos 等──▶ Dashboard(EC2:3500) ─────────────┘
```

**插件统计什么**：它解析 Kiro 持久化的执行日志，识别 AI 写入操作，用内置的 `git-ai`
对每次 commit 做行级归因（AI 新增 / 人工新增 / 混合 / AI 接受率 / 等待 AI 时长 / 按工具·模型细分），
通过 post-commit 钩子上传到 Dashboard，最终落进 RDS。

---

## 2. 前置条件与包内容

- AWS CLI v2；凭据具备 EC2 / RDS / IAM / SSM / S3 权限（新建 VPC 还需 VPC 相关权限）；`export AWS_REGION=us-east-1`。
- 已安装 `jq`、`node>=20`。
- 解压后的目录（`code/` 为**完整原仓库 + 本次 RDS 改造**，可独立构建）：
  ```
  ├── 部署手册-Kiro-Metrics-RDS-VPC.md   ← 本文件（主手册，先读这个）
  ├── README.md                           ← 速览与正确顺序
  ├── code/                               ← 完整仓库（原结构 + RDS 改造）
  │   ├── kiro-dashboard/                 ← Dashboard 源码（已迁移到 pg）
  │   ├── kiro-plugin/                    ← 插件源码 + out/ + bin/(预编译二进制) + 预打包 VSIX
  │   ├── git-ai-src/                     ← git-ai Rust 后端源码（仅“重编译二进制”时需要）
  │   ├── skills/                         ← 客户支持技能（原仓库自带）
  │   ├── docs/                           ← 原仓库设计文档（prototype-report / manual-test-plan）
  │   └── README/LICENSE/NOTICE/THIRD-PARTY-LICENSES
  ├── scripts/                            ← 部署/打包/清理脚本（见各章）
  │   ├── 01-network.sh 02-rds.sh 03-ec2.sh   ← 新建 VPC + RDS + Dashboard EC2
  │   ├── 04-windows-test-ec2.sh              ← 建 Windows 测试机（跑插件用）
  │   ├── remote-deploy.sh ssm-run.sh         ← EC2 部署 + SSM 下发助手
  │   ├── build-plugin.sh                     ← ★ 生成指向你 Dashboard 的插件 VSIX
  │   ├── local-smoke.sh 99-teardown.sh       ← 本地冒烟 + 一键清理（含 Windows 机）
  ├── cloudformation/
  │   ├── kiro-metrics-vpc-rds.yaml       ← 【新建 VPC】一键栈
  │   └── kiro-metrics-existing-vpc.yaml  ← 【复用现有 VPC】一键栈
  ├── docs/
  │   └── Windows测试机-端到端验证手册.md  ← 真机跑插件全过程（建机/RDP/排查/指标）
  └── evidence/                           ← 实测端到端证据（含本次 Windows 插件验证）
  ```
  > **构建依赖说明（已实测）**：
  > - 安装插件：直接用 `code/kiro-plugin/git-ai-kiro-0.2.3-rds.vsix`，零依赖。
  > - 重新生成插件（改端点）：只需 `code/kiro-plugin/` 本身（`src` 自包含、`bin/` 已含 mac/win/linux 预编译 `git-ai`）。已在洁净室验证可成功出包。用 §6 的 `build-plugin.sh` 一条命令完成。
  > - 从源码重编译 `git-ai` 二进制（少见）：才需要 `code/git-ai-src/` + Rust/cargo。

---

## 3. 步骤①：准备网络（新建 VPC 或 复用客户现有 VPC）

> **本系统对两种情况都适配。先判断你属于哪种**：

```
客户环境里已经有可用的 VPC 和（至少两个不同 AZ 的）私有子网吗？
   ├─ 没有 / 想要独立隔离环境  ──▶  3A 新建 VPC
   └─ 有，要把系统装进现有网络  ──▶  3B 复用现有 VPC（更贴近生产）
```

### ⚠️ 两种情况共同的硬性要求

1. **私有子网要能出网**（部署阶段 EC2 需访问外网/AWS）：用于装 Node、`npm install`、向
   **SSM** 注册（免 SSH 部署）、从 S3 拉代码。满足以下任一即可：
   - 子网有 **NAT 网关**（最常见，开箱即用）；**或**
   - 配了 **VPC Endpoints**（`ssm`/`ssmmessages`/`ec2messages` + `s3` 网关端点）——此时 SSM 能连，但
     公网 npm 取不到包，需改用「预装 Node 的自定义 AMI / 内网 npm 镜像」。
   - 运行期 RDS 连接是纯内网的，**RDS 本身不需要出网**。
2. **至少两个分属不同可用区的私有子网**（RDS 子网组的硬性要求）。本包实测用的是 1a + 1b。
3. EC2 与 RDS 都在私有子网；RDS 非公网可达；安全组 5432 仅放行 app 安全组。

### 3A. 新建 VPC（模拟/独立环境）

会创建：VPC `10.162.255.0/24` + 私有子网 `…0/26`(1a)、`…64/26`(1b) + 公有子网 `…128/26` + IGW + NAT + 路由 + 安全组。

**方式一（脚本）**：
```bash
cd scripts
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
bash 01-network.sh   # 资源 ID 写入 ../state/network.env
```
**方式二（CloudFormation，连 RDS+EC2 一起建）**：直接用 `cloudformation/kiro-metrics-vpc-rds.yaml`，见 §4 方式 A。

拓扑：
```
        ┌──────────────── VPC 10.162.255.0/24 ────────────────┐
Internet┤ 公有 .128/26: [NAT+EIP]                              │
  ─IGW─ │ 私有A .0/26 : [EC2 Dashboard]──5432──▶[RDS]          │
        │ 私有B .64/26:                                        │
        └──────────────────────────────────────────────────────┘
开发者 Kiro IDE（经 VPN/对等/Direct Connect 可达本 VPC）──:80──▶ EC2 Ingest
```

### 3B. 复用客户现有 VPC（生产推荐）

**不创建、不修改**客户任何网络资源，只把现有 ID 作为参数传入，随后只建 RDS+EC2+安全组。
先收集客户的：

```bash
⚠️ VPC_ID=vpc-xxxxxxxx                       # 现有 VPC
⚠️ PRIV_SUBNET_A=subnet-aaaa                  # 现有私有子网（AZ-1）
⚠️ PRIV_SUBNET_B=subnet-bbbb                  # 现有私有子网（AZ-2，与 A 不同 AZ）
⚠️ VPC_CIDR=10.0.0.0/16                       # 现有 VPC 的 CIDR（用于安全组放行）

# 快速核对这两个子网确实在不同 AZ、且属于该 VPC：
aws ec2 describe-subnets --subnet-ids $PRIV_SUBNET_A $PRIV_SUBNET_B \
  --query 'Subnets[].{Subnet:SubnetId,AZ:AvailabilityZone,VPC:VpcId,CIDR:CidrBlock}' --output table
```

> **好消息**：生产里「开发者机器能否访问私有 Dashboard」这个前提通常天然成立——
> 开发者本就在能访问该 VPC 的企业网/VPN 里。继续用 §4 方式 B 部署。

---

## 4. 步骤②：部署 Dashboard（EC2 + RDS PostgreSQL）

无论 3A/3B，都要先把 Dashboard 源码上传到一个 S3 桶（供 EC2 拉取）：

```bash
⚠️ ACCT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="kiro-metrics-deploy-$ACCT"
aws s3api create-bucket --bucket "$BUCKET" --region us-east-1
cd code
tar -czf kiro-dashboard-src.tgz \
  --exclude='node_modules' --exclude='data/stats.db*' --exclude='.env' --exclude='logs' \
  kiro-dashboard
aws s3 cp kiro-dashboard-src.tgz "s3://$BUCKET/kiro-dashboard-src.tgz"
cd ..
```

下面按你 §3 的选择，选 A 或 B 一条路。

### 方式 A — CloudFormation 一键（最省事）

**3A 新建 VPC** → 用 `kiro-metrics-vpc-rds.yaml`：
```bash
⚠️ DB_PASSWORD='ChangeMe-StrongPass123'   # 8+ 位，避免 / @ " 空格
⚠️ IDENTITY_STORE_ID='d-xxxxxxxxxx'        # 可选，没有就留 ''
aws cloudformation create-stack --stack-name kiro-metrics-rds \
  --template-body file://cloudformation/kiro-metrics-vpc-rds.yaml \
  --capabilities CAPABILITY_IAM \
  --parameters ParameterKey=DBPassword,ParameterValue="$DB_PASSWORD" \
               ParameterKey=DeployBucket,ParameterValue="$BUCKET" \
               ParameterKey=IdentityStoreId,ParameterValue="$IDENTITY_STORE_ID"
aws cloudformation wait stack-create-complete --stack-name kiro-metrics-rds
```

**3B 复用现有 VPC** → 用 `kiro-metrics-existing-vpc.yaml`（传入现有 VPC/子网）：
```bash
⚠️ DB_PASSWORD='ChangeMe-StrongPass123'
⚠️ IDENTITY_STORE_ID=''                    # 可选
aws cloudformation create-stack --stack-name kiro-metrics-rds \
  --template-body file://cloudformation/kiro-metrics-existing-vpc.yaml \
  --capabilities CAPABILITY_IAM \
  --parameters \
    ParameterKey=VpcId,ParameterValue="$VPC_ID" \
    "ParameterKey=PrivateSubnetIds,ParameterValue=\"$PRIV_SUBNET_A,$PRIV_SUBNET_B\"" \
    ParameterKey=VpcCidr,ParameterValue="$VPC_CIDR" \
    ParameterKey=DBPassword,ParameterValue="$DB_PASSWORD" \
    ParameterKey=DeployBucket,ParameterValue="$BUCKET" \
    ParameterKey=IdentityStoreId,ParameterValue="$IDENTITY_STORE_ID"
aws cloudformation wait stack-create-complete --stack-name kiro-metrics-rds
```

> RDS 约 6–10 分钟；整栈约 10–15 分钟。EC2 UserData 会自动装 Node、拉代码、写 `.env`、起 systemd 服务。

**取关键输出（含步骤③要的私有 IP）**：
```bash
aws cloudformation describe-stacks --stack-name kiro-metrics-rds \
  --query 'Stacks[0].Outputs' --output table
# 记下 Ec2PrivateIp（→ §6 生成插件用） 和 RdsEndpoint
```

### 方式 B — 分步 shell 脚本（与实测一致，便于排查）

> 适用于 3A（已 `01-network.sh` 建好网络）。3B 复用现有 VPC 建议走方式 A 的 existing-vpc 模板（最稳妥）。

```bash
cd scripts
bash 02-rds.sh    # 建 DB 子网组(A+B)+RDS PostgreSQL 16.14，凭据/端点写入 ../state/rds.env（6-10分钟）
bash 03-ec2.sh    # 私有子网启动 SSM 托管的 EC2，私有 IP 写入 ../state/ec2.env
```
**授予 EC2 实例角色读取部署桶**（复用现成 SSM 角色时必需）：
```bash
ACCT=$(aws sts get-caller-identity --query Account --output text); BUCKET="kiro-metrics-deploy-$ACCT"
ROLE_ARN="arn:aws:iam::$ACCT:role/AmazonSSMRoleForInstancesQuickSetup"
cat > /tmp/bp.json <<EOF
{"Version":"2012-10-17","Statement":[{"Sid":"KiroEc2Read","Effect":"Allow",
"Principal":{"AWS":"$ROLE_ARN"},"Action":["s3:GetObject","s3:ListBucket"],
"Resource":["arn:aws:s3:::$BUCKET","arn:aws:s3:::$BUCKET/*"]}]}
EOF
aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///tmp/bp.json
```
**经 SSM 部署服务**：
```bash
source ../state/rds.env; source ../state/ec2.env
⚠️ IDENTITY_STORE_ID=''
sed -e "s|__DEPLOY_BUCKET__|$BUCKET|g" -e "s|__DB_HOST__|$DB_HOST|g" -e "s|__DB_PORT__|$DB_PORT|g" \
    -e "s|__DB_NAME__|$DB_NAME|g" -e "s|__DB_USER__|$DB_USER|g" -e "s|__DB_PASSWORD__|$DB_PASSWORD|g" \
    -e "s|__IDENTITY_STORE_ID__|$IDENTITY_STORE_ID|g" remote-deploy.sh > remote-deploy.rendered.sh
bash ssm-run.sh "$EC2_ID" remote-deploy.rendered.sh 900   # 末尾打印 service=active + 本机 self-test
rm -f remote-deploy.rendered.sh                            # 含口令，用完即删
```

### 步骤③：记录 EC2 私有 IP（插件要用）

```bash
# 方式 A：从栈输出取
aws cloudformation describe-stacks --stack-name kiro-metrics-rds \
  --query 'Stacks[0].Outputs[?OutputKey==`Ec2PrivateIp`].OutputValue' --output text
# 方式 B：state/ec2.env 里的 EC2_PRIVATE_IP
```
**把这个 IP 记下来**（例如 `10.162.255.8`），§6 生成插件时填它。

---

## 5. 步骤⑥（先看后用）：验证 Dashboard 本身就绪

EC2 在私有子网内，从「可达该 VPC 的运维机」执行；若你在本机但 EC2 无公网，用 **SSM 端口转发**打通（见附录 E）。

```bash
⚠️ EC2_IP=10.162.255.8

# 模拟一次插件上报（与插件真实 payload 同构）→ 期望 {"status":"ok"}
curl -s -X POST http://$EC2_IP/api/v1/stats -H 'Content-Type: application/json' \
  -H 'X-Idempotency-Key: verify-1' -d '{"repo_name":"smoke","branch":"main","commit_sha":"s1",
  "user_name":"Tester","user_email":"t@corp.example","reported_at":"2026-06-30T12:00:00Z",
  "commit_msg":"smoke","commit_stats":{"human_additions":30,"ai_additions":70,"mixed_additions":5,
  "ai_accepted":68,"total_ai_additions":75,"total_ai_deletions":2,"time_waiting_for_ai":900,
  "git_diff_added_lines":100,"git_diff_deleted_lines":3,"ai_deletions":1,"human_deletions":1,
  "tool_model_breakdown":{"Kiro/claude-opus-4":{"ai_additions":70,"mixed_additions":5,"ai_accepted":68,
  "total_ai_additions":75,"total_ai_deletions":2,"time_waiting_for_ai":900}}}}'

# 看板查询 API
curl -s http://$EC2_IP:3500/api/repos | jq .
curl -s http://$EC2_IP:3500/api/repos/smoke/aggregate | jq '{totals, by_user:(.by_user|keys)}'
echo "浏览器打开看板: http://$EC2_IP:3500/"
```
**通过标准**：上报返回 `{"status":"ok"}`，看板查到该数据。说明 Dashboard+RDS 就绪，可以生成插件了。

---

## 6. 步骤④：生成并安装 Kiro 插件（指向你的 Dashboard）

插件需要知道 Dashboard 地址（步骤③记录的 EC2 私有 IP）。**Ingest 监听 80 端口，所以地址不带端口。**

### 6.1 一条命令生成 VSIX（推荐）

```bash
cd scripts
⚠️ bash build-plugin.sh http://10.162.255.8        # 换成你的 EC2 私有 IP
# 产物: ../code/kiro-plugin/git-ai-kiro-0.2.3-rds.vsix（已内置该端点，并打印校验结果）
```

`build-plugin.sh` 做的事：写入 `apiConfig.ts` 的 `STATS_BASE_URL` → `npm install` → `tsc` 编译 → `vsce package` 出 VSIX → 校验内置端点。

> 若 EC2 私有 IP 不变、且你直接用本包预打包的 `code/kiro-plugin/git-ai-kiro-0.2.3-rds.vsix`（已内置 `http://10.162.255.8`），可跳过本步直接安装。

### 6.2 安装到 Kiro IDE

1. 打开 **Kiro IDE → 扩展 → `...`（右上角）→ Install from VSIX**
2. 选择 `code/kiro-plugin/git-ai-kiro-0.2.3-rds.vsix`
3. **重启 IDE**

插件激活后会自动：发现工作区 git 仓库 → 安装 post-commit 钩子 → 监测 Kiro 的 AI 编辑。

### ⚠️ 6.3 网络前提（务必满足，否则上传静默失败）

Kiro IDE 所在机器必须能路由到 Dashboard：
- **复用现有 VPC（3B）**：开发者在企业网/VPN 内，通常天然可达，直接用私有 IP。
- **新建 VPC（3A）/ 开发者在公网**：需经 **VPN / VPC 对等 / Direct Connect** 接入，或改用**内网 ALB / 私有 DNS** 作为端点（用 `build-plugin.sh http://内网域名` 重新生成）。
- **纯本地试用**：`build-plugin.sh http://127.0.0.1`，并在本机起 Dashboard（附录 F）。

---

## 7. 步骤⑤+⑥：用 Kiro 产生数据并在看板查看

1. 在装了插件的 Kiro IDE 里，打开一个 **git 仓库**（`git init` 的本地仓库即可）。
2. **★关键顺序**：确保「先有 git 仓库 + 插件已激活」，post-commit 钩子才会装上。
   插件在**激活时**给当时已打开的仓库装钩子；若先开 Kiro、后 `git init` 或后打开项目，钩子不会自动补装
   → 这是「commit 了但看板没数据」最常见的原因。补救：`Ctrl+Shift+P` → **`Developer: Reload Window`**，再 commit。
3. **用 Kiro 的 AI 功能写代码**（vibe coding 或 spec 模式让 AI 生成/修改文件）——
   插件靠解析 Kiro 执行日志来识别 AI 编辑，所以必须真正用到 AI，AI 行数才不为 0。
4. `git commit`。post-commit 钩子触发 `git-ai` 计算行级归因，并把统计 POST 到 `http://<EC2_IP>/api/v1/stats`。
5. 打开看板 `http://<EC2_IP>:3500/`：应能看到该仓库、AI/人工/混合行数、AI 接受率、AI 占比趋势、按用户与按模型的明细。

> **确认上传成功**：Kiro `View → Output` 选 `git-ai-kiro`，commit 后应见 `Commit stats uploaded`；
> 服务端 `journalctl -u kiro-dashboard` 应见 `[ingest] Saved commit stats`。
>
> **注意**：钩子安装前发生的旧 commit **不会自动补报、也不会与后续累加**——只统计「启用监控后」的 commit。

### 7.1 完整真机演示（推荐）

想用一台真实 Windows 测试机走完「装 Kiro → 装插件 → AI 写码 → commit → 看板」，
见配套文档 **[`docs/Windows测试机-端到端验证手册.md`](docs/Windows测试机-端到端验证手册.md)**：
含「公有子网建 Windows EC2 → SSM 端口转发 RDP → 远程准备环境 → 排查钩子未装 → 指标解读」，
每步均已实测，并记录了本次真实踩坑（钩子顺序、第一次提交丢失、SSM 多行脚本、RDP 连接）。

### 7.2 指标怎么读（实测 calculator 仓库为例）

| 指标 | 含义 |
|---|---|
| `ai_additions` | 最终留在 commit、归因为 AI 的**净新增行** |
| `human_additions` / `mixed_additions` | 人工新增 / AI 写后被人改过的行 |
| `ai_accepted` | AI 行被原样接受数 |
| `git_diff_added_lines` / `deleted` | git diff 实际增删行 |
| `total_ai_additions` | AI **整个过程的累计写入动作**（含被改写/删除的过程量；与 `ai_additions` 不等是预期） |
| AI 占比 `ai_ratio` | `(ai_additions − mixed_additions*0.5) / (ai_additions + human_additions − mixed_additions)` |

> 数据库、`/api/repos/<repo>/aggregate`、`by_tool_model` 三处应完全一致。

---

## 8. 数据库表与（可选）历史数据迁移

服务首次启动 `store.ensureReady()` 自动建表（幂等）：

| 表 | 用途 |
|----|------|
| `commits` | 每次 commit 行级归因 |
| `tool_model_stats` | 按工具/模型细分 |
| `ai_ratio_history` | 每仓库累计 AI 占比快照（趋势图） |
| `idempotency_keys` | 幂等去重 |
| `kiro_user` / `sessions` / `plugins` | 用户、SSO 会话、活跃插件设备 |

迁移旧 SQLite/JSON 历史（可选）：把旧 JSON 上报文件放入 `kiro-dashboard/data/`，在配好 `.env` 处 `node src/migrate.js`（按 commit_sha 去重写入 RDS）。

---

## 9. 运维（经 SSM，无需 SSH）

```bash
⚠️ EC2_ID=i-xxxxxxxx
RUN(){ aws ssm send-command --instance-ids "$EC2_ID" --document-name AWS-RunShellScript \
  --parameters "commands=[\"$1\"]" --query Command.CommandId --output text; }
RUN 'systemctl status kiro-dashboard --no-pager'
RUN 'journalctl -u kiro-dashboard --no-pager -n 50'
RUN 'systemctl restart kiro-dashboard'
```
`.env` 在 `/opt/kiro/kiro-dashboard/.env`（600）；改后 `systemctl restart kiro-dashboard`。

---

## 10. 生产加固（超出演示范围）

- **看板入口**：私有子网前置 **internal ALB** + ACM/TLS，插件指向 ALB 内网 DNS（IP 变更无感）。
- **数据库**：Multi-AZ、加大备份、用 **Secrets Manager** 托管口令；`DB_SSL` 用 RDS CA 校验。
- **EC2**：最小权限实例角色（existing-vpc 模板已是专属最小角色）。
- **采集鉴权**：Ingest 默认内网信任无鉴权；如需可启用仓库内 `auth.js` 的 Bearer Token。
- **无 NAT 的隔离子网**：加 `ssm`/`ssmmessages`/`ec2messages`/`s3` VPC Endpoints + 预装 Node 的 AMI。

---

## 11. 清理（避免持续计费）

> 计费项：NAT（新建 VPC 才有）、RDS、EC2、EIP。

**CloudFormation**：
```bash
aws s3 rm "s3://$BUCKET" --recursive && aws s3api delete-bucket --bucket "$BUCKET"
aws cloudformation delete-stack --stack-name kiro-metrics-rds
aws cloudformation wait stack-delete-complete --stack-name kiro-metrics-rds
```
> existing-vpc 栈只会删它自己建的 RDS/EC2/安全组/角色，**不动客户原有 VPC**。

**shell 脚本（新建 VPC）**：
```bash
cd scripts && bash 99-teardown.sh        # 或 --yes 跳过确认
```

---

## 附录 A — 改造文件清单（相对原仓库）

```
kiro-dashboard/src/store.js        重写为 pg 异步连接池（核心）
kiro-dashboard/src/ingest.js       await 异步 store；handler 改 async
kiro-dashboard/src/dashboard.js    await 异步 store；/api/users IdC 降级
kiro-dashboard/src/creditSync.js   await userSync / syncIdCUsersToLocal
kiro-dashboard/src/sessionSync.js  await upsertSessions / deleteExpiredSessions
kiro-dashboard/src/main.js         先 ensureReady 再监听；条件启动可选同步
kiro-dashboard/src/envCheck.js     DB_* 必须；AWS 变量可选（实例角色）
kiro-dashboard/src/migrate.js      改用 pg 异步查询去重
kiro-dashboard/package.json        +pg, better-sqlite3 移到 devDeps
kiro-dashboard/.env.example        DB_* 优先；AWS 变量标注可选
kiro-plugin/src/apiConfig.ts       STATS_BASE_URL → http://<EC2私有IP>
kiro-plugin/package.json           version 0.2.2 → 0.2.3
```

## 附录 B — 环境变量

| 变量 | 必须 | 说明 |
|------|:---:|------|
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` | ✅ | RDS 连接（或单一 `DATABASE_URL`） |
| `DB_SSL` | 建议 | `require` 开启 TLS |
| `AWS_REGION` | 建议 | 默认 us-east-1 |
| `IDENTITY_STORE_ID` | 可选 | IdC 用户同步（看板"用户管理"显示真实用户）。**注意：EC2 实例角色须有 `identitystore:ListUsers` 权限**，否则用户管理只显示本地降级数据 |
| `KIRO_S3_BUCKET` `KIRO_S3_PREFIX` `KIRO_ACCOUNT_ID` | 可选 | S3 credit 同步 |
| `INGEST_PORT` `DASHBOARD_PORT` | 可选 | 默认 80 / 3500 |

### 附录 B.1 — Dashboard EC2 实例角色所需 IAM 权限（按代码实际调用整理）

> 这是 **Dashboard 应用本身**运行所需的权限（与 SSM 管理、部署拉代码分开列）。
> CloudFormation 两个模板的实例角色**已包含全部**；用 shell 脚本复用现成 SSM 角色时，
> `03-ec2.sh` 会自动补一条内联策略 `kiro-app-readonly`。

| 功能模块 | 代码调用 | 所需 IAM Action | 缺失后果（优雅降级） |
|---|---|---|---|
| 用户管理 / 同步 | `identitystore:ListUsers`（`identityCenter.js`） | `identitystore:ListUsers`（+`DescribeUser` 备用） | 用户管理只显示本地降级数据（`Unknown`/`UNKNOWN`） |
| 登录会话同步 | `cloudtrail:LookupEvents`（`sessionSync.js`） | `cloudtrail:LookupEvents` | 会话数为 0，插件覆盖率算不出 |
| Credit 用量同步 | `ListObjectsV2` + `GetObject`（`creditSync.js`） | `s3:ListBucket` + `s3:GetObject`（Kiro 活动报告桶） | credit 用量为空 |
| 部署拉取代码 | 从部署桶下载 tgz | `s3:GetObject` + `s3:ListBucket`（部署桶） | EC2 起不来服务（`HeadObject 403`） |
| SSM 管理 | — | 托管策略 `AmazonSSMManagedInstanceCore` | 无法 SSM 连接/下发 |

> 一条覆盖应用全部调用的最小内联策略（演示用 `Resource:"*"`；生产建议把 S3 限定到具体桶 ARN）：
> ```json
> {"Version":"2012-10-17","Statement":[
>   {"Effect":"Allow","Action":["identitystore:ListUsers","identitystore:DescribeUser"],"Resource":"*"},
>   {"Effect":"Allow","Action":["cloudtrail:LookupEvents"],"Resource":"*"},
>   {"Effect":"Allow","Action":["s3:GetObject","s3:ListBucket"],"Resource":"*"}]}
> ```
> 全部为**只读**；缺任一项不会让服务崩溃，只是对应功能降级（envCheck 已把 AWS 集成设为可选）。

## 附录 C — 故障排查

| 现象 | 原因 / 处理 |
|------|------------|
| **插件装了、`userSync` 有但看板无 commit 数据** | **post-commit 钩子未装**（先开 Kiro 后建/开仓库）→ `Developer: Reload Window` 后**再 commit 一次**；查 `.git/hooks/post-commit` 是否存在。**最常见** |
| 看板始终无某次旧 commit | 钩子安装前的 commit 不补报、不累加，只统计启用后的新 commit |
| AI 行数为 0 | 没真正用 Kiro AI 写（vibe/spec）；纯手写 commit 的 AI 行数本就为 0 |
| **用户管理显示不全 / 全是 `Unknown`、`status=UNKNOWN`** | **Dashboard EC2 实例角色缺 `identitystore:ListUsers`** → 加只读权限即可显示 IdC 真实用户（显示名/状态）。CFN 模板已含；复用现成 SSM 角色时 `03-ec2.sh` 会自动补，或手动：`aws iam put-role-policy --role-name <角色> --policy-name kiro-idc-readonly --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["identitystore:ListUsers","identitystore:DescribeUser"],"Resource":"*"}]}'`。**已实测：加权限后立即拉到 IdC 真实用户** |
| 机器连不上 Dashboard | §6.3 网络前提；测试机建议放公有子网（同 VPC 天然可达），见 Windows 测试文档 |
| EC2 拉代码 `HeadObject 403` | 实例角色无部署桶读权限 → §4 方式 B 的桶策略；CFN 模板已自带 |
| 启动报缺 `DB_*` 退出 | `.env` 未配数据库 → 附录 B |
| `cloudtrail:LookupEvents` 拒绝 | 可选 session 同步功能，未授权；不影响核心采集 |
| `/api/users` 500 | 已改为降级；若仍 500 查 RDS 连通性 |
| 连不上 RDS 5432 | EC2 在 `kiro-app-sg`、RDS 在 `kiro-db-sg` 且入站源是 app SG；子网在同 VPC |
| EC2 一直起不来服务（隔离子网） | 私有子网无出网 → §3 共同要求①（NAT 或 Endpoints+自定义 AMI） |
| 子网组报错需要多 AZ | 两个私有子网必须在不同 AZ |
| SSM 下发多行脚本报 `Unexpected token '\n...'` | 别用 shorthand `--parameters`，改用 `--cli-input-json`+jq（`ssm-run.sh` 已实现） |
| RDP `TargetNotConnected` | Windows 首启重启致 SSM 短暂掉线，等 1-2 分钟重试；或本机缺 session-manager-plugin / 账号区域不符 |

## 附录 D — 实测结果（账号 774868049561 / us-east-1）

| 项 | 值 |
|----|----|
| VPC | `vpc-07f349dd936edd3fe` `10.162.255.0/24` |
| 私有子网 A/B | `subnet-091a5de35c79888a2`(1a) / `subnet-0778a7965cd7cb237`(1b) |
| RDS | `kiro-metrics-pg.csc7vhhc35lz.us-east-1.rds.amazonaws.com:5432`（PG 16.14, db.t4g.micro, 非公网） |
| EC2 | `i-0e130b8e7679dcff0`，私有 IP `10.162.255.8`（AL2023, SSM 托管） |
| 端到端 | `POST /api/v1/stats`/`userSync`→ok；5 个查询 API 结构正确；**node-pg 直连 RDS 校验 commits/ai_ratio_history/kiro_user/plugins 均落库** |
| 插件 | `git-ai-kiro-0.2.3-rds.vsix`，端点 `http://10.162.255.8`（洁净室构建验证通过） |
| **真机插件验证** | Windows 测试机 `i-00a83bf17de47d6dc`（公有子网 `10.162.255.159`，SSM 转发 RDP）；装 Kiro+插件→AI 写 calculator→commit→**`calculator` 仓库统计落库 RDS**（ai_additions=20, AI 占比=1.0, tool=`kiro::kiro-ai`）。详见 `docs/Windows测试机-端到端验证手册.md` 与 `evidence/02-windows-plugin-e2e.txt` |
| **数据源自证** | 直接 UPDATE RDS 的 commit_msg → dashboard API 立刻返回该值（未重启服务）→ 证明实时读 RDS、无本地缓存/SQLite |
| **用户管理（IdC）** | 给实例角色加 `identitystore:ListUsers` 后，`/api/users` 拉到 IdC 真实用户 `q-developer(wzp)`、`wzp2(zipeng2 wang)`，status=ENABLED（加权限前因无权限降级为本地 `Unknown`）|

## 附录 E — 用 SSM 端口转发从本机访问私有看板（测试用）

EC2 无公网时，本机装 `session-manager-plugin` 后：
```bash
aws ssm start-session --target <EC2_ID> --region us-east-1 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3500"],"localPortNumber":["3500"]}'
# 另开终端: 浏览器 http://localhost:3500 ；如需测采集再转发 80 -> 本机 8080
```
> 本包已实测此法可拉到看板数据与首页。

## 附录 F — 纯本地离线试用（不依赖 AWS 可达性）

```bash
# 本机用 Docker 起 Postgres
docker run -d --name kiro-pg -e POSTGRES_PASSWORD=kirolocal -e POSTGRES_USER=kiro -e POSTGRES_DB=kiro -p 5433:5432 postgres:16
# 起 Dashboard（指向本地 pg）
cd code/kiro-dashboard && npm install
DB_HOST=127.0.0.1 DB_PORT=5433 DB_NAME=kiro DB_USER=kiro DB_PASSWORD=kirolocal DB_SSL=false \
  INGEST_PORT=8080 DASHBOARD_PORT=8085 node src/main.js
# 生成指向本地的插件
cd ../../scripts && bash build-plugin.sh http://127.0.0.1:8080
```
> 注：本地 ingest 用 8080，需让插件端点带该端口（如上）。

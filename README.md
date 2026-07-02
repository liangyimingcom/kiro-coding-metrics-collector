# Kiro Coding Metrics Collector — RDS 迁移 + VPC 私有子网部署交付包

本包包含将 [sample-kiro-coding-metrics-collector](https://github.com/aws-samples/sample-kiro-coding-metrics-collector)
的本地 SQLite 改造为 **RDS PostgreSQL**，并在**模拟客户 VPC（`10.162.255.0/24`）私有子网**中完成
EC2 + RDS 端到端部署所需的全部代码、IaC、脚本与手册。已在 AWS 实测跑通。

## 先读这个

👉 **[`部署手册-Kiro-Metrics-RDS-VPC.md`](部署手册-Kiro-Metrics-RDS-VPC.md)** — 完整 AWS 环境安装手册（Kiro CLI 可读后执行）。

想用真机完整验证插件效果（装 Kiro→AI 写码→commit→看板），另见
**[`docs/Windows测试机-端到端验证手册.md`](docs/Windows测试机-端到端验证手册.md)**。

## 目录结构

```
.
├── 部署手册-Kiro-Metrics-RDS-VPC.md   主手册（中文，含两种部署路径 + 验证 + 清理）
├── code/                   完整仓库（原结构 + RDS 改造），可独立构建
│   ├── kiro-dashboard/      改造后的 Dashboard 服务（store.js 已迁移到 pg；不含 node_modules/.env）
│   ├── kiro-plugin/         插件源码 + 编译产物 out/ + bin/ 预编译二进制 + git-ai-kiro-0.2.3-rds.vsix
│   ├── git-ai-src/          git-ai Rust 后端源码（仅重编译二进制时需要；不含 target/）
│   ├── skills/              客户支持技能（原仓库自带）
│   └── README/LICENSE/NOTICE/THIRD-PARTY-LICENSES  原仓库根文档与许可
├── cloudformation/
│   ├── kiro-metrics-vpc-rds.yaml       【新建 VPC】一键栈（VPC+子网+NAT+RDS+EC2+角色+自动部署）
│   └── kiro-metrics-existing-vpc.yaml  【复用现有 VPC】一键栈（只建 RDS+EC2+SG+角色，不动客户网络）
├── scripts/
│   ├── 01-network.sh        创建 VPC/子网/NAT/路由/安全组（仅新建 VPC 时）
│   ├── 02-rds.sh            创建私有子网 RDS PostgreSQL
│   ├── 03-ec2.sh            私有子网启动 SSM 管理的 EC2
│   ├── 04-windows-test-ec2.sh   公有子网建 Windows 测试机（真跑插件用）
│   ├── remote-deploy.sh     EC2 上执行的部署脚本（含占位符，渲染后用）
│   ├── ssm-run.sh           SSM 下发脚本助手（正确保留换行）
│   ├── build-plugin.sh      ★ 一条命令生成指向你 Dashboard 的插件 VSIX
│   ├── local-smoke.sh       本地 Docker Postgres 端到端冒烟测试
│   └── 99-teardown.sh       一键清理全部资源（含 Windows 测试机）
├── docs/
│   └── Windows测试机-端到端验证手册.md   真机跑插件全过程（建机/RDP/排查/指标）
└── evidence/
    ├── 00-summary.txt        实测资源清单与端到端结果摘要
    ├── 01-ec2-deploy-and-selftest.txt   EC2 部署 + 本机 self-test 完整日志
    └── 02-windows-plugin-e2e.txt        Windows 真机插件验证（含踩坑与指标解读）
```

## 三句话总结

1. **数据层**：`kiro-dashboard/src/store.js` 由同步 `better-sqlite3` 重写为异步 `pg` 连接池，
   对外 JSON 响应结构与 AI 比率公式保持不变；所有调用方改为 `await`。
2. **基础设施**：EC2(Dashboard) + RDS PostgreSQL 都在 VPC 私有子网；EC2 经 SSM 管理、RDS 非公网可达。
   **VPC 可新建、也可复用客户现有的**——两套 CloudFormation 模板各管一种。
3. **插件**：用 `build-plugin.sh http://<EC2私有IP>` 生成指向你 Dashboard 的 VSIX，Kiro IDE 安装后
   用 AI 写代码并 commit，统计即自动上传到私有子网内的 Ingest API → RDS。

## 正确顺序（关键）

```
① 网络(新建/复用 VPC) → ② 部署 Dashboard(EC2+RDS) → ③ 记录 EC2 私有 IP
                                                            ↓
⑥ 看板查看  ←  ⑤ 用 Kiro 写代码+commit  ←  ④ 用该 IP 生成插件并装进 Kiro IDE
```
**先有 Dashboard 才能生成插件**——插件里要写它的地址。完整步骤见手册 §0–§7。

## 快速开始

- **已有 VPC**：手册 §3B + §4 方式 A（`kiro-metrics-existing-vpc.yaml`）。
- **要新建 VPC**：手册 §3A + §4（CloudFormation 或 shell 脚本）。
- **先本地试代码**：`手册附录 F`（Docker Postgres，不依赖 AWS）。

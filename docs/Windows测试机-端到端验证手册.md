# Windows 测试机 — Kiro 插件端到端验证手册

> **用途**：在已部署好 Dashboard（EC2+RDS）之后，开一台 **Windows 测试机**真实验证整条链路：
> 安装 Kiro IDE + 插件 → 用 AI 写代码 → commit → 统计上传到 RDS → 看板展示。
>
> **本手册的每一步都已在 AWS 实测跑通**（账号 774868049561 / us-east-1），并记录了真实踩坑与解法。
> 适合「想完整演示插件效果」的场景；只想验证看板可达用 [主手册附录 E](../部署手册-Kiro-Metrics-RDS-VPC.md) 的 SSM 端口转发即可。

---

## 0. 为什么需要一台测试机

Kiro IDE 是图形应用，且插件靠**解析 Kiro 执行日志 + git post-commit 钩子**工作，所以"真跑插件"必须有一个能跑 Kiro 的桌面环境，并且这台机器要能访问私有子网里的 Dashboard。

**放哪个子网**：放 **公有子网**（如 `10.162.255.128/26`）最方便：
- Dashboard 的安全组 `kiro-app-sg` 放行了**整个 VPC 段** `10.162.255.0/24` 的 80/3500，公有子网在此段内 → **天然能连** Dashboard，无需改安全组。
- 公有子网经 IGW 直接出网，装 Kiro/浏览器更顺。
- 用 **SSM 端口转发 RDP** 连桌面，**不需要开任何公网入站端口**（SSM 是实例主动外连，安全）。

```
本地 Mac/Win ──SSM 端口转发(13389→3389)──▶ [Windows 测试机 公有子网]
                                                  │ 同 VPC，:80/:3500
                                                  ▼
                                          [Dashboard EC2 私有子网 10.162.255.8] ──▶ RDS
```

---

## 1. 创建 Windows 测试机（一条脚本）

脚本 `scripts/04-windows-test-ec2.sh`（依赖 `state/network.env`，即 §3 已建好的网络）：

```bash
cd scripts
bash 04-windows-test-ec2.sh
```

它做的事：
- 在公有子网启动 **Windows Server 2022 / t3.large / 50GB**，关联公网 IP（仅用于出网，不开入站）；
- 套用 **SSM 实例配置文件** `AmazonSSMRoleForInstancesQuickSetup`（含 `AmazonSSMManagedInstanceCore`）→ 可被 SSM 管理；
- 建独立安全组 `kiro-win-test-sg`：**无任何公网入站**（RDP 走 SSM 转发）；出站默认全开；
- user-data 里设置 `Administrator` 口令、开启 RDP 服务、确保 SSM Agent 运行；
- 等待 running + SSM Online，把 `WIN_EC2_ID / 私有IP / RDP 口令` 写入 `state/windows.env`。

> ⚠️ **RDP 口令保存在 `state/windows.env`**（演示用明文）。该文件**不会**进入交付 ZIP，请勿外传。

**取连接信息**：
```bash
cat ../state/windows.env     # WIN_EC2_ID / RDP_USER=Administrator / RDP_PASS=... / WIN_PRIVATE_IP
```

---

## 2. 用 SSM 端口转发 + RDP 连桌面

### 2.1 本机装 session-manager-plugin（一次性）
- **Windows**：装 https://s3.amazonaws.com/session-manager-downloads/plugin/latest/windows/SessionManagerPluginSetup.exe
- **macOS**：`brew install --cask session-manager-plugin`
- 前提：本机 `aws sts get-caller-identity` 能通，且是**同一个账号/区域**。

### 2.2 起转发隧道（开一个终端，保持不关）
```bash
aws ssm start-session --target <WIN_EC2_ID> --region us-east-1 \
    --document-name AWS-StartPortForwardingSession \
    --parameters "portNumber=3389,localPortNumber=13389"
```
看到 `Port 13389 opened ... Waiting for connections` 即成功。

### 2.3 用 RDP 客户端连本地端口
- **Windows**：`mstsc` → 计算机填 `localhost:13389`
- **macOS（Windows App / Microsoft Remote Desktop）**：Add PC → **PC name 必须填 `localhost:13389`（带端口！）** → 添加用户 `Administrator` / 口令（来自 `state/windows.env`）→ 双击连接 → 证书警告点"继续"。

> 第一次连黑屏转圈几十秒是正常的（Windows 在准备桌面）。

### ⚠️ 常见报错：`TargetNotConnected`
Windows 首次启动跑完 user-data 会**重启一次**，期间 SSM agent 短暂掉线。**等 1-2 分钟重试 `start-session` 即可**。
若仍不行，排查本机侧：`session-manager-plugin --version`（没装）、`aws sts get-caller-identity`（账号/区域不对）、`aws --version`（需 v2）。

---

## 3. 桌面准备（可由运维方经 SSM 远程完成，无需在桌面里手动翻设置）

Windows Server 默认有 **IE 增强安全(IE ESC)** 会拦浏览器下载；commit 需要 **git**。这两件可经 SSM 远程搞定，命令模板见 `scripts/`（或用下面方式）。

> **重要：经 SSM 下发"多行 PowerShell"必须用 `--cli-input-json`（配合 jq 构造请求体），不要用 shorthand `--parameters "commands=..."`**——否则换行会被损坏成字面量 `\n` 导致脚本解析失败（本次实测踩过此坑，已在 `ssm-run.sh` 里解决）。

远程准备（在运维机执行，`<WIN_EC2_ID>` 换成实际值）：把如下 PowerShell 存成 `prep.ps1` 用 `cli-input-json` 下发：
```powershell
# 关闭 IE ESC
$b='HKLM:\SOFTWARE\Microsoft\Active Setup\Installed Components'
Set-ItemProperty "$b\{A509B1A7-37EF-4b3f-8CFC-4F3A74704073}" IsInstalled 0
Set-ItemProperty "$b\{A509B1A8-37EF-4b3f-8CFC-4F3A74704073}" IsInstalled 0
# 装 git（winget 在 SSM 后台环境常不可用，直接下安装包最稳）
$u='https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe'
Invoke-WebRequest -UseBasicParsing $u -OutFile "$env:TEMP\git.exe" -TimeoutSec 180
Start-Process "$env:TEMP\git.exe" -ArgumentList '/VERYSILENT','/NORESTART','/NOCANCEL','/SP-' -Wait
# 配 git 提交身份（插件上报需要，不配会缺字段）
& "C:\Program Files\Git\cmd\git.exe" config --global user.name  "Kiro Tester"
& "C:\Program Files\Git\cmd\git.exe" config --global user.email "tester@corp.example"
```

下发方式（运维机）：
```bash
jq -n --rawfile s prep.ps1 --arg iid <WIN_EC2_ID> \
  '{InstanceIds:[$iid],DocumentName:"AWS-RunPowerShellScript",TimeoutSeconds:600,Parameters:{commands:[$s]}}' > req.json
aws ssm send-command --cli-input-json file://req.json --query Command.CommandId --output text
# 用返回的 CommandId 轮询 get-command-invocation 看结果
```

### 把插件 VSIX 推到桌面（免去 RDP 里传文件）
```bash
# 1) 把 VSIX 传到部署桶
aws s3 cp code/kiro-plugin/git-ai-kiro-0.2.3-rds.vsix s3://<DEPLOY_BUCKET>/git-ai-kiro-0.2.3-rds.vsix
# 2) 让 Windows 从 S3 下到桌面（实例角色已有桶读权限）；PowerShell：
#    Read-S3Object -BucketName <DEPLOY_BUCKET> -Key git-ai-kiro-0.2.3-rds.vsix \
#      -File C:\Users\Administrator\Desktop\git-ai-kiro-0.2.3-rds.vsix -Region us-east-1
```

---

## 4. 在桌面里：装 Kiro + 插件 + 产生数据

1. **装 Kiro IDE**：浏览器（用 Edge，别用 IE）访问 `https://kiro.dev` 或内部分发地址 → 下载 Windows 版 → 安装 → 登录（Builder ID / IdC）。
2. **装插件**：Kiro → 扩展 → `...` → **Install from VSIX** → 选桌面 `git-ai-kiro-0.2.3-rds.vsix` → **重启 Kiro**。
3. **先验看板**：浏览器开 `http://10.162.255.8:3500/`（换成你的 Dashboard EC2 私有 IP），确认能打开。
4. **产生数据**：
   - 打开/新建一个文件夹，**先确保它是 git 仓库**（终端 `git init`）；
   - **★关键顺序：先有 git 仓库、且插件已激活，钩子才会装上**（见 §5 第 1 条踩坑）；
   - **用 Kiro 的 AI 功能写代码**（vibe/spec 模式让 AI 生成/改代码）——必须真用 AI，否则 AI 行数为 0；
   - 终端 `git add -A && git commit -m "test ai"`。
5. **看结果**：刷新 `http://10.162.255.8:3500/`，应出现该仓库的 AI/人工行数、AI 占比、按用户/按模型明细。

**怎么确认上报成功**：Kiro `View → Output`，下拉选 `git-ai-kiro`，commit 后应见 `Commit stats uploaded`。

---

## 5. 实战踩坑与排查（本次真实发生）

### 坑 1（最常见）：commit 了但看板没数据 → post-commit 钩子未装
**现象**：插件装了、`userSync` 也上报了（看板用户在线），但 commit 后看板无新仓库。
**根因**：插件在**激活时**给"当时已打开的 git 仓库"装 post-commit 钩子。若**先启动 Kiro/插件、后 `git init` 或后打开项目**，钩子就没装上 → commit 不触发统计上报。
**判定**：检查仓库 `.git/hooks/post-commit` 是否存在。
**修复**：Kiro 里 `Ctrl+Shift+P` → **`Developer: Reload Window`**（或重启 Kiro），插件重新扫描补装钩子；**然后再 commit 一次**。

### 坑 2：第一次 commit 永久丢失，不会补报
钩子只对**安装之后的新 commit**生效。修好钩子前的那次 commit **不会自动补统计**，也不会和后续累加。
**所以修好后必须再 commit 一次**才有数据；想要真实 AI 行数，这次提交记得**再用 Kiro AI 改点代码**。

### 坑 3：用户显示 `Unknown`
若插件上报的 `user_id` 无法经 IAM Identity Center 解析（如实例角色无 `identitystore:ListUsers` 权限，或该用户不在 IdC），用户名会回退为 `Unknown`。不影响 commit 统计入库；要正确显示需给 Dashboard 实例角色加 `identitystore:ListUsers` 且用户在 IdC 内。

### 坑 4：SSM 下发多行脚本被损坏
症状：远程脚本报 `Unexpected token '\nWrite-Output'`。
原因：用了 shorthand `--parameters "commands=[...]"` 传多行。
解法：改用 `--cli-input-json` + `jq` 构造请求体（保留真实换行）。本包 `ssm-run.sh` 已采用该法，建议所有远程命令都经它下发。

### 坑 5：RDP `TargetNotConnected`
Windows 首启重启导致 SSM 短暂掉线，等 1-2 分钟重试 `start-session`；或本机没装 session-manager-plugin / 账号区域不对 / CLI 非 v2。

---

## 6. 指标怎么读（用本次 calculator 仓库实测值说明）

| 指标 | 本次值 | 含义 |
|---|---|---|
| `ai_additions` | 20 | 最终留在 commit、归因为 AI 的**净新增行** |
| `human_additions` | 0 | 人工手写新增行 |
| `mixed_additions` | 0 | AI 写后被人改过的行 |
| `ai_accepted` | 20 | AI 行被原样接受数 |
| `git_diff_added_lines` / `deleted` | 20 / 10 | git diff 实际增删 |
| `total_ai_additions` | 60 | AI **整个过程的累计写入动作**（含被改写/删除的过程量） |
| AI 占比 `ai_ratio` | 1.0 | `(ai − mixed*0.5)/(ai + human − mixed)` = 100% |

**关键理解**：`ai_additions`(最终归因) 与 `total_ai_additions`(过程努力) 不相等是**预期设计**——前者是最终落地行数，后者是 AI 编码过程的总动作量。数据库、聚合 API、tool_model 三处应完全一致。

---

## 7. 清理测试机

```bash
cd scripts
bash 99-teardown.sh           # 会一并清理 Windows 测试机 + 其安全组（若 state/windows.env 存在）
```
> 单独删 Windows 测试机（保留 Dashboard）：
> ```bash
> source ../state/windows.env
> aws ec2 terminate-instances --instance-ids $WIN_EC2_ID
> aws ec2 wait instance-terminated --instance-ids $WIN_EC2_ID
> aws ec2 delete-security-group --group-id $SG_WIN
> ```
> Windows t3.large 约 $2–2.5/天，测完尽快清理。

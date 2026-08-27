# TODO / 注意点与已知问题

> 测试与加固过程中确认的问题清单,按归属分类。**每一条都有实测或代码行号支撑**,不是猜测。
> 后续发现新问题请直接往对应分类里追加。
> 最近更新:2026-08-27(display_name 功能测试期间,AWS 真机环境)

| # | 归属 | 一句话 | 严重度 |
|---|---|---|---|
| P1 | 插件 | 新仓库头几条 commit 丢 user_id(工号关联失效) | 中,详见下文 |
| P2 | 插件 | 先开 Kiro 后建的仓库,钩子装不上 → commit **无声丢失且不补报** | 高 |
| P3 | 插件 | 钩子失效时的兜底上报,payload 结构里没有 user_id 字段 | 低 |
| P4 | 插件 | Windows 版 Kiro 不带 kiro-cli → whoami 永远失败,身份全靠服务端解析 | 中 |
| S1 | 服务端 | 所有解析失败的用户共享一行 "Unknown"(多机互相覆盖) | 低 |
| S2 | 服务端 | 升级跨越"改写 user_email"版本时,同一人在 by_user 里裂成两行 | 中,详见下文 |
| S3 | 服务端 | `GET /api/users` 每次全量同步 IdC,大目录下拖慢页面 | 低(性能) |
| O1 | 运维 | `scripts/remote-deploy.sh` 不能当升级工具用 | 已写进部署手册 §12.6 |
| Q1 | 待业务确认 | 显示优先级:方案文档的文字与它自己的示例代码矛盾 | 需拍板 |
| Q2 | 待业务确认 | 客户现网 IdC 目录与员工登录 Kiro 的目录是否同一个 | **决定功能实效** |

---

## P1(详)插件 user_id 上报时序:新仓库的头几条 commit 会丢工号关联

**一句话**:commit 上报里的 `user_id` 不是钩子自己知道的,是从「本仓库」里上次心跳留下的
记录里抄的。新仓库还没收到过心跳,头几条 commit 抄不到,`user_id` 为空。

**真机复现**(2026-08-27,同一台机、同一人、同样"先用 AI 后 commit"):

| 仓库 | 心跳落进本仓库 | commit 时间 | 带没带 user_id |
|---|---|---|---|
| 仓库 A | 06:03 | 06:08 | ✅ |
| 仓库 B | 07:22 | 07:26 | ✅(差 4 分钟,刚好赶上) |
| **仓库 C 首条** | **08:01 才到** | **07:38** | ❌ **没赶上** |
| 仓库 C 次条 | (记录已在) | 08:11 | ✅ 恢复 |

**机制**:

```
用 AI 写代码
  ↓ ← 耗时不可控(实测 2~25 分钟):等 Kiro 自己调 GetUsageLimitsCommand 写日志
插件发心跳,往【当前打开的仓库】.git/ai/ 留一条含 user_id 的记录
  ↓
该仓库之后每次 commit,钩子从记录里抄 user_id 随统计上报
```

- 心跳非定时:事件触发 + 闸门(「本次启动后第一次」或「距上次 >4 小时」),`kiro-plugin/src/userSync.ts:34-39`。**不用 AI 就没有心跳**;
- 钩子是 Kiro 进程外的 shell 脚本,只能翻本仓库 `.git/ai/last_upload_payload.json`
  (Bash `gitUtils.ts:729-739`,PowerShell `gitUtils.ts:1150-1173`);
- 记录按仓库隔离,落一次终身有效 → **暴露面只有每个仓库「首次打开 → 首条心跳」之间的 commit**。

**影响**:这些 commit 的中文名回落到邮箱匹配;真正受伤的交集是
「新仓库头几条 × git 配个人邮箱 × 本人在 IdC」——恰好是功能最想覆盖的工号型员工。

**修法(首选)**:装钩子时(`gitUtils.ts:805` `installHooksForWorkspace`)若内存里已有 user_id,
**主动**写好记录,不等心跳。几行改动,赛跑消失。

---

## P2 插件激活后不扫新仓库 → 钩子装不上,commit 无声丢失

- 现象:Kiro 开着的状态下新建/`git init` 的仓库,或从未在 Kiro 里打开过的仓库,
  插件完全不知道 → 不装钩子 → commit 不上报,**且事后不补**(真机两次踩中,首条 commit 永久丢失)。
- 原因:`installHooksForWorkspace` 只在扩展激活时跑一次(`extension.ts:66`),
  没有监听工作区/git 仓库的新增事件。
- 修法:在 `onDidChangeWorkspaceFolders` 或 git 扩展 `onDidOpenRepository` 回调里补装钩子。
- 用户侧口诀(修复前的缓解):**commit 之前,确保项目文件夹在 Kiro 里被打开过**;
  自查:仓库里存在 `.git/hooks/post-commit` 即已生效。

## P3 兜底上报路径没有 user_id 字段

`kiro-plugin/src/statsUploader.ts:39-50` 的 `UploadPayload` 接口(钩子失效时
`uploadCommitStats` 走的路)没有 `user_id` 字段——这条路的 commit 永远无工号关联。修法:补字段。

## P4 Windows 版 Kiro 不带 kiro-cli

`userSync.ts:154` 靠 `kiro-cli whoami` 拿邮箱;实测 Windows 安装不含该命令 → 永远失败 →
心跳只能上报 `user_name="Unknown" + user_id`,身份全押在服务端 IdC 解析上。
若客户现网目录不一致(见 Q2),用户管理页将出现大量 Unknown。

## S1 "Unknown" 是全局共享的一行

`kiro_user` 主键是 user_name,所有解析失败的机器挤在同一行 "Unknown" 里,
`user_ip`/`updated_at` 互相覆盖,无法统计"有几个未识别用户"(只能去 `plugins` 表按 hostname 数)。
已缓解:该行现在保存首个上报的 user_id(只补空不覆盖)。彻底修需要一人一行
(如 `Unknown-<uuid前8位>`),涉及展示语义,建议业务表态后再动。

## S2 升级后同一人在 by_user 里裂成两行(仅影响升级前已有数据的库)

- 机制:旧版(345790d)入库时把 `user_email` 改写成 IdC 工号;新版不再改写(原值保留,
  工号进 `idc_user_name` 列)。同一人升级前的行以工号为聚合键、升级后的以 git 邮箱为键 → 两行。
  两行中文名相同、数值各自正确,只是不合并;新数据积累后旧行影响自然稀释。
- 已在部署手册 §12.6 第 4 条向升级操作者说明。
- 若客户要求合并,两个方案(**都需业务拍板,勿默默执行**):
  ① 一次性数据订正:把升级前被改写过的行的聚合键统一(如
  `UPDATE commits SET idc_user_name = user_email WHERE idc_user_name='' AND LOWER(user_email) IN (SELECT LOWER(user_name) FROM kiro_user)`
  ,再把 by_user 聚合键改为 `COALESCE(NULLIF(idc_user_name,''), user_email, …)`);
  ② 只改聚合键不动数据(同上第二半),旧行经 idc_user_name、新行经邮箱可归到同键。
  方案②改动小但会改变历史报表口径,需要向客户说明。

## S3 `GET /api/users` 每次触发 IdC 全量同步,大目录下拖慢页面

- 现状:每次打开用户管理页都跑一遍 `syncIdCUsersToLocal`,每个用户约 4 次串行 RDS 往返
  (SAVEPOINT + 守卫 UPDATE + 存在性 SELECT + RELEASE),外加该路由原有的每用户 2 次统计查询。
  500 人目录 ≈ 每次刷新数千条串行查询、2-4 秒额外延迟,而稳态下写入量为 0(守卫本来就挡住了)。
- 改法候选:改成基于 `uq_kiro_user_lower_name` 的单条
  `INSERT ... ON CONFLICT ((LOWER(user_name))) DO UPDATE`(那支"SELECT 存在性"舞步本来就是为了绕它);
  或 `unnest()` 批量;或把同步挪出请求路径(定时任务已每小时跑一次 credit 同步,可搭车)。
- 测试环境只有 3 个用户,无感;客户目录大才会显现。

## O1 `remote-deploy.sh` 不能当升级工具

它会整体重写 `.env`,丢掉 `KIRO_S3_BUCKET`/`KIRO_ACCOUNT_ID` 等配置 → credit 同步被静默关闭。
只适合首次部署。**升级请走《部署手册》§12**(该章节已含完整升级/回滚流程与此坑的说明)。

## Q1 显示优先级:方案文档自相矛盾,需业务拍板

需求方案的文字写「IdC DisplayName > user_email > git user.name」,但同一文档的示例代码是
`display_name || user_name || user_email`(git 名在邮箱**前**)。现实现按代码版。
两者只在「display_name 为空且 user_name/user_email 都有值」时有差异(显示 git 名 vs 邮箱)。
**请业务确认要哪个**,一行改动的事,但别默默改。

## Q2 客户现网:登录 Kiro 的 IdC 目录 == dashboard 配置的目录?

服务端拿上报的 user_id 到 `.env` 里 `IDENTITY_STORE_ID` 配的目录里查(`ingest.js`),
**从不校验两边目录是否一致,不一致时静默查不到**(只有一条 warn 日志)。
若客户员工登录 Kiro 走的不是同一个目录,工号关联整条失效、用户管理页堆满 Unknown。
需要客户确认:① 现网 `.env` 的 `IDENTITY_STORE_ID`;② 员工登录 Kiro 用的哪个目录;
③ 最好取一段现网 `q-client.log` 里 `userInfo.userId` 的原文核对前缀。

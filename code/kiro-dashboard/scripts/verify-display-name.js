/**
 * display_name 关联链路的集成验证（需要一个真实的 PostgreSQL）。
 *
 * 为什么单独一个脚本、不放进 `npm test`：
 * src/__tests__ 走的是 better-sqlite3 + 手写的一份等价 SQL，既不 import store.js
 * 也不建 kiro_user 表，因此对这里的四处 SQL 改动零覆盖 —— `npm test` 全绿是假信号。
 * 而 LOWER()/collation/`ON CONFLICT DO UPDATE ... WHERE` 在 SQLite 与 PostgreSQL 下
 * 语义不等价，只能对着真库跑。
 *
 * 用法（会 DROP 并重建目标库里的业务表，只指向一次性测试库）：
 *   DB_HOST=127.0.0.1 DB_USER=kiro DB_PASSWORD=kiro DB_NAME=kiro \
 *     npm run test:display-name
 *
 * 在已部署的机器上（/opt/kiro/kiro-dashboard 有 .env 的场景）：
 *   DB_NAME=kiro_verify node scripts/verify-display-name.js
 * 连接参数从 .env 读，只用 DB_NAME 覆盖到一次性库 —— loadEnv() 里已存在的
 * 环境变量优先，所以不会被 .env 的 DB_NAME=kiro 覆盖回生产库。
 *
 * 每个用例都先构造"旧写法会出错"的脏数据，T0 会先证明旧写法确实错，
 * 避免在干净空库上得到一片假绿。
 */
const path = require("path");
// 必须在 require store.js 之前加载 .env：store.js 在模块顶层就用 process.env
// 建好了 Pool，晚一步加载等于拿默认值连 127.0.0.1:5432（ECONNREFUSED）。
require(path.resolve(__dirname, "../src/loadEnv.js")).loadEnv(
  path.resolve(__dirname, "../.env")
);
const store = require(path.resolve(__dirname, "../src/store.js"));
const { pool } = store;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

/** 建"升级前"的旧库：kiro_user 无 display_name、commits 无 idc_user_name、无唯一索引。 */
async function seedLegacySchema() {
  await pool.query(`DROP TABLE IF EXISTS ai_ratio_history, tool_model_stats, idempotency_keys,
                    commits, kiro_user, sessions, plugins CASCADE`);
  await pool.query(`
    CREATE TABLE commits (
      id BIGSERIAL PRIMARY KEY, repo_name TEXT NOT NULL, repo_remote_url TEXT, branch TEXT,
      commit_sha TEXT NOT NULL, machine_id TEXT, user_name TEXT, user_email TEXT,
      reported_at TEXT, commit_msg TEXT DEFAULT '',
      human_additions INTEGER DEFAULT 0, ai_additions INTEGER DEFAULT 0, mixed_additions INTEGER DEFAULT 0,
      ai_accepted INTEGER DEFAULT 0, total_ai_additions INTEGER DEFAULT 0, total_ai_deletions INTEGER DEFAULT 0,
      time_waiting_for_ai BIGINT DEFAULT 0, git_diff_added_lines INTEGER DEFAULT 0,
      git_diff_deleted_lines INTEGER DEFAULT 0, ai_deletions INTEGER DEFAULT 0,
      human_deletions INTEGER DEFAULT 0, created_at TEXT DEFAULT (now()::text));
    CREATE TABLE kiro_user (
      user_name TEXT PRIMARY KEY, user_id TEXT DEFAULT '', created_at TEXT NOT NULL,
      user_ip TEXT DEFAULT '', credit_used TEXT DEFAULT '{}', updated_at TEXT NOT NULL,
      plugin_added INTEGER DEFAULT 0);
  `);
  // 大小写重复行：IdC 同步写 UserName 原样大小写、插件 userSync 写 whoami 邮箱，
  // 两个源互不协调，在大小写敏感的 TEXT 主键上可以合法共存。
  await pool.query(`INSERT INTO kiro_user (user_name, user_id, created_at, updated_at) VALUES
      ('Zhang.San@haier.com', 'uuid-zs', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'),
      ('zhang.san@haier.com', 'uuid-zs', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'),
      ('q-developer',         'uuid-qd', '2020-01-01T00:00:00.000Z', '2020-03-03T03:03:03.000Z'),
      ('wang.qiang@haier.com','uuid-wq', '2020-01-01T00:00:00.000Z', '2020-02-02T02:02:02.000Z')`);
  // 3 条提交，同一个人，git config user.name 是工号
  await pool.query(`INSERT INTO commits (repo_name, commit_sha, user_name, user_email, reported_at,
      human_additions, ai_additions, git_diff_added_lines) VALUES
      ('demo','sha1','A1008803','zhang.san@haier.com','2026-08-01T01:00:00Z',10,20,30),
      ('demo','sha2','A1008803','zhang.san@haier.com','2026-08-02T01:00:00Z',10,20,30),
      ('demo','sha3','A1008803','zhang.san@haier.com','2026-08-03T01:00:00Z',10,20,30)`);
}

/** 未收敛的 JOIN 写法。用来证明脏数据确实会触发放大，否则后面的 PASS 没有意义。 */
async function legacyJoinCounts() {
  const r = await pool.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(c.human_additions),0) AS ha
     FROM commits c
     LEFT JOIN kiro_user k ON LOWER(c.user_email) = LOWER(k.user_name)
     WHERE c.repo_name = 'demo'`);
  return { cnt: Number(r.rows[0].cnt), ha: Number(r.rows[0].ha) };
}

async function main() {
  console.log(`\n=== 环境 ===`);
  console.log(`  PG: ${(await pool.query("select version()")).rows[0].version.split(",")[0]}`);

  console.log(`\n=== 准备：模拟带脏数据的旧库（无 display_name 列 / 无唯一索引 / 有大小写重复行）===`);
  await seedLegacySchema();
  const legacy = await legacyJoinCounts();
  console.log(`  未收敛的 JOIN 在此数据上：commit_count=${legacy.cnt}, human_additions=${legacy.ha}（真实值 3 / 30）`);
  check("T0 用例有效性：未收敛写法确实放大（否则后面全是假绿）",
    legacy.cnt === 6 && legacy.ha === 60, `实际 cnt=${legacy.cnt} ha=${legacy.ha}，期望 6/60`);

  console.log(`\n=== T1 ensureReady() 在脏库上不得阻断启动（唯一索引建失败只能告警）===`);
  let initErr = null;
  try { await store.ensureReady(); } catch (e) { initErr = e; }
  check("T1a ensureReady 不抛异常", initErr === null, initErr && initErr.message);
  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename='kiro_user' AND indexname='uq_kiro_user_lower_name'`);
  check("T1b 唯一索引在脏数据下没建上（预期行为，靠查询侧收敛兜底）", idx.rows.length === 0,
    "意外建成了索引");
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name IN ('commits','kiro_user') AND column_name IN ('display_name','idc_user_name')`);
  const colSet = cols.rows.map((r) => r.column_name).sort();
  check("T1c 迁移补齐了 kiro_user.display_name 与 commits.idc_user_name",
    colSet.join(",") === "display_name,idc_user_name", `实际: ${colSet.join(",")}`);

  console.log(`\n=== T2 syncIdCUsersToLocal 不得刷掉 updated_at（最后活跃时间）===`);
  await pool.query(`UPDATE kiro_user SET display_name='' WHERE user_name='wang.qiang@haier.com'`);
  const before = await pool.query(`SELECT user_name, updated_at FROM kiro_user ORDER BY user_name`);
  await store.syncIdCUsersToLocal([
    { userName: "Zhang.San@haier.com", userId: "uuid-zs", displayName: "张三" },
    { userName: "zhang.san@haier.com", userId: "uuid-zs", displayName: "张三" },
    { userName: "q-developer",          userId: "uuid-qd", displayName: "王泽鹏" },
    { userName: "wang.qiang@haier.com", userId: "uuid-wq", displayName: "王强" },
  ]);
  const after = await pool.query(`SELECT user_name, updated_at, display_name FROM kiro_user ORDER BY user_name`);
  const changed = after.rows.filter((r, i) => r.updated_at !== before.rows[i].updated_at);
  check("T2a 所有已存在用户的 updated_at 保持原值", changed.length === 0,
    `被改动: ${JSON.stringify(changed)}`);
  check("T2b display_name 被正确写入", after.rows.every((r) => r.display_name !== ""),
    JSON.stringify(after.rows));

  console.log(`\n=== T3 IdC 返回空 DisplayName 不得擦除已有值（含人工回填）===`);
  await pool.query(`UPDATE kiro_user SET display_name='王强-人工回填' WHERE user_name='wang.qiang@haier.com'`);
  const upd0 = (await pool.query(
    `SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname='kiro_user'`)).rows[0].n_tup_upd;
  await store.syncIdCUsersToLocal([
    { userName: "wang.qiang@haier.com", userId: "uuid-wq", displayName: "" },
  ]);
  const kept = (await pool.query(
    `SELECT display_name FROM kiro_user WHERE user_name='wang.qiang@haier.com'`)).rows[0].display_name;
  check("T3a 空串没有覆盖已有 display_name", kept === "王强-人工回填", `实际: "${kept}"`);

  console.log(`\n=== T4 无变化时 WHERE 守卫应让写入量为 0（稳态不产生死元组/行锁）===`);
  await store.syncIdCUsersToLocal([
    { userName: "wang.qiang@haier.com", userId: "uuid-wq", displayName: "王强-人工回填" },
  ]);
  await new Promise((r) => setTimeout(r, 600));  // pg_stat 异步刷新
  const upd1 = (await pool.query(
    `SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname='kiro_user'`)).rows[0].n_tup_upd;
  check("T4a 值完全相同时 UPDATE 行数为 0", Number(upd1) === Number(upd0),
    `n_tup_upd ${upd0} → ${upd1}（差 ${Number(upd1) - Number(upd0)}）`);

  console.log(`\n=== T5 一对多收敛：by_user 的提交数必须与 totals 一致 ===`);
  const agg = await store.aggregateRepoStats("demo");
  const users = Object.entries(agg.by_user);
  const byUserSum = users.reduce((s, [, v]) => s + Number(v.commit_count), 0);
  console.log(`  totals.commit_count=${agg.totals.commit_count}, by_user=${JSON.stringify(
    users.map(([k, v]) => [k, Number(v.commit_count), v.display_name]))}`);
  check("T5a totals 与 by_user 提交数一致（未收敛时是 3 vs 6，同弹窗两个数字对不上）",
    Number(agg.totals.commit_count) === byUserSum,
    `totals=${agg.totals.commit_count} by_user 合计=${byUserSum}`);
  check("T5b 大小写重复行下 human_additions 不放大",
    Number(users[0][1].human_additions) === 30, `实际 ${users[0][1].human_additions}，期望 30`);
  check("T5c display_name 正确关联到中文名", users[0][1].display_name === "张三",
    `实际 "${users[0][1].display_name}"`);
  check("T5d user_key 仍是邮箱（没有因规范化而裂行）", users[0][0] === "zhang.san@haier.com",
    `实际 "${users[0][0]}"`);

  console.log(`\n=== T6 明细列表不得出现重复行 ===`);
  const rs = await store.getRepoStats("demo");
  check("T6a 3 条提交仍是 3 行（未收敛时为 6 行、同一 sha 重复）", rs.length === 3,
    `实际 ${rs.length} 行: ${rs.map((c) => c.commit_sha)}`);
  check("T6b 每行都带上了 display_name", rs.every((c) => c.display_name === "张三"),
    JSON.stringify(rs.map((c) => [c.commit_sha, c.display_name])));

  console.log(`\n=== T7 IdC UserName 不是邮箱时（q-developer），旁路列 idc_user_name 必须能命中 ===`);
  await store.saveStats({
    repo_name: "demo2", repo_remote_url: "", branch: "main", commit_sha: "sha-qd",
    machine_id: "m1", user_name: "22072312", user_email: "someone@foxmail.com",
    idc_user_name: "q-developer",              // ingest.js normalizeUserIdentity 写入的值
    reported_at: "2026-08-20T10:00:00Z", commit_msg: "t",
    commit_stats: { human_additions: 5, ai_additions: 5, mixed_additions: 0, ai_accepted: 0,
      total_ai_additions: 0, total_ai_deletions: 0, time_waiting_for_ai: 0,
      git_diff_added_lines: 10, git_diff_deleted_lines: 0, ai_deletions: 0, human_deletions: 0 },
  });
  const agg2 = await store.aggregateRepoStats("demo2");
  const [key2, val2] = Object.entries(agg2.by_user)[0];
  check("T7a 个人邮箱 + 非邮箱 IdC UserName 也能拿到中文名", val2.display_name === "王泽鹏",
    `实际 "${val2.display_name}"`);
  check("T7b user_email 未被改写，分组键仍是原始邮箱", key2 === "someone@foxmail.com",
    `实际 "${key2}"`);
  const raw = (await pool.query(
    `SELECT user_email, idc_user_name FROM commits WHERE commit_sha='sha-qd'`)).rows[0];
  check("T7c 落库后 user_email 原值保留、IdC 标识存在旁路列",
    raw.user_email === "someone@foxmail.com" && raw.idc_user_name === "q-developer",
    JSON.stringify(raw));

  console.log(`\n=== T8 去重后唯一索引应能建上（模拟运维合并重复行 + 重启）===`);
  await pool.query(`DELETE FROM kiro_user WHERE user_name='Zhang.San@haier.com'`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_kiro_user_lower_name ON kiro_user (LOWER(user_name))`);
  const idx2 = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename='kiro_user' AND indexname='uq_kiro_user_lower_name'`);
  check("T8a 去重后唯一索引建成", idx2.rows.length === 1, "索引仍未建成");
  let dupErr = null;
  try {
    await pool.query(`INSERT INTO kiro_user (user_name, created_at, updated_at)
                      VALUES ('ZHANG.SAN@haier.com','x','x')`);
  } catch (e) { dupErr = e; }
  check("T8b 索引生效：再插入大小写变体被拒绝", dupErr !== null && dupErr.code === "23505",
    dupErr ? `code=${dupErr.code}` : "居然插入成功了");

  // ---------------------------------------------------------------------------
  // T9：唯一索引建成之后，两条写入路径都不能再被大小写变体打挂。
  // 这是 T8 的必然后果、也是最容易漏的回归：ON CONFLICT (user_name) 是精确大小写，
  // 匹配不上 LOWER 唯一索引 → 23505。IdC 侧一行失败会回滚整批（全表 display_name 同步不进来），
  // 插件侧一次失败会让 ingest 回 HTTP 500（user_id 落不了库）。
  // 注意 T9 必须跑在 T8 之后：此时 uq_kiro_user_lower_name 已经建成，才有意义。
  // ---------------------------------------------------------------------------
  console.log(`\n=== T9 唯一索引存在时，大小写变体不得打挂写入路径（回归）===`);
  await pool.query(`DELETE FROM kiro_user`);
  await pool.query(
    `INSERT INTO kiro_user (user_name, user_id, display_name, created_at, user_ip, credit_used, updated_at, plugin_added)
     VALUES ('zhang.san@haier.com', '', '', 'T0', '', '{}', 'T0', 1)`);

  // ① IdC 侧：IdC 的规范大小写与库里插件建的行不一致
  let idcErr = null;
  try {
    await store.syncIdCUsersToLocal([
      { userName: "ZHANG.SAN@haier.com", userId: "uid-zs", displayName: "张三" },
      { userName: "brand.new@haier.com", userId: "uid-bn", displayName: "新人" },
    ]);
  } catch (e) { idcErr = e; }
  check("T9a syncIdCUsersToLocal 遇大小写变体不抛异常",
    idcErr === null, idcErr ? `抛了 code=${idcErr.code} ${idcErr.message}` : "");

  const zs = await pool.query(`SELECT user_name, display_name, user_id, updated_at FROM kiro_user
                               WHERE LOWER(user_name)='zhang.san@haier.com'`);
  check("T9b 变体命中的是已有行（没新建行）、display_name 已写入",
    zs.rows.length === 1 && zs.rows[0].user_name === "zhang.san@haier.com" &&
    zs.rows[0].display_name === "张三" && zs.rows[0].user_id === "uid-zs",
    JSON.stringify(zs.rows));
  check("T9c 该行的 updated_at 仍未被同步刷掉",
    zs.rows[0] && zs.rows[0].updated_at === "T0", JSON.stringify(zs.rows[0]));

  const bn = await pool.query(`SELECT user_name, display_name FROM kiro_user
                               WHERE user_name='brand.new@haier.com'`);
  check("T9d 同批次里的新用户没被前一个用户的冲突牵连（SAVEPOINT 生效）",
    bn.rows.length === 1 && bn.rows[0].display_name === "新人", JSON.stringify(bn.rows));

  // ② 插件侧：插件送来的大小写与库里不一致
  let pluginErr = null;
  try {
    await store.userSync({ user_name: "ZHANG.SAN@haier.com", user_ip: "10.0.0.9", credit_used: {} });
  } catch (e) { pluginErr = e; }
  check("T9e userSync 遇大小写变体不抛异常（否则 ingest 回 500）",
    pluginErr === null, pluginErr ? `抛了 code=${pluginErr.code} ${pluginErr.message}` : "");

  const t9After = await pool.query(`SELECT user_name, user_ip, display_name FROM kiro_user
                                  WHERE LOWER(user_name)='zhang.san@haier.com'`);
  check("T9f userSync 更新到了已有行、且没擦掉 display_name",
    t9After.rows.length === 1 && t9After.rows[0].user_ip === "10.0.0.9" &&
    t9After.rows[0].display_name === "张三", JSON.stringify(t9After.rows));

  // ③ 稳态：值没变时仍然 0 写入（T4a 的守卫不能被上面的改写弄丢）
  const t9StatBefore = await pool.query(
    `SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname='kiro_user'`);
  await store.syncIdCUsersToLocal([{ userName: "zhang.san@haier.com", userId: "uid-zs", displayName: "张三" }]);
  await new Promise((r) => setTimeout(r, 600));
  const t9StatAfter = await pool.query(
    `SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname='kiro_user'`);
  check("T9g 无变化时写入量仍为 0（WHERE 守卫没被改坏）",
    Number(t9StatAfter.rows[0].n_tup_upd) === Number(t9StatBefore.rows[0].n_tup_upd),
    `n_tup_upd ${t9StatBefore.rows[0].n_tup_upd} -> ${t9StatAfter.rows[0].n_tup_upd}`);

  // ---------------------------------------------------------------------------
  // T10：关联键必须是**两级回退**，不是"优先"。
  // idc_user_name 非空但在 kiro_user 里查不到（IdC 用户被删/改名、或运维合并重复行时
  // 删掉了那一行）时，必须回落到 user_email。写成单个
  // `ON k.lname = LOWER(COALESCE(NULLIF(idc_user_name,''), user_email))` 会让这种行
  // 拿到空名字 —— 比升级前更差（升级前靠邮箱是能显示的）。
  // ---------------------------------------------------------------------------
  console.log(`\n=== T10 idc_user_name 命不中时必须回落到 user_email（不能比升级前更差）===`);
  await pool.query(`DELETE FROM kiro_user`);
  await pool.query(
    `INSERT INTO kiro_user (user_name, user_id, display_name, created_at, user_ip, credit_used, updated_at, plugin_added)
     VALUES ('zhang.san@haier.com', 'uuid-zs', '张三', 'T0', '', '{}', 'T0', 1)`);
  const mkCommit = (sha, idcName) => store.saveStats({
    repo_name: "demo3", repo_remote_url: "", branch: "main", commit_sha: sha,
    machine_id: "m1", user_name: "A1008803", user_email: "zhang.san@haier.com",
    idc_user_name: idcName,
    reported_at: "2026-08-21T10:00:00Z", commit_msg: "t",
    commit_stats: { human_additions: 10, ai_additions: 0, mixed_additions: 0, ai_accepted: 0,
      total_ai_additions: 0, total_ai_deletions: 0, time_waiting_for_ai: 0,
      git_diff_added_lines: 10, git_diff_deleted_lines: 0, ai_deletions: 0, human_deletions: 0 },
  });
  await mkCommit("t10-no-idc", "");                    // 升级前落的老行
  await mkCommit("t10-stale-idc", "A9999999");         // 升级后落的新行，工号已不在 IdC
  const rs10 = await store.getRepoStats("demo3");
  const byShaName = Object.fromEntries(rs10.map((c) => [c.commit_sha, c.display_name]));
  console.log(`  明细行取到的名字: ${JSON.stringify(byShaName)}`);
  check("T10a 老行（idc_user_name 为空）走邮箱命中",
    byShaName["t10-no-idc"] === "张三", `实际 "${byShaName["t10-no-idc"]}"`);
  check("T10b 新行（idc_user_name 非空但查不到）回落邮箱命中，不是空名",
    byShaName["t10-stale-idc"] === "张三", `实际 "${byShaName["t10-stale-idc"]}"`);
  check("T10c 两级回退没有让明细行重复（仍是 2 行）", rs10.length === 2,
    `实际 ${rs10.length} 行: ${rs10.map((c) => c.commit_sha)}`);
  const agg10 = await store.aggregateRepoStats("demo3");
  const u10 = Object.entries(agg10.by_user);
  const sum10 = u10.reduce((s, [, v]) => s + Number(v.commit_count), 0);
  check("T10d 聚合侧同样取到中文名，且 totals 与 by_user 一致（未放大）",
    Number(agg10.totals.commit_count) === sum10 && u10.length === 1 &&
    u10[0][1].display_name === "张三" && Number(u10[0][1].human_additions) === 20,
    `totals=${agg10.totals.commit_count} by_user=${JSON.stringify(u10)}`);

  // ---------------------------------------------------------------------------
  // T11：重复行的 display_name 不同时，MAX() 的取值规则必须与手册写的一致
  // （LOWER 分组内按 collation 取字典序最大的那个）。这条是把"非确定性语义"钉死，
  // 免得以后有人把 MAX 换成别的聚合却没人发现报表上的名字变了。
  // 需要先摘掉 T8 建的唯一索引才能造出重复行。
  // ---------------------------------------------------------------------------
  console.log(`\n=== T11 重复行 display_name 不同时的取值规则（文档写明：字典序最大）===`);
  await pool.query(`DROP INDEX IF EXISTS uq_kiro_user_lower_name`);
  await pool.query(
    `INSERT INTO kiro_user (user_name, user_id, display_name, created_at, user_ip, credit_used, updated_at, plugin_added)
     VALUES ('Zhang.San@haier.com', 'uuid-zs', '张三-已离职', 'T0', '', '{}', 'T0', 0)`);
  const rs11 = await store.getRepoStats("demo3");
  const picked = rs11[0] && rs11[0].display_name;
  const expected = ["张三", "张三-已离职"].sort().pop();
  check("T11a 取到的是分组内字典序最大的那个（与 §12.5 写明的规则一致）",
    picked === expected, `实际 "${picked}"，按规则应为 "${expected}"`);
  check("T11b 有重复行时明细仍不放大（仍是 2 行）", rs11.length === 2,
    `实际 ${rs11.length} 行`);

  // T12：身份线索不许丢 —— 上报里带的 user_id 必须落库（M12/M13）
  // 背景：IdC 解析失败的那一刻若不存原始 user_id，这条数据就永久失去关联线索，
  // 事后 IdC 恢复也无法补救。真机实测中 Unknown 行 user_id="" 即此缺陷。
  console.log(`\n=== T12 上报的 user_id 必须原样落库（解析成败都存）===`);
  await store.saveStats({
    repo_name: "demo12", repo_remote_url: "", branch: "main", commit_sha: "t12-commit",
    machine_id: "m1", user_name: "someone", user_email: "someone@nowhere.test",
    idc_user_name: "",                                  // 模拟解析失败：旁路列为空
    user_id: "5418e428-d061-7038-dfc4-73f97e5523c7",    // 但原始 UUID 依然要存
    reported_at: "2026-08-22T10:00:00Z", commit_msg: "t",
    commit_stats: { human_additions: 1, ai_additions: 0, mixed_additions: 0, ai_accepted: 0,
      total_ai_additions: 0, total_ai_deletions: 0, time_waiting_for_ai: 0,
      git_diff_added_lines: 1, git_diff_deleted_lines: 0, ai_deletions: 0, human_deletions: 0 },
  });
  const r12a = await pool.query(
    "SELECT idc_user_id, idc_user_name FROM commits WHERE commit_sha = 't12-commit'");
  check("T12a commits.idc_user_id 存下了原始 UUID（idc_user_name 为空也要存）",
    r12a.rows[0].idc_user_id === "5418e428-d061-7038-dfc4-73f97e5523c7" && r12a.rows[0].idc_user_name === "",
    JSON.stringify(r12a.rows[0]));

  await store.userSync({ user_name: "Unknown", user_ip: "10.0.0.12",
    user_id: "5418e428-d061-7038-dfc4-73f97e5523c7", credit_used: {}, hostname: "T12HOST" });
  const r12b = await pool.query("SELECT user_id FROM kiro_user WHERE user_name = 'Unknown'");
  check("T12b userSync 新建的 Unknown 行保存了上报的 user_id",
    r12b.rows[0].user_id === "5418e428-d061-7038-dfc4-73f97e5523c7",
    JSON.stringify(r12b.rows));

  // 已有行 user_id 非空时不许被顶掉（IdC 同步写入的权威 UUID 优先）
  await store.userSync({ user_name: "zhang.san@haier.com", user_ip: "10.0.0.13",
    user_id: "ffffffff-0000-0000-0000-000000000000", credit_used: {}, hostname: "T12HOST2" });
  const r12c = await pool.query(
    "SELECT user_id FROM kiro_user WHERE LOWER(user_name) = 'zhang.san@haier.com'");
  check("T12c 已有权威 user_id 的行不被插件上报覆盖（只补空不覆盖）",
    r12c.rows[0].user_id !== "ffffffff-0000-0000-0000-000000000000" && r12c.rows[0].user_id !== "",
    JSON.stringify(r12c.rows));

  console.log(`\n=== 结果：${pass} passed, ${fail} failed ===\n`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("\n验证脚本自身异常：", e);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(2);
});

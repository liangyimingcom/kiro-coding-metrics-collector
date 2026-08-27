/**
 * Data layer — RDS PostgreSQL backend (migrated from SQLite/better-sqlite3).
 *
 * 设计说明（迁移要点）：
 *  - 使用 node-postgres (pg) 连接池，所有导出函数改为 async（返回 Promise）。
 *  - 占位符由 SQLite 的 `?` 改为 PostgreSQL 的 `$1,$2,...`。
 *  - 自增主键 lastInsertRowid 改为 `INSERT ... RETURNING id`。
 *  - `INSERT OR IGNORE` 改为 `INSERT ... ON CONFLICT (...) DO NOTHING`。
 *    （原代码的 `ON CONFLICT(...) DO UPDATE SET x = excluded.x` 在 PG 下原生兼容，保留不变。）
 *  - 事务由 better-sqlite3 的 db.transaction(fn) 改为显式 BEGIN/COMMIT/ROLLBACK（同一 client）。
 *  - 时间列保留 TEXT 存 ISO 8601 字符串，保持原有的字符串比较/排序语义不变。
 *  - 注册 int8(20)/numeric(1700) 类型解析器：让 SUM()/COUNT() 返回 JS number 而非字符串，
 *    这样前端拿到的 totals/commit_count 仍是数字，响应结构与 SQLite 版本完全一致。
 *
 * 环境变量：
 *   DB_HOST, DB_PORT(5432), DB_NAME, DB_USER, DB_PASSWORD, DB_SSL(true|require|false)
 *   或单一 DATABASE_URL=postgres://user:pass@host:5432/db
 */

const { Pool, types } = require("pg");

// 让 bigint(int8) 与 numeric 以 JS number 返回（SUM/COUNT 结果默认是字符串）。
// 行级加法/差值都在 number 安全范围内（代码行数、毫秒计时），不会溢出 Number.MAX_SAFE_INTEGER。
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));   // int8 / bigint
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));   // numeric

function sslOption() {
  const v = (process.env.DB_SSL || "").toLowerCase();
  // RDS 使用 AWS 托管 CA；为简化部署使用 rejectUnauthorized:false（仍是 TLS 加密传输）。
  if (v === "true" || v === "require" || v === "1") return { rejectUnauthorized: false };
  return false;
}

function buildPoolConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, ssl: sslOption() };
  }
  return {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "kiro",
    user: process.env.DB_USER || "kiro",
    password: process.env.DB_PASSWORD || "",
    ssl: sslOption(),
    max: parseInt(process.env.DB_POOL_MAX || "10", 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
}

const pool = new Pool(buildPoolConfig());
pool.on("error", (err) => console.error("[store] idle pg client error:", err.message));

/** 直接查询助手（migrate.js 等会用到）。 */
async function query(text, params) {
  return pool.query(text, params);
}

// ==================== Schema 初始化 ====================

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS commits (
    id BIGSERIAL PRIMARY KEY,
    repo_name TEXT NOT NULL,
    repo_remote_url TEXT,
    branch TEXT,
    commit_sha TEXT NOT NULL,
    machine_id TEXT,
    user_name TEXT,
    user_email TEXT,
    idc_user_name TEXT DEFAULT '',
    idc_user_id TEXT DEFAULT '',
    reported_at TEXT,
    commit_msg TEXT DEFAULT '',
    human_additions INTEGER DEFAULT 0,
    ai_additions INTEGER DEFAULT 0,
    mixed_additions INTEGER DEFAULT 0,
    ai_accepted INTEGER DEFAULT 0,
    total_ai_additions INTEGER DEFAULT 0,
    total_ai_deletions INTEGER DEFAULT 0,
    time_waiting_for_ai BIGINT DEFAULT 0,
    git_diff_added_lines INTEGER DEFAULT 0,
    git_diff_deleted_lines INTEGER DEFAULT 0,
    ai_deletions INTEGER DEFAULT 0,
    human_deletions INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (now()::text)
  );

  CREATE TABLE IF NOT EXISTS tool_model_stats (
    id BIGSERIAL PRIMARY KEY,
    commit_id BIGINT NOT NULL REFERENCES commits(id),
    tool_model TEXT NOT NULL,
    ai_additions INTEGER DEFAULT 0,
    mixed_additions INTEGER DEFAULT 0,
    ai_accepted INTEGER DEFAULT 0,
    total_ai_additions INTEGER DEFAULT 0,
    total_ai_deletions INTEGER DEFAULT 0,
    time_waiting_for_ai BIGINT DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_commits_repo_name ON commits(repo_name);
  CREATE INDEX IF NOT EXISTS idx_commits_user_email ON commits(user_email);
  CREATE INDEX IF NOT EXISTS idx_commits_reported_at ON commits(reported_at);
  CREATE INDEX IF NOT EXISTS idx_tool_model_stats_commit_id ON tool_model_stats(commit_id);

  CREATE TABLE IF NOT EXISTS ai_ratio_history (
    id BIGSERIAL PRIMARY KEY,
    repo_name TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    ai_ratio DOUBLE PRECISION NOT NULL,
    ai_additions INTEGER NOT NULL,
    human_additions INTEGER NOT NULL,
    mixed_additions INTEGER NOT NULL,
    commit_sha TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ai_ratio_history_repo_time
    ON ai_ratio_history(repo_name, recorded_at);

  CREATE TABLE IF NOT EXISTS kiro_user (
    user_name      TEXT PRIMARY KEY,
    user_id        TEXT DEFAULT '',
    display_name   TEXT DEFAULT '',
    created_at     TEXT NOT NULL,
    user_ip        TEXT DEFAULT '',
    credit_used    TEXT DEFAULT '{}',
    updated_at     TEXT NOT NULL,
    plugin_added   INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id     TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    expire_time    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS plugins (
    hostname       TEXT PRIMARY KEY,
    user_name      TEXT NOT NULL,
    ip             TEXT DEFAULT '',
    last_updated   TEXT DEFAULT (now()::text)
  );
  CREATE INDEX IF NOT EXISTS idx_plugins_user_name ON plugins(user_name);
`;

/**
 * commits → kiro_user.display_name 的关联片段（getRepoStats / aggregateRepoStats 共用一份，
 * 避免两处写法漂移导致同一弹窗里两个数字对不上）。
 *
 * 两个要点：
 * 1. 子查询按 LOWER(user_name) 先 GROUP BY 收敛成一对一。直接
 *    `JOIN kiro_user ON LOWER(c.user_email)=LOWER(k.user_name)` 在存在大小写重复行时
 *    会让每条 commit 匹配多行 —— 明细行重复、by_user 的 COUNT/SUM 成倍放大，
 *    而 totals 查询没有 JOIN 不放大，同屏两个数字直接矛盾。
 * 2. 关联键先试 idc_user_name（IdC 权威标识，由 ingest 旁路写入），**没命中再试**
 *    user_email。既能命中"IdC UserName 不是邮箱"的环境，又不必改写 commits.user_email
 *    （改写会让同一个人在升级前后分裂成两个 user_key，且回滚代码追不回来）。
 *
 *    这里必须是**两级回退**（两个 LEFT JOIN + COALESCE），不能写成
 *    `ON k.lname = LOWER(COALESCE(NULLIF(c.idc_user_name,''), c.user_email))`。
 *    后者是"优先"而不是"都试"：idc_user_name 一旦非空就只拿它去匹配，匹配不上就是空，
 *    不会再回落到邮箱。实测（本机 PG 18.6，TEMP 表 + ROLLBACK）：kiro_user 里只有
 *    ('zhang.san@haier.com','张三')，两条 commit 的 user_email 都是它，其中一条
 *    idc_user_name='A1008803'（IdC 用户已删/改名，或运维按建议合并重复行时删掉了那一行）
 *      单级 COALESCE 写法 → new-stale-idc: ""      old-no-idc: "张三"
 *      两级回退写法       → new-stale-idc: "张三"  old-no-idc: "张三"
 *    也就是说单级写法下"升级后新落的行反而比升级前更差"：本来靠邮箱能显示的中文名变空。
 *    两个 LEFT JOIN 都对着已收敛成一对一的子查询，所以不会放大行数（实测仍是 2 行）。
 */
const DISPLAY_NAME_SRC = `
    SELECT LOWER(user_name) AS lname, MAX(NULLIF(display_name, '')) AS display_name
    FROM kiro_user
    WHERE COALESCE(user_name, '') <> ''
    GROUP BY LOWER(user_name)
`;
const DISPLAY_NAME_JOIN = `
  LEFT JOIN (${DISPLAY_NAME_SRC}) ki ON ki.lname = LOWER(NULLIF(c.idc_user_name, ''))
  LEFT JOIN (${DISPLAY_NAME_SRC}) ke ON ke.lname = LOWER(NULLIF(c.user_email, ''))
`;
/** 与 DISPLAY_NAME_JOIN 配套的取值表达式：先 IdC 标识、再邮箱、都没有则空串。 */
const DISPLAY_NAME_EXPR = `COALESCE(NULLIF(ki.display_name, ''), NULLIF(ke.display_name, ''), '')`;

let readyPromise = null;

/** 幂等初始化：建表 + 列迁移 + 回填 ai_ratio_history。首次被任意公共函数触发。 */
function ensureReady() {
  if (!readyPromise) readyPromise = init();
  return readyPromise;
}

async function init() {
  // 全部 DDL 走**同一条**连接：lock_timeout 是会话级 GUC，用 pool.query 单发一条
  // `SET` 只作用于池里随机取到的那条连接，后面的 ALTER 不保证还是它（node-postgres
  // 取空闲连接"通常"是同一条，但不是契约），而且那条连接归还池后会带着
  // lock_timeout=10s 去跑业务查询。显式 connect() 才能保证作用域正确、用完复位。
  const ddl = await pool.connect();
  try {
    // DDL 加锁超时：宁可启动失败并留下日志，也不要在 ALTER 上无限等锁——
    // 那会让进程既不退出也不监听端口，而 systemctl is-active 仍显示 active（假健康）。
    await ddl.query("SET lock_timeout = '10s'");
    await ddl.query(SCHEMA_SQL);
    // 兼容旧库的幂等列补齐（新库已含，这些是 no-op）
    await ddl.query("ALTER TABLE commits ADD COLUMN IF NOT EXISTS ai_deletions INTEGER DEFAULT 0");
    await ddl.query("ALTER TABLE commits ADD COLUMN IF NOT EXISTS human_deletions INTEGER DEFAULT 0");
    await ddl.query("ALTER TABLE commits ADD COLUMN IF NOT EXISTS commit_msg TEXT DEFAULT ''");
    await ddl.query("ALTER TABLE commits ADD COLUMN IF NOT EXISTS idc_user_name TEXT DEFAULT ''");
    await ddl.query("ALTER TABLE commits ADD COLUMN IF NOT EXISTS idc_user_id TEXT DEFAULT ''");
    await ddl.query("ALTER TABLE kiro_user ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT ''");
    await ddl.query("ALTER TABLE kiro_user ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT ''");
    await ddl.query("ALTER TABLE kiro_user ADD COLUMN IF NOT EXISTS plugin_added INTEGER DEFAULT 0");
    await ensureLowerNameUniqueIndex(ddl);
  } finally {
    // RESET 后再归还，避免这条连接把 lock_timeout 带给后续业务查询。
    await ddl.query("RESET lock_timeout").catch(() => {});
    ddl.release();
  }
  try {
    await backfillAiRatioHistory();
  } catch (err) {
    console.error("backfillAiRatioHistory: failed:", err);
  }
  console.log("[store] PostgreSQL schema ready");
}

/**
 * kiro_user.user_name 是大小写敏感的主键，但两个写入源互不协调
 * （IdC 同步写 UserName 原样大小写；插件 userSync 写 kiro-cli whoami 的邮箱），
 * 所以 'Zhang.San@x.com' 与 'zhang.san@x.com' 可以合法共存。
 * display_name 的关联走 LOWER()，这类重复行会让 JOIN 一对多放大统计值。
 *
 * 建唯一索引根治。已有脏数据时索引会建失败——此处**不得**让它阻断启动：
 * 查询侧已用子查询收敛（见 DISPLAY_NAME_JOIN），失败只是少了一层护栏。
 *
 * @param {import("pg").PoolClient|import("pg").Pool} db init() 里持有 lock_timeout 的那条连接
 */
async function ensureLowerNameUniqueIndex(db = pool) {
  try {
    await db.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_kiro_user_lower_name ON kiro_user (LOWER(user_name))"
    );
  } catch (err) {
    const dupRes = await db.query(
      `SELECT LOWER(user_name) AS lname, array_agg(user_name) AS variants
       FROM kiro_user GROUP BY LOWER(user_name) HAVING count(*) > 1`
    ).catch(() => ({ rows: [] }));
    console.error(
      `[store] uq_kiro_user_lower_name 未能创建：${err.message}\n` +
      `[store] kiro_user 存在大小写重复行 ${dupRes.rows.length} 组，需人工合并后重启：` +
      dupRes.rows.map((r) => `${r.lname} -> ${JSON.stringify(r.variants)}`).join("; ")
    );
  }
  // 关联键在 commits 侧的支撑索引（表可能很大，用 LOWER 表达式索引匹配查询写法）。
  // 注意这两条**不是** CONCURRENTLY：commits 是唯一会长到百万行的表，非并发建索引
  // 要持 SHARE 锁 + 全表扫，期间 ingest 的 INSERT 全部排队，而 main.js 是
  // await ensureReady() 之后才 require ingest/dashboard → 80/3500 全程不监听。
  // 因此百万行级的库要在**停服前**手工用 CREATE INDEX CONCURRENTLY 预建
  // （SQL 见《部署手册》§12.3 的 ⚠️ 说明），预建过之后这里的 IF NOT EXISTS 就是 no-op。
  await db.query(
    "CREATE INDEX IF NOT EXISTS idx_commits_user_email_lower ON commits (LOWER(user_email))"
  ).catch((err) => console.warn(`[store] idx_commits_user_email_lower: ${err.message}`));
  await db.query(
    "CREATE INDEX IF NOT EXISTS idx_commits_idc_user_name_lower ON commits (LOWER(idc_user_name))"
  ).catch((err) => console.warn(`[store] idx_commits_idc_user_name_lower: ${err.message}`));
}

/**
 * 从已有 commits 回填 ai_ratio_history。仅当该表为空时运行。
 * 按时间顺序重放，维护每个仓库的累计比率。
 */
async function backfillAiRatioHistory() {
  const cntRes = await pool.query("SELECT COUNT(*) AS cnt FROM ai_ratio_history");
  if (cntRes.rows[0].cnt > 0) return;

  const commitsRes = await pool.query(`
    SELECT repo_name, commit_sha,
           COALESCE(reported_at, created_at) AS effective_at,
           ai_additions, human_additions, mixed_additions
    FROM commits
    WHERE COALESCE(reported_at, created_at) IS NOT NULL
    ORDER BY COALESCE(reported_at, created_at) ASC
  `);
  const commits = commitsRes.rows;
  if (commits.length === 0) return;

  const accumulators = {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const commit of commits) {
      if (!accumulators[commit.repo_name]) {
        accumulators[commit.repo_name] = { ai: 0, human: 0, mixed: 0 };
      }
      const acc = accumulators[commit.repo_name];
      acc.ai += commit.ai_additions;
      acc.human += commit.human_additions;
      acc.mixed += commit.mixed_additions;

      const total = acc.ai + acc.human - acc.mixed;
      if (total === 0) continue;

      const ratio = (acc.ai - acc.mixed * 0.5) / total;
      await client.query(
        `INSERT INTO ai_ratio_history
           (repo_name, recorded_at, ai_ratio, ai_additions, human_additions, mixed_additions, commit_sha)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [commit.repo_name, commit.effective_at, ratio, acc.ai, acc.human, acc.mixed, commit.commit_sha]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ==================== 幂等键 ====================

async function hasIdempotencyKey(key) {
  try {
    await ensureReady();
    const r = await pool.query("SELECT 1 FROM idempotency_keys WHERE key = $1", [key]);
    return r.rowCount > 0;
  } catch (err) {
    console.error("hasIdempotencyKey: query failed:", err);
    return false;
  }
}

async function setIdempotencyKey(key) {
  await ensureReady();
  await pool.query(
    "INSERT INTO idempotency_keys (key, created_at) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING",
    [key, new Date().toISOString()]
  );
}

// ==================== 写入提交统计 ====================

/**
 * 原子写入一条提交统计（commits + tool_model_stats + ai_ratio 快照）。
 */
async function saveStats(payload) {
  await ensureReady();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const p = payload;
    const cs = p.commit_stats || {};

    const insRes = await client.query(
      `INSERT INTO commits (
         repo_name, repo_remote_url, branch, commit_sha, machine_id,
         user_name, user_email, idc_user_name, reported_at, commit_msg,
         human_additions, ai_additions, mixed_additions,
         ai_accepted, total_ai_additions, total_ai_deletions,
         time_waiting_for_ai, git_diff_added_lines, git_diff_deleted_lines,
         ai_deletions, human_deletions, idc_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING id`,
      [
        p.repo_name, p.repo_remote_url, p.branch, p.commit_sha, p.machine_id,
        p.user_name, p.user_email, p.idc_user_name || "", p.reported_at, p.commit_msg || "",
        cs.human_additions, cs.ai_additions, cs.mixed_additions,
        cs.ai_accepted, cs.total_ai_additions, cs.total_ai_deletions,
        cs.time_waiting_for_ai, cs.git_diff_added_lines, cs.git_diff_deleted_lines,
        cs.ai_deletions || 0, cs.human_deletions || 0,
        // 原始上报的 user_id 原样落库（解析成功与否都存）。idc_user_name 只是"入库当时"的
        // 解析结果——若那一刻 IdC 恰好故障，没有这一列这条 commit 就永久失去关联线索。
        p.user_id || "",
      ]
    );
    const commitId = insRes.rows[0].id;

    const tmb = cs.tool_model_breakdown || {};
    for (const [toolModel, stats] of Object.entries(tmb)) {
      await client.query(
        `INSERT INTO tool_model_stats (
           commit_id, tool_model,
           ai_additions, mixed_additions, ai_accepted,
           total_ai_additions, total_ai_deletions, time_waiting_for_ai
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          commitId, toolModel,
          stats.ai_additions, stats.mixed_additions, stats.ai_accepted,
          stats.total_ai_additions, stats.total_ai_deletions, stats.time_waiting_for_ai,
        ]
      );
    }

    await recordAiRatioSnapshotTx(client, p.repo_name, p.commit_sha);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ==================== 查询：仓库 ====================

async function listRepos() {
  try {
    await ensureReady();
    const r = await pool.query("SELECT DISTINCT repo_name FROM commits ORDER BY repo_name");
    return r.rows.map((row) => row.repo_name);
  } catch (err) {
    console.error("listRepos: query failed:", err);
    return [];
  }
}

/**
 * 获取某仓库所有提交记录（所有用户），按 reported_at 降序。
 */
async function getRepoStats(repoName) {
  try {
    await ensureReady();
    const commitsRes = await pool.query(
      `SELECT c.*, ${DISPLAY_NAME_EXPR} AS display_name
       FROM commits c
       ${DISPLAY_NAME_JOIN}
       WHERE c.repo_name = $1 ORDER BY c.reported_at DESC`,
      [repoName]
    );
    const commits = commitsRes.rows;

    // 一次性取出该仓库所有 tool_model 行，按 commit_id 分组（避免 N+1）
    const tmRes = await pool.query(
      `SELECT tms.commit_id, tms.tool_model, tms.ai_additions, tms.mixed_additions,
              tms.ai_accepted, tms.total_ai_additions, tms.total_ai_deletions, tms.time_waiting_for_ai
       FROM tool_model_stats tms
       JOIN commits c ON tms.commit_id = c.id
       WHERE c.repo_name = $1`,
      [repoName]
    );
    const tmByCommit = {};
    for (const tm of tmRes.rows) {
      (tmByCommit[tm.commit_id] = tmByCommit[tm.commit_id] || {})[tm.tool_model] = {
        ai_additions: tm.ai_additions,
        mixed_additions: tm.mixed_additions,
        ai_accepted: tm.ai_accepted,
        total_ai_additions: tm.total_ai_additions,
        total_ai_deletions: tm.total_ai_deletions,
        time_waiting_for_ai: tm.time_waiting_for_ai,
      };
    }

    return commits.map((row) => ({
      repo_name: row.repo_name,
      repo_remote_url: row.repo_remote_url,
      branch: row.branch,
      commit_sha: row.commit_sha,
      commit_msg: row.commit_msg || "",
      machine_id: row.machine_id,
      user_name: row.user_name,
      user_email: row.user_email,
      display_name: row.display_name || "",
      reported_at: row.reported_at,
      commit_stats: {
        human_additions: row.human_additions,
        ai_additions: row.ai_additions,
        mixed_additions: row.mixed_additions,
        ai_accepted: row.ai_accepted,
        total_ai_additions: row.total_ai_additions,
        total_ai_deletions: row.total_ai_deletions,
        time_waiting_for_ai: row.time_waiting_for_ai,
        git_diff_added_lines: row.git_diff_added_lines,
        git_diff_deleted_lines: row.git_diff_deleted_lines,
        tool_model_breakdown: tmByCommit[row.id] || {},
      },
    }));
  } catch (err) {
    console.error("getRepoStats: query failed:", err);
    return [];
  }
}

/**
 * 聚合某仓库所有提交为汇总（SQL SUM/GROUP BY）。
 */
async function aggregateRepoStats(repoName) {
  try {
    await ensureReady();
    const totalsRes = await pool.query(
      `SELECT
         COALESCE(SUM(human_additions), 0) AS human_additions,
         COALESCE(SUM(ai_additions), 0) AS ai_additions,
         COALESCE(SUM(mixed_additions), 0) AS mixed_additions,
         COALESCE(SUM(ai_accepted), 0) AS ai_accepted,
         COALESCE(SUM(total_ai_additions), 0) AS total_ai_additions,
         COALESCE(SUM(total_ai_deletions), 0) AS total_ai_deletions,
         COALESCE(SUM(time_waiting_for_ai), 0) AS time_waiting_for_ai,
         COALESCE(SUM(git_diff_added_lines), 0) AS git_diff_added_lines,
         COALESCE(SUM(git_diff_deleted_lines), 0) AS git_diff_deleted_lines,
         COALESCE(SUM(ai_deletions), 0) AS ai_deletions,
         COALESCE(SUM(human_deletions), 0) AS human_deletions,
         COUNT(*) AS commit_count
       FROM commits WHERE repo_name = $1`,
      [repoName]
    );
    const totalsRow = totalsRes.rows[0];
    if (!totalsRow || totalsRow.commit_count === 0) {
      return null;
    }

    const latestRes = await pool.query(
      "SELECT branch, commit_sha, reported_at FROM commits WHERE repo_name = $1 ORDER BY reported_at DESC LIMIT 1",
      [repoName]
    );
    const latestRow = latestRes.rows[0];

    // 按用户聚合：NULLIF 把空串当 NULL，匹配原 JS 的 || 逻辑
    // LEFT JOIN kiro_user 获取 display_name（IdC 中文全名）
    const userRes = await pool.query(
      `SELECT
         COALESCE(NULLIF(c.user_email, ''), NULLIF(c.user_name, ''), 'anonymous') AS user_key,
         COALESCE(MAX(c.user_name), '') AS user_name,
         COALESCE(MAX(c.user_email), '') AS user_email,
         COALESCE(MAX(${DISPLAY_NAME_EXPR}), '') AS display_name,
         COALESCE(SUM(c.human_additions), 0) AS human_additions,
         COALESCE(SUM(c.ai_additions), 0) AS ai_additions,
         COALESCE(SUM(c.mixed_additions), 0) AS mixed_additions,
         COALESCE(SUM(c.ai_accepted), 0) AS ai_accepted,
         COALESCE(SUM(c.git_diff_added_lines), 0) AS git_diff_added_lines,
         COUNT(*) AS commit_count,
         COALESCE(SUM(c.time_waiting_for_ai), 0) AS time_waiting_for_ai
       FROM commits c
       ${DISPLAY_NAME_JOIN}
       WHERE c.repo_name = $1
       GROUP BY user_key`,
      [repoName]
    );

    const byUser = {};
    for (const row of userRes.rows) {
      byUser[row.user_key] = {
        user_name: row.user_name,
        user_email: row.user_email,
        display_name: row.display_name,
        human_additions: row.human_additions,
        ai_additions: row.ai_additions,
        mixed_additions: row.mixed_additions,
        ai_accepted: row.ai_accepted,
        git_diff_added_lines: row.git_diff_added_lines,
        commit_count: row.commit_count,
        time_waiting_for_ai: row.time_waiting_for_ai,
      };
    }

    const tmRes = await pool.query(
      `SELECT
         tms.tool_model,
         COALESCE(SUM(tms.ai_additions), 0) AS ai_additions,
         COALESCE(SUM(tms.mixed_additions), 0) AS mixed_additions,
         COALESCE(SUM(tms.ai_accepted), 0) AS ai_accepted,
         COALESCE(SUM(tms.total_ai_additions), 0) AS total_ai_additions,
         COALESCE(SUM(tms.total_ai_deletions), 0) AS total_ai_deletions,
         COALESCE(SUM(tms.time_waiting_for_ai), 0) AS time_waiting_for_ai
       FROM tool_model_stats tms
       JOIN commits c ON tms.commit_id = c.id
       WHERE c.repo_name = $1
       GROUP BY tms.tool_model`,
      [repoName]
    );

    const byToolModel = {};
    for (const row of tmRes.rows) {
      byToolModel[row.tool_model] = {
        ai_additions: row.ai_additions,
        mixed_additions: row.mixed_additions,
        ai_accepted: row.ai_accepted,
        total_ai_additions: row.total_ai_additions,
        total_ai_deletions: row.total_ai_deletions,
        time_waiting_for_ai: row.time_waiting_for_ai,
      };
    }

    return {
      repo_name: repoName,
      branch: latestRow.branch,
      commit_sha: latestRow.commit_sha,
      reported_at: latestRow.reported_at,
      totals: {
        human_additions: totalsRow.human_additions,
        ai_additions: totalsRow.ai_additions,
        mixed_additions: totalsRow.mixed_additions,
        ai_accepted: totalsRow.ai_accepted,
        total_ai_additions: totalsRow.total_ai_additions,
        total_ai_deletions: totalsRow.total_ai_deletions,
        time_waiting_for_ai: totalsRow.time_waiting_for_ai,
        git_diff_added_lines: totalsRow.git_diff_added_lines,
        git_diff_deleted_lines: totalsRow.git_diff_deleted_lines,
        ai_deletions: totalsRow.ai_deletions,
        human_deletions: totalsRow.human_deletions,
        commit_count: totalsRow.commit_count,
      },
      by_user: byUser,
      by_tool_model: byToolModel,
    };
  } catch (err) {
    console.error("aggregateRepoStats: query failed:", err);
    return null;
  }
}

/**
 * 所有仓库的汇总列表。
 */
async function getAllReposSummary() {
  try {
    const repos = await listRepos();
    const out = [];
    for (const name of repos) {
      const agg = await aggregateRepoStats(name);
      if (!agg) continue; // 与原逻辑一致：无聚合则不计入（filter commit_count !== undefined）
      const t = agg.totals;
      out.push({
        repo_name: name,
        branch: agg.branch,
        commit_sha: agg.commit_sha,
        reported_at: agg.reported_at,
        human_additions: t.human_additions,
        ai_additions: t.ai_additions,
        mixed_additions: t.mixed_additions,
        ai_accepted: t.ai_accepted,
        git_diff_added_lines: t.git_diff_added_lines,
        commit_count: t.commit_count,
        time_waiting_for_ai: t.time_waiting_for_ai,
        user_count: Object.keys(agg.by_user).length,
        by_tool_model: agg.by_tool_model,
      });
    }
    return out;
  } catch (err) {
    console.error("getAllReposSummary: query failed:", err);
    return [];
  }
}

/**
 * 记录一次累计 AI 比率快照（在已有事务的 client 内执行，不自开事务）。
 */
async function recordAiRatioSnapshotTx(client, repoName, commitSha) {
  const r = await client.query(
    `SELECT
       COALESCE(SUM(ai_additions), 0) AS ai,
       COALESCE(SUM(human_additions), 0) AS human,
       COALESCE(SUM(mixed_additions), 0) AS mixed
     FROM commits WHERE repo_name = $1`,
    [repoName]
  );
  const row = r.rows[0];
  const total = row.ai + row.human - row.mixed;
  if (total === 0) return;

  const ratio = (row.ai - row.mixed * 0.5) / total;
  await client.query(
    `INSERT INTO ai_ratio_history
       (repo_name, recorded_at, ai_ratio, ai_additions, human_additions, mixed_additions, commit_sha)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [repoName, new Date().toISOString(), ratio, row.ai, row.human, row.mixed, commitSha]
  );
}

async function getAiRatioHistory(repoName) {
  try {
    await ensureReady();
    const r = await pool.query(
      `SELECT recorded_at, ai_ratio, ai_additions, human_additions, mixed_additions, commit_sha
       FROM ai_ratio_history
       WHERE repo_name = $1
       ORDER BY recorded_at ASC`,
      [repoName]
    );
    return r.rows;
  } catch (err) {
    console.error("getAiRatioHistory: query failed:", err);
    return [];
  }
}

// ==================== 用户管理 ====================

function safeParseJson(str) {
  try { return JSON.parse(str || "{}"); } catch { return {}; }
}

async function getUser(userName) {
  await ensureReady();
  const r = await pool.query("SELECT * FROM kiro_user WHERE user_name = $1", [userName]);
  const row = r.rows[0];
  return row ? { ...row, credit_used: safeParseJson(row.credit_used), plugin_added: !!row.plugin_added } : null;
}

/**
 * 按 LOWER(user_name) 查用户（大小写不敏感）。
 *
 * 为什么必须有这个函数：唯一索引 uq_kiro_user_lower_name 建的是 LOWER(user_name)，
 * 而写入路径原来用的是 `ON CONFLICT (user_name)` / `WHERE user_name = $1`（精确大小写）。
 * 两者对不上时，只要送进来的 user_name 与库里已有行只差大小写，
 * 就会绕过 ON CONFLICT 直接撞上 LOWER 唯一索引 → 抛 23505 → 整个写入失败。
 * 实测（RDS PostgreSQL 16.14）：库里有 zhang.san@haier.com，
 * 送 ZHANG.SAN@haier.com 进来时 syncIdCUsersToLocal 与 userSync 双双抛
 * `duplicate key value violates unique constraint "uq_kiro_user_lower_name"`。
 *
 * 存在重复行（唯一索引没建上）时取哪一行是确定的：先 plugin_added 再 updated_at，
 * 即"信息更全、更近活跃"的那行，避免每次调用挑到不同行造成写入漂移。
 */
async function getUserCaseInsensitive(userName) {
  await ensureReady();
  const r = await pool.query(
    `SELECT * FROM kiro_user WHERE LOWER(user_name) = LOWER($1)
     ORDER BY plugin_added DESC, updated_at DESC LIMIT 1`,
    [userName]
  );
  const row = r.rows[0];
  return row ? { ...row, credit_used: safeParseJson(row.credit_used), plugin_added: !!row.plugin_added } : null;
}

async function getAllUsers() {
  await ensureReady();
  const r = await pool.query("SELECT * FROM kiro_user ORDER BY updated_at DESC");
  return r.rows.map((row) => ({
    ...row,
    credit_used: safeParseJson(row.credit_used),
    plugin_added: !!row.plugin_added,
  }));
}

/**
 * 从 IAM Identity Center 用户列表同步到本地表。
 * 冲突时更新 user_id 和 display_name（保证 IdC 的最新 displayName 能覆盖到本地）。
 *
 * 关联键按 LOWER(user_name) 匹配，而不是 `ON CONFLICT (user_name)`：
 * kiro_user 里的行可能是插件 userSync 先建的（大小写取决于插件送什么），
 * 与 IdC 的规范大小写不一致时，`ON CONFLICT (user_name)` 匹配不上，
 * 却会撞上 uq_kiro_user_lower_name → 23505 → 整个事务回滚 →
 * **一行脏数据就能让全表的 display_name 永远同步不进来**（调用方 /api/users 还会把异常吞掉降级）。
 * 因此改为「按 LOWER 先 UPDATE，确认不存在再 INSERT」，且每个用户套一个 SAVEPOINT，
 * 单个用户失败只跳过该用户、不牵连整批。
 */
async function syncIdCUsersToLocal(idcUsers) {
  await ensureReady();
  const now = new Date().toISOString();
  const client = await pool.connect();
  let updated = 0;
  let inserted = 0;
  const failed = [];
  try {
    await client.query("BEGIN");
    for (const u of idcUsers) {
      if (!u.userName) { continue; }
      await client.query("SAVEPOINT sp_idc_user");
      try {
        // updated_at 语义是"最后活跃时间"（getAllUsers 的排序键 + 前端"最后活跃"列的唯一数据源），
        // 只应由插件 userSync / S3 credit 同步刷新。本函数被 GET /api/users 每次调用，
        // 若在这里刷 updated_at，全表活跃时间会被抹成页面打开时间且不可恢复。
        // NULLIF 守卫：IdC 未设 DisplayName 的用户会产出空串，不能用它覆盖已有（含人工回填的）值。
        // WHERE 守卫：无变化时不写，稳态下写入量为 0，避免每次刷页面产生 N 个死元组 + N 个行锁。
        const upd = await client.query(
          `UPDATE kiro_user SET
             user_id      = COALESCE(NULLIF($2, ''), user_id),
             display_name = COALESCE(NULLIF($3, ''), display_name)
           WHERE LOWER(user_name) = LOWER($1)
             AND (user_id      IS DISTINCT FROM COALESCE(NULLIF($2, ''), user_id)
               OR display_name IS DISTINCT FROM COALESCE(NULLIF($3, ''), display_name))`,
          [u.userName, u.userId || "", u.displayName || ""]
        );
        if (upd.rowCount > 0) {
          updated += upd.rowCount;
        } else {
          // rowCount=0 有两种成因：① 行不存在 ② 行存在但值完全没变（WHERE 守卫生效）。
          // 必须区分，否则会对已存在的行重复 INSERT 撞唯一索引。
          const ex = await client.query(
            "SELECT 1 FROM kiro_user WHERE LOWER(user_name) = LOWER($1) LIMIT 1",
            [u.userName]
          );
          if (ex.rowCount === 0) {
            await client.query(
              `INSERT INTO kiro_user (user_name, user_id, display_name, created_at, user_ip, credit_used, updated_at, plugin_added)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (user_name) DO NOTHING`,
              [u.userName, u.userId || "", u.displayName || "", now, "", "{}", now, 0]
            );
            inserted++;
          }
        }
        await client.query("RELEASE SAVEPOINT sp_idc_user");
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT sp_idc_user");
        failed.push(`${u.userName}(${e.code || e.message})`);
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  console.log(
    `[userManagement] Synced ${idcUsers.length} IdC user(s) to local table` +
    ` (${inserted} inserted, ${updated} updated)`
  );
  if (failed.length) {
    console.warn(`[userManagement] ${failed.length} IdC user(s) skipped: ${failed.join(", ")}`);
  }
}

/**
 * userSync: 更新用户记录。
 * - 插件调用（_overwrite_credits falsy）：更新 ip/updated_at/plugin_added=1，credits 累加；有 hostname 则 upsert plugins。
 * - S3 同步（_overwrite_credits=true）：只覆盖 credit_used。
 */
async function userSync(payload) {
  await ensureReady();
  const { user_name, user_id, user_ip, credit_used, _overwrite_credits, hostname } = payload;
  if (!user_name) { throw new Error("user_name is required"); }

  const now = new Date().toISOString();
  // 大小写不敏感地找已有行：否则「库里是 zhang.san@，插件送 ZHANG.SAN@」会走进 INSERT 分支，
  // 撞上 uq_kiro_user_lower_name 抛 23505 → ingest 回 HTTP 500 → 该用户的 userSync 永久失败
  // （连带 user_id 落不了库，工号型账号的中文名链路整条断掉）。实测已复现，见 getUserCaseInsensitive 注释。
  const existing = await getUserCaseInsensitive(user_name);
  // 后续所有 UPDATE / plugins 关联都必须用库里那行的**原始大小写**做键，不能用送进来的大小写。
  const canonicalName = existing ? existing.user_name : user_name;
  if (existing && existing.user_name !== user_name) {
    console.warn(
      `[userManagement] userSync 大小写不一致：送来 "${user_name}"，库里是 "${existing.user_name}"，` +
      `按库里的行更新（不新建行）`
    );
  }

  if (!existing) {
    const isPlugin = !_overwrite_credits;
    try {
      await pool.query(
        `INSERT INTO kiro_user (user_name, user_id, created_at, user_ip, credit_used, updated_at, plugin_added)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_name) DO NOTHING`,
        // user_id 原样落库。尤其是 user_name="Unknown"（IdC 解析失败）的行：
        // 上报的 user_id 是这行唯一能对回"是谁"的线索，丢了就永久无法事后补救。
        [user_name, user_id || "", now, user_ip || "", JSON.stringify(credit_used || {}), now, isPlugin ? 1 : 0]
      );
      console.log(`[userManagement] Created user: ${user_name} (source=${isPlugin ? "plugin" : "s3"})`);
    } catch (err) {
      // 竞态窗口：上面 getUserCaseInsensitive 查空之后、INSERT 落地之前，
      // 并发写入者（IdC 同步 / 同一用户的另一台机器）先插入了一个大小写变体。
      // ON CONFLICT (user_name) 只仲裁主键的精确大小写冲突，撞上
      // uq_kiro_user_lower_name（LOWER 表达式唯一索引）仍会抛 23505 →
      // 若不接住，ingest 对插件回 HTTP 500。此处重查一次并按已有行更新收场。
      if (err.code !== "23505") throw err;
      const raced = await getUserCaseInsensitive(user_name);
      if (!raced) throw err;
      console.warn(
        `[userManagement] userSync 撞上并发写入的大小写变体（送来 "${user_name}"，库里已是 "${raced.user_name}"），按已有行更新`
      );
      await pool.query(
        `UPDATE kiro_user SET user_ip = $1, updated_at = $2, plugin_added = 1,
           user_id = COALESCE(NULLIF(user_id, ''), NULLIF($4, ''), '')
         WHERE user_name = $3`,
        [user_ip || "", now, raced.user_name, user_id || ""]
      );
    }
  } else {
    const existingCredits = existing.credit_used || {};
    const incomingCredits = credit_used || {};

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    if (_overwrite_credits) {
      const merged = { ...existingCredits, ...Object.fromEntries(Object.entries(incomingCredits).filter(([, v]) => typeof v === "number")) };
      const trimmed = Object.fromEntries(Object.entries(merged).filter(([d]) => d >= cutoffStr));
      await pool.query("UPDATE kiro_user SET credit_used = $1 WHERE user_name = $2", [JSON.stringify(trimmed), canonicalName]);
      console.log(`[userManagement] Updated credits (s3): ${canonicalName}`);
    } else {
      const merged = Object.entries(incomingCredits).reduce((acc, [d, v]) => {
        acc[d] = (acc[d] || 0) + (typeof v === "number" ? v : 0); return acc;
      }, { ...existingCredits });
      const trimmed = Object.fromEntries(Object.entries(merged).filter(([d]) => d >= cutoffStr));
      // user_id 只补空不覆盖：IdC 同步写入的权威 UUID 不该被插件上报顶掉；
      // 但行里还是空（如历史遗留的 Unknown 行）时，用上报值补上。
      await pool.query(
        `UPDATE kiro_user SET user_ip = $1, credit_used = $2, updated_at = $3, plugin_added = $4,
           user_id = COALESCE(NULLIF(user_id, ''), NULLIF($6, ''), '')
         WHERE user_name = $5`,
        [user_ip || existing.user_ip || "", JSON.stringify(trimmed), now, 1, canonicalName, user_id || ""]
      );
      console.log(`[userManagement] Updated user (plugin): ${canonicalName}`);
    }
  }

  if (!_overwrite_credits && hostname) {
    await upsertPlugin(hostname, canonicalName, user_ip || "");
  }
}

// ==================== sessions ====================

async function upsertSessions(sessions) {
  await ensureReady();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const s of sessions) {
      await client.query(
        `INSERT INTO sessions (session_id, user_id, expire_time)
         VALUES ($1,$2,$3)
         ON CONFLICT (session_id) DO UPDATE SET user_id = excluded.user_id, expire_time = excluded.expire_time`,
        [s.session_id, s.user_id, s.expire_time]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function deleteExpiredSessions() {
  await ensureReady();
  const now = new Date().toISOString();
  const r = await pool.query("DELETE FROM sessions WHERE expire_time < $1", [now]);
  return r.rowCount;
}

async function countSessionsByUserId(userId) {
  await ensureReady();
  const r = await pool.query("SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = $1", [userId]);
  return r.rows[0] ? r.rows[0].cnt : 0;
}

async function getTotalSessionCount() {
  await ensureReady();
  const r = await pool.query("SELECT COUNT(*) AS cnt FROM sessions");
  return r.rows[0] ? r.rows[0].cnt : 0;
}

// ==================== plugins ====================

async function upsertPlugin(hostname, userName, ip) {
  await ensureReady();
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO plugins (hostname, user_name, ip, last_updated)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (hostname) DO UPDATE SET user_name = excluded.user_name, ip = excluded.ip, last_updated = excluded.last_updated`,
    [hostname, userName, ip, now]
  );
}

async function countPluginsByUserName(userName) {
  await ensureReady();
  const r = await pool.query("SELECT COUNT(*) AS cnt FROM plugins WHERE user_name = $1", [userName]);
  return r.rows[0] ? r.rows[0].cnt : 0;
}

async function getTotalPluginCount() {
  await ensureReady();
  const r = await pool.query("SELECT COUNT(*) AS cnt FROM plugins");
  return r.rows[0] ? r.rows[0].cnt : 0;
}

module.exports = {
  // 生命周期 / 底层
  ensureReady,
  init,
  query,
  pool,
  // 幂等
  hasIdempotencyKey,
  setIdempotencyKey,
  // 统计
  saveStats,
  listRepos,
  getRepoStats,
  aggregateRepoStats,
  getAllReposSummary,
  getAiRatioHistory,
  // 用户管理
  getUser,
  getUserCaseInsensitive,
  getAllUsers,
  userSync,
  syncIdCUsersToLocal,
  // sessions
  upsertSessions,
  deleteExpiredSessions,
  countSessionsByUserId,
  getTotalSessionCount,
  // plugins
  upsertPlugin,
  countPluginsByUserName,
  getTotalPluginCount,
};

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

let readyPromise = null;

/** 幂等初始化：建表 + 列迁移 + 回填 ai_ratio_history。首次被任意公共函数触发。 */
function ensureReady() {
  if (!readyPromise) readyPromise = init();
  return readyPromise;
}

async function init() {
  await pool.query(SCHEMA_SQL);
  // 兼容旧库的幂等列补齐（新库已含，这些是 no-op）
  await pool.query("ALTER TABLE commits ADD COLUMN IF NOT EXISTS ai_deletions INTEGER DEFAULT 0");
  await pool.query("ALTER TABLE commits ADD COLUMN IF NOT EXISTS human_deletions INTEGER DEFAULT 0");
  await pool.query("ALTER TABLE commits ADD COLUMN IF NOT EXISTS commit_msg TEXT DEFAULT ''");
  await pool.query("ALTER TABLE kiro_user ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT ''");
  await pool.query("ALTER TABLE kiro_user ADD COLUMN IF NOT EXISTS plugin_added INTEGER DEFAULT 0");
  try {
    await backfillAiRatioHistory();
  } catch (err) {
    console.error("backfillAiRatioHistory: failed:", err);
  }
  console.log("[store] PostgreSQL schema ready");
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
         user_name, user_email, reported_at, commit_msg,
         human_additions, ai_additions, mixed_additions,
         ai_accepted, total_ai_additions, total_ai_deletions,
         time_waiting_for_ai, git_diff_added_lines, git_diff_deleted_lines,
         ai_deletions, human_deletions
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        p.repo_name, p.repo_remote_url, p.branch, p.commit_sha, p.machine_id,
        p.user_name, p.user_email, p.reported_at, p.commit_msg || "",
        cs.human_additions, cs.ai_additions, cs.mixed_additions,
        cs.ai_accepted, cs.total_ai_additions, cs.total_ai_deletions,
        cs.time_waiting_for_ai, cs.git_diff_added_lines, cs.git_diff_deleted_lines,
        cs.ai_deletions || 0, cs.human_deletions || 0,
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
      "SELECT * FROM commits WHERE repo_name = $1 ORDER BY reported_at DESC",
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
    const userRes = await pool.query(
      `SELECT
         COALESCE(NULLIF(user_email, ''), NULLIF(user_name, ''), 'anonymous') AS user_key,
         COALESCE(MAX(user_name), '') AS user_name,
         COALESCE(MAX(user_email), '') AS user_email,
         COALESCE(SUM(human_additions), 0) AS human_additions,
         COALESCE(SUM(ai_additions), 0) AS ai_additions,
         COALESCE(SUM(mixed_additions), 0) AS mixed_additions,
         COALESCE(SUM(ai_accepted), 0) AS ai_accepted,
         COALESCE(SUM(git_diff_added_lines), 0) AS git_diff_added_lines,
         COUNT(*) AS commit_count,
         COALESCE(SUM(time_waiting_for_ai), 0) AS time_waiting_for_ai
       FROM commits WHERE repo_name = $1
       GROUP BY user_key`,
      [repoName]
    );

    const byUser = {};
    for (const row of userRes.rows) {
      byUser[row.user_key] = {
        user_name: row.user_name,
        user_email: row.user_email,
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
 * 从 IAM Identity Center 用户列表同步到本地表。只插入不存在的（ON CONFLICT DO NOTHING）。
 */
async function syncIdCUsersToLocal(idcUsers) {
  await ensureReady();
  const now = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const u of idcUsers) {
      await client.query(
        `INSERT INTO kiro_user (user_name, user_id, created_at, user_ip, credit_used, updated_at, plugin_added)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_name) DO NOTHING`,
        [u.userName, u.userId, now, "", "{}", now, 0]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  console.log(`[userManagement] Synced ${idcUsers.length} IdC user(s) to local table`);
}

/**
 * userSync: 更新用户记录。
 * - 插件调用（_overwrite_credits falsy）：更新 ip/updated_at/plugin_added=1，credits 累加；有 hostname 则 upsert plugins。
 * - S3 同步（_overwrite_credits=true）：只覆盖 credit_used。
 */
async function userSync(payload) {
  await ensureReady();
  const { user_name, user_ip, credit_used, _overwrite_credits, hostname } = payload;
  if (!user_name) { throw new Error("user_name is required"); }

  const now = new Date().toISOString();
  const existing = await getUser(user_name);

  if (!existing) {
    const isPlugin = !_overwrite_credits;
    await pool.query(
      `INSERT INTO kiro_user (user_name, user_id, created_at, user_ip, credit_used, updated_at, plugin_added)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_name) DO NOTHING`,
      [user_name, "", now, user_ip || "", JSON.stringify(credit_used || {}), now, isPlugin ? 1 : 0]
    );
    console.log(`[userManagement] Created user: ${user_name} (source=${isPlugin ? "plugin" : "s3"})`);
  } else {
    const existingCredits = existing.credit_used || {};
    const incomingCredits = credit_used || {};

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    if (_overwrite_credits) {
      const merged = { ...existingCredits, ...Object.fromEntries(Object.entries(incomingCredits).filter(([, v]) => typeof v === "number")) };
      const trimmed = Object.fromEntries(Object.entries(merged).filter(([d]) => d >= cutoffStr));
      await pool.query("UPDATE kiro_user SET credit_used = $1 WHERE user_name = $2", [JSON.stringify(trimmed), user_name]);
      console.log(`[userManagement] Updated credits (s3): ${user_name}`);
    } else {
      const merged = Object.entries(incomingCredits).reduce((acc, [d, v]) => {
        acc[d] = (acc[d] || 0) + (typeof v === "number" ? v : 0); return acc;
      }, { ...existingCredits });
      const trimmed = Object.fromEntries(Object.entries(merged).filter(([d]) => d >= cutoffStr));
      await pool.query(
        "UPDATE kiro_user SET user_ip = $1, credit_used = $2, updated_at = $3, plugin_added = $4 WHERE user_name = $5",
        [user_ip || existing.user_ip || "", JSON.stringify(trimmed), now, 1, user_name]
      );
      console.log(`[userManagement] Updated user (plugin): ${user_name}`);
    }
  }

  if (!_overwrite_credits && hostname) {
    await upsertPlugin(hostname, user_name, user_ip || "");
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

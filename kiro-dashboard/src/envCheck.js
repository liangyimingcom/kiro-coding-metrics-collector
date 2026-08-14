/**
 * 环境变量检查 — 启动时验证配置。
 *
 * 迁移说明（SQLite → RDS PostgreSQL）：
 *  - 新增「必须」组：数据库连接（DB_HOST 等，或单一 DATABASE_URL）。缺失则退出。
 *  - AWS 凭据改为「可选」：在 EC2 上用 实例角色(Instance Profile) 时不存在静态
 *    AWS_ACCESS_KEY_ID/SECRET，SDK 会自动走实例角色，因此不再强制要求。
 *  - IAM Identity Center / S3 / CloudTrail 相关变量改为「可选」：未配置时对应的
 *    用户同步 / credit 同步 / session 同步功能降级跳过，但核心的 stats 采集与
 *    dashboard 查询不受影响。
 */

// 必须：数据库连接（二选一：DATABASE_URL 或 DB_HOST+DB_NAME+DB_USER+DB_PASSWORD）
function checkDbEnv() {
  if (process.env.DATABASE_URL) return [];
  const required = [
    { name: "DB_HOST",     desc: "RDS PostgreSQL 终端节点地址" },
    { name: "DB_NAME",     desc: "数据库名（如 kiro）" },
    { name: "DB_USER",     desc: "数据库用户名" },
    { name: "DB_PASSWORD", desc: "数据库口令" },
  ];
  return required.filter((e) => !process.env[e.name]);
}

// 可选：AWS 集成（缺失则相应同步功能降级跳过）
const OPTIONAL_AWS_ENV = [
  { name: "AWS_REGION",        desc: "AWS 区域（默认 us-east-1）" },
  { name: "IDENTITY_STORE_ID", desc: "IAM Identity Center Identity Store ID（用户同步需要）" },
  { name: "KIRO_S3_BUCKET",    desc: "Kiro User Activity Report S3 桶（credit 同步需要）" },
  { name: "KIRO_S3_PREFIX",    desc: "S3 前缀（credit 同步需要）" },
  { name: "KIRO_ACCOUNT_ID",   desc: "AWS 账号 ID（credit 同步需要）" },
];

function checkEnv() {
  const missingDb = checkDbEnv();
  if (missingDb.length > 0) {
    console.error("\n[ERROR] 数据库连接环境变量未配置（必须）:\n");
    for (const e of missingDb) {
      console.error(`  ${e.name}  — ${e.desc}`);
    }
    console.error("\n示例:");
    console.error("  export DB_HOST=kiro-metrics-pg.xxxx.us-east-1.rds.amazonaws.com");
    console.error("  export DB_PORT=5432");
    console.error("  export DB_NAME=kiro");
    console.error("  export DB_USER=kiroadmin");
    console.error("  export DB_PASSWORD=********");
    console.error("  export DB_SSL=require            # RDS 建议开启 TLS");
    console.error("  # 或单一: export DATABASE_URL=postgres://user:pass@host:5432/kiro\n");
    process.exit(1);
  }

  console.log("[env] Database connection variables OK:");
  if (process.env.DATABASE_URL) {
    console.log("  DATABASE_URL=*** (set)");
  } else {
    console.log(`  DB_HOST=${process.env.DB_HOST}`);
    console.log(`  DB_PORT=${process.env.DB_PORT || "5432"}`);
    console.log(`  DB_NAME=${process.env.DB_NAME}`);
    console.log(`  DB_USER=${process.env.DB_USER}`);
    console.log(`  DB_PASSWORD=${(process.env.DB_PASSWORD || "").slice(0, 2)}****`);
    console.log(`  DB_SSL=${process.env.DB_SSL || "(off)"}`);
  }

  // 可选 AWS 集成：仅告警，不退出
  const missingAws = OPTIONAL_AWS_ENV.filter((e) => !process.env[e.name]);
  if (missingAws.length > 0) {
    console.warn("\n[warn] 以下 AWS 集成变量未配置，对应同步功能将降级跳过（不影响核心采集/查询）:");
    for (const e of missingAws) {
      console.warn(`  ${e.name}  — ${e.desc}`);
    }
  }
  if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_SECRET_ACCESS_KEY) {
    console.log("[env] 未检测到静态 AWS 凭据 — 将使用 EC2 实例角色 / 默认凭据链。");
  }
  console.log("");
}

module.exports = { checkEnv };

/**
 * Main entry — 加载 .env → 环境变量检查 → 初始化 RDS PostgreSQL schema
 *              → 启动 ingest + dashboard → 按需启动 S3 credit sync / CloudTrail session sync
 *
 * 迁移说明：
 *  - 启动时先 await store.ensureReady() 完成 PostgreSQL 建表/迁移/回填，再开始监听，
 *    避免首个请求遇到「表不存在」。
 *  - credit/session 同步依赖 AWS 集成变量；缺失时跳过启动，核心采集/查询照常工作。
 */
const { loadEnv } = require("./loadEnv");
loadEnv(); // 优先读取工作目录下的 .env，已有环境变量不会被覆盖

const { checkEnv } = require("./envCheck");
checkEnv();

const store = require("./store");

async function main() {
  // 先确保数据库 schema 就绪（建表 + 迁移 + 回填）
  await store.ensureReady();

  // 启动 HTTP 服务
  require("./ingest");
  require("./dashboard");

  // S3 credit 同步：需要 S3 桶 / 账号 / 前缀 / Identity Store
  if (process.env.KIRO_S3_BUCKET && process.env.KIRO_ACCOUNT_ID && process.env.IDENTITY_STORE_ID) {
    const { startCreditSync } = require("./creditSync");
    startCreditSync();
  } else {
    console.log("[main] Skip credit sync (KIRO_S3_BUCKET / KIRO_ACCOUNT_ID / IDENTITY_STORE_ID 未全部配置)");
  }

  // CloudTrail session 同步：需要 Identity Store（用于 user 关联）+ CloudTrail 读取权限
  if (process.env.IDENTITY_STORE_ID) {
    const { startSessionSync } = require("./sessionSync");
    startSessionSync();
  } else {
    console.log("[main] Skip session sync (IDENTITY_STORE_ID 未配置)");
  }
}

main().catch((err) => {
  console.error("[main] Fatal startup error:", err);
  process.exit(1);
});

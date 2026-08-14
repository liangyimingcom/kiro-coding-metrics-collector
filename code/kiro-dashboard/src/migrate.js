#!/usr/bin/env node

/**
 * Migration script: reads existing JSON files from data/ directory
 * and imports them into the RDS PostgreSQL database via saveStats().
 *
 * Usage: node src/migrate.js
 *
 * - Skips .idempotency/ directory and stats.db* files
 * - Uses commit_sha for deduplication (won't import duplicates)
 * - Logs progress: files found, imported, skipped, errors
 *
 * 迁移说明：原版用 better-sqlite3 直接查 commits 去重；现改为通过 store.query()
 * 异步查询 PostgreSQL。store 会在首次调用时自动建表（ensureReady）。
 */

const fs = require("node:fs");
const path = require("node:path");
const { loadEnv } = require("./loadEnv");
loadEnv();
const store = require("./store");

const DATA_DIR = path.resolve(__dirname, "..", "data");

/**
 * Recursively find all .json files under a directory,
 * skipping .idempotency/ and stats.db related files.
 */
function findJsonFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`  [warn] Cannot read directory ${dir}: ${err.message}`);
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === ".idempotency") continue;
      results.push(...findJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      if (entry.name.startsWith("stats.db")) continue;
      results.push(fullPath);
    }
  }

  return results;
}

async function commitExists(commitSha) {
  const r = await store.query("SELECT 1 FROM commits WHERE commit_sha = $1 LIMIT 1", [commitSha]);
  return r.rowCount > 0;
}

async function migrate() {
  console.log(`Migration: scanning ${DATA_DIR} for JSON files...`);
  await store.ensureReady();

  const jsonFiles = findJsonFiles(DATA_DIR);
  console.log(`Found ${jsonFiles.length} JSON file(s).`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const filePath of jsonFiles) {
    const relPath = path.relative(DATA_DIR, filePath);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const payload = JSON.parse(raw);

      if (!payload.commit_sha) {
        console.warn(`  [skip] ${relPath}: missing commit_sha`);
        skipped++;
        continue;
      }

      if (await commitExists(payload.commit_sha)) {
        skipped++;
        continue;
      }

      await store.saveStats(payload);
      imported++;
    } catch (err) {
      console.error(`  [error] ${relPath}: ${err.message}`);
      errors++;
    }
  }

  console.log(
    `\nMigration complete: ${imported} imported, ${skipped} skipped (duplicates), ${errors} error(s).`
  );
}

migrate()
  .then(() => store.pool.end())
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });

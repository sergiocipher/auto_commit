import { randomBytes } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { inject } from "vitest";
import { buildProblemSlug, sha256Hex, type SubmissionEvent } from "@cst/shared";
import { createPool, Db } from "../src/db/db.js";
import { loadMigrations, migrate } from "../src/db/migrate.js";
import { ensureUser } from "../src/db/repos.js";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");
export const DATABASE_URL = inject("databaseUrl");
export const REDIS_URL = inject("redisUrl");
/** Integration suites use describe.skipIf(SKIP) and print this reason. */
export const SKIP = !DATABASE_URL || !REDIS_URL;
if (SKIP) console.warn(`backend integration tests skipped: ${inject("servicesSkipReason")}`);

/** A new, empty database on the test server, optionally migrated. */
export async function freshDatabase(opts: { migrated?: boolean } = { migrated: true }) {
  const admin = new pg.Client({ connectionString: DATABASE_URL! });
  await admin.connect();
  const name = `t_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(DATABASE_URL!);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), 25);
  const db = new Db(pool);
  if (opts.migrated !== false) {
    await migrate(pool, await loadMigrations(MIGRATIONS_DIR));
    await ensureUser(db);
  }
  return {
    url: url.toString(),
    pool,
    db,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: DATABASE_URL! });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export const T0 = Date.parse("2024-03-10T10:00:00Z");
export const HOUR = 3_600_000;

/** An accepted LeetCode event whose source has CRLF, tabs, trailing spaces and unicode. */
export async function makeEvent(
  overrides: Partial<SubmissionEvent> = {},
): Promise<SubmissionEvent> {
  const sourceCode =
    overrides.sourceCode ??
    "class Solution {\r\npublic:\n\tint f() { return 1; }  \n};\n// ünïcödé ✓\n";
  const platform = overrides.platform ?? "leetcode";
  const problemKey = overrides.problemKey ?? "two-sum";
  const problemTitle = overrides.problemTitle ?? "Two Sum";
  return {
    platform,
    problemKey,
    problemSlug: overrides.problemSlug ?? buildProblemSlug(platform, problemKey, problemTitle),
    problemTitle,
    problemUrl: overrides.problemUrl ?? "https://leetcode.com/problems/two-sum/",
    submissionId: "1001",
    language: "cpp",
    verdict: "ACCEPTED",
    submittedAt: T0,
    detectedAt: T0 + 1000,
    ...overrides,
    sourceCode,
    sourceSha256: overrides.sourceSha256 ?? (await sha256Hex(sourceCode)),
  };
}

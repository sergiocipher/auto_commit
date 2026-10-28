import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

export interface Migration {
  version: string;
  sql: string;
}

/** Arbitrary constant: serializes migration runs from the api and worker starting together. */
const MIGRATION_LOCK = 4_262_026;

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (f) => ({
      version: f.replace(/\.sql$/, ""),
      sql: await readFile(join(dir, f), "utf8"),
    })),
  );
}

const checksum = (sql: string) => createHash("sha256").update(sql).digest("hex");

/**
 * Applies pending migrations in order, each in its own transaction.
 * Forward-only: an applied migration whose file changed is an error, never
 * re-run. Safe to call concurrently (session advisory lock) and repeatedly.
 * Returns the versions applied by this call.
 */
export async function migrate(pool: Pool, migrations: Migration[]): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const done: string[] = [];
    for (const m of migrations) {
      const sum = checksum(m.sql);
      const existing = applied.get(m.version);
      if (existing !== undefined) {
        if (existing !== sum)
          throw new Error(`migration ${m.version} was modified after it was applied`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
          m.version,
          sum,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      done.push(m.version);
    }
    return done;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}

/** True when every known migration is applied (used by /readyz). */
export async function migrationsApplied(pool: Pool, migrations: Migration[]): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));
    return migrations.every((m) => applied.has(m.version));
  } catch {
    return false;
  }
}

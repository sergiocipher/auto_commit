import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { GitHubSession, type HttpFetch } from "@cst/core";
import type { Config } from "./config.js";
import { Cipher } from "./crypto.js";
import { createPool, Db } from "./db/db.js";
import { PgJobStore } from "./db/jobStore.js";
import { loadMigrations, migrate, migrationsApplied, type Migration } from "./db/migrate.js";
import { ensureUser, InstallsRepo, PgSessionStore, SettingsRepo } from "./db/repos.js";
import { timedFetch } from "./http/fetch.js";
import type { Logger } from "./logger.js";
import { createQueue, enqueue, redisConnection } from "./queue.js";

/** Migrations ship next to the bundle (dist/../migrations) and the sources (src/../migrations). */
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? join(import.meta.dirname, "..", "migrations");

export const httpFetch: HttpFetch = timedFetch();

/** Everything the api and worker processes share, built from the config. */
export async function createServices(config: Config, log: Logger) {
  const pool = createPool(config.databaseUrl, {
    onIdleError: (err) => log.warn("idle database connection closed; will reconnect", { err }),
  });
  const db = new Db(pool);
  const cipher = new Cipher(config.encryptionKeys, config.currentKeyId);
  const store = new PgJobStore(db);
  const settings = new SettingsRepo(db);
  const installs = new InstallsRepo(db);
  const redis = redisConnection(config.redisUrl);
  const queue = createQueue(redis);
  const migrations: Migration[] = await loadMigrations(MIGRATIONS_DIR);
  const now = () => Date.now();

  const sessions = new Map<string, GitHubSession>();
  const session = (userId: string) => {
    let s = sessions.get(userId);
    if (!s) {
      s = new GitHubSession(
        new PgSessionStore(db, cipher, userId),
        httpFetch,
        config.githubClientId,
        now,
      );
      sessions.set(userId, s);
    }
    return s;
  };

  /**
   * Token for uploads. A token that no longer decrypts (APP_ENCRYPTION_KEY
   * changed without listing the old key) counts as "not connected", so jobs
   * wait in NEEDS_AUTH until the user reconnects.
   */
  const getToken = async (userId: string) => {
    try {
      return await session(userId).getToken();
    } catch (err) {
      log.warn("stored GitHub token cannot be decrypted; reconnect GitHub", { userId, err });
      return undefined;
    }
  };

  return {
    config,
    log,
    pool,
    db,
    store,
    settings,
    installs,
    redis,
    queue,
    migrations,
    now,
    session,
    getToken,
    newId: () => randomUUID(),
    enqueue: (job: Parameters<typeof enqueue>[1]) => enqueue(queue, job, now()),
    async migrate() {
      const applied = await migrate(pool, migrations);
      await ensureUser(db);
      return applied;
    },
    async readiness() {
      const [postgres, redisOk, migrated] = await Promise.all([
        pool.query("SELECT 1").then(
          () => true,
          () => false,
        ),
        redis.ping().then(
          (r) => r === "PONG",
          () => false,
        ),
        migrationsApplied(pool, migrations),
      ]);
      return { postgres, redis: redisOk, migrations: migrated };
    },
    async close() {
      await queue.close().catch(() => undefined);
      redis.disconnect();
      await pool.end().catch(() => undefined);
    },
  };
}

export type Services = Awaited<ReturnType<typeof createServices>>;

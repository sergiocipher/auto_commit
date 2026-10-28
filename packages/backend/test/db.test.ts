import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestSubmission, requeueJob } from "@cst/core";
import { DEFAULT_SETTINGS } from "@cst/shared";
import { Cipher, hashSecret } from "../src/crypto.js";
import { loadMigrations, migrate, migrationsApplied } from "../src/db/migrate.js";
import { PgJobStore } from "../src/db/jobStore.js";
import {
  DEFAULT_USER_ID,
  ensureUser,
  InstallsRepo,
  PAIRING_CODE_TTL_MS,
  PgSessionStore,
  SettingsRepo,
} from "../src/db/repos.js";
import { freshDatabase, HOUR, makeEvent, MIGRATIONS_DIR, SKIP, T0 } from "./services.js";

type Fresh = Awaited<ReturnType<typeof freshDatabase>>;
const U = DEFAULT_USER_ID;
let ids = 0;
const newId = () => `job-${++ids}-${randomBytes(3).toString("hex")}`;
const opts = (now = T0, extra: object = {}) => ({
  userId: U,
  settings: { period: { kind: "calendar_day" as const }, timezone: "UTC" },
  now,
  newId,
  ...extra,
});

describe.skipIf(SKIP)("migrations", () => {
  it("apply to an empty database once, concurrently and idempotently", async () => {
    const f = await freshDatabase({ migrated: false });
    try {
      const migrations = await loadMigrations(MIGRATIONS_DIR);
      expect(migrations.map((m) => m.version)).toContain("001_initial");
      expect(await migrationsApplied(f.pool, migrations)).toBe(false);
      const [a, b] = await Promise.all([migrate(f.pool, migrations), migrate(f.pool, migrations)]);
      expect([...a, ...b]).toEqual(migrations.map((m) => m.version)); // applied exactly once
      expect(await migrate(f.pool, migrations)).toEqual([]);
      expect(await migrationsApplied(f.pool, migrations)).toBe(true);
    } finally {
      await f.drop();
    }
  });

  it("refuse an applied migration whose file changed", async () => {
    const f = await freshDatabase();
    try {
      const migrations = await loadMigrations(MIGRATIONS_DIR);
      const edited = migrations.map((m) => ({ ...m, sql: m.sql + "\n-- edited" }));
      await expect(migrate(f.pool, edited)).rejects.toThrow(/modified after it was applied/);
    } finally {
      await f.drop();
    }
  });

  it("roll back a failing migration completely", async () => {
    const f = await freshDatabase();
    try {
      const bad = [
        { version: "999_bad", sql: "CREATE TABLE half (id int); SELECT broken_call();" },
      ];
      await expect(migrate(f.pool, bad)).rejects.toThrow();
      const { rows } = await f.pool.query("SELECT to_regclass('half') AS t");
      expect(rows[0].t).toBeNull();
      expect(await migrationsApplied(f.pool, bad)).toBe(false);
    } finally {
      await f.drop();
    }
  });
});

describe.skipIf(SKIP)("PgJobStore", () => {
  let f: Fresh;
  let store: PgJobStore;
  beforeAll(async () => {
    f = await freshDatabase();
    store = new PgJobStore(f.db);
  });
  afterAll(() => f?.drop());

  it("round-trips a job and its source byte for byte", async () => {
    const event = await makeEvent({
      submissionId: "rt-1",
      problemKey: "rt",
      contest: { id: "weekly-1", kind: "contest" },
    });
    const { job } = await ingestSubmission(store, event, opts());
    const loaded = await store.get(job.id);
    expect(loaded).toEqual(job);
    expect(loaded!.event!.sourceCode).toBe(event.sourceCode);
    expect(loaded!.reservationBucket).toBe("day:2024-03-10");
  });

  it("returns the existing record for a repeated submission", async () => {
    const event = await makeEvent({ submissionId: "idem-1", problemKey: "idem" });
    const a = await ingestSubmission(store, event, opts());
    const b = await ingestSubmission(store, event, opts());
    expect(b.decision).toBe("existing");
    expect(b.job.id).toBe(a.job.id);
    await expect(store.insert({ ...a.job, id: newId() })).rejects.toThrow(/duplicate key/);
  });

  it("skips within the window and uploads in the next one", async () => {
    const first = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "w-1", problemKey: "w" }),
      opts(),
    );
    await store.update({
      ...first.job,
      status: "SUCCESS",
      event: undefined,
      reservationBucket: undefined,
    });
    const again = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "w-2", problemKey: "w", submittedAt: T0 + HOUR }),
      opts(),
    );
    expect(again.decision).toBe("skipped");
    const next = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "w-3", problemKey: "w", submittedAt: T0 + 24 * HOUR }),
      opts(),
    );
    expect(next.decision).toBe("queued");
  });

  it("creates exactly one job for 20 concurrent identical events", async () => {
    const event = await makeEvent({ submissionId: "race-1", problemKey: "race" });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => ingestSubmission(store, event, opts())),
    );
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => r.decision === "queued")).toHaveLength(1);
    expect(await store.listByProblem(U, "leetcode", "race")).toHaveLength(1);
  });

  it("queues exactly one of 20 concurrent different submissions of one problem", async () => {
    const events = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        makeEvent({ submissionId: `race2-${i}`, problemKey: "race2" }),
      ),
    );
    const results = await Promise.all(events.map((e) => ingestSubmission(store, e, opts())));
    expect(results.filter((r) => r.decision === "queued")).toHaveLength(1);
    expect(results.filter((r) => r.decision === "skipped")).toHaveLength(19);
  });

  it("enforces one reservation per bucket even without the lock", async () => {
    const { job } = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "res-1", problemKey: "res" }),
      opts(),
    );
    const sneaky = await makeEvent({ submissionId: "res-2", problemKey: "res" });
    await expect(
      store.insert({ ...job, id: newId(), submissionId: "res-2", event: sneaky }),
    ).rejects.toThrow(/upload_jobs_one_reservation/);
    // A held job does not reserve, so it can coexist.
    await store.insert({
      ...job,
      id: newId(),
      submissionId: "res-3",
      status: "HELD",
      reservationBucket: undefined,
      event: await makeEvent({ submissionId: "res-3", problemKey: "res" }),
    });
  });

  it("purges source on update and keeps the record", async () => {
    const { job } = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "purge-1", problemKey: "purge" }),
      opts(),
    );
    await store.update({ ...job, status: "SUCCESS", commitSha: "a".repeat(40), event: undefined });
    const loaded = await store.get(job.id);
    expect(loaded!.event).toBeUndefined();
    expect(loaded!.commitSha).toBe("a".repeat(40));
    const { rows } = await f.pool.query("SELECT source_code FROM upload_jobs WHERE id = $1", [
      job.id,
    ]);
    expect(rows[0].source_code).toBeNull();
  });

  it("requeues through the same lock and lists active jobs", async () => {
    const { job } = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "rq-1", problemKey: "rq" }),
      opts(T0, { hold: true }),
    );
    expect(job.status).toBe("HELD");
    const next = await requeueJob(store, job, opts(T0 + 1));
    expect(next.status).toBe("QUEUED");
    expect((await store.listActive()).map((j) => j.id)).toContain(job.id);
  });

  it("lists newest first, counts successes and deletes a user's data", async () => {
    const list = await store.listForUser(U, 500);
    expect(list.length).toBeGreaterThan(5);
    expect(list.map((j) => j.createdAt)).toEqual(
      [...list.map((j) => j.createdAt)].sort((a, b) => b - a),
    );
    expect(await store.countSuccess(U)).toBe(2);
    await store.deleteAllForUser(U);
    expect(await store.listForUser(U)).toEqual([]);
  });
});

describe.skipIf(SKIP)("repositories", () => {
  let f: Fresh;
  beforeAll(async () => {
    f = await freshDatabase();
  });
  afterAll(() => f?.drop());

  it("stores settings validated, with defaults when absent", async () => {
    const repo = new SettingsRepo(f.db);
    expect(await repo.get(U)).toEqual(DEFAULT_SETTINGS);
    const s = {
      ...DEFAULT_SETTINGS,
      timezone: "Asia/Kolkata",
      period: { kind: "permanent" as const },
    };
    await repo.set(U, s);
    expect(await repo.get(U)).toEqual(s);
    await expect(repo.set(U, { ...s, timezone: "Mars/Base" })).rejects.toThrow();
  });

  it("keeps the GitHub token encrypted at rest and bound to its user", async () => {
    const keys = new Map([["k1", randomBytes(32)]]);
    const cipher = new Cipher(keys, "k1");
    const token = ["gho", "x".repeat(36)].join("_");
    const store = new PgSessionStore(f.db, cipher, U);
    await store.setConnection({ token, scopes: ["repo"], login: "octo", connectedAt: T0 });
    expect(await store.getConnection()).toEqual({
      token,
      scopes: ["repo"],
      login: "octo",
      connectedAt: T0,
    });
    const dump = JSON.stringify((await f.pool.query("SELECT * FROM github_connections")).rows);
    expect(dump).not.toContain(token);

    // The same ciphertext under another user id must not decrypt.
    await ensureUser(f.db, "other");
    await f.pool.query(
      `INSERT INTO github_connections (user_id, key_id, token_ciphertext, scopes, login, connected_at)
       SELECT 'other', key_id, token_ciphertext, scopes, login, connected_at FROM github_connections WHERE user_id = $1`,
      [U],
    );
    await expect(new PgSessionStore(f.db, cipher, "other").getConnection()).rejects.toThrow();

    await store.setPending({
      deviceCode: "device-secret",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresAt: T0 + 900_000,
      intervalSec: 5,
      nextPollAt: T0 + 5000,
    });
    expect((await store.getPending())?.deviceCode).toBe("device-secret");
    expect(
      JSON.stringify((await f.pool.query("SELECT * FROM github_device_pending")).rows),
    ).not.toContain("device-secret");
    await store.clearConnection();
    await store.clearPending();
    expect(await store.getConnection()).toBeUndefined();
    expect(await store.getPending()).toBeUndefined();
  });

  it("redeems a pairing code once, before expiry, and stores only hashes", async () => {
    const repo = new InstallsRepo(f.db);
    const { code } = await repo.createPairingCode(U, T0);
    const paired = await repo.redeem(code, "Chrome", T0 + 1000);
    expect(paired?.token).toBeTruthy();
    expect(await repo.redeem(code, "Chrome", T0 + 2000)).toBeNull(); // one-time
    expect(await repo.authenticate(paired!.token)).toEqual(paired!.install);
    expect(await repo.authenticate(paired!.token + "x")).toBeNull();
    const dump = JSON.stringify((await f.pool.query("SELECT * FROM installs, pairing_codes")).rows);
    expect(dump).not.toContain(paired!.token);
    expect(dump).not.toContain(code);
    expect(dump).toContain(hashSecret(paired!.token));

    const late = await repo.createPairingCode(U, T0);
    expect(await repo.redeem(late.code, "Chrome", T0 + PAIRING_CODE_TTL_MS + 1)).toBeNull();

    await repo.revoke(paired!.install.id);
    expect(await repo.authenticate(paired!.token)).toBeNull();
  });
});

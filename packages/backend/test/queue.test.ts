import { randomBytes, randomUUID } from "node:crypto";
import type { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ingestSubmission, type UploadJob } from "@cst/core";
import { FakeGitHub, FAKE_TOKEN } from "@cst/core/testing";
import { DEFAULT_SETTINGS, type SubmissionEvent } from "@cst/shared";
import { PgJobStore } from "../src/db/jobStore.js";
import { DEFAULT_USER_ID as U, SettingsRepo } from "../src/db/repos.js";
import { createLogger } from "../src/logger.js";
import { bullJobId, createQueue, enqueue, redisConnection } from "../src/queue.js";
import { reconcile } from "../src/reconciler.js";
import { createUploadWorker, runUpload, type UploadRunnerDeps } from "../src/worker.js";
import { freshDatabase, makeEvent, REDIS_URL, SKIP } from "./services.js";

const SETTINGS = {
  ...DEFAULT_SETTINGS,
  repo: { owner: "octo", name: "solutions", branch: "main" },
};

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(SKIP)("upload queue and worker", () => {
  let f: Awaited<ReturnType<typeof freshDatabase>>;
  let store: PgJobStore;
  let gh: FakeGitHub;
  let token: string | undefined;
  let deps: UploadRunnerDeps;
  const prefix = `t${randomBytes(4).toString("hex")}`;
  const connections: Redis[] = [];
  const conn = () => {
    const c = redisConnection(REDIS_URL!);
    connections.push(c);
    return c;
  };
  const queue = () => createQueue(conn(), prefix);
  let q: ReturnType<typeof createQueue>;
  let worker: Worker | undefined;
  let seq = 0;

  beforeAll(async () => {
    f = await freshDatabase();
    store = new PgJobStore(f.db);
    await new SettingsRepo(f.db).set(U, SETTINGS);
    q = queue();
  });
  afterAll(async () => {
    await worker?.close();
    await q?.obliterate({ force: true }).catch(() => undefined);
    await q?.close();
    for (const c of connections) c.disconnect();
    await f?.drop();
  });

  beforeEach(async () => {
    gh = new FakeGitHub();
    token = FAKE_TOKEN;
    deps = {
      store,
      settings: new SettingsRepo(f.db),
      getToken: async () => token,
      fetch: (url, init) => gh.fetch(url, init),
      now: Date.now,
      maxAttempts: 6,
      purgeSourceOnSuccess: true,
      log: createLogger("error", () => undefined),
      random: () => 0, // shortest backoff: 5 s
    };
  });

  const startWorker = () => {
    worker = createUploadWorker(conn(), deps, { prefix });
    return worker;
  };
  const stopWorker = async () => {
    await worker?.close();
    worker = undefined;
  };

  async function submit(overrides: Partial<SubmissionEvent> = {}, enqueueIt = true) {
    seq++;
    const event = await makeEvent({
      submissionId: `q-${seq}`,
      problemKey: `p-${seq}`,
      ...overrides,
    });
    const { job } = await ingestSubmission(store, event, {
      userId: U,
      settings: SETTINGS,
      now: Date.now(),
      newId: randomUUID,
    });
    if (enqueueIt) await enqueue(q, job, Date.now());
    return { job, event };
  }
  const statusOf = (id: string) => store.get(id).then((j) => j!);
  const until = (id: string, status: UploadJob["status"]) =>
    waitFor(
      () => statusOf(id),
      (j) => j.status === status,
    );

  it("uploads a queued job and removes it from the queue", async () => {
    startWorker();
    const { job, event } = await submit();
    const done = await until(job.id, "SUCCESS");
    expect(done.event).toBeUndefined(); // source purged
    expect(gh.readFile(done.filePath!)).toBe(event.sourceCode);
    expect(gh.log()[0]).toBe("feat(solutions): add LeetCode - Two Sum (C++)");
    expect(await q.getJob(bullJobId(job))).toBeUndefined();
    await stopWorker();
  });

  it("collapses duplicate enqueues of one submission into one queue job", async () => {
    const { job } = await submit({}, false);
    await Promise.all(Array.from({ length: 10 }, () => enqueue(q, job, Date.now())));
    const counts = await q.getJobCounts("waiting", "delayed", "active");
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
    startWorker();
    await until(job.id, "SUCCESS");
    expect(gh.log()).toHaveLength(2); // initial + one upload
    await stopWorker();
  });

  it("retries a 5xx with backoff on the same queue job, without a duplicate commit", async () => {
    startWorker();
    gh.failNext({}, 502);
    const { job } = await submit();
    const retrying = await until(job.id, "RETRYING");
    expect(retrying.attempts).toBe(1);
    expect(retrying.nextAttemptAt! - Date.now()).toBeGreaterThan(3_000);
    const bj = await q.getJob(bullJobId(job));
    expect(await bj!.getState()).toBe("delayed");
    await bj!.promote(); // skip the wait
    await until(job.id, "SUCCESS");
    expect(gh.log()).toHaveLength(2);
    await stopWorker();
  });

  it("waits out a 429 without burning an attempt", async () => {
    startWorker();
    gh.failNext({}, 429, { headers: { "retry-after": "1" } });
    const { job } = await submit();
    const limited = await until(job.id, "RETRYING");
    expect(limited.attempts).toBe(0);
    await until(job.id, "SUCCESS");
    await stopWorker();
  });

  it("stops at NEEDS_AUTH on a bad token and leaves nothing queued", async () => {
    startWorker();
    token = "bad-token-value";
    const { job } = await submit();
    const stuck = await until(job.id, "NEEDS_AUTH");
    expect(stuck.event).toBeDefined(); // kept for after reconnect
    expect(JSON.stringify(stuck)).not.toContain("bad-token-value");
    await waitFor(
      () => q.getJob(bullJobId(job)),
      (j) => j === undefined,
    );
    await stopWorker();
  });

  it("recovers jobs after Redis loses its data and after a crash mid-upload", async () => {
    await stopWorker();
    const lost = await submit();
    const crashed = await submit({}, false);
    // Worker died after claiming: row UPLOADING, no queue job.
    await store.update({ ...crashed.job, status: "UPLOADING" });
    await q.obliterate({ force: true }); // Redis data loss
    expect(await q.getJob(bullJobId(lost.job))).toBeUndefined();

    const log = createLogger("error", () => undefined);
    expect(await reconcile(store, q, Date.now(), log)).toBe(2);
    expect(await reconcile(store, q, Date.now(), log)).toBe(0); // now live: nothing to do
    startWorker();
    await until(lost.job.id, "SUCCESS");
    await until(crashed.job.id, "SUCCESS");
    expect(gh.log()).toHaveLength(3); // exactly one commit each
    await stopWorker();
  });

  it("re-claims an UPLOADING row on re-delivery and ignores finished or early rows", async () => {
    const { job } = await submit({}, false);
    await store.update({ ...job, status: "UPLOADING" });
    expect((await runUpload(job.id, deps)).kind).toBe("done");
    expect((await statusOf(job.id)).status).toBe("SUCCESS");
    expect(await runUpload(job.id, deps)).toEqual({ kind: "skipped", reason: "status is SUCCESS" });

    const early = await submit({}, false);
    await store.update({ ...early.job, nextAttemptAt: Date.now() + 60_000 });
    expect((await runUpload(early.job.id, deps)).kind).toBe("later");
    expect(await runUpload("missing", deps)).toMatchObject({ kind: "skipped" });
  });

  it("finishes the active upload before a graceful shutdown completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = deps.fetch;
    deps.fetch = async (url, init) => {
      if (init?.method === "PATCH") await gate;
      return slow(url, init);
    };
    startWorker();
    const { job } = await submit();
    await until(job.id, "UPLOADING");
    const closing = worker!.close();
    setTimeout(release, 200);
    await closing;
    worker = undefined;
    expect((await statusOf(job.id)).status).toBe("SUCCESS");
  });
});

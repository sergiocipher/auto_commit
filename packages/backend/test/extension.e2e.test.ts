import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubSession, type HttpFetch } from "@cst/core";
import { FakeGitHub, FAKE_TOKEN } from "@cst/core/testing";
import { DEFAULT_SETTINGS } from "@cst/shared";
// The real extension delivery path (outbox -> backend sink -> HTTP).
import { ActivityLog } from "../../extension/src/background/activity.js";
import {
  BackendClient,
  BackendConfigStore,
  BackendSink,
  pairBackend,
} from "../../extension/src/background/backend.js";
import { Outbox } from "../../extension/src/background/outbox.js";
import { createApp } from "../src/app.js";
import { Cipher } from "../src/crypto.js";
import { PgJobStore } from "../src/db/jobStore.js";
import {
  DEFAULT_USER_ID as U,
  InstallsRepo,
  PgSessionStore,
  SettingsRepo,
} from "../src/db/repos.js";
import { createLogger } from "../src/logger.js";
import { createQueue, enqueue, redisConnection } from "../src/queue.js";
import { createUploadWorker } from "../src/worker.js";
import { freshDatabase, makeEvent, REDIS_URL, SKIP } from "./services.js";

class MemoryStore {
  readonly data = new Map<string, unknown>();
  async get(key: string) {
    const v = this.data.get(key);
    return v === undefined ? undefined : structuredClone(v);
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async remove(key: string) {
    this.data.delete(key);
  }
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(SKIP)("extension backend mode end to end", () => {
  let f: Awaited<ReturnType<typeof freshDatabase>>;
  let server: Server;
  let base: string;
  let worker: Worker;
  const redis: Redis[] = [];
  const prefix = `e${randomBytes(4).toString("hex")}`;
  const gh = new FakeGitHub();
  let backendUp = true;
  // The extension's fetch reaches our test server; "down" simulates a stopped stack.
  const extFetch: HttpFetch = async (url, init) => {
    if (!backendUp) throw new TypeError("Failed to fetch");
    return globalThis.fetch(url, init) as unknown as ReturnType<HttpFetch>;
  };
  const browser = new MemoryStore();
  const configs = new BackendConfigStore(browser);
  const activity = new ActivityLog(browser);
  const outbox = new Outbox(browser);
  const sink = new BackendSink(
    new BackendClient(extFetch, () => configs.get()),
    activity,
    Date.now,
  );
  let queue: ReturnType<typeof createQueue>;
  let store: PgJobStore;

  beforeAll(async () => {
    f = await freshDatabase();
    store = new PgJobStore(f.db);
    const settings = new SettingsRepo(f.db);
    const cipher = new Cipher(new Map([["k1", randomBytes(32)]]), "k1");
    const sessionStore = new PgSessionStore(f.db, cipher, U);
    // Pretend the user already connected GitHub through the backend.
    await sessionStore.setConnection({
      token: FAKE_TOKEN,
      scopes: ["repo"],
      login: "octo",
      connectedAt: 0,
    });
    const session = new GitHubSession(sessionStore, gh.fetch, "Ov23test", Date.now);
    const log = createLogger("error", () => undefined);
    const conn = () => {
      const c = redisConnection(REDIS_URL!);
      redis.push(c);
      return c;
    };
    queue = createQueue(conn(), prefix);
    const app = createApp({
      store,
      settings,
      installs: new InstallsRepo(f.db),
      session: () => session,
      enqueue: (job) => enqueue(queue, job, Date.now()),
      readiness: async () => ({ postgres: true, redis: true, migrations: true }),
      extensionOrigin: `chrome-extension://${"c".repeat(32)}`,
      fetch: gh.fetch,
      now: Date.now,
      newId: randomUUID,
      log,
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    worker = createUploadWorker(
      conn(),
      {
        store,
        settings,
        getToken: () => session.getToken(),
        fetch: gh.fetch,
        now: Date.now,
        maxAttempts: 6,
        purgeSourceOnSuccess: true,
        log,
      },
      { prefix },
    );
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    for (const c of redis) c.disconnect();
    await new Promise((r) => server?.close(r));
    await f?.drop();
  });

  it("pairs with a one-time code and pushes settings", async () => {
    const { code } = await new InstallsRepo(f.db).createPairingCode(U, Date.now());
    const config = await pairBackend(extFetch, configs, { url: base, code });
    expect(config.url).toBe(base);
    await sink.pushSettings({
      ...DEFAULT_SETTINGS,
      repo: { owner: "octo", name: "solutions", branch: "main" },
    });
    expect((await new SettingsRepo(f.db).get(U)).repo.name).toBe("solutions");
  });

  it("delivers an accepted submission that the backend worker uploads", async () => {
    const event = await makeEvent({ submissionId: "e2e-1" });
    await outbox.enqueue(event, Date.now());
    await activity.recordQueued(event, Date.now());
    const reports = await outbox.drain(sink.deliver, Date.now);
    expect(reports[0]!.result).toEqual({ kind: "accepted", status: "QUEUED" });
    for (const r of reports) await activity.recordDelivery(r, Date.now());
    expect(await outbox.list()).toEqual([]);

    const { history } = await waitFor(
      () => sink.refresh(),
      (r) => r.history.uploads[0]?.status === "SUCCESS",
    );
    expect(history.uploadedCount).toBe(1);
    expect(gh.readFile(history.uploads[0]!.filePath!)).toBe(event.sourceCode);
    // The popup's activity entry now says SUCCESS, reported by the backend.
    expect((await activity.list())[0]).toMatchObject({ key: "leetcode:e2e-1", status: "SUCCESS" });
  });

  it("keeps submissions in the outbox while the backend is down, then delivers them", async () => {
    backendUp = false;
    const event = await makeEvent({
      submissionId: "e2e-2",
      problemKey: "down",
      problemTitle: "Down",
    });
    await outbox.enqueue(event, Date.now());
    const first = await outbox.drain(sink.deliver, Date.now);
    expect(first[0]!.result.kind).toBe("retry");
    expect(await outbox.list()).toHaveLength(1);

    backendUp = true;
    await outbox.retryNow(Date.now());
    const second = await outbox.drain(sink.deliver, Date.now);
    expect(second[0]!.result).toEqual({ kind: "accepted", status: "QUEUED" });
    await waitFor(
      () => store.findBySubmission("leetcode", "e2e-2"),
      (j) => j?.status === "SUCCESS",
    );
  });

  it("skips a repeat in the period and force-uploads it through the backend", async () => {
    const event = await makeEvent({ submissionId: "e2e-3", sourceCode: "print('again')\n" });
    await outbox.enqueue(event, Date.now());
    const [report] = await outbox.drain(sink.deliver, Date.now);
    expect(report!.result).toMatchObject({ kind: "accepted", status: "SKIPPED_NOT_ELIGIBLE" });
    expect((await sink.uploads.retry("leetcode", "e2e-3", { force: true }))?.status).toBe("QUEUED");
    const done = await waitFor(
      () => store.findBySubmission("leetcode", "e2e-3"),
      (j) => j?.status === "SUCCESS",
    );
    expect(done!.filePath).toBe("data/leetcode/two-sum/solution-e2e-3.cpp");
    expect(gh.log()).toHaveLength(4); // initial + three uploads, no duplicates
  });

  it("treats a revoked install as a re-pair problem without losing the submission", async () => {
    const config = (await configs.get())!;
    await configs.set({ ...config, token: "r".repeat(43) });
    const event = await makeEvent({ submissionId: "e2e-4", problemKey: "revoked" });
    await outbox.enqueue(event, Date.now());
    const [report] = await outbox.drain(sink.deliver, Date.now);
    expect(report!.result).toMatchObject({
      kind: "retry",
      error: expect.stringMatching(/pair again/),
    });
    expect(await outbox.list()).toHaveLength(1);
    await configs.set(config);
  });
});

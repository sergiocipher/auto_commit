import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubSession, type HttpFetch, type UploadJob } from "@cst/core";
import { FakeGitHub, FAKE_TOKEN } from "@cst/core/testing";
import { DEFAULT_SETTINGS, type Settings } from "@cst/shared";
import { createApp, type Readiness } from "../src/app.js";
import { Cipher } from "../src/crypto.js";
import { PgJobStore } from "../src/db/jobStore.js";
import {
  DEFAULT_USER_ID as U,
  ensureUser,
  InstallsRepo,
  PgSessionStore,
  SettingsRepo,
} from "../src/db/repos.js";
import { createLogger } from "../src/logger.js";
import { freshDatabase, makeEvent, SKIP } from "./services.js";

const ORIGIN = `chrome-extension://${"b".repeat(32)}`;
const SOURCE_MARKER = "SOURCE_MARKER_42";

describe.skipIf(SKIP)("HTTP API", () => {
  let f: Awaited<ReturnType<typeof freshDatabase>>;
  let server: Server;
  let base: string;
  let token: string;
  let store: PgJobStore;
  const logs: string[] = [];
  const enqueued: UploadJob[] = [];
  const secrets: string[] = [FAKE_TOKEN];
  let ready: Readiness = { postgres: true, redis: true, migrations: true };
  const gh = new FakeGitHub();
  // Device-flow endpoints are not part of the fake; answer them here.
  const fetch: HttpFetch = async (url, init) => {
    if (url.startsWith("https://github.com/login/")) {
      const json = url.endsWith("/device/code")
        ? {
            device_code: "device-code-secret",
            user_code: "WDJB-MJHT",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 0,
          }
        : { access_token: FAKE_TOKEN, scope: "repo" };
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(json) };
    }
    return gh.fetch(url, init);
  };

  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
    const res = await globalThis.fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {}, headers: res.headers };
  }

  beforeAll(async () => {
    f = await freshDatabase();
    store = new PgJobStore(f.db);
    const cipher = new Cipher(new Map([["k1", randomBytes(32)]]), "k1");
    const sessions = new Map<string, GitHubSession>();
    const app = createApp({
      store,
      settings: new SettingsRepo(f.db),
      installs: new InstallsRepo(f.db),
      session: (userId) => {
        if (!sessions.has(userId))
          sessions.set(
            userId,
            new GitHubSession(
              new PgSessionStore(f.db, cipher, userId),
              fetch,
              "Ov23test",
              Date.now,
            ),
          );
        return sessions.get(userId)!;
      },
      enqueue: async (job) => {
        enqueued.push(job);
      },
      readiness: async () => ready,
      extensionOrigin: ORIGIN,
      fetch,
      now: Date.now,
      newId: randomUUID,
      log: createLogger("debug", (l) => logs.push(l)),
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    await f?.drop();
  });

  async function pair(): Promise<string> {
    const { code } = await new InstallsRepo(f.db).createPairingCode(U, Date.now());
    secrets.push(code);
    const saved = token;
    token = "";
    const r = await call("POST", "/v1/pair", { code, name: "Test Chrome" });
    token = saved;
    expect(r.status).toBe(201);
    secrets.push(r.json.token as string);
    return r.json.token as string;
  }

  async function saveSettings(patch: Partial<Settings> = {}) {
    const r = await call("PUT", "/v1/settings", {
      ...DEFAULT_SETTINGS,
      repo: { owner: "octo", name: "solutions", branch: "main" },
      ...patch,
    });
    expect(r.status).toBe(200);
  }

  describe("health", () => {
    it("reports liveness without dependencies and readiness from them", async () => {
      expect((await call("GET", "/healthz")).status).toBe(200);
      expect((await call("GET", "/readyz")).json).toMatchObject({ ok: true });
      ready = { postgres: true, redis: false, migrations: true };
      const r = await call("GET", "/readyz");
      expect(r.status).toBe(503);
      expect(r.json).toMatchObject({ ok: false, redis: false });
      ready = { postgres: true, redis: true, migrations: true };
    });
  });

  describe("CORS and auth", () => {
    it("allows only the extension origin", async () => {
      const pre = await call("OPTIONS", "/v1/settings", undefined, {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "PUT",
      });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(pre.headers.get("access-control-allow-headers")).toContain("Authorization");
      const evil = await call("GET", "/v1/settings", undefined, { Origin: "https://evil.example" });
      expect(evil.status).toBe(403);
      expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("requires a paired install's bearer token", async () => {
      token = "";
      expect((await call("GET", "/v1/settings")).status).toBe(401);
      token = "x".repeat(43);
      expect((await call("GET", "/v1/settings")).status).toBe(401);
      expect((await call("POST", "/v1/pair", { code: "wrong-code-123", name: "x" })).status).toBe(
        401,
      );
      token = await pair();
      expect((await call("GET", "/v1/settings")).status).toBe(200);
    });

    it("pairing codes work once", async () => {
      const { code } = await new InstallsRepo(f.db).createPairingCode(U, Date.now());
      secrets.push(code);
      const first = await call("POST", "/v1/pair", { code });
      expect(first.status).toBe(201);
      secrets.push(first.json.token as string);
      expect((await call("POST", "/v1/pair", { code })).status).toBe(401);
    });
  });

  describe("settings", () => {
    it("validates and stores settings", async () => {
      await saveSettings({ timezone: "Asia/Kolkata" });
      expect((await call("GET", "/v1/settings")).json).toMatchObject({ timezone: "Asia/Kolkata" });
      const bad = await call("PUT", "/v1/settings", { ...DEFAULT_SETTINGS, timezone: "Mars/Base" });
      expect(bad.status).toBe(400);
      expect(bad.json.error).toMatch(/timezone/);
      const extra = await call("PUT", "/v1/settings", { ...DEFAULT_SETTINGS, admin: true });
      expect(extra.status).toBe(400);
    });
  });

  describe("submissions", () => {
    it("ingests an accepted submission once and queues it", async () => {
      await saveSettings();
      enqueued.length = 0;
      const event = await makeEvent({ submissionId: "api-1", sourceCode: `// ${SOURCE_MARKER}\n` });
      const r = await call("POST", "/v1/submissions", event);
      expect(r.status).toBe(201);
      expect(r.json).toMatchObject({
        decision: "queued",
        upload: { status: "QUEUED", sourceStored: true },
      });
      expect(JSON.stringify(r.json)).not.toContain(SOURCE_MARKER);
      expect(enqueued).toHaveLength(1);

      const again = await call("POST", "/v1/submissions", event);
      expect(again.status).toBe(200);
      expect(again.json.decision).toBe("existing");
      expect((await store.listByProblem(U, "leetcode", "two-sum")).length).toBe(1);
    });

    it("rejects what must never upload", async () => {
      const rejected = await makeEvent({ submissionId: "api-2", verdict: "REJECTED" });
      expect((await call("POST", "/v1/submissions", rejected)).status).toBe(422);
      const ev = await makeEvent({ submissionId: "api-3" });
      const tampered = await call("POST", "/v1/submissions", {
        ...ev,
        sourceCode: ev.sourceCode + " ",
      });
      expect(tampered.status).toBe(422);
      expect(tampered.json.error).toMatch(/hash mismatch/);
      expect((await call("POST", "/v1/submissions", { ...ev, extra: 1 })).status).toBe(400);
      expect((await call("POST", "/v1/submissions", { ...ev, sourceCode: "" })).status).toBe(400);
      expect((await call("POST", "/v1/submissions", "{not json")).status).toBe(400);
      const huge = await call("POST", "/v1/submissions", {
        ...ev,
        sourceCode: "x".repeat(5_000_000),
      });
      expect(huge.status).toBe(413);
    });

    it("holds with auto-upload off and ignores disabled platforms", async () => {
      await saveSettings({ autoUpload: false });
      enqueued.length = 0;
      const held = await call(
        "POST",
        "/v1/submissions",
        await makeEvent({ submissionId: "api-4", problemKey: "held-problem" }),
      );
      expect(held.json).toMatchObject({ decision: "held", upload: { status: "HELD" } });
      expect(enqueued).toHaveLength(0);

      await saveSettings({
        enabledPlatforms: { leetcode: false, codeforces: true, codechef: true },
      });
      const off = await call("POST", "/v1/submissions", await makeEvent({ submissionId: "api-5" }));
      expect(off.json).toEqual({ decision: "platform-disabled" });
      await saveSettings();
    });
  });

  describe("uploads", () => {
    it("lists history without source and counts successes", async () => {
      const r = await call("GET", "/v1/uploads?limit=50");
      const uploads = r.json.uploads as { status: string; sourceStored: boolean }[];
      expect(uploads.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(r.json)).not.toContain(SOURCE_MARKER);
      expect(r.json.uploadedCount).toBe(0);
      expect((await call("GET", "/v1/uploads?limit=0")).status).toBe(400);
    });

    it("uploads a held job manually, force-uploads a skipped one, retries failures", async () => {
      enqueued.length = 0;
      const held = (await store.findBySubmission("leetcode", "api-4"))!;
      const manual = await call("POST", `/v1/uploads/${held.id}/retry`);
      expect(manual.json).toMatchObject({ upload: { status: "QUEUED", force: false } });
      expect(enqueued.map((j) => j.id)).toEqual([held.id]);

      // Make api-1 a success, then a second submission of the same problem is skipped.
      const first = (await store.findBySubmission("leetcode", "api-1"))!;
      await store.update({
        ...first,
        status: "SUCCESS",
        event: undefined,
        reservationBucket: undefined,
      });
      const skipped = await call(
        "POST",
        "/v1/submissions",
        await makeEvent({ submissionId: "api-6" }),
      );
      expect(skipped.json.decision).toBe("skipped");
      const forced = await call("POST", "/v1/uploads/force", {
        platform: "leetcode",
        submissionId: "api-6",
      });
      expect(forced.json).toMatchObject({ upload: { status: "QUEUED", force: true } });
      expect(
        (await call("POST", "/v1/uploads/force", { platform: "leetcode", submissionId: "nope" }))
          .status,
      ).toBe(404);

      const failed = (await store.findBySubmission("leetcode", "api-6"))!;
      await store.update({ ...failed, status: "FAILED_PERMANENT", lastError: "x" });
      expect((await call("POST", "/v1/uploads/retry-failed")).json).toEqual({ queued: 1 });
      expect((await call("GET", "/v1/uploads")).json.uploadedCount).toBe(1);
    });

    it("hides other users' uploads", async () => {
      await ensureUser(f.db, "someone-else");
      const theirs = await makeEvent({ submissionId: "other-1", problemKey: "theirs" });
      const job: UploadJob = {
        id: randomUUID(),
        userId: "someone-else",
        platform: "leetcode",
        problemKey: "theirs",
        problemTitle: "Theirs",
        submissionId: "other-1",
        language: "cpp",
        submittedAt: theirs.submittedAt,
        status: "FAILED_PERMANENT",
        attempts: 0,
        force: false,
        createdAt: 1,
        updatedAt: 1,
        event: theirs,
      };
      await store.insert(job);
      expect((await call("GET", `/v1/uploads/${job.id}`)).status).toBe(404);
      expect((await call("POST", `/v1/uploads/${job.id}/retry`)).status).toBe(404);
      expect(
        (await call("POST", "/v1/uploads/force", { platform: "leetcode", submissionId: "other-1" }))
          .status,
      ).toBe(404);
    });
  });

  describe("GitHub", () => {
    it("connects via device flow, resumes waiting jobs and never returns the token", async () => {
      const waiting = (await store.findBySubmission("leetcode", "api-4"))!;
      await store.update({ ...waiting, status: "NEEDS_AUTH" });
      enqueued.length = 0;
      const start = await call("POST", "/v1/github/device/start");
      expect(start.json).toMatchObject({ state: "pending", userCode: "WDJB-MJHT" });
      const poll = await call("POST", "/v1/github/device/poll");
      expect(poll.json).toEqual({ state: "connected", login: "octo" });
      expect(enqueued.map((j) => j.id)).toContain(waiting.id);
      const status = await call("GET", "/v1/github");
      expect(status.json).toMatchObject({ connected: true, login: "octo" });
      for (const r of [start, poll, status]) {
        expect(JSON.stringify(r.json)).not.toContain(FAKE_TOKEN);
        expect(JSON.stringify(r.json)).not.toContain("device-code-secret");
      }
    });

    it("lists repositories and validates branch parameters", async () => {
      const repos = await call("GET", "/v1/github/repos");
      expect(repos.status).toBe(200);
      expect((await call("GET", "/v1/github/repos/octo/solutions/branches")).status).toBe(200);
      expect((await call("GET", "/v1/github/repos/..%2Fx/r/branches")).status).toBe(400);
    });

    it("disconnects and reports not connected", async () => {
      expect((await call("DELETE", "/v1/github")).status).toBe(200);
      expect((await call("GET", "/v1/github")).json).toEqual({ connected: false });
      expect((await call("GET", "/v1/github/repos")).status).toBe(409);
    });
  });

  describe("data and errors", () => {
    it("deletes stored submissions and jobs", async () => {
      expect((await call("DELETE", "/v1/data")).status).toBe(200);
      expect((await call("GET", "/v1/uploads")).json.uploads).toEqual([]);
    });

    it("returns 404 for unknown routes", async () => {
      expect((await call("GET", "/nope")).status).toBe(404);
    });

    it("rate-limits pairing attempts", async () => {
      const saved = token;
      token = "";
      let last = 0;
      for (let i = 0; i < 12; i++)
        last = (await call("POST", "/v1/pair", { code: "wrong-code-123" })).status;
      expect(last).toBe(429);
      token = saved;
    });

    it("never logs tokens, pairing codes or source code", () => {
      const all = logs.join("\n");
      expect(logs.length).toBeGreaterThan(10);
      for (const s of secrets) expect(all).not.toContain(s);
      expect(all).not.toContain(SOURCE_MARKER);
      expect(all).not.toContain("device-code-secret");
    });
  });
});

import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpRequestInit, UploadSummary } from "@cst/core";
import { ActivityLog } from "../src/background/activity.js";
import {
  BACKEND_STORAGE_KEY,
  backendOrigin,
  BackendClient,
  BackendConfigStore,
  BackendError,
  BackendSink,
  pairBackend,
} from "../src/background/backend.js";
import { makeEvent, MemoryStore } from "./helpers.js";

const URL0 = "http://127.0.0.1:8787";
const TOKEN = "t".repeat(43);

type Route = (
  init: HttpRequestInit | undefined,
  url: string,
) => { status: number; body?: unknown } | "network";

function fakeBackend(routes: Record<string, Route>) {
  const calls: { method: string; url: string; init?: HttpRequestInit }[] = [];
  const fetch: HttpFetch = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, init });
    const path = url.replace(URL0, "").replace(/\?.*$/, "");
    const route = routes[`${method} ${path}`];
    const out = route ? route(init, url) : { status: 404, body: { error: "Not found." } };
    if (out === "network") throw new TypeError("Failed to fetch");
    return {
      status: out.status,
      headers: { get: () => null },
      text: async () => (out.body === undefined ? "" : JSON.stringify(out.body)),
    };
  };
  return { fetch, calls };
}

async function setup(routes: Record<string, Route>, opts: { paired?: boolean } = { paired: true }) {
  const store = new MemoryStore();
  const configs = new BackendConfigStore(store);
  if (opts.paired) await configs.set({ url: URL0, token: TOKEN, installId: "i1" });
  const backend = fakeBackend(routes);
  const activity = new ActivityLog(store);
  const sink = new BackendSink(
    new BackendClient(backend.fetch, () => configs.get()),
    activity,
    () => 5,
  );
  return { store, configs, sink, activity, ...backend };
}

const summary = (patch: Partial<UploadSummary> = {}): UploadSummary => ({
  id: "job-1",
  userId: "local",
  platform: "leetcode",
  problemKey: "two-sum",
  problemTitle: "Two Sum",
  submissionId: "1001",
  language: "python3",
  submittedAt: 1,
  status: "QUEUED",
  attempts: 0,
  force: false,
  createdAt: 1,
  updatedAt: 1,
  sourceStored: true,
  ...patch,
});

describe("backendOrigin", () => {
  it("accepts only plain local http origins", () => {
    expect(backendOrigin("http://127.0.0.1:8787")).toBe(URL0);
    expect(backendOrigin(" http://localhost:9000/ ")).toBe("http://localhost:9000");
    for (const bad of [
      "https://127.0.0.1:8787",
      "http://127.0.0.1.evil.example:8787",
      "http://evil.example",
      "http://127.0.0.1:8787/v1",
      "http://user:pw@127.0.0.1:8787",
      "http://127.0.0.1:8787/?x=1",
      "not a url",
    ]) {
      expect(backendOrigin(bad), bad).toBeNull();
    }
  });
});

describe("pairBackend", () => {
  it("stores the token returned for a valid code", async () => {
    const store = new MemoryStore();
    const configs = new BackendConfigStore(store);
    const { fetch, calls } = fakeBackend({
      "POST /v1/pair": () => ({ status: 201, body: { token: TOKEN, installId: "i9" } }),
    });
    expect(await pairBackend(fetch, configs, { url: `${URL0}/`, code: " abcdefghijkl " })).toEqual({
      url: URL0,
      token: TOKEN,
      installId: "i9",
    });
    expect(JSON.parse(calls[0]!.init!.body!)).toEqual({
      code: "abcdefghijkl",
      name: "Chrome extension",
    });
    expect(await store.get(BACKEND_STORAGE_KEY)).toMatchObject({ token: TOKEN });
  });

  it("reports bad codes, bad URLs and unreachable backends without storing anything", async () => {
    const configs = new BackendConfigStore(new MemoryStore());
    const bad = fakeBackend({
      "POST /v1/pair": () => ({ status: 401, body: { error: "Invalid or expired pairing code." } }),
    });
    await expect(
      pairBackend(bad.fetch, configs, { url: URL0, code: "abcdefghijkl" }),
    ).rejects.toThrow("Invalid or expired pairing code.");
    await expect(
      pairBackend(bad.fetch, configs, { url: "https://example.com", code: "abcdefghijkl" }),
    ).rejects.toThrow(/must be http:\/\/127\.0\.0\.1/);
    const down = fakeBackend({ "POST /v1/pair": () => "network" });
    await expect(
      pairBackend(down.fetch, configs, { url: URL0, code: "abcdefghijkl" }),
    ).rejects.toThrow(/not reachable/);
    expect(await configs.get()).toBeUndefined();
  });
});

describe("BackendSink.deliver", () => {
  it("maps backend decisions to outbox results", async () => {
    const event = await makeEvent();
    const ok = await setup({
      "POST /v1/submissions": () => ({
        status: 201,
        body: { decision: "queued", upload: summary() },
      }),
    });
    expect(await ok.sink.deliver(event)).toEqual({ kind: "accepted", status: "QUEUED" });
    expect(ok.calls[0]!.init!.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(ok.calls[0]!.init!.body!).sourceCode).toBe(event.sourceCode);

    const skipped = await setup({
      "POST /v1/submissions": () => ({
        status: 201,
        body: {
          decision: "skipped",
          upload: summary({ status: "SKIPPED_NOT_ELIGIBLE", lastError: "Already uploaded" }),
        },
      }),
    });
    expect(await skipped.sink.deliver(event)).toEqual({
      kind: "accepted",
      status: "SKIPPED_NOT_ELIGIBLE",
      detail: "Already uploaded",
    });
  });

  it("rejects what the backend refuses and keeps everything else for retry", async () => {
    const event = await makeEvent();
    const cases: [Route, string][] = [
      [
        () => ({ status: 422, body: { error: "Only accepted submissions are uploaded." } }),
        "rejected",
      ],
      [() => ({ status: 200, body: { decision: "platform-disabled" } }), "rejected"],
      [() => ({ status: 503, body: { error: "busy" } }), "retry"],
      [() => ({ status: 429, body: { error: "Too many requests." } }), "retry"],
      [() => "network", "retry"],
      [() => ({ status: 401, body: { error: "Not paired" } }), "retry"],
    ];
    for (const [route, kind] of cases) {
      const t = await setup({ "POST /v1/submissions": route });
      expect((await t.sink.deliver(event)).kind).toBe(kind);
    }
    const unpaired = await setup({}, { paired: false });
    expect(await unpaired.sink.deliver(event)).toEqual({
      kind: "retry",
      error: "Not paired with a backend.",
    });
  });
});

describe("BackendSink history and actions", () => {
  it("mirrors changed statuses into the activity log and reports activity", async () => {
    let uploads = [summary()];
    const t = await setup({
      "GET /v1/uploads": () => ({ status: 200, body: { uploads, uploadedCount: 0 } }),
    });
    await t.activity.recordQueued(await makeEvent(), 1);
    expect((await t.sink.refresh()).active).toBe(true);
    expect((await t.activity.list())[0]!.status).toBe("QUEUED");

    uploads = [summary({ status: "SUCCESS", commitSha: "c".repeat(40), filePath: "data/x" })];
    const r = await t.sink.refresh();
    expect(r.active).toBe(false);
    expect(r.history.uploads[0]!.status).toBe("SUCCESS");
    expect((await t.activity.list())[0]).toMatchObject({
      status: "SUCCESS",
      commitSha: "c".repeat(40),
    });
  });

  it("refuses replies in an unexpected shape", async () => {
    const t = await setup({
      "GET /v1/uploads": () => ({ status: 200, body: { uploads: "nope" } }),
    });
    await expect(t.sink.uploads.history()).rejects.toThrow(/expected format/);
  });

  it("retries by job id, force-uploads by submission and retries all failed", async () => {
    const t = await setup({
      "GET /v1/uploads": () => ({
        status: 200,
        body: { uploads: [summary({ status: "FAILED_PERMANENT" })], uploadedCount: 0 },
      }),
      "POST /v1/uploads/job-1/retry": () => ({ status: 200, body: { upload: summary() } }),
      "POST /v1/uploads/force": () => ({ status: 200, body: { upload: summary({ force: true }) } }),
      "POST /v1/uploads/retry-failed": () => ({ status: 200, body: { queued: 3 } }),
    });
    expect((await t.sink.uploads.retry("leetcode", "1001"))?.status).toBe("QUEUED");
    expect(await t.sink.uploads.retry("leetcode", "unknown")).toBeUndefined();
    expect((await t.sink.uploads.retry("leetcode", "1001", { force: true }))?.force).toBe(true);
    const force = t.calls.find((c) => c.url.endsWith("/v1/uploads/force"))!;
    expect(JSON.parse(force.init!.body!)).toEqual({ platform: "leetcode", submissionId: "1001" });
    expect(await t.sink.uploads.retryFailed()).toBe(3);
  });

  it("proxies GitHub calls and surfaces backend error messages", async () => {
    const t = await setup({
      "GET /v1/github": () => ({ status: 200, body: { connected: false } }),
      "GET /v1/github/repos": () => ({ status: 409, body: { error: "GitHub is not connected." } }),
      "GET /v1/github/repos/octo/solutions/branches": () => ({ status: 200, body: ["main"] }),
    });
    expect(await t.sink.github.status()).toEqual({ connected: false });
    const err = await t.sink.github.repos().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect((err as Error).message).toBe("GitHub is not connected.");
    expect(await t.sink.github.branches("octo", "solutions")).toEqual(["main"]);
  });
});

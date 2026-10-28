import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, sha256Hex, type Platform } from "@cst/shared";
import { ActivityLog } from "../src/background/activity.js";
import {
  createMessageHandler,
  MAX_HISTORY_IN_STATE,
  type PopupState,
  type UploadSummary,
} from "../src/background/handler.js";
import { Outbox } from "../src/background/outbox.js";
import { SettingsStore } from "../src/background/settings.js";
import type { ConnectProgress } from "../src/background/githubAuth.js";
import { UploadError, type UploadJob } from "@cst/core";
import { contentSender, EXT_ID, makeEvent, MemoryStore, pageSender } from "./helpers.js";

function setup() {
  const store = new MemoryStore();
  const deps = {
    extensionId: EXT_ID,
    outbox: new Outbox(store),
    activity: new ActivityLog(store),
    settings: new SettingsStore(store, () => "Asia/Kolkata"),
    now: () => 1_700_000_001_000,
    sha256: (t: string) => sha256Hex(t),
    requestDrain: vi.fn(),
    github: {
      status: vi.fn(async () => ({ connected: true, login: "octo", scopes: ["repo"] })),
      start: vi.fn(async () => ({
        state: "pending" as const,
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        retryInMs: 5000,
      })),
      poll: vi.fn(async (): Promise<ConnectProgress> => ({ state: "connected", login: "octo" })),
      disconnect: vi.fn(async () => undefined),
      repos: vi.fn(async () => []),
      branches: vi.fn(async () => ["main"]),
    },
    uploads: {
      retry: vi.fn(
        async (
          _p: Platform,
          _s: string,
          _o?: { force?: boolean },
        ): Promise<UploadJob | undefined> => undefined,
      ),
      retryFailed: vi.fn(async () => 2),
      history: vi.fn(async (): Promise<UploadSummary[]> => []),
      onConnected: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    },
  };
  return { deps, handle: createMessageHandler(deps), store };
}

let ctx: ReturnType<typeof setup>;
beforeEach(() => {
  ctx = setup();
});

describe("sender checks", () => {
  it.each([
    ["another extension", { ...contentSender(), id: "other" }],
    ["no url", { id: EXT_ID }],
    ["a non-platform site", contentSender("https://evil.example/leetcode.com")],
    ["a look-alike host", contentSender("https://leetcode.com.evil.example/")],
    ["plain http", contentSender("http://leetcode.com/")],
    ["a subframe", { ...contentSender(), frameId: 3 }],
    ["a platform url without a tab", { id: EXT_ID, url: "https://leetcode.com/", frameId: 0 }],
  ])("rejects %s", async (_label, sender) => {
    const reply = await ctx.handle({ type: "state/get" }, sender as chrome.runtime.MessageSender);
    expect(reply).toEqual({ ok: false, error: "Unauthorized sender." });
  });
});

describe("content messages", () => {
  it("queues an accepted submission and requests delivery", async () => {
    const event = await makeEvent();
    const reply = await ctx.handle({ type: "submission/detected", event }, contentSender());
    expect(reply).toEqual({ ok: true, data: "queued" });
    expect(ctx.deps.requestDrain).toHaveBeenCalledTimes(1);
    const [item] = await ctx.deps.outbox.list();
    expect(item!.event.sourceCode).toBe(event.sourceCode);
    expect((await ctx.deps.activity.list())[0]).toMatchObject({
      queued: true,
      verdict: "ACCEPTED",
    });
  });

  it("reports repeats of the same submission as duplicates", async () => {
    const event = await makeEvent();
    await ctx.handle({ type: "submission/detected", event }, contentSender());
    const reply = await ctx.handle({ type: "submission/detected", event }, contentSender());
    expect(reply).toEqual({ ok: true, data: "duplicate" });
    expect(await ctx.deps.outbox.list()).toHaveLength(1);
  });

  it.each(["REJECTED", "PENDING"] as const)("never queues %s submissions", async (verdict) => {
    const reply = await ctx.handle(
      { type: "submission/detected", event: await makeEvent({ verdict }) },
      contentSender(),
    );
    expect(reply).toEqual({ ok: false, error: "Only accepted submissions are uploaded." });
    expect(await ctx.deps.outbox.list()).toEqual([]);
  });

  it("rejects a source hash mismatch (altered or truncated code)", async () => {
    const event = await makeEvent();
    const reply = await ctx.handle(
      { type: "submission/detected", event: { ...event, sourceCode: event.sourceCode.trimEnd() } },
      contentSender(),
    );
    expect(reply).toMatchObject({ ok: false, error: expect.stringMatching(/hash mismatch/) });
  });

  it("rejects events claiming a different platform than the sending page", async () => {
    const reply = await ctx.handle(
      { type: "submission/detected", event: await makeEvent() },
      contentSender("https://codeforces.com/contest/4/my"),
    );
    expect(reply).toMatchObject({ ok: false });
    expect(await ctx.deps.outbox.list()).toEqual([]);
  });

  it("rejects problem URLs on another platform and unsafe slugs", async () => {
    const wrongUrl = await makeEvent({
      problemUrl: "https://codeforces.com/problemset/problem/4/A",
    });
    expect(
      await ctx.handle({ type: "submission/detected", event: wrongUrl }, contentSender()),
    ).toMatchObject({
      ok: false,
    });
    const badSlug = await makeEvent({ problemSlug: "../../etc" });
    expect(
      await ctx.handle({ type: "submission/detected", event: badSlug }, contentSender()),
    ).toEqual({
      ok: false,
      error: "Problem slug is not a safe folder name.",
    });
  });

  it("ignores submissions from disabled platforms", async () => {
    await ctx.deps.settings.set({
      ...ctx.deps.settings.defaults(),
      enabledPlatforms: { ...DEFAULT_SETTINGS.enabledPlatforms, leetcode: false },
    });
    const reply = await ctx.handle(
      { type: "submission/detected", event: await makeEvent() },
      contentSender(),
    );
    expect(reply).toEqual({ ok: true, data: "platform-disabled" });
    expect(await ctx.deps.outbox.list()).toEqual([]);
  });

  it("rejects malformed and over-specified messages", async () => {
    const event = await makeEvent();
    for (const msg of [
      null,
      "x",
      { type: "nope" },
      { type: "submission/detected", event: { ...event, token: "secret" } },
      { type: "submission/detected", event: { ...event, sourceCode: "" } },
      { type: "submission/detected", event, extra: 1 },
    ]) {
      expect(await ctx.handle(msg, contentSender())).toEqual({
        ok: false,
        error: "Invalid message.",
      });
    }
  });

  it("records observed verdicts for the popup", async () => {
    const reply = await ctx.handle(
      {
        type: "verdict/observed",
        platform: "leetcode",
        submissionId: "9",
        verdict: "REJECTED",
        rawVerdict: "Wrong Answer",
        at: 1,
      },
      contentSender(),
    );
    expect(reply.ok).toBe(true);
    expect((await ctx.deps.activity.list())[0]).toMatchObject({
      submissionId: "9",
      rawVerdict: "Wrong Answer",
    });
    expect(await ctx.deps.outbox.list()).toEqual([]);
  });

  it("refuses page-only commands from content scripts", async () => {
    expect(await ctx.handle({ type: "data/clear" }, contentSender())).toEqual({
      ok: false,
      error: "Invalid message.",
    });
  });
});

describe("extension page messages", () => {
  it("returns state without any source code", async () => {
    const event = await makeEvent({ sourceCode: "SECRET_SOURCE_MARKER" });
    await ctx.handle({ type: "submission/detected", event }, contentSender());
    const reply = await ctx.handle({ type: "state/get" }, pageSender());
    expect(reply.ok).toBe(true);
    const state = (reply as { data: PopupState }).data;
    expect(state.outbox).toHaveLength(1);
    expect(state.settings.timezone).toBe("Asia/Kolkata");
    expect(JSON.stringify(state)).not.toContain("SECRET_SOURCE_MARKER");
  });

  it("validates and persists settings", async () => {
    const settings = {
      ...ctx.deps.settings.defaults(),
      period: { kind: "custom_hours" as const, hours: 6 },
    };
    expect(
      await ctx.handle({ type: "settings/update", settings }, pageSender("options.html")),
    ).toEqual({
      ok: true,
      data: settings,
    });
    expect((await ctx.deps.settings.get()).period).toEqual({ kind: "custom_hours", hours: 6 });
    const bad = await ctx.handle(
      { type: "settings/update", settings: { ...settings, timezone: "Nowhere/Land" } },
      pageSender(),
    );
    expect(bad).toEqual({ ok: false, error: "Invalid message." });
  });

  it("retries pending items on request", async () => {
    await ctx.handle({ type: "submission/detected", event: await makeEvent() }, contentSender());
    ctx.deps.requestDrain.mockClear();
    expect(await ctx.handle({ type: "outbox/retry" }, pageSender())).toEqual({
      ok: true,
      data: undefined,
    });
    expect(ctx.deps.requestDrain).toHaveBeenCalledTimes(1);
  });

  it("clears outbox and history but keeps settings", async () => {
    const settings = { ...ctx.deps.settings.defaults(), autoUpload: false };
    await ctx.deps.settings.set(settings);
    await ctx.handle({ type: "submission/detected", event: await makeEvent() }, contentSender());
    expect(await ctx.handle({ type: "data/clear" }, pageSender())).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await ctx.deps.outbox.list()).toEqual([]);
    expect(await ctx.deps.activity.list()).toEqual([]);
    expect((await ctx.deps.settings.get()).autoUpload).toBe(false);
  });

  it("refuses content-only messages from extension pages", async () => {
    const reply = await ctx.handle(
      { type: "submission/detected", event: await makeEvent() },
      pageSender(),
    );
    expect(reply).toEqual({ ok: false, error: "Invalid message." });
  });
});

describe("github and upload commands", () => {
  it("never exposes the token in state", async () => {
    const reply = await ctx.handle({ type: "state/get" }, pageSender());
    expect((reply as { data: PopupState }).data.github).toEqual({
      connected: true,
      login: "octo",
      scopes: ["repo"],
    });
  });

  it("resumes waiting uploads once GitHub connects", async () => {
    const reply = await ctx.handle({ type: "github/device/poll" }, pageSender("options.html"));
    expect(reply).toEqual({ ok: true, data: { state: "connected", login: "octo" } });
    expect(ctx.deps.uploads.onConnected).toHaveBeenCalledTimes(1);
    expect(ctx.deps.requestDrain).toHaveBeenCalled();
  });

  it("does not resume while sign-in is still pending", async () => {
    ctx.deps.github.poll.mockResolvedValueOnce({
      state: "pending",
      userCode: "X",
      verificationUri: "https://github.com/login/device",
      retryInMs: 5000,
    });
    await ctx.handle({ type: "github/device/poll" }, pageSender("options.html"));
    expect(ctx.deps.uploads.onConnected).not.toHaveBeenCalled();
  });

  it("passes our own GitHub error messages through, hides others", async () => {
    ctx.deps.github.start.mockRejectedValueOnce(
      new UploadError("permanent", "GitHub refused device sign-in (device_flow_disabled)."),
    );
    expect(await ctx.handle({ type: "github/device/start" }, pageSender())).toEqual({
      ok: false,
      error: "GitHub refused device sign-in (device_flow_disabled).",
    });
    ctx.deps.github.repos.mockRejectedValueOnce(new Error("internal details"));
    expect(await ctx.handle({ type: "github/repos" }, pageSender())).toEqual({
      ok: false,
      error: "GitHub request failed.",
    });
  });

  it("validates branch-listing parameters", async () => {
    expect(
      await ctx.handle({ type: "github/branches", owner: "../x", name: "r" }, pageSender()),
    ).toEqual({ ok: false, error: "Invalid message." });
    expect(
      await ctx.handle({ type: "github/branches", owner: "octo", name: "r" }, pageSender()),
    ).toEqual({ ok: true, data: ["main"] });
  });

  it("retries an upload and reports unknown submissions", async () => {
    expect(
      await ctx.handle(
        { type: "upload/retry", platform: "leetcode", submissionId: "1" },
        pageSender(),
      ),
    ).toEqual({
      ok: false,
      error: "No upload found for that submission.",
    });
    ctx.deps.uploads.retry.mockResolvedValueOnce({ status: "QUEUED" } as UploadJob);
    expect(
      await ctx.handle(
        { type: "upload/retry", platform: "leetcode", submissionId: "1" },
        pageSender(),
      ),
    ).toEqual({ ok: true, data: "QUEUED" });
    expect(ctx.deps.uploads.retry).toHaveBeenLastCalledWith("leetcode", "1", { force: false });
  });

  it("force-uploads a stored submission and retries all failed uploads", async () => {
    ctx.deps.uploads.retry.mockResolvedValueOnce({ status: "QUEUED" } as UploadJob);
    expect(
      await ctx.handle(
        { type: "upload/force", platform: "codeforces", submissionId: "9" },
        pageSender(),
      ),
    ).toEqual({ ok: true, data: "QUEUED" });
    expect(ctx.deps.uploads.retry).toHaveBeenLastCalledWith("codeforces", "9", { force: true });
    expect(await ctx.handle({ type: "upload/retry-failed" }, pageSender())).toEqual({
      ok: true,
      data: 2,
    });
    expect(ctx.deps.requestDrain).toHaveBeenCalledTimes(2);
  });

  it("refuses upload commands from content scripts", async () => {
    for (const msg of [
      { type: "upload/force", platform: "leetcode", submissionId: "1" },
      { type: "upload/retry-failed" },
    ]) {
      expect(await ctx.handle(msg, contentSender())).toEqual({
        ok: false,
        error: "Invalid message.",
      });
    }
    expect(ctx.deps.uploads.retry).not.toHaveBeenCalled();
    expect(ctx.deps.uploads.retryFailed).not.toHaveBeenCalled();
  });

  it("caps the history in state but counts every successful upload", async () => {
    const summary = (i: number, status: UploadSummary["status"]): UploadSummary =>
      ({ id: `j${i}`, status, sourceStored: false }) as UploadSummary;
    ctx.deps.uploads.history.mockResolvedValueOnce([
      ...Array.from({ length: MAX_HISTORY_IN_STATE }, (_, i) => summary(i, "SKIPPED_NOT_ELIGIBLE")),
      summary(1000, "SUCCESS"),
      summary(1001, "SUCCESS"),
    ]);
    const reply = await ctx.handle({ type: "state/get" }, pageSender());
    const state = (reply as { data: PopupState }).data;
    expect(state.uploads).toHaveLength(MAX_HISTORY_IN_STATE);
    expect(state.uploadedCount).toBe(2);
  });

  it("clear local data also clears stored upload jobs; disconnect deletes the token", async () => {
    await ctx.handle({ type: "data/clear" }, pageSender());
    expect(ctx.deps.uploads.clear).toHaveBeenCalledTimes(1);
    await ctx.handle({ type: "github/disconnect" }, pageSender());
    expect(ctx.deps.github.disconnect).toHaveBeenCalledTimes(1);
  });

  it("refuses GitHub commands from content scripts", async () => {
    expect(await ctx.handle({ type: "github/device/start" }, contentSender())).toEqual({
      ok: false,
      error: "Invalid message.",
    });
    expect(ctx.deps.github.start).not.toHaveBeenCalled();
  });
});

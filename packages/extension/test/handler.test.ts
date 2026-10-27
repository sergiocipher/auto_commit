import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, sha256Hex } from "@cst/shared";
import { ActivityLog } from "../src/background/activity.js";
import { createMessageHandler, type PopupState } from "../src/background/handler.js";
import { Outbox } from "../src/background/outbox.js";
import { SettingsStore } from "../src/background/settings.js";
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

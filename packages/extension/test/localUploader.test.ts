import { describe, expect, it } from "vitest";
import { KeyValueJobStore, type UploadJob } from "@cst/core";
import { FakeGitHub, FAKE_TOKEN as TOKEN } from "@cst/core/testing";
import { SettingsStore } from "../src/background/settings.js";
import { LocalUploader } from "../src/background/localUploader.js";
import { makeEvent, MemoryStore } from "./helpers.js";

async function setup(opts: { token?: string; autoUpload?: boolean } = { token: TOKEN }) {
  const gh = new FakeGitHub();
  const store = new MemoryStore();
  const settings = new SettingsStore(store, () => "UTC");
  await settings.set({
    ...settings.defaults(),
    autoUpload: opts.autoUpload ?? true,
    repo: { owner: "octo", name: "solutions", branch: "main" },
  });
  let now = 1_700_000_000_000;
  let token = opts.token;
  const seen: UploadJob[] = [];
  let ids = 0;
  const jobs = new KeyValueJobStore(store);
  const uploader = new LocalUploader({
    jobs,
    settings,
    fetch: gh.fetch,
    getToken: async () => token,
    now: () => now,
    newId: () => `id-${++ids}`,
    onJob: async (j) => {
      seen.push(j);
    },
  });
  return {
    gh,
    uploader,
    jobs,
    seen,
    setToken: (t?: string) => (token = t),
    advance: (ms: number) => (now += ms),
  };
}

describe("LocalUploader", () => {
  it("uploads an accepted submission end to end, reporting progress", async () => {
    const t = await setup();
    const event = await makeEvent();
    expect(await t.uploader.deliver(event)).toEqual({ kind: "accepted", status: "QUEUED" });
    await t.uploader.runDue();
    expect(t.seen.map((j) => j.status)).toEqual(["UPLOADING", "SUCCESS"]);
    expect(t.gh.readFile("data/leetcode/two-sum/solution.py")).toBe(event.sourceCode);
    expect(t.gh.log()[0]).toBe("feat(solutions): add LeetCode - Two Sum (Python)");
    expect((await t.jobs.list())[0]!.event).toBeUndefined(); // source purged after SUCCESS
  });

  it("skips a second solution in the same period without touching GitHub", async () => {
    const t = await setup();
    await t.uploader.deliver(await makeEvent());
    await t.uploader.runDue();
    const before = t.gh.requests.length;
    const second = await t.uploader.deliver(
      await makeEvent({ submissionId: "1002", sourceCode: "print(2)\n" }),
    );
    expect(second).toMatchObject({
      kind: "accepted",
      status: "SKIPPED_NOT_ELIGIBLE",
      detail: expect.stringMatching(/Already uploaded/),
    });
    await t.uploader.runDue();
    expect(t.gh.requests.length).toBe(before);
  });

  it("rejects non-accepted or tampered events permanently", async () => {
    const t = await setup();
    expect(await t.uploader.deliver(await makeEvent({ verdict: "REJECTED" }))).toEqual({
      kind: "rejected",
      error: "Only accepted submissions are uploaded.",
    });
    const e = await makeEvent();
    expect((await t.uploader.deliver({ ...e, sourceCode: `${e.sourceCode}x` })).kind).toBe(
      "rejected",
    );
  });

  it("waits for GitHub, then resumes after connecting", async () => {
    const t = await setup({});
    await t.uploader.deliver(await makeEvent());
    await t.uploader.runDue();
    expect(t.seen.at(-1)!.status).toBe("NEEDS_AUTH");
    t.setToken(TOKEN);
    await t.uploader.resumeNeedsAuth();
    await t.uploader.runDue();
    expect(t.seen.at(-1)!.status).toBe("SUCCESS");
    expect(t.gh.log()).toHaveLength(2);
  });

  it("recovers jobs interrupted mid-upload by a service-worker kill", async () => {
    const t = await setup();
    await t.uploader.deliver(await makeEvent());
    const [job] = await t.jobs.list();
    await t.jobs.update({ ...job!, status: "UPLOADING" });
    await t.uploader.runDue();
    expect(t.gh.log()).toHaveLength(1); // UPLOADING is not runnable on its own
    await t.uploader.recoverInterrupted();
    await t.uploader.runDue();
    expect((await t.jobs.list())[0]!.status).toBe("SUCCESS");
    expect(t.gh.log()).toHaveLength(2);
  });

  it("retries a failed job manually without duplicating the commit", async () => {
    const t = await setup();
    t.gh.failNext({ method: "PATCH" }, 404);
    await t.uploader.deliver(await makeEvent());
    await t.uploader.runDue();
    expect(t.seen.at(-1)!.status).toBe("FAILED_PERMANENT");
    expect(await t.uploader.retry("leetcode", "1001")).toMatchObject({ status: "QUEUED" });
    await t.uploader.runDue();
    expect(t.seen.at(-1)!.status).toBe("SUCCESS");
    expect(t.gh.log()).toHaveLength(2);
  });

  it("does not run the same job twice when runs overlap", async () => {
    const t = await setup();
    await t.uploader.deliver(await makeEvent());
    await Promise.all([t.uploader.runDue(), t.uploader.runDue(), t.uploader.runDue()]);
    expect(t.gh.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  it("holds accepted submissions when auto-upload is off until uploaded manually", async () => {
    const t = await setup({ token: TOKEN, autoUpload: false });
    const event = await makeEvent();
    expect(await t.uploader.deliver(event)).toMatchObject({ kind: "accepted", status: "HELD" });
    await t.uploader.runDue();
    expect(t.gh.requests).toHaveLength(0);

    expect(await t.uploader.retry("leetcode", "1001")).toMatchObject({ status: "QUEUED" });
    await t.uploader.runDue();
    expect(t.seen.at(-1)!.status).toBe("SUCCESS");
    expect(t.gh.readFile("data/leetcode/two-sum/solution.py")).toBe(event.sourceCode);
  });

  it("force-uploads a skipped solution next to the first one", async () => {
    const t = await setup();
    await t.uploader.deliver(await makeEvent());
    await t.uploader.runDue();
    const second = await makeEvent({ submissionId: "1002", sourceCode: "print(2)\n" });
    expect(await t.uploader.deliver(second)).toMatchObject({ status: "SKIPPED_NOT_ELIGIBLE" });

    expect(await t.uploader.retry("leetcode", "1002", { force: true })).toMatchObject({
      status: "QUEUED",
      force: true,
    });
    await t.uploader.runDue();
    expect(t.seen.at(-1)!.status).toBe("SUCCESS");
    expect(t.gh.readFile("data/leetcode/two-sum/solution.py")).not.toBe(second.sourceCode);
    expect(t.gh.readFile("data/leetcode/two-sum/solution-1002.py")).toBe(second.sourceCode);
    expect(t.gh.log()).toHaveLength(3); // initial commit + one per upload
  });

  it("retries all failed and needs-auth jobs at once", async () => {
    const t = await setup({ token: undefined });
    await t.uploader.deliver(await makeEvent());
    await t.uploader.deliver(
      await makeEvent({ submissionId: "2", problemKey: "add-two-numbers", problemTitle: "Add" }),
    );
    await t.uploader.runDue();
    expect((await t.jobs.list()).map((j) => j.status)).toEqual(["NEEDS_AUTH", "NEEDS_AUTH"]);
    t.setToken(TOKEN);
    expect(await t.uploader.retryFailed()).toBe(2);
    await t.uploader.runDue();
    expect((await t.jobs.list()).map((j) => j.status)).toEqual(["SUCCESS", "SUCCESS"]);
  });

  it("reports history without source code", async () => {
    const t = await setup({ token: TOKEN, autoUpload: false });
    await t.uploader.deliver(await makeEvent({ sourceCode: "SECRET_SOURCE_MARKER" }));
    const history = await t.uploader.history();
    expect(history).toEqual({
      uploads: [expect.objectContaining({ status: "HELD", sourceStored: true })],
      uploadedCount: 0,
    });
    expect(JSON.stringify(history)).not.toContain("SECRET_SOURCE_MARKER");
  });
});

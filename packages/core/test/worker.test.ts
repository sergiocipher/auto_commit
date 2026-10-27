import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@cst/shared";
import {
  DEFAULT_MAX_ATTEMPTS,
  ingestSubmission,
  processJob,
  retryDelay,
  type ProcessDeps,
  type UploadJob,
} from "../src/index.js";
import { FakeGitHub } from "./fakeGitHub.js";
import { fakeToken, makeEvent, newId, newStore, T0, TOKEN } from "./helpers.js";

let gh: FakeGitHub;
let token: string | undefined;
let now: number;

function deps(overrides: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    fetch: gh.fetch,
    now: () => now,
    random: () => 0,
    getToken: async () => token,
    settings: { ...DEFAULT_SETTINGS, repo: { owner: "octo", name: "solutions", branch: "main" } },
    ...overrides,
  };
}

async function queuedJob(overrides: Parameters<typeof makeEvent>[0] = {}): Promise<UploadJob> {
  const store = newStore();
  const r = await ingestSubmission(store, await makeEvent(overrides), {
    userId: "u1",
    settings: { period: { kind: "calendar_day" }, timezone: "UTC" },
    now,
    newId,
  });
  return r.job;
}

beforeEach(() => {
  gh = new FakeGitHub();
  token = TOKEN;
  now = T0;
});

describe("processJob", () => {
  it("uploads, records the commit and purges the source", async () => {
    const job = await processJob(await queuedJob(), deps());
    expect(job).toMatchObject({
      status: "SUCCESS",
      commitSha: gh.head(),
      filePath: "data/leetcode/two-sum/solution.cpp",
      repository: "octo/solutions",
      branch: "main",
      commitMessage: "feat(solutions): add LeetCode - Two Sum (C++)",
      uploadedAt: T0,
    });
    expect(job.event).toBeUndefined();
  });

  it("keeps the source when purge is disabled", async () => {
    const job = await processJob(await queuedJob(), deps({ purgeSourceOnSuccess: false }));
    expect(job.event?.sourceCode).toBeDefined();
  });

  it("needs auth without a token, and resumes after reconnect with one commit", async () => {
    token = undefined;
    const waiting = await processJob(await queuedJob(), deps());
    expect(waiting).toMatchObject({ status: "NEEDS_AUTH", attempts: 0 });
    expect(gh.requests).toHaveLength(0);

    token = fakeToken("gho", "revoked"); // GitHub says 401
    const revoked = await processJob({ ...waiting, status: "QUEUED" }, deps());
    expect(revoked.status).toBe("NEEDS_AUTH");
    expect(revoked.lastError).toMatch(/reconnect/);
    expect(revoked.lastError).not.toContain(fakeToken("gho", "revoked"));

    token = TOKEN;
    const done = await processJob({ ...revoked, status: "QUEUED" }, deps());
    expect(done.status).toBe("SUCCESS");
    expect(gh.log()).toHaveLength(2);
  });

  it("delays on rate limits without burning attempts", async () => {
    gh.failNext({ pathIncludes: "/git/ref/" }, 429, { headers: { "Retry-After": "120" } });
    const job = await processJob(await queuedJob(), deps());
    expect(job).toMatchObject({ status: "RETRYING", attempts: 0, nextAttemptAt: T0 + 120_000 });
  });

  it("retries 5xx with backoff and gives up after the max attempts", async () => {
    gh.failNext({ pathIncludes: "/git/ref/" }, 503, { times: 100 });
    let job = await queuedJob();
    for (let i = 1; i < DEFAULT_MAX_ATTEMPTS; i++) {
      job = await processJob(job, deps());
      expect(job).toMatchObject({
        status: "RETRYING",
        attempts: i,
        nextAttemptAt: now + retryDelay(i, () => 0),
      });
      now = job.nextAttemptAt!;
    }
    job = await processJob(job, deps());
    expect(job.status).toBe("FAILED_PERMANENT");
    expect(job.lastError).toMatch(/Gave up after 6 attempts/);
    expect(job.event).toBeDefined(); // kept for a manual retry
  });

  it("a retry after a transient failure produces exactly one commit", async () => {
    gh.failNext({ method: "PATCH" }, 500);
    const failed = await processJob(await queuedJob(), deps());
    expect(failed.status).toBe("RETRYING");
    const ok = await processJob(failed, deps());
    expect(ok.status).toBe("SUCCESS");
    expect(gh.log()).toEqual(["feat(solutions): add LeetCode - Two Sum (C++)", "Initial commit"]);
  });

  it("a retry after GitHub already applied the commit makes no second commit", async () => {
    // Simulates a lost response: the ref update succeeded but we saw a 502.
    const job = await queuedJob();
    await processJob(job, deps());
    const again = await processJob(job, deps());
    expect(again.status).toBe("SUCCESS");
    expect(gh.log()).toHaveLength(2);
  });

  it("missing repo or branch is permanent", async () => {
    const job = await processJob(
      await queuedJob(),
      deps({
        settings: {
          ...deps().settings,
          repo: { owner: "octo", name: "solutions", branch: "nope" },
        },
      }),
    );
    expect(job.status).toBe("FAILED_PERMANENT");
    expect(job.lastError).toMatch(/Not found while reading the branch head/);
  });

  it("403 without write access is permanent", async () => {
    gh.failNext({ method: "PATCH" }, 403, {
      body: { message: "Resource not accessible by integration" },
    });
    expect((await processJob(await queuedJob(), deps())).status).toBe("FAILED_PERMANENT");
  });

  it("unsupported language fails clearly before touching GitHub", async () => {
    const job = await processJob(await queuedJob({ language: "Befunge-98" }), deps());
    expect(job.status).toBe("FAILED_PERMANENT");
    expect(job.lastError).toMatch(/Unsupported language "Befunge-98"/);
    expect(gh.requests).toHaveLength(0);
  });

  it("requires a configured repository", async () => {
    const job = await processJob(await queuedJob(), deps({ settings: { ...DEFAULT_SETTINGS } }));
    expect(job).toMatchObject({
      status: "FAILED_PERMANENT",
      lastError: expect.stringMatching(/No repository configured/),
    });
  });

  it("never stores the token in lastError", async () => {
    gh.failNext({ pathIncludes: "/git/ref/" }, 500, { body: { message: `echo ${TOKEN}` } });
    const job = await processJob(await queuedJob(), deps());
    expect(job.lastError).not.toContain(TOKEN);
  });

  it("fails jobs whose source was already purged", async () => {
    const job = await processJob({ ...(await queuedJob()), event: undefined }, deps());
    expect(job.status).toBe("FAILED_PERMANENT");
  });
});

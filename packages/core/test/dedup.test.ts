import { describe, expect, it } from "vitest";
import type { Settings } from "@cst/shared";
import {
  ingestSubmission,
  InvalidSubmissionError,
  retryJob,
  type UploadJob,
} from "../src/index.js";
import { HOUR, makeEvent, newId, newStore, T0 } from "./helpers.js";

const day: Pick<Settings, "period" | "timezone"> = {
  period: { kind: "calendar_day" },
  timezone: "UTC",
};
const opts = (now = T0, extra: object = {}) => ({
  userId: "u1",
  settings: day,
  now,
  newId,
  ...extra,
});

async function markSuccess(store: ReturnType<typeof newStore>, job: UploadJob) {
  await store.update({ ...job, status: "SUCCESS", uploadedAt: job.createdAt, event: undefined });
}

describe("ingestSubmission", () => {
  it("queues the first accepted submission", async () => {
    const store = newStore();
    const r = await ingestSubmission(store, await makeEvent(), opts());
    expect(r.decision).toBe("queued");
    expect(r.job).toMatchObject({ status: "QUEUED", attempts: 0, submissionId: "1001" });
  });

  it("returns the existing record for a repeated submission (idempotency)", async () => {
    const store = newStore();
    const a = await ingestSubmission(store, await makeEvent(), opts());
    const b = await ingestSubmission(store, await makeEvent(), opts());
    expect(b).toEqual({ decision: "existing", job: a.job });
    expect(await store.list()).toHaveLength(1);
  });

  it("skips a second accepted solution in the same window, uploads in the next", async () => {
    const store = newStore();
    const first = await ingestSubmission(store, await makeEvent(), opts());
    await markSuccess(store, first.job);
    const again = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "1002", submittedAt: T0 + HOUR }),
      opts(),
    );
    expect(again.decision).toBe("skipped");
    expect(again.job.lastError).toMatch(
      /Already uploaded during this period \(once per calendar day\)/,
    );
    const nextDay = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "1003", submittedAt: T0 + 24 * HOUR }),
      opts(),
    );
    expect(nextDay.decision).toBe("queued");
  });

  it("an in-flight job reserves the slot", async () => {
    const store = newStore();
    await ingestSubmission(store, await makeEvent(), opts());
    const second = await ingestSubmission(store, await makeEvent({ submissionId: "2" }), opts());
    expect(second.decision).toBe("skipped");
  });

  it("a permanently failed job releases the reservation", async () => {
    const store = newStore();
    const first = await ingestSubmission(store, await makeEvent(), opts());
    await store.update({ ...first.job, status: "FAILED_PERMANENT" });
    expect(
      (await ingestSubmission(store, await makeEvent({ submissionId: "2" }), opts())).decision,
    ).toBe("queued");
  });

  it("keeps problems and platforms independent, even with equal titles or keys", async () => {
    const store = newStore();
    await ingestSubmission(store, await makeEvent(), opts());
    const otherProblem = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "2", problemKey: "add-two-numbers" }),
      opts(),
    );
    const otherPlatform = await ingestSubmission(
      store,
      await makeEvent({
        submissionId: "3",
        platform: "codechef",
        problemKey: "two-sum",
        problemUrl: "https://www.codechef.com/problems/TWOSUM",
      }),
      opts(),
    );
    const sameTitle = await ingestSubmission(
      store,
      await makeEvent({
        submissionId: "4",
        platform: "codeforces",
        problemKey: "1A",
        problemTitle: "Two Sum",
        problemUrl: "https://codeforces.com/problemset/problem/1/A",
      }),
      opts(),
    );
    expect([otherProblem.decision, otherPlatform.decision, sameTitle.decision]).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
  });

  it("skips another language of the same problem in the same window", async () => {
    const store = newStore();
    await ingestSubmission(store, await makeEvent(), opts());
    const py = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "2", language: "python3" }),
      opts(),
    );
    expect(py.decision).toBe("skipped");
  });

  it("admits exactly one of many concurrent submissions for a problem", async () => {
    const store = newStore();
    const events = await Promise.all(
      Array.from({ length: 20 }, (_, i) => makeEvent({ submissionId: `c${i}` })),
    );
    const results = await Promise.all(events.map((e) => ingestSubmission(store, e, opts())));
    expect(results.filter((r) => r.decision === "queued")).toHaveLength(1);
    expect(results.filter((r) => r.decision === "skipped")).toHaveLength(19);
  });

  it("collapses concurrent identical events into one job", async () => {
    const store = newStore();
    const event = await makeEvent();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => ingestSubmission(store, event, opts())),
    );
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("force bypasses the window and revives a skipped record", async () => {
    const store = newStore();
    const first = await ingestSubmission(store, await makeEvent(), opts());
    await markSuccess(store, first.job);
    const forcedNew = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "2" }),
      opts(T0, { force: true }),
    );
    expect(forcedNew.decision).toBe("queued");

    const skipped = await ingestSubmission(store, await makeEvent({ submissionId: "3" }), opts());
    expect(skipped.decision).toBe("skipped");
    const revived = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "3" }),
      opts(T0, { force: true }),
    );
    expect(revived).toMatchObject({
      decision: "requeued",
      job: { status: "QUEUED", force: true, id: skipped.job.id },
    });
  });

  it("force never bypasses the accepted/source checks", async () => {
    const store = newStore();
    await expect(
      ingestSubmission(store, await makeEvent({ verdict: "REJECTED" }), opts(T0, { force: true })),
    ).rejects.toBeInstanceOf(InvalidSubmissionError);
    const e = await makeEvent();
    await expect(
      ingestSubmission(store, { ...e, sourceCode: e.sourceCode + " " }, opts(T0, { force: true })),
    ).rejects.toThrow(/hash mismatch/);
    await expect(
      ingestSubmission(store, { ...e, sourceCode: "" }, opts(T0, { force: true })),
    ).rejects.toBeInstanceOf(InvalidSubmissionError);
    expect(await store.list()).toEqual([]);
  });

  it("does not revive a SUCCESS record even when forced", async () => {
    const store = newStore();
    const first = await ingestSubmission(store, await makeEvent(), opts());
    await markSuccess(store, first.job);
    expect(
      (await ingestSubmission(store, await makeEvent(), opts(T0, { force: true }))).decision,
    ).toBe("existing");
  });
});

describe("retryJob", () => {
  it("requeues a failed job when still eligible", async () => {
    const store = newStore();
    const { job } = await ingestSubmission(store, await makeEvent(), opts());
    await store.update({ ...job, status: "FAILED_PERMANENT", attempts: 6, lastError: "x" });
    const retried = await retryJob(store, (await store.get(job.id))!, opts(T0 + 1));
    expect(retried).toMatchObject({ status: "QUEUED", attempts: 0, nextAttemptAt: T0 + 1 });
    expect(retried.lastError).toBeUndefined();
  });

  it("re-checks eligibility: skipped if another submission succeeded meanwhile", async () => {
    const store = newStore();
    const a = await ingestSubmission(store, await makeEvent(), opts());
    await store.update({ ...a.job, status: "FAILED_PERMANENT" });
    const b = await ingestSubmission(store, await makeEvent({ submissionId: "2" }), opts());
    await markSuccess(store, b.job);
    const retried = await retryJob(store, (await store.get(a.job.id))!, opts());
    expect(retried.status).toBe("SKIPPED_NOT_ELIGIBLE");
  });

  it("resumes a NEEDS_AUTH job", async () => {
    const store = newStore();
    const { job } = await ingestSubmission(store, await makeEvent(), opts());
    await store.update({ ...job, status: "NEEDS_AUTH" });
    expect((await retryJob(store, (await store.get(job.id))!, opts())).status).toBe("QUEUED");
  });
});

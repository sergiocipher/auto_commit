import { describe, expect, it } from "vitest";
import type { PeriodPolicy } from "@cst/shared";
import { ingestSubmission, type UploadJob } from "../src/index.js";
import { makeEvent, newId, newStore } from "./helpers.js";

// End-to-end dedup decisions at the edges of every period policy: a prior
// SUCCESS at `prev`, then a new accepted submission at `next`.

const at = (iso: string) => Date.parse(iso);
const MS = 1;

// prettier-ignore
type Row = [label: string, policy: PeriodPolicy, tz: string, prev: number, next: number, expected: "queued" | "skipped"];

const day: PeriodPolicy = { kind: "calendar_day" };
const monWeek: PeriodPolicy = { kind: "calendar_week", weekStartsOn: 1 };
const sunWeek: PeriodPolicy = { kind: "calendar_week", weekStartsOn: 0 };
const month: PeriodPolicy = { kind: "calendar_month" };

// prettier-ignore
const rows: Row[] = [
  // calendar_day: local midnight, not UTC midnight
  ["day: last ms of the IST day", day, "Asia/Kolkata", at("2024-03-10T00:00:00Z"), at("2024-03-10T18:29:59.999Z"), "skipped"],
  ["day: first ms of the next IST day", day, "Asia/Kolkata", at("2024-03-10T00:00:00Z"), at("2024-03-10T18:30:00Z"), "queued"],
  ["day: UTC midnight is not an IST boundary", day, "Asia/Kolkata", at("2024-03-09T23:00:00Z"), at("2024-03-10T01:00:00Z"), "skipped"],
  // calendar_day across DST in New York
  ["day: 23-hour spring-forward day, last ms", day, "America/New_York", at("2024-03-10T05:00:00Z"), at("2024-03-11T03:59:59.999Z"), "skipped"],
  ["day: after the spring-forward day", day, "America/New_York", at("2024-03-10T05:00:00Z"), at("2024-03-11T04:00:00Z"), "queued"],
  ["day: 25-hour fall-back day, last ms", day, "America/New_York", at("2024-11-03T04:00:00Z"), at("2024-11-04T04:59:59.999Z"), "skipped"],
  ["day: after the fall-back day", day, "America/New_York", at("2024-11-03T04:00:00Z"), at("2024-11-04T05:00:00Z"), "queued"],
  // leap day
  ["day: Feb 28 to leap day", day, "UTC", at("2024-02-28T23:59:59.999Z"), at("2024-02-29T00:00:00Z"), "queued"],
  ["day: leap day to Mar 1", day, "UTC", at("2024-02-29T23:59:59.999Z"), at("2024-03-01T00:00:00Z"), "queued"],
  ["day: within the leap day", day, "UTC", at("2024-02-29T00:00:00Z"), at("2024-02-29T23:59:59.999Z"), "skipped"],
  // calendar_week: Monday vs Sunday start
  ["week(Mon): Sunday then Monday", monWeek, "UTC", at("2024-03-10T12:00:00Z"), at("2024-03-11T00:00:00Z"), "queued"],
  ["week(Mon): Monday then Sunday", monWeek, "UTC", at("2024-03-11T00:00:00Z"), at("2024-03-17T23:59:59.999Z"), "skipped"],
  ["week(Sun): Saturday then Sunday", sunWeek, "UTC", at("2024-03-09T23:59:59.999Z"), at("2024-03-10T00:00:00Z"), "queued"],
  ["week(Sun): Sunday then Saturday", sunWeek, "UTC", at("2024-03-10T00:00:00Z"), at("2024-03-16T23:59:59.999Z"), "skipped"],
  ["week(Mon): local weekday in IST", monWeek, "Asia/Kolkata", at("2024-03-10T18:29:59.999Z"), at("2024-03-10T18:30:00Z"), "queued"],
  ["week(Mon): year boundary inside one week", monWeek, "UTC", at("2024-12-30T00:00:00Z"), at("2025-01-05T23:59:59.999Z"), "skipped"],
  ["week(Mon): week containing the DST change", monWeek, "America/New_York", at("2024-03-04T05:00:00Z"), at("2024-03-11T03:59:59.999Z"), "skipped"],
  // calendar_month: month ends, leap February, December rollover
  ["month: Jan 31 to Feb 1", month, "UTC", at("2024-01-31T23:59:59.999Z"), at("2024-02-01T00:00:00Z"), "queued"],
  ["month: Feb 1 to leap day", month, "UTC", at("2024-02-01T00:00:00Z"), at("2024-02-29T23:59:59.999Z"), "skipped"],
  ["month: leap day to Mar 1", month, "UTC", at("2024-02-29T23:59:59.999Z"), at("2024-03-01T00:00:00Z"), "queued"],
  ["month: December to January", month, "UTC", at("2024-12-31T23:59:59.999Z"), at("2025-01-01T00:00:00Z"), "queued"],
  ["month: local month end in IST", month, "Asia/Kolkata", at("2024-01-31T18:29:59.999Z"), at("2024-01-31T18:30:00Z"), "queued"],
  // duration policies ignore calendars
  ["rolling_24h: 1 ms short of 24h", { kind: "rolling_24h" }, "UTC", at("2024-03-10T10:00:00Z"), at("2024-03-11T09:59:59.999Z"), "skipped"],
  ["rolling_24h: exactly 24h", { kind: "rolling_24h" }, "UTC", at("2024-03-10T10:00:00Z"), at("2024-03-11T10:00:00Z"), "queued"],
  ["rolling_24h: across the 23-hour DST day", { kind: "rolling_24h" }, "America/New_York", at("2024-03-10T05:00:00Z"), at("2024-03-11T04:59:59.999Z"), "skipped"],
  ["custom 6h: 1 ms short", { kind: "custom_hours", hours: 6 }, "UTC", at("2024-03-10T10:00:00Z"), at("2024-03-10T16:00:00Z") - MS, "skipped"],
  ["custom 6h: exactly 6h", { kind: "custom_hours", hours: 6 }, "UTC", at("2024-03-10T10:00:00Z"), at("2024-03-10T16:00:00Z"), "queued"],
  ["custom 1.5h: fractional hours", { kind: "custom_hours", hours: 1.5 }, "UTC", at("2024-03-10T10:00:00Z"), at("2024-03-10T11:30:00Z"), "queued"],
  ["custom 1.5h: fractional, 1 ms short", { kind: "custom_hours", hours: 1.5 }, "UTC", at("2024-03-10T10:00:00Z"), at("2024-03-10T11:30:00Z") - MS, "skipped"],
  // permanent
  ["permanent: years later", { kind: "permanent" }, "UTC", at("2024-03-10T10:00:00Z"), at("2034-03-10T10:00:00Z"), "skipped"],
];

async function decide(policy: PeriodPolicy, timezone: string, prev: number, next: number) {
  const store = newStore();
  const opts = { userId: "u1", settings: { period: policy, timezone }, now: next, newId };
  const first = await ingestSubmission(store, await makeEvent({ submittedAt: prev }), opts);
  await store.update({ ...first.job, status: "SUCCESS", event: undefined });
  return ingestSubmission(store, await makeEvent({ submissionId: "2", submittedAt: next }), opts);
}

describe("period policies through ingest", () => {
  it.each(rows)("%s", async (_label, policy, tz, prev, next, expected) => {
    expect((await decide(policy, tz, prev, next)).decision).toBe(expected);
  });
});

describe("what blocks a window", () => {
  const settings = { period: { kind: "calendar_day" } as PeriodPolicy, timezone: "UTC" };
  const T = at("2024-03-10T10:00:00Z");

  async function withPrior(status: UploadJob["status"]) {
    const store = newStore();
    const opts = { userId: "u1", settings, now: T, newId };
    const first = await ingestSubmission(store, await makeEvent(), opts);
    await store.update({ ...first.job, status });
    return ingestSubmission(store, await makeEvent({ submissionId: "2" }), opts);
  }

  it.each([
    ["SUCCESS", "skipped"],
    ["QUEUED", "skipped"],
    ["UPLOADING", "skipped"],
    ["RETRYING", "skipped"],
    ["NEEDS_AUTH", "skipped"],
    ["HELD", "queued"],
    ["FAILED_PERMANENT", "queued"],
    ["SKIPPED_NOT_ELIGIBLE", "queued"],
  ] as const)("a prior %s job → %s", async (status, expected) => {
    expect((await withPrior(status)).decision).toBe(expected);
  });

  it("a success on another platform or problem never blocks", async () => {
    const store = newStore();
    const opts = { userId: "u1", settings, now: T, newId };
    const first = await ingestSubmission(store, await makeEvent(), opts);
    await store.update({ ...first.job, status: "SUCCESS" });
    const otherProblem = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "2", problemKey: "3sum", problemTitle: "3Sum" }),
      opts,
    );
    // Same title and key on another platform is a different problem.
    const otherPlatform = await ingestSubmission(
      store,
      await makeEvent({
        submissionId: "3",
        platform: "codechef",
        problemUrl: "https://www.codechef.com/problems/TWOSUM",
      }),
      opts,
    );
    expect([otherProblem.decision, otherPlatform.decision]).toEqual(["queued", "queued"]);
  });

  it("applies the policy in force at decision time", async () => {
    const store = newStore();
    const daily = { userId: "u1", settings, now: T, newId };
    const first = await ingestSubmission(store, await makeEvent(), daily);
    await store.update({ ...first.job, status: "SUCCESS" });
    const nextDay = T + 24 * 3_600_000;
    const permanent = {
      ...daily,
      settings: { period: { kind: "permanent" } as PeriodPolicy, timezone: "UTC" },
    };
    const r = await ingestSubmission(
      store,
      await makeEvent({ submissionId: "2", submittedAt: nextDay }),
      permanent,
    );
    expect(r.decision).toBe("skipped");
    expect(r.job.lastError).toMatch(/first accepted solution only/);
  });
});

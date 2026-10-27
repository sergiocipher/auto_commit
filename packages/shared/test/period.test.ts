import { describe, expect, it } from "vitest";
import {
  isEligible,
  isWithinSameWindow,
  periodBucket,
  startOfLocalDay,
  windowBounds,
  type PeriodPolicy,
} from "../src/index.js";

const t = (iso: string) => Date.parse(iso);
const day: PeriodPolicy = { kind: "calendar_day" };
const month: PeriodPolicy = { kind: "calendar_month" };
const weekSun: PeriodPolicy = { kind: "calendar_week", weekStartsOn: 0 };
const weekMon: PeriodPolicy = { kind: "calendar_week", weekStartsOn: 1 };

describe("calendar_day", () => {
  it("splits at local midnight in Asia/Kolkata (UTC+05:30)", () => {
    const before = t("2024-03-10T18:29:59.999Z"); // 23:59:59.999 IST
    const after = t("2024-03-10T18:30:00.000Z"); // 00:00 IST next day
    expect(periodBucket(day, before, "Asia/Kolkata")).toBe("day:2024-03-10");
    expect(periodBucket(day, after, "Asia/Kolkata")).toBe("day:2024-03-11");
    expect(isWithinSameWindow(day, "Asia/Kolkata", before, after)).toBe(false);
    // The same two instants are the same UTC day.
    expect(isWithinSameWindow(day, "UTC", before, after)).toBe(true);
  });

  it("handles the 23-hour spring-forward day in America/New_York", () => {
    const b = windowBounds(day, t("2024-03-10T12:00:00Z"), "America/New_York");
    expect(b.start).toBe(t("2024-03-10T05:00:00Z"));
    expect(b.end).toBe(t("2024-03-11T04:00:00Z"));
    expect(b.end! - b.start!).toBe(23 * 3_600_000);
  });

  it("handles the 25-hour fall-back day in America/New_York", () => {
    const b = windowBounds(day, t("2024-11-03T12:00:00Z"), "America/New_York");
    expect(b.start).toBe(t("2024-11-03T04:00:00Z"));
    expect(b.end).toBe(t("2024-11-04T05:00:00Z"));
    // Both passes through the repeated 01:xx hour are the same local day.
    expect(
      isWithinSameWindow(
        day,
        "America/New_York",
        t("2024-11-03T05:30:00Z"),
        t("2024-11-03T06:30:00Z"),
      ),
    ).toBe(true);
  });

  it("finds the start of a day whose midnight is skipped (America/Santiago)", () => {
    // Chile jumped 00:00 -> 01:00 on 2024-09-08; the day starts at 01:00 local.
    expect(startOfLocalDay({ year: 2024, month: 9, day: 8 }, "America/Santiago")).toBe(
      t("2024-09-08T04:00:00Z"),
    );
  });

  it("treats a leap day as its own bucket", () => {
    expect(periodBucket(day, t("2024-02-29T10:00:00Z"), "UTC")).toBe("day:2024-02-29");
    expect(
      isWithinSameWindow(day, "UTC", t("2024-02-29T23:59:59Z"), t("2024-03-01T00:00:00Z")),
    ).toBe(false);
  });
});

describe("calendar_week", () => {
  it("respects Sunday vs Monday week start", () => {
    const sunday = t("2024-03-03T12:00:00Z");
    expect(periodBucket(weekSun, sunday, "UTC")).toBe("week0:2024-03-03");
    expect(periodBucket(weekMon, sunday, "UTC")).toBe("week1:2024-02-26");
    const saturday = t("2024-03-02T12:00:00Z");
    expect(isWithinSameWindow(weekSun, "UTC", saturday, sunday)).toBe(false);
    expect(isWithinSameWindow(weekMon, "UTC", saturday, sunday)).toBe(true);
  });

  it("spans a year boundary", () => {
    expect(periodBucket(weekMon, t("2024-12-31T12:00:00Z"), "UTC")).toBe("week1:2024-12-30");
    expect(
      isWithinSameWindow(weekMon, "UTC", t("2024-12-31T12:00:00Z"), t("2025-01-05T12:00:00Z")),
    ).toBe(true);
  });

  it("computes the week containing a leap day", () => {
    expect(periodBucket(weekMon, t("2024-02-29T12:00:00Z"), "UTC")).toBe("week1:2024-02-26");
    expect(periodBucket(weekSun, t("2024-02-29T12:00:00Z"), "UTC")).toBe("week0:2024-02-25");
  });

  it("uses the local weekday, not the UTC weekday", () => {
    // 2024-03-03T20:00Z is Monday 01:30 in Kolkata.
    expect(periodBucket(weekMon, t("2024-03-03T20:00:00Z"), "Asia/Kolkata")).toBe(
      "week1:2024-03-04",
    );
  });

  it("has 7-day bounds across a DST change", () => {
    const b = windowBounds(weekSun, t("2024-03-12T12:00:00Z"), "America/New_York");
    expect(b.start).toBe(t("2024-03-10T05:00:00Z"));
    expect(b.end).toBe(t("2024-03-17T04:00:00Z"));
  });
});

describe("calendar_month", () => {
  it("splits at month end in Europe/London winter and summer", () => {
    expect(periodBucket(month, t("2024-01-31T23:59:59Z"), "Europe/London")).toBe("month:2024-01");
    expect(periodBucket(month, t("2024-02-01T00:00:00Z"), "Europe/London")).toBe("month:2024-02");
    // 23:00Z on June 30 is 00:00 BST July 1.
    expect(periodBucket(month, t("2024-06-30T23:00:00Z"), "Europe/London")).toBe("month:2024-07");
  });

  it("bounds February in a leap year and December rollover", () => {
    const feb = windowBounds(month, t("2024-02-15T00:00:00Z"), "UTC");
    expect(feb.start).toBe(t("2024-02-01T00:00:00Z"));
    expect(feb.end).toBe(t("2024-03-01T00:00:00Z"));
    const dec = windowBounds(month, t("2024-12-15T00:00:00Z"), "UTC");
    expect(dec.end).toBe(t("2025-01-01T00:00:00Z"));
  });
});

describe("duration policies", () => {
  const rolling: PeriodPolicy = { kind: "rolling_24h" };
  it("rolling_24h blocks strictly inside 24h", () => {
    const a = t("2024-03-10T10:00:00Z");
    expect(isWithinSameWindow(rolling, "UTC", a, a + 24 * 3_600_000 - 1)).toBe(true);
    expect(isWithinSameWindow(rolling, "UTC", a, a + 24 * 3_600_000)).toBe(false);
  });

  it("rolling windows ignore calendar midnight", () => {
    expect(
      isWithinSameWindow(rolling, "UTC", t("2024-03-10T23:00:00Z"), t("2024-03-11T01:00:00Z")),
    ).toBe(true);
    expect(periodBucket(rolling, 0, "UTC")).toBeNull();
  });

  it("custom_hours uses the configured length", () => {
    const p: PeriodPolicy = { kind: "custom_hours", hours: 6 };
    const a = t("2024-03-10T00:00:00Z");
    expect(isWithinSameWindow(p, "UTC", a, a + 6 * 3_600_000 - 1)).toBe(true);
    expect(isWithinSameWindow(p, "UTC", a, a + 6 * 3_600_000)).toBe(false);
  });

  it("an older submission arriving late is still blocked (spec formula)", () => {
    const later = t("2024-03-10T12:00:00Z");
    expect(isWithinSameWindow(rolling, "UTC", later, later - 3_600_000)).toBe(true);
  });
});

describe("permanent and isEligible", () => {
  const permanent: PeriodPolicy = { kind: "permanent" };
  it("permanent blocks any prior success", () => {
    expect(
      isEligible(permanent, "UTC", t("2030-01-01T00:00:00Z"), [t("2020-01-01T00:00:00Z")]),
    ).toBe(false);
    expect(isEligible(permanent, "UTC", t("2030-01-01T00:00:00Z"), [])).toBe(true);
    expect(periodBucket(permanent, 0, "UTC")).toBe("permanent");
  });

  it("is eligible again in a new window", () => {
    const prior = [t("2024-03-10T10:00:00Z")];
    expect(isEligible(day, "UTC", t("2024-03-10T20:00:00Z"), prior)).toBe(false);
    expect(isEligible(day, "UTC", t("2024-03-11T00:00:00Z"), prior)).toBe(true);
  });
});

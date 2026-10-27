import type { PeriodPolicy } from "./schemas.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Calendar date of instant `ts` as seen in IANA zone `timeZone`. */
export function localDate(ts: number, timeZone: string): LocalDate {
  const out: Partial<LocalDate> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ts))) {
    if (p.type === "year" || p.type === "month" || p.type === "day") out[p.type] = Number(p.value);
  }
  if (!out.year || !out.month || !out.day) throw new Error(`cannot resolve date in ${timeZone}`);
  return out as LocalDate;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function dateKey(d: LocalDate): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

/** Shifts a calendar date by whole days (pure calendar arithmetic, no zones). */
function addDays(d: LocalDate, days: number): LocalDate {
  const u = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: u.getUTCFullYear(), month: u.getUTCMonth() + 1, day: u.getUTCDate() };
}

function weekday(d: LocalDate): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

function compareDates(a: LocalDate, b: LocalDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * First instant whose local date in `timeZone` is on or after `d`.
 * Binary search keeps this correct when midnight is skipped by a DST jump.
 */
export function startOfLocalDay(d: LocalDate, timeZone: string): number {
  const utcMidnight = Date.UTC(d.year, d.month - 1, d.day);
  let lo = utcMidnight - 15 * HOUR_MS; // local midnight is never earlier (max offset +14)
  let hi = utcMidnight + 15 * HOUR_MS; // nor later (min offset -12)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (compareDates(localDate(mid, timeZone), d) >= 0) hi = mid;
    else lo = mid;
  }
  return hi;
}

function calendarBucketStart(policy: PeriodPolicy, ts: number, timeZone: string): LocalDate {
  const d = localDate(ts, timeZone);
  switch (policy.kind) {
    case "calendar_day":
      return d;
    case "calendar_week":
      return addDays(d, -((weekday(d) - policy.weekStartsOn + 7) % 7));
    case "calendar_month":
      return { year: d.year, month: d.month, day: 1 };
    default:
      throw new Error(`${policy.kind} is not a calendar policy`);
  }
}

function isCalendar(policy: PeriodPolicy): boolean {
  return (
    policy.kind === "calendar_day" ||
    policy.kind === "calendar_week" ||
    policy.kind === "calendar_month"
  );
}

/** Window length for duration-based policies, in ms. */
function durationMs(policy: PeriodPolicy): number | undefined {
  if (policy.kind === "rolling_24h") return DAY_MS;
  if (policy.kind === "custom_hours") return policy.hours * HOUR_MS;
  return undefined;
}

/**
 * Bucket identifier for calendar policies (e.g. "day:2024-03-10"), used for
 * equality checks and database reservation keys. Duration-based policies
 * have no fixed buckets and return null; permanent returns "permanent".
 */
export function periodBucket(policy: PeriodPolicy, ts: number, timeZone: string): string | null {
  if (policy.kind === "permanent") return "permanent";
  if (!isCalendar(policy)) return null;
  const start = calendarBucketStart(policy, ts, timeZone);
  if (policy.kind === "calendar_month") return `month:${pad(start.year, 4)}-${pad(start.month)}`;
  const prefix = policy.kind === "calendar_week" ? `week${policy.weekStartsOn}` : "day";
  return `${prefix}:${dateKey(start)}`;
}

/**
 * Whether a prior successful upload at `previousAt` blocks a new submission
 * at `submittedAt` under `policy`. Both are submission times (epoch ms).
 */
export function isWithinSameWindow(
  policy: PeriodPolicy,
  timeZone: string,
  previousAt: number,
  submittedAt: number,
): boolean {
  if (policy.kind === "permanent") return true;
  const duration = durationMs(policy);
  if (duration !== undefined) return submittedAt - previousAt < duration;
  return periodBucket(policy, previousAt, timeZone) === periodBucket(policy, submittedAt, timeZone);
}

/** True when none of the prior successful uploads block `submittedAt`. */
export function isEligible(
  policy: PeriodPolicy,
  timeZone: string,
  submittedAt: number,
  priorSuccessAt: readonly number[],
): boolean {
  return !priorSuccessAt.some((prev) => isWithinSameWindow(policy, timeZone, prev, submittedAt));
}

export interface WindowBounds {
  /** Inclusive start (epoch ms), or null when unbounded. */
  start: number | null;
  /** Exclusive end (epoch ms), or null when unbounded. */
  end: number | null;
}

/**
 * Bounds of the window containing `ts`. For calendar policies these are the
 * local bucket edges; for duration policies, the look-back range that can
 * block `ts`; for permanent, unbounded. Useful for narrowing DB queries and
 * for "resets at" display; eligibility itself is decided by isEligible.
 */
export function windowBounds(policy: PeriodPolicy, ts: number, timeZone: string): WindowBounds {
  if (policy.kind === "permanent") return { start: null, end: null };
  const duration = durationMs(policy);
  if (duration !== undefined) return { start: ts - duration + 1, end: ts + 1 };
  const start = calendarBucketStart(policy, ts, timeZone);
  let next: LocalDate;
  if (policy.kind === "calendar_day") next = addDays(start, 1);
  else if (policy.kind === "calendar_week") next = addDays(start, 7);
  else
    next =
      start.month === 12
        ? { year: start.year + 1, month: 1, day: 1 }
        : { year: start.year, month: start.month + 1, day: 1 };
  return { start: startOfLocalDay(start, timeZone), end: startOfLocalDay(next, timeZone) };
}

/** Human-readable policy description, e.g. for "already uploaded" messages. */
export function describePeriod(p: PeriodPolicy): string {
  switch (p.kind) {
    case "calendar_day":
      return "once per calendar day";
    case "rolling_24h":
      return "once per rolling 24 hours";
    case "calendar_week":
      return `once per week starting ${p.weekStartsOn === 0 ? "Sunday" : "Monday"}`;
    case "calendar_month":
      return "once per calendar month";
    case "permanent":
      return "first accepted solution only";
    case "custom_hours":
      return `once per ${p.hours} hours`;
  }
}

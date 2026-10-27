import { z } from "zod";
import { SubmissionEventSchema, type SubmissionEvent, type UploadStatus } from "@cst/shared";
import type { KeyValueStore } from "../storage.js";
import { submissionKey } from "../platforms.js";
import { createSerialLock } from "../lock.js";

export const OUTBOX_STORAGE_KEY = "outbox:v1";
export const MAX_OUTBOX_ITEMS = 200;
export const MAX_SEEN_KEYS = 2000;
const BASE_DELAY_MS = 5_000;
export const MAX_DELAY_MS = 30 * 60_000;

const OutboxItemSchema = z.strictObject({
  key: z.string(),
  event: SubmissionEventSchema,
  attempts: z.number().int().nonnegative(),
  enqueuedAt: z.number(),
  nextAttemptAt: z.number(),
  lastError: z.string().optional(),
});
export type OutboxItem = z.infer<typeof OutboxItemSchema>;

const OutboxStateSchema = z.object({
  items: z.array(z.unknown()),
  seen: z.array(z.tuple([z.string(), z.number()])),
});
interface OutboxState {
  items: OutboxItem[];
  seen: [string, number][];
}

/**
 * Outcome of handing an event to the upload sink.
 * - accepted: the sink owns it now (it has its own record/status); leave the outbox.
 * - rejected: permanently invalid; leave the outbox, report the error.
 * - retry: transient; keep it and back off.
 */
export type DeliveryResult =
  | { kind: "accepted"; status: UploadStatus; detail?: string }
  | { kind: "rejected"; error: string }
  | { kind: "retry"; error: string; retryAfterMs?: number };
export type Deliver = (event: SubmissionEvent) => Promise<DeliveryResult>;

export interface DeliveryReport {
  key: string;
  event: SubmissionEvent;
  result: DeliveryResult;
}

/** Exponential backoff with jitter in [50%, 100%] of the capped delay. */
export function backoffDelay(attempts: number, random: () => number = Math.random): number {
  const capped = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(capped * (0.5 + random() * 0.5));
}

/**
 * Persistent queue of accepted submissions awaiting delivery to the sink,
 * plus a bounded "seen" cache for early duplicate suppression. All state
 * lives in storage so a service-worker restart loses nothing; operations
 * are serialized so concurrent messages cannot clobber each other.
 */
export class Outbox {
  private readonly lock = createSerialLock();
  private draining = false;
  private drainAgain = false;

  constructor(
    private readonly store: KeyValueStore,
    private readonly random: () => number = Math.random,
  ) {}

  private async load(): Promise<OutboxState> {
    const parsed = OutboxStateSchema.safeParse(await this.store.get(OUTBOX_STORAGE_KEY));
    if (!parsed.success) return { items: [], seen: [] };
    const items: OutboxItem[] = [];
    for (const raw of parsed.data.items) {
      const item = OutboxItemSchema.safeParse(raw);
      if (item.success) items.push(item.data);
    }
    return { items, seen: parsed.data.seen };
  }

  private async save(state: OutboxState): Promise<void> {
    await this.store.set(OUTBOX_STORAGE_KEY, state);
  }

  /** Adds an accepted event unless its submission was already seen. */
  enqueue(event: SubmissionEvent, now: number): Promise<"enqueued" | "duplicate" | "full"> {
    return this.lock(async () => {
      const state = await this.load();
      const key = submissionKey(event.platform, event.submissionId);
      if (state.seen.some(([k]) => k === key) || state.items.some((i) => i.key === key)) {
        return "duplicate";
      }
      if (state.items.length >= MAX_OUTBOX_ITEMS) return "full";
      state.items.push({ key, event, attempts: 0, enqueuedAt: now, nextAttemptAt: now });
      state.seen.push([key, now]);
      if (state.seen.length > MAX_SEEN_KEYS)
        state.seen.splice(0, state.seen.length - MAX_SEEN_KEYS);
      await this.save(state);
      return "enqueued";
    });
  }

  list(): Promise<OutboxItem[]> {
    return this.lock(async () => (await this.load()).items);
  }

  /** Earliest pending attempt time, for scheduling the next wake-up. */
  async nextAttemptAt(): Promise<number | null> {
    const items = await this.list();
    return items.length ? Math.min(...items.map((i) => i.nextAttemptAt)) : null;
  }

  /** Makes one item (or all) due immediately. */
  retryNow(now: number, key?: string): Promise<void> {
    return this.lock(async () => {
      const state = await this.load();
      for (const item of state.items) if (!key || item.key === key) item.nextAttemptAt = now;
      await this.save(state);
    });
  }

  /** Drops queued items and the seen cache. */
  clear(): Promise<void> {
    return this.lock(() => this.store.remove(OUTBOX_STORAGE_KEY));
  }

  /**
   * Delivers every due item. Delivery runs outside the lock so new events
   * can be enqueued meanwhile; a concurrent call schedules one more pass
   * instead of delivering the same item twice.
   */
  async drain(deliver: Deliver, now: () => number): Promise<DeliveryReport[]> {
    if (this.draining) {
      this.drainAgain = true;
      return [];
    }
    this.draining = true;
    const reports: DeliveryReport[] = [];
    try {
      do {
        this.drainAgain = false;
        const due = (await this.list()).filter((i) => i.nextAttemptAt <= now());
        for (const item of due) {
          let result: DeliveryResult;
          try {
            result = await deliver(item.event);
          } catch (err) {
            result = { kind: "retry", error: err instanceof Error ? err.message : String(err) };
          }
          await this.applyResult(item.key, result, now());
          reports.push({ key: item.key, event: item.event, result });
        }
      } while (this.drainAgain);
    } finally {
      this.draining = false;
    }
    return reports;
  }

  private applyResult(key: string, result: DeliveryResult, now: number): Promise<void> {
    return this.lock(async () => {
      const state = await this.load();
      const idx = state.items.findIndex((i) => i.key === key);
      if (idx === -1) return; // cleared while delivering
      if (result.kind === "retry") {
        const item = state.items[idx]!;
        item.attempts += 1;
        item.lastError = result.error;
        item.nextAttemptAt =
          now + Math.max(result.retryAfterMs ?? 0, backoffDelay(item.attempts, this.random));
      } else {
        state.items.splice(idx, 1);
      }
      await this.save(state);
    });
  }
}

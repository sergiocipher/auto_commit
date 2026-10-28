import { z } from "zod";
import type { Platform } from "@cst/shared";
import type { DedupStore } from "./dedup.js";
import { isRunnable, UploadJobSchema, type UploadJob } from "./jobs.js";

/** Minimal async key-value store (chrome.storage.local, a Map, ...). */
export interface KeyValue {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export const JOBS_STORAGE_KEY = "jobs:v1";
/**
 * Skipped and held records beyond this many are pruned (oldest first), which
 * also bounds how much held source code is kept. SUCCESS records are kept:
 * they drive dedup.
 */
export const MAX_SKIPPED_JOBS = 500;

type Chain = Promise<unknown>;

function serial(chains: Map<string, Chain>, key: string) {
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => undefined);
    chains.set(key, settled);
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return run;
  };
}

/**
 * DedupStore over a single key in a key-value store. Two lock levels: a
 * per-problem lock for dedup decisions (withProblemLock) and one storage
 * lock for each read-modify-write. The storage lock is never held while
 * waiting for a problem lock, so the two cannot deadlock.
 */
export class KeyValueJobStore implements DedupStore {
  private readonly problemChains = new Map<string, Chain>();
  private readonly storageChains = new Map<string, Chain>();

  constructor(private readonly kv: KeyValue) {}

  private storage<T>(fn: () => Promise<T>): Promise<T> {
    return serial(this.storageChains, "storage")(fn);
  }

  private async load(): Promise<UploadJob[]> {
    const parsed = z.array(z.unknown()).safeParse(await this.kv.get(JOBS_STORAGE_KEY));
    if (!parsed.success) return [];
    return parsed.data.flatMap((raw) => {
      const job = UploadJobSchema.safeParse(raw);
      return job.success ? [job.data] : [];
    });
  }

  private async save(jobs: UploadJob[]): Promise<void> {
    const skipped = jobs.filter(
      (j) =>
        j.status === "SKIPPED_NOT_ELIGIBLE" ||
        j.status === "SKIPPED_DUPLICATE" ||
        j.status === "HELD",
    );
    let pruned = jobs;
    if (skipped.length > MAX_SKIPPED_JOBS) {
      const drop = new Set(
        skipped
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, skipped.length - MAX_SKIPPED_JOBS)
          .map((j) => j.id),
      );
      pruned = jobs.filter((j) => !drop.has(j.id));
    }
    await this.kv.set(JOBS_STORAGE_KEY, pruned);
  }

  withProblemLock<T>(
    userId: string,
    platform: Platform,
    problemKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return serial(this.problemChains, `${userId}\u0000${platform}\u0000${problemKey}`)(fn);
  }

  findBySubmission(platform: Platform, submissionId: string): Promise<UploadJob | undefined> {
    return this.storage(async () =>
      (await this.load()).find((j) => j.platform === platform && j.submissionId === submissionId),
    );
  }

  listByProblem(userId: string, platform: Platform, problemKey: string): Promise<UploadJob[]> {
    return this.storage(async () =>
      (await this.load()).filter(
        (j) => j.userId === userId && j.platform === platform && j.problemKey === problemKey,
      ),
    );
  }

  insert(job: UploadJob): Promise<void> {
    return this.storage(async () => {
      const jobs = await this.load();
      if (
        jobs.some(
          (j) =>
            j.id === job.id || (j.platform === job.platform && j.submissionId === job.submissionId),
        )
      ) {
        throw new Error("duplicate job"); // mirrors the DB unique constraint
      }
      jobs.push(UploadJobSchema.parse(job));
      await this.save(jobs);
    });
  }

  update(job: UploadJob): Promise<void> {
    return this.storage(async () => {
      const jobs = await this.load();
      const idx = jobs.findIndex((j) => j.id === job.id);
      if (idx === -1) throw new Error("job not found");
      jobs[idx] = UploadJobSchema.parse(job);
      await this.save(jobs);
    });
  }

  get(id: string): Promise<UploadJob | undefined> {
    return this.storage(async () => (await this.load()).find((j) => j.id === id));
  }

  /** All jobs, newest first. */
  list(): Promise<UploadJob[]> {
    return this.storage(async () => (await this.load()).sort((a, b) => b.createdAt - a.createdAt));
  }

  listRunnable(now: number): Promise<UploadJob[]> {
    return this.storage(async () => (await this.load()).filter((j) => isRunnable(j, now)));
  }

  /** Earliest nextAttemptAt among runnable-later jobs, or null. */
  nextWakeAt(): Promise<number | null> {
    return this.storage(async () => {
      const times = (await this.load())
        .filter((j) => j.status === "QUEUED" || j.status === "RETRYING")
        .map((j) => j.nextAttemptAt ?? 0);
      return times.length ? Math.min(...times) : null;
    });
  }

  clear(): Promise<void> {
    return this.storage(() => this.kv.remove(JOBS_STORAGE_KEY));
  }
}

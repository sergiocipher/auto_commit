import type { UploadJob, UploadSummary } from "@cst/core";
import { problemFolder, type Platform, type Settings, type SubmissionEvent } from "@cst/shared";
import { ContentMessageSchema, PageMessageSchema, type Reply } from "../messages.js";
import { platformForUrl } from "../platforms.js";
import type { ActivityEntry, ActivityLog } from "./activity.js";
import type { ConnectProgress, GitHubStatus, RepoSummary } from "./githubAuth.js";
import type { Outbox } from "./outbox.js";
import { classifySender } from "./senders.js";
import type { SettingsStore } from "./settings.js";

/** GitHub connection operations; implemented by GitHubAuth in local mode. */
export interface GitHubService {
  status(): Promise<GitHubStatus>;
  start(): Promise<ConnectProgress>;
  poll(): Promise<ConnectProgress>;
  disconnect(): Promise<void>;
  repos(): Promise<RepoSummary[]>;
  branches(owner: string, name: string): Promise<string[]>;
}

export type { UploadSummary } from "@cst/core";

export interface UploadHistory {
  uploads: UploadSummary[];
  uploadedCount: number;
}

/** Pairing with a self-hosted backend (backend mode). */
export interface BackendControl {
  status(): Promise<BackendStatus>;
  pair(url: string, code: string): Promise<BackendStatus>;
  unpair(): Promise<void>;
  /** Pushes saved settings to the backend; no-op in local mode. */
  pushSettings(settings: Settings): Promise<void>;
}

export interface BackendStatus {
  paired: boolean;
  url?: string;
}

/** Upload-job operations; implemented by LocalUploader in local mode. */
export interface UploadService {
  /** Retry, manual upload of a held job, or with `force`, upload despite the period. */
  retry(
    platform: Platform,
    submissionId: string,
    options?: { force?: boolean },
  ): Promise<UploadJob | undefined>;
  /** Retries every failed or needs-auth job; returns how many were queued. */
  retryFailed(): Promise<number>;
  /** Recent jobs, newest first, plus the count of all successful uploads. */
  history(): Promise<UploadHistory>;
  /** Resume jobs that were waiting for GitHub auth. */
  onConnected(): Promise<void>;
  /** Removes stored jobs (part of "clear local data"). */
  clear(): Promise<void>;
}

export interface HandlerDeps {
  extensionId: string;
  outbox: Outbox;
  activity: ActivityLog;
  settings: SettingsStore;
  now: () => number;
  sha256: (text: string) => Promise<string>;
  github: GitHubService;
  uploads: UploadService;
  backend: BackendControl;
  /** Kicks off delivery of due outbox items and due uploads (fire-and-forget). */
  requestDrain: () => void;
}

/** Outbox item as exposed to the popup: never includes source code. */
export interface OutboxSummary {
  key: string;
  platform: SubmissionEvent["platform"];
  submissionId: string;
  problemTitle: string;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

export interface PopupState {
  settings: Settings;
  github: GitHubStatus;
  activity: ActivityEntry[];
  outbox: OutboxSummary[];
  /** Newest first, at most MAX_HISTORY_IN_STATE entries. */
  uploads: UploadSummary[];
  /** Every successful upload still on record (not limited to the history shown). */
  uploadedCount: number;
  backend: BackendStatus;
}

export const MAX_HISTORY_IN_STATE = 100;

export type SubmissionOutcome = "queued" | "duplicate" | "platform-disabled";

/**
 * Checks an accepted event before it may enter the outbox. Returns an
 * error message, or null when the event is safe to upload.
 */
async function rejectReason(
  event: SubmissionEvent,
  senderPlatform: string,
  sha256: HandlerDeps["sha256"],
): Promise<string | null> {
  if (event.platform !== senderPlatform) return "Event platform does not match the sending page.";
  if (event.verdict !== "ACCEPTED") return "Only accepted submissions are uploaded.";
  if (platformForUrl(event.problemUrl) !== event.platform)
    return "Problem URL is not on the event's platform.";
  try {
    problemFolder(event.platform, event.problemSlug);
  } catch {
    return "Problem slug is not a safe folder name.";
  }
  if ((await sha256(event.sourceCode)) !== event.sourceSha256) {
    return "Source code hash mismatch; the code may have been altered or truncated.";
  }
  return null;
}

/**
 * GitHub operations fail with our own (already redacted) messages, which
 * are useful to show; anything else stays generic.
 */
async function userFacing<T>(fn: () => Promise<T>): Promise<Reply<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const known =
      err instanceof Error &&
      (err.name === "UploadError" ||
        err.name === "BackendError" ||
        err.message === "GitHub is not connected.");
    return { ok: false, error: known ? err.message : "GitHub request failed." };
  }
}

export function createMessageHandler(deps: HandlerDeps) {
  return async function handle(
    raw: unknown,
    sender: chrome.runtime.MessageSender,
  ): Promise<Reply<unknown>> {
    const from = classifySender(sender, deps.extensionId);
    if (!from) return { ok: false, error: "Unauthorized sender." };
    try {
      if (from.kind === "content") {
        const parsed = ContentMessageSchema.safeParse(raw);
        if (!parsed.success) return { ok: false, error: "Invalid message." };
        const msg = parsed.data;
        if (msg.type === "verdict/observed") {
          if (msg.platform !== from.platform)
            return { ok: false, error: "Event platform does not match the sending page." };
          await deps.activity.recordVerdict(msg, deps.now());
          return { ok: true, data: undefined };
        }
        const event = msg.event;
        const settings = await deps.settings.get();
        if (!settings.enabledPlatforms[event.platform]) {
          return { ok: true, data: "platform-disabled" satisfies SubmissionOutcome };
        }
        const reason = await rejectReason(event, from.platform, deps.sha256);
        if (reason) return { ok: false, error: reason };
        const result = await deps.outbox.enqueue(event, deps.now());
        if (result === "full")
          return { ok: false, error: "Upload queue is full; retry or clear pending uploads." };
        if (result === "duplicate")
          return { ok: true, data: "duplicate" satisfies SubmissionOutcome };
        await deps.activity.recordQueued(event, deps.now());
        deps.requestDrain();
        return { ok: true, data: "queued" satisfies SubmissionOutcome };
      }

      const parsed = PageMessageSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: "Invalid message." };
      const msg = parsed.data;
      switch (msg.type) {
        case "state/get": {
          const backend = await deps.backend.status();
          // A busy or unreachable backend must not break the popup.
          const [settings, activity, items, github, history] = await Promise.all([
            deps.settings.get(),
            deps.activity.list(),
            deps.outbox.list(),
            deps.github.status().catch((): GitHubStatus => ({ connected: false })),
            deps.uploads.history().catch((): UploadHistory => ({ uploads: [], uploadedCount: 0 })),
          ]);
          const outbox: OutboxSummary[] = items.map((i) => ({
            key: i.key,
            platform: i.event.platform,
            submissionId: i.event.submissionId,
            problemTitle: i.event.problemTitle,
            attempts: i.attempts,
            nextAttemptAt: i.nextAttemptAt,
            lastError: i.lastError,
          }));
          const state: PopupState = {
            settings,
            github,
            activity,
            outbox,
            uploads: history.uploads.slice(0, MAX_HISTORY_IN_STATE),
            uploadedCount: history.uploadedCount,
            backend,
          };
          return { ok: true, data: state };
        }
        case "settings/update": {
          const saved = await deps.settings.set(msg.settings);
          const pushed = await userFacing(() => deps.backend.pushSettings(saved));
          if (!pushed.ok)
            return {
              ok: false,
              error: `Saved here, but the backend did not take it: ${pushed.error}`,
            };
          return { ok: true, data: saved };
        }
        case "backend/pair": {
          const reply = await userFacing(() => deps.backend.pair(msg.url, msg.code));
          if (reply.ok) deps.requestDrain();
          return reply;
        }
        case "backend/unpair":
          await deps.backend.unpair();
          return { ok: true, data: undefined };
        case "outbox/retry":
          await deps.outbox.retryNow(deps.now(), msg.key);
          deps.requestDrain();
          return { ok: true, data: undefined };
        case "data/clear":
          await Promise.all([deps.outbox.clear(), deps.activity.clear(), deps.uploads.clear()]);
          return { ok: true, data: undefined };
        case "upload/retry":
        case "upload/force": {
          const job = await deps.uploads.retry(msg.platform, msg.submissionId, {
            force: msg.type === "upload/force",
          });
          if (!job) return { ok: false, error: "No upload found for that submission." };
          deps.requestDrain();
          return { ok: true, data: job.status };
        }
        case "upload/retry-failed": {
          const queued = await deps.uploads.retryFailed();
          deps.requestDrain();
          return { ok: true, data: queued };
        }
        case "github/device/start":
          return await userFacing(() => deps.github.start());
        case "github/device/poll": {
          const reply = await userFacing(() => deps.github.poll());
          if (reply.ok && reply.data.state === "connected") {
            await deps.uploads.onConnected();
            deps.requestDrain();
          }
          return reply;
        }
        case "github/disconnect":
          await deps.github.disconnect();
          return { ok: true, data: undefined };
        case "github/repos":
          return await userFacing(() => deps.github.repos());
        case "github/branches":
          return await userFacing(() => deps.github.branches(msg.owner, msg.name));
      }
    } catch {
      // Never echo internals (which could include payload fragments) to callers.
      return { ok: false, error: "Internal error while handling the message." };
    }
  };
}

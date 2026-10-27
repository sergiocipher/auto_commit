import { problemFolder, type Settings, type SubmissionEvent } from "@cst/shared";
import { ContentMessageSchema, PageMessageSchema, type Reply } from "../messages.js";
import { platformForUrl } from "../platforms.js";
import type { ActivityEntry, ActivityLog } from "./activity.js";
import type { Outbox } from "./outbox.js";
import { classifySender } from "./senders.js";
import type { SettingsStore } from "./settings.js";

export interface HandlerDeps {
  extensionId: string;
  outbox: Outbox;
  activity: ActivityLog;
  settings: SettingsStore;
  now: () => number;
  sha256: (text: string) => Promise<string>;
  /** Kicks off delivery of due outbox items (fire-and-forget). */
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
  activity: ActivityEntry[];
  outbox: OutboxSummary[];
}

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
          const [settings, activity, items] = await Promise.all([
            deps.settings.get(),
            deps.activity.list(),
            deps.outbox.list(),
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
          return { ok: true, data: { settings, activity, outbox } satisfies PopupState };
        }
        case "settings/update":
          return { ok: true, data: await deps.settings.set(msg.settings) };
        case "outbox/retry":
          await deps.outbox.retryNow(deps.now(), msg.key);
          deps.requestDrain();
          return { ok: true, data: undefined };
        case "data/clear":
          await Promise.all([deps.outbox.clear(), deps.activity.clear()]);
          return { ok: true, data: undefined };
      }
    } catch {
      // Never echo internals (which could include payload fragments) to callers.
      return { ok: false, error: "Internal error while handling the message." };
    }
  };
}

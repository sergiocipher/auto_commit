import { sha256Hex } from "@cst/shared";
import { chromeLocalStore } from "../storage.js";
import { ActivityLog } from "./activity.js";
import { createMessageHandler } from "./handler.js";
import { Outbox, type Deliver } from "./outbox.js";
import { SettingsStore } from "./settings.js";

const DRAIN_ALARM = "outbox-drain";
const MIN_ALARM_DELAY_MS = 30_000; // Chrome's minimum alarm granularity

const store = chromeLocalStore();
const outbox = new Outbox(store);
const activity = new ActivityLog(store);
const settings = new SettingsStore(store);

// No upload sink exists until stage 2; events stay queued (never dropped).
const deliver: Deliver = async () => ({
  kind: "retry",
  error: "No upload destination configured yet.",
});

async function scheduleWakeUp(): Promise<void> {
  const at = await outbox.nextAttemptAt();
  if (at === null) await chrome.alarms.clear(DRAIN_ALARM);
  else
    await chrome.alarms.create(DRAIN_ALARM, {
      when: Math.max(at, Date.now() + MIN_ALARM_DELAY_MS),
    });
}

async function drain(): Promise<void> {
  const reports = await outbox.drain(deliver, Date.now);
  for (const report of reports) await activity.recordDelivery(report, Date.now());
  await scheduleWakeUp();
}

function requestDrain(): void {
  drain().catch((err: unknown) =>
    console.warn("outbox drain failed:", err instanceof Error ? err.name : "error"),
  );
}

const handle = createMessageHandler({
  extensionId: chrome.runtime.id,
  outbox,
  activity,
  settings,
  now: Date.now,
  sha256: (text) => sha256Hex(text),
  requestDrain,
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handle(message, sender).then(sendResponse);
  return true; // async response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DRAIN_ALARM) requestDrain();
});

// Each service-worker start resumes whatever the previous instance left queued.
requestDrain();

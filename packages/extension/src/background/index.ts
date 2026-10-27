import { KeyValueJobStore, type HttpFetch } from "@cst/core";
import { sha256Hex } from "@cst/shared";
import { GITHUB_ORIGINS } from "../platforms.js";
import { chromeLocalStore } from "../storage.js";
import { ActivityLog } from "./activity.js";
import { GitHubAuth, listBranches, listRepos } from "./githubAuth.js";
import { createMessageHandler } from "./handler.js";
import { LocalUploader } from "./localUploader.js";
import { Outbox } from "./outbox.js";
import { SettingsStore } from "./settings.js";

const WORK_ALARM = "work";
const GITHUB_POLL_ALARM = "github-poll";
const MIN_ALARM_DELAY_MS = 30_000; // Chrome's minimum alarm granularity

const now = () => Date.now();
const httpFetch: HttpFetch = (url, init) => fetch(url, init);
const store = chromeLocalStore();
const outbox = new Outbox(store);
const activity = new ActivityLog(store);
const settings = new SettingsStore(store);
const auth = new GitHubAuth(store, httpFetch, import.meta.env.VITE_GITHUB_CLIENT_ID ?? "", now);
const jobs = new KeyValueJobStore(store);

async function hasGitHubAccess(): Promise<boolean> {
  return chrome.permissions.contains({ origins: GITHUB_ORIGINS });
}

const uploader = new LocalUploader({
  jobs,
  settings,
  fetch: httpFetch,
  // Without the GitHub host permission requests would fail; treat as not connected.
  getToken: async () => ((await hasGitHubAccess()) ? auth.getToken() : undefined),
  now,
  newId: () => crypto.randomUUID(),
  onJob: (job) => activity.recordJob(job, now()),
});

async function scheduleWakeUp(): Promise<void> {
  const times = [await outbox.nextAttemptAt(), await uploader.nextWakeAt()].filter(
    (t): t is number => t !== null,
  );
  if (times.length === 0) await chrome.alarms.clear(WORK_ALARM);
  else
    await chrome.alarms.create(WORK_ALARM, {
      when: Math.max(Math.min(...times), now() + MIN_ALARM_DELAY_MS),
    });
}

async function work(): Promise<void> {
  const reports = await outbox.drain(uploader.deliver, now);
  for (const report of reports) await activity.recordDelivery(report, now());
  await uploader.runDue();
  await scheduleWakeUp();
}

function requestDrain(): void {
  work().catch((err: unknown) =>
    console.warn("background work failed:", err instanceof Error ? err.name : "error"),
  );
}

async function pollGitHubInBackground(): Promise<void> {
  const status = await auth.status();
  if (!status.pending) return;
  const progress = await auth.poll();
  if (progress.state === "connected") {
    await uploader.resumeNeedsAuth();
    requestDrain();
  } else if (progress.state === "pending") {
    await chrome.alarms.create(GITHUB_POLL_ALARM, {
      when: now() + Math.max(progress.retryInMs, MIN_ALARM_DELAY_MS),
    });
  }
}

const handle = createMessageHandler({
  extensionId: chrome.runtime.id,
  outbox,
  activity,
  settings,
  now,
  sha256: (text) => sha256Hex(text),
  requestDrain,
  github: {
    status: () => auth.status(),
    start: async () => {
      if (!(await hasGitHubAccess())) throw new Error("GitHub access was not granted.");
      const progress = await auth.start();
      // Keep polling even if the options page is closed.
      await chrome.alarms.create(GITHUB_POLL_ALARM, { when: now() + MIN_ALARM_DELAY_MS });
      return progress;
    },
    poll: () => auth.poll(),
    disconnect: () => auth.disconnect(),
    repos: () => listRepos(auth, httpFetch, now),
    branches: (owner, name) => listBranches(auth, httpFetch, now, owner, name),
  },
  uploads: {
    retry: (platform, submissionId) => uploader.retry(platform, submissionId),
    onConnected: () => uploader.resumeNeedsAuth(),
    clear: () => jobs.clear(),
  },
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handle(message, sender).then(sendResponse);
  return true; // async response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WORK_ALARM) requestDrain();
  if (alarm.name === GITHUB_POLL_ALARM) {
    pollGitHubInBackground().catch(() => undefined);
  }
});

// Each service-worker start resumes whatever the previous instance left behind.
uploader
  .recoverInterrupted()
  .catch(() => undefined)
  .finally(requestDrain);

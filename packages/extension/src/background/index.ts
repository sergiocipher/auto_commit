import { KeyValueJobStore, type HttpFetch } from "@cst/core";
import { sha256Hex } from "@cst/shared";
import { GITHUB_ORIGINS } from "../platforms.js";
import { chromeLocalStore } from "../storage.js";
import { ActivityLog } from "./activity.js";
import { BackendClient, BackendConfigStore, BackendSink, pairBackend } from "./backend.js";
import { GitHubAuth, listBranches, listRepos } from "./githubAuth.js";
import { timedFetch } from "./http.js";
import { createMessageHandler, type GitHubService, type UploadService } from "./handler.js";
import { LocalUploader } from "./localUploader.js";
import { Outbox } from "./outbox.js";
import { SettingsStore } from "./settings.js";

const WORK_ALARM = "work";
const BACKEND_SYNC_ALARM = "backend-sync";
const GITHUB_POLL_ALARM = "github-poll";
const MIN_ALARM_DELAY_MS = 30_000; // Chrome's minimum alarm granularity

const now = () => Date.now();
const httpFetch: HttpFetch = timedFetch();
const store = chromeLocalStore();
const outbox = new Outbox(store);
const activity = new ActivityLog(store);
const settings = new SettingsStore(store);
const auth = new GitHubAuth(store, httpFetch, import.meta.env.VITE_GITHUB_CLIENT_ID ?? "", now);
const jobs = new KeyValueJobStore(store);
const backendConfigs = new BackendConfigStore(store);
const backend = new BackendSink(
  new BackendClient(httpFetch, () => backendConfigs.get()),
  activity,
  now,
);
/** Backend mode once paired; local mode otherwise. Checked per call so pairing takes effect at once. */
const paired = async () => (await backendConfigs.get()) !== undefined;

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

const deliver = async (event: Parameters<typeof uploader.deliver>[0]) =>
  (await paired()) ? backend.deliver(event) : uploader.deliver(event);

async function work(): Promise<void> {
  const reports = await outbox.drain(deliver, now);
  for (const report of reports) await activity.recordDelivery(report, now());
  // Local jobs created before pairing still finish locally.
  await uploader.runDue();
  if (await paired()) {
    // Poll the backend while uploads are in progress so the popup sees SUCCESS.
    const { active } = await backend.refresh().catch(() => ({ active: true }));
    if (active)
      await chrome.alarms.create(BACKEND_SYNC_ALARM, { when: now() + MIN_ALARM_DELAY_MS });
  }
  await scheduleWakeUp();
}

function requestDrain(): void {
  work().catch((err: unknown) =>
    console.warn("background work failed:", err instanceof Error ? err.name : "error"),
  );
}

async function pollGitHubInBackground(): Promise<void> {
  const github = modeGitHub();
  const status = await github.status();
  if (!status.pending) return;
  const progress = await github.poll();
  if (progress.state === "connected") {
    await modeUploads().onConnected();
    requestDrain();
  } else if (progress.state === "pending") {
    await chrome.alarms.create(GITHUB_POLL_ALARM, {
      when: now() + Math.max(progress.retryInMs, MIN_ALARM_DELAY_MS),
    });
  }
}

const localGitHub: GitHubService = {
  status: () => auth.status(),
  start: async () => {
    if (!(await hasGitHubAccess())) throw new Error("GitHub access was not granted.");
    return auth.start();
  },
  poll: () => auth.poll(),
  disconnect: () => auth.disconnect(),
  repos: () => listRepos(auth, httpFetch, now),
  branches: (owner, name) => listBranches(auth, httpFetch, now, owner, name),
};

const localUploads: UploadService = {
  retry: (platform, submissionId, options) => uploader.retry(platform, submissionId, options),
  retryFailed: () => uploader.retryFailed(),
  history: () => uploader.history(),
  onConnected: () => uploader.resumeNeedsAuth(),
  clear: () => jobs.clear(),
};

/** Routes each GitHub call to the backend when paired, else to local mode. */
function modeGitHub(): GitHubService {
  const pick = async () => ((await paired()) ? backend.github : localGitHub);
  return {
    status: async () => (await pick()).status(),
    start: async () => {
      const progress = await (await pick()).start();
      await chrome.alarms.create(GITHUB_POLL_ALARM, { when: now() + MIN_ALARM_DELAY_MS });
      return progress;
    },
    poll: async () => (await pick()).poll(),
    disconnect: async () => (await pick()).disconnect(),
    repos: async () => (await pick()).repos(),
    branches: async (owner, name) => (await pick()).branches(owner, name),
  };
}

function modeUploads(): UploadService {
  const pick = async () => ((await paired()) ? backend.uploads : localUploads);
  return {
    retry: async (platform, submissionId, options) =>
      (await pick()).retry(platform, submissionId, options),
    retryFailed: async () => (await pick()).retryFailed(),
    history: async () => (await pick()).history(),
    onConnected: async () => (await pick()).onConnected(),
    // "Clear local data" clears this browser's jobs, and the backend's when paired.
    clear: async () => {
      await jobs.clear();
      if (await paired()) await backend.uploads.clear();
    },
  };
}

const handle = createMessageHandler({
  extensionId: chrome.runtime.id,
  outbox,
  activity,
  settings,
  now,
  sha256: (text) => sha256Hex(text),
  requestDrain,
  github: modeGitHub(),
  uploads: modeUploads(),
  backend: {
    status: async () => {
      const config = await backendConfigs.get();
      return config ? { paired: true, url: config.url } : { paired: false };
    },
    pair: async (url, code) => {
      // The GitHub connection moves to the backend; connect there after pairing.
      const config = await pairBackend(httpFetch, backendConfigs, { url, code });
      await backend.pushSettings(await settings.get());
      return { paired: true, url: config.url };
    },
    unpair: () => backendConfigs.clear(),
    pushSettings: async (s) => {
      if (await paired()) await backend.pushSettings(s);
    },
  },
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handle(message, sender).then(sendResponse);
  return true; // async response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WORK_ALARM || alarm.name === BACKEND_SYNC_ALARM) requestDrain();
  if (alarm.name === GITHUB_POLL_ALARM) {
    pollGitHubInBackground().catch(() => undefined);
  }
});

// Each service-worker start resumes whatever the previous instance left behind.
uploader
  .recoverInterrupted()
  .catch(() => undefined)
  .finally(requestDrain);

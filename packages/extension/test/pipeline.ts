import { KeyValueJobStore } from "@cst/core";
import { FakeGitHub, FAKE_TOKEN } from "@cst/core/testing";
import { sha256Hex } from "@cst/shared";
import { ActivityLog } from "../src/background/activity.js";
import { GitHubAuth, GITHUB_TOKEN_KEY } from "../src/background/githubAuth.js";
import { createMessageHandler } from "../src/background/handler.js";
import { LocalUploader } from "../src/background/localUploader.js";
import { Outbox } from "../src/background/outbox.js";
import { SettingsStore } from "../src/background/settings.js";
import type { ContentMessage, PageMessage } from "../src/messages.js";
import { contentSender, EXT_ID, MemoryStore, pageSender } from "./helpers.js";

/**
 * The real service-worker pipeline (handler -> outbox -> local uploader)
 * wired to an in-memory store and a fake GitHub with a connected token.
 */
export async function createPipeline(start = 1_700_000_005_000) {
  const gh = new FakeGitHub();
  const store = new MemoryStore();
  let now = start;
  const settings = new SettingsStore(store, () => "UTC");
  await settings.set({
    ...settings.defaults(),
    repo: { owner: "octo", name: "solutions", branch: "main" },
  });
  await store.set(GITHUB_TOKEN_KEY, {
    token: FAKE_TOKEN,
    scopes: ["repo"],
    login: "octo",
    connectedAt: 0,
  });
  const auth = new GitHubAuth(store, gh.fetch, "Ov23test", () => now);
  const outbox = new Outbox(store);
  const activity = new ActivityLog(store);
  const jobs = new KeyValueJobStore(store);
  let ids = 0;
  const uploader = new LocalUploader({
    jobs,
    settings,
    fetch: gh.fetch,
    getToken: () => auth.getToken(),
    now: () => now,
    newId: () => `job-${++ids}`,
    onJob: (job) => activity.recordJob(job, now),
  });
  let pending = Promise.resolve();
  const work = async () => {
    for (const r of await outbox.drain(uploader.deliver, () => now))
      await activity.recordDelivery(r, now);
    await uploader.runDue();
  };
  const handle = createMessageHandler({
    extensionId: EXT_ID,
    outbox,
    activity,
    settings,
    now: () => now,
    sha256: sha256Hex,
    requestDrain: () => {
      pending = pending.then(work);
    },
    github: {
      status: () => auth.status(),
      start: () => auth.start(),
      poll: () => auth.poll(),
      disconnect: () => auth.disconnect(),
      repos: async () => [],
      branches: async () => [],
    },
    uploads: {
      retry: (p, s, o) => uploader.retry(p, s, o),
      retryFailed: () => uploader.retryFailed(),
      history: () => uploader.history(),
      onConnected: () => uploader.resumeNeedsAuth(),
      clear: () => jobs.clear(),
    },
  });
  return {
    gh,
    activity,
    jobs,
    settings,
    /** A message from the popup or options page. */
    page: (m: PageMessage) => handle(m, pageSender()),
    /** A content script's sendMessage from a tab at `tabUrl`. */
    sender: (tabUrl: string) => (m: ContentMessage) => handle(m, contentSender(tabUrl)),
    /** Waits for all requested background work to finish. */
    settle: () => pending,
    now: () => now,
    advance: (ms: number) => (now += ms),
  };
}

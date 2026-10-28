import type { Platform, Settings, UploadStatus } from "@cst/shared";
import type { ConnectProgress, RepoSummary } from "../background/githubAuth.js";
import type { PopupState } from "../background/handler.js";
import type { PageMessage, Reply } from "../messages.js";
import { GITHUB_ORIGINS } from "../platforms.js";

async function call<T>(message: PageMessage): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(message)) as Reply<T> | undefined;
  if (!reply) throw new Error("No response from the extension background.");
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

export const api = {
  getState: () => call<PopupState>({ type: "state/get" }),
  saveSettings: (settings: Settings) => call<Settings>({ type: "settings/update", settings }),
  retry: (key?: string) =>
    call<undefined>(key ? { type: "outbox/retry", key } : { type: "outbox/retry" }),
  retryUpload: (platform: Platform, submissionId: string) =>
    call<UploadStatus>({ type: "upload/retry", platform, submissionId }),
  forceUpload: (platform: Platform, submissionId: string) =>
    call<UploadStatus>({ type: "upload/force", platform, submissionId }),
  retryFailedUploads: () => call<number>({ type: "upload/retry-failed" }),
  clearData: () => call<undefined>({ type: "data/clear" }),
  /** Must run inside a user gesture: asks Chrome for the optional GitHub host access first. */
  async connectGitHub(): Promise<ConnectProgress> {
    const granted = await chrome.permissions.request({ origins: GITHUB_ORIGINS });
    if (!granted) throw new Error("GitHub access is needed to sign in and upload.");
    return call<ConnectProgress>({ type: "github/device/start" });
  },
  pollGitHub: () => call<ConnectProgress>({ type: "github/device/poll" }),
  disconnectGitHub: () => call<undefined>({ type: "github/disconnect" }),
  repos: () => call<RepoSummary[]>({ type: "github/repos" }),
  branches: (owner: string, name: string) =>
    call<string[]>({ type: "github/branches", owner, name }),
};

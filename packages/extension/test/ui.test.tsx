import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UPLOAD_STATUSES } from "@cst/shared";
import type { ActivityEntry } from "../src/background/activity.js";
import type { PopupState, UploadSummary } from "../src/background/handler.js";
import { HistoryPanel } from "../src/ui/HistoryPanel.js";
import {
  commitUrl,
  hasRetryableFailures,
  periodResetsAt,
  repoUrl,
  uploadActions,
} from "../src/ui/history.js";
import { StatusPanel } from "../src/ui/StatusPanel.js";
import { deriveStatus, STATUS_LABELS } from "../src/ui/status.js";

const entry = (patch: Partial<ActivityEntry> = {}): ActivityEntry => ({
  key: "leetcode:1",
  platform: "leetcode",
  submissionId: "1",
  verdict: "ACCEPTED",
  queued: false,
  updatedAt: 1,
  ...patch,
});

describe("deriveStatus", () => {
  it("maps every state to one of the spec's labels", () => {
    expect(deriveStatus(undefined)).toBe("waiting");
    expect(deriveStatus(entry({ verdict: "REJECTED" }))).toBe("waiting");
    expect(deriveStatus(entry({ queued: true }))).toBe("accepted");
    expect(deriveStatus(entry({ status: "QUEUED" }))).toBe("uploading");
    expect(deriveStatus(entry({ status: "RETRYING" }))).toBe("uploading");
    expect(deriveStatus(entry({ status: "SUCCESS" }))).toBe("success");
    expect(deriveStatus(entry({ status: "SKIPPED_NOT_ELIGIBLE" }))).toBe("alreadyUploaded");
    expect(deriveStatus(entry({ status: "FAILED_PERMANENT" }))).toBe("failed");
    expect(deriveStatus(entry({ status: "NEEDS_AUTH" }))).toBe("needsAuth");
    expect(deriveStatus(entry({ status: "HELD" }))).toBe("accepted");
  });

  it("only reports success for a SUCCESS status", () => {
    for (const status of UPLOAD_STATUSES) {
      expect(deriveStatus(entry({ status })) === "success").toBe(status === "SUCCESS");
    }
  });

  it("uses the exact status strings from the spec", () => {
    expect(Object.values(STATUS_LABELS)).toEqual([
      "Waiting for submission",
      "Submission accepted",
      "Uploading to GitHub",
      "Upload successful",
      "Already uploaded during this period",
      "Upload failed — retry available",
      "Needs GitHub reconnect",
    ]);
  });
});

describe("StatusPanel", () => {
  it("renders platform-derived strings as text, not HTML", () => {
    const state: PopupState = {
      settings: {
        autoUpload: true,
        period: { kind: "calendar_day" },
        timezone: "UTC",
        enabledPlatforms: { leetcode: true, codeforces: true, codechef: true },
        uploadMetadata: true,
        repo: { owner: "", name: "", branch: "main" },
        languageExtensionOverrides: {},
      },
      github: { connected: false },
      activity: [
        entry({
          problemTitle: '<img src=x onerror="alert(1)">',
          status: "FAILED_PERMANENT",
          detail: "<b>x</b>",
        }),
      ],
      outbox: [],
      uploads: [],
      uploadedCount: 0,
      backend: { paired: false },
    };
    const html = renderToStaticMarkup(<StatusPanel state={state} onRetry={() => undefined} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("Upload failed — retry available");
  });
});

const upload = (patch: Partial<UploadSummary> = {}): UploadSummary => ({
  id: "j1",
  userId: "local",
  platform: "codeforces",
  problemKey: "4A",
  problemTitle: "Watermelon",
  submissionId: "77",
  language: "GNU G++20",
  submittedAt: 1,
  status: "SUCCESS",
  attempts: 0,
  force: false,
  createdAt: 1,
  updatedAt: 1,
  sourceStored: false,
  ...patch,
});

const baseState = (patch: Partial<PopupState> = {}): PopupState => ({
  settings: {
    autoUpload: true,
    period: { kind: "calendar_day" },
    timezone: "Asia/Kolkata",
    enabledPlatforms: { leetcode: true, codeforces: true, codechef: true },
    uploadMetadata: true,
    repo: { owner: "octo", name: "solutions", branch: "main" },
    languageExtensionOverrides: {},
  },
  github: { connected: true },
  activity: [],
  outbox: [],
  uploads: [],
  uploadedCount: 0,
  backend: { paired: false },
  ...patch,
});

describe("uploadActions", () => {
  it("offers manual and force upload for held jobs with stored source", () => {
    expect(uploadActions(upload({ status: "HELD", sourceStored: true }))).toEqual([
      "upload",
      "force",
    ]);
    expect(uploadActions(upload({ status: "HELD", sourceStored: false }))).toEqual([]);
  });

  it("offers force only for skipped jobs that still have their source", () => {
    expect(uploadActions(upload({ status: "SKIPPED_NOT_ELIGIBLE", sourceStored: true }))).toEqual([
      "force",
    ]);
    expect(uploadActions(upload({ status: "SKIPPED_NOT_ELIGIBLE" }))).toEqual([]);
  });

  it("offers retry for failures, plus force while the job is not forced yet", () => {
    expect(uploadActions(upload({ status: "FAILED_PERMANENT", sourceStored: true }))).toEqual([
      "retry",
      "force",
    ]);
    expect(
      uploadActions(upload({ status: "FAILED_PERMANENT", sourceStored: true, force: true })),
    ).toEqual(["retry"]);
    expect(uploadActions(upload({ status: "NEEDS_AUTH", sourceStored: true }))).toEqual(["retry"]);
  });

  it("offers nothing for successful or in-flight jobs", () => {
    for (const status of ["SUCCESS", "QUEUED", "UPLOADING", "RECEIVED"] as const) {
      expect(uploadActions(upload({ status, sourceStored: true }))).toEqual([]);
    }
  });

  it("detects retryable failures", () => {
    expect(hasRetryableFailures([upload()])).toBe(false);
    expect(hasRetryableFailures([upload(), upload({ status: "NEEDS_AUTH" })])).toBe(true);
  });
});

describe("links", () => {
  it("builds repository and commit links only from valid parts", () => {
    expect(repoUrl({ owner: "octo", name: "solutions", branch: "main" })).toBe(
      "https://github.com/octo/solutions",
    );
    expect(repoUrl({ owner: "", name: "", branch: "main" })).toBeNull();
    const sha = "a".repeat(40);
    expect(commitUrl({ repository: "octo/solutions", commitSha: sha })).toBe(
      `https://github.com/octo/solutions/commit/${sha}`,
    );
    expect(commitUrl({ repository: "octo/solutions", commitSha: "javascript:x" })).toBeNull();
    expect(commitUrl({ repository: "octo/../x/y", commitSha: sha })).toBeNull();
    expect(commitUrl({ repository: "evil.example/x?y", commitSha: sha })).toBeNull();
    expect(commitUrl({ commitSha: sha })).toBeNull();
  });
});

describe("periodResetsAt", () => {
  const now = Date.parse("2024-03-10T10:00:00Z");
  it("returns the next local midnight for calendar days", () => {
    expect(
      periodResetsAt({ period: { kind: "calendar_day" }, timezone: "Asia/Kolkata" }, now),
    ).toBe(Date.parse("2024-03-10T18:30:00Z"));
  });
  it("has no reset for rolling or permanent policies", () => {
    expect(periodResetsAt({ period: { kind: "rolling_24h" }, timezone: "UTC" }, now)).toBeNull();
    expect(periodResetsAt({ period: { kind: "permanent" }, timezone: "UTC" }, now)).toBeNull();
  });
});

describe("StatusPanel summary", () => {
  it("shows the stored upload count, reset time, repository link and auto-upload state", () => {
    const html = renderToStaticMarkup(
      <StatusPanel
        state={baseState({
          uploadedCount: 7,
          settings: { ...baseState().settings, autoUpload: false },
        })}
        onRetry={() => undefined}
        now={Date.parse("2024-03-10T10:00:00Z")}
      />,
    );
    expect(html).toContain("Uploaded: 7");
    expect(html).toContain('href="https://github.com/octo/solutions"');
    expect(html).toContain("resets");
    expect(html).toContain("(Asia/Kolkata)");
    expect(html).toContain("Auto-upload is off");
  });
});

describe("HistoryPanel", () => {
  it("renders rows as text with status, path, commit link and actions", () => {
    const sha = "b".repeat(40);
    const html = renderToStaticMarkup(
      <HistoryPanel
        uploads={[
          upload({
            problemTitle: '<img src=x onerror="alert(1)">',
            repository: "octo/solutions",
            commitSha: sha,
            filePath: "data/codeforces/4a-watermelon/solution.cpp",
          }),
          upload({
            id: "j2",
            status: "SKIPPED_NOT_ELIGIBLE",
            sourceStored: true,
            lastError: "<b>Already uploaded</b>",
          }),
          upload({ id: "j3", status: "FAILED_PERMANENT", lastError: "Repository not found." }),
        ]}
        onAction={() => undefined}
        onRetryFailed={() => undefined}
      />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>Already");
    expect(html).toContain("data/codeforces/4a-watermelon/solution.cpp");
    expect(html).toContain(`href="https://github.com/octo/solutions/commit/${sha}"`);
    expect(html).toContain("Force upload");
    expect(html).toContain("Retry all failed");
    expect(html).toContain("Repository not found.");
  });

  it("renders nothing without history", () => {
    expect(
      renderToStaticMarkup(
        <HistoryPanel uploads={[]} onAction={() => undefined} onRetryFailed={() => undefined} />,
      ),
    ).toBe("");
  });
});

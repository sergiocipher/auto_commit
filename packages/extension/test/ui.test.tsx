import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UPLOAD_STATUSES } from "@cst/shared";
import type { ActivityEntry } from "../src/background/activity.js";
import type { PopupState } from "../src/background/handler.js";
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
    };
    const html = renderToStaticMarkup(<StatusPanel state={state} onRetry={() => undefined} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("Upload failed — retry available");
  });
});

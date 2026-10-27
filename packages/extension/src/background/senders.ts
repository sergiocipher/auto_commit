import type { Platform } from "@cst/shared";
import { platformForUrl } from "../platforms.js";

export type SenderKind = { kind: "content"; platform: Platform } | { kind: "page" };

/**
 * Identifies who sent a runtime message. Only this extension's own pages
 * (popup/options) and its top-frame content scripts on supported platform
 * hosts are trusted; everything else is rejected.
 */
export function classifySender(
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): SenderKind | null {
  if (sender.id !== extensionId || !sender.url) return null;
  if (sender.url.startsWith(`chrome-extension://${extensionId}/`)) return { kind: "page" };
  if (!sender.tab || sender.frameId !== 0) return null;
  const platform = platformForUrl(sender.url);
  return platform ? { kind: "content", platform } : null;
}

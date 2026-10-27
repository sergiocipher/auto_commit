import type { Settings } from "@cst/shared";
import type { PopupState } from "../background/handler.js";
import type { PageMessage, Reply } from "../messages.js";

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
  clearData: () => call<undefined>({ type: "data/clear" }),
};

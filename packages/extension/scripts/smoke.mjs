// Loads the built extension (dist/) unpacked into Chrome for Testing /
// Chromium and checks that the service worker starts and answers the popup.
// Branded Google Chrome ignores --load-extension, so point CHROME_PATH at a
// Chrome for Testing or Chromium binary (e.g. Playwright's).
//
//   CHROME_PATH=/path/to/chrome npm -w @cst/extension run smoke
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const chromePath = process.env.CHROME_PATH;
if (!chromePath) {
  console.error("Set CHROME_PATH to a Chrome for Testing or Chromium binary.");
  process.exit(2);
}
const dist = resolve(import.meta.dirname, "../dist");
const profile = await mkdtemp(join(tmpdir(), "cst-smoke-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not ready yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const ready = new Promise((r) => (ws.onopen = r));
  return {
    async evaluate(expression) {
      await ready;
      const msgId = ++id;
      ws.send(
        JSON.stringify({
          id: msgId,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
      const reply = await new Promise((r) => pending.set(msgId, r));
      if (reply.result?.exceptionDetails)
        throw new Error(JSON.stringify(reply.result.exceptionDetails));
      return reply.result?.result?.value;
    },
    close: () => ws.close(),
  };
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

try {
  const port = await until(
    async () => (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0],
    "DevTools port",
  );
  const base = `http://127.0.0.1:${port}`;
  const sw = await until(async () => {
    const targets = await (await fetch(`${base}/json/list`)).json();
    return targets.find((t) => t.type === "service_worker" && t.url.endsWith("/background.js"));
  }, "extension service worker");
  const extensionId = new URL(sw.url).host;
  check("service worker registered", true, sw.url);

  const page = await (
    await fetch(`${base}/json/new?chrome-extension://${extensionId}/popup.html`, { method: "PUT" })
  ).json();
  const client = cdp(page.webSocketDebuggerUrl);

  const statusText = await until(
    () => client.evaluate(`document.querySelector('[data-testid="status"]')?.textContent ?? null`),
    "popup status",
  );
  check("popup renders initial status", statusText === "Waiting for submission", statusText);

  const state = await client.evaluate(`chrome.runtime.sendMessage({ type: "state/get" })`);
  check("service worker answers state/get", state?.ok === true && Array.isArray(state.data.outbox));

  const invalid = await client.evaluate(
    `chrome.runtime.sendMessage({ type: "state/get", extra: 1 })`,
  );
  check("unknown fields rejected", invalid?.ok === false && invalid.error === "Invalid message.");

  const contentOnly = await client.evaluate(
    `chrome.runtime.sendMessage({ type: "verdict/observed", platform: "leetcode", submissionId: "1", verdict: "ACCEPTED", at: 1 })`,
  );
  check("content-only message refused from extension page", contentOnly?.ok === false);

  const saved = await client.evaluate(
    `chrome.runtime.sendMessage({ type: "settings/update", settings: { ...${JSON.stringify(state.data.settings)}, period: { kind: "permanent" } } })`,
  );
  const reread = await client.evaluate(`chrome.runtime.sendMessage({ type: "state/get" })`);
  check(
    "settings persist through the service worker",
    saved?.ok === true && reread?.data?.settings?.period?.kind === "permanent",
  );
  client.close();
} catch (err) {
  check("smoke run", false, err instanceof Error ? err.message : String(err));
} finally {
  chrome.kill();
  await sleep(300);
  await rm(profile, { recursive: true, force: true });
}

process.exit(checks.every((c) => c.ok) ? 0 : 1);

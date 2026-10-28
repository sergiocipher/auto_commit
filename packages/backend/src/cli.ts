import type { Server } from "node:http";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { DEFAULT_USER_ID } from "./db/repos.js";
import { createLogger } from "./logger.js";
import { reconcile } from "./reconciler.js";
import { createServices, httpFetch, type Services } from "./services.js";
import { redisConnection } from "./queue.js";
import { createUploadWorker } from "./worker.js";

const USAGE = "usage: cli.js <migrate|api|worker|pair>";

function onShutdown(log: Services["log"], stop: () => Promise<void>) {
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      log.info("shutting down", { signal });
      stop().then(
        () => process.exit(0),
        (err: unknown) => {
          log.error("shutdown failed", { err });
          process.exit(1);
        },
      );
    });
  }
}

async function runApi(s: Services) {
  // Migrations run on api start (idempotent, advisory-locked).
  const applied = await s.migrate();
  if (applied.length) s.log.info("migrations applied", { versions: applied });
  const app = createApp({
    store: s.store,
    settings: s.settings,
    installs: s.installs,
    session: s.session,
    enqueue: s.enqueue,
    readiness: s.readiness,
    extensionOrigin: s.config.extensionOrigin,
    fetch: httpFetch,
    now: s.now,
    newId: s.newId,
    log: s.log,
  });
  const server: Server = await new Promise((resolve) => {
    const srv = app.listen(s.config.port, s.config.host, () => resolve(srv));
  });
  s.log.info("api listening", { host: s.config.host, port: s.config.port });
  onShutdown(s.log, async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await s.close();
  });
}

async function runWorker(s: Services) {
  await s.migrate();
  const worker = createUploadWorker(redisConnection(s.config.redisUrl), {
    store: s.store,
    settings: s.settings,
    getToken: s.getToken,
    fetch: httpFetch,
    now: s.now,
    maxAttempts: s.config.uploadMaxAttempts,
    purgeSourceOnSuccess: s.config.purgeSourceOnSuccess,
    log: s.log.child({ component: "worker" }),
  });
  const tick = () =>
    reconcile(s.store, s.queue, s.now(), s.log.child({ component: "reconciler" })).catch(
      (err: unknown) => s.log.error("reconcile failed", { err }),
    );
  await tick();
  const timer = setInterval(() => void tick(), s.config.reconcileIntervalMs);
  s.log.info("worker started", { reconcileIntervalMs: s.config.reconcileIntervalMs });
  onShutdown(s.log, async () => {
    clearInterval(timer);
    await worker.close(); // waits for the active upload to finish
    await s.close();
  });
}

async function main(command: string | undefined) {
  if (!command || !["migrate", "api", "worker", "pair"].includes(command)) {
    console.error(USAGE);
    process.exit(2);
  }
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : "Invalid configuration.");
    process.exit(1);
  }
  const log = createLogger(config.logLevel).child({ process: command });
  const s = await createServices(config, log);
  switch (command) {
    case "migrate": {
      const applied = await s.migrate();
      log.info("migrations done", { applied });
      await s.close();
      return;
    }
    case "pair": {
      await s.migrate();
      const { code, expiresAt } = await s.installs.createPairingCode(DEFAULT_USER_ID, s.now());
      // Printed to the operator's terminal only, never to the service log.
      process.stdout.write(
        `Pairing code: ${code}\nEnter it in the extension's settings within 10 minutes ` +
          `(expires ${new Date(expiresAt).toISOString()}). It works once.\n`,
      );
      await s.close();
      return;
    }
    case "api":
      return runApi(s);
    case "worker":
      return runWorker(s);
  }
}

main(process.argv[2]).catch((err: unknown) => {
  console.error("fatal:", err instanceof Error ? `${err.name}: ${err.message}` : "error");
  process.exit(1);
});

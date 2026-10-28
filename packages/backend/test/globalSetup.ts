import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

// Integration tests need real Postgres and Redis. Use TEST_DATABASE_URL /
// TEST_REDIS_URL when given; otherwise start throwaway servers from local
// binaries. When neither works, integration suites skip (and say why).

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string | null;
    redisUrl: string | null;
    servicesSkipReason: string;
  }
}

const PG_BIN_DIRS = [
  "/usr/lib/postgresql/16/bin",
  "/usr/lib/postgresql/17/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
];

function findBin(name: string): string | null {
  for (const dir of PG_BIN_DIRS) if (existsSync(join(dir, name))) return join(dir, name);
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port")),
      );
    });
  });
}

async function waitFor(check: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what} did not start in time`);
}

export default async function setup(project: TestProject) {
  const cleanups: (() => void)[] = [];
  let databaseUrl = process.env.TEST_DATABASE_URL ?? null;
  let redisUrl = process.env.TEST_REDIS_URL ?? null;
  const reasons: string[] = [];

  if (!databaseUrl) {
    const initdb = findBin("initdb");
    const pgCtl = findBin("pg_ctl");
    const pgIsReady = findBin("pg_isready");
    if (initdb && pgCtl && pgIsReady) {
      const dir = mkdtempSync(join(tmpdir(), "cst-pg-"));
      const port = await freePort();
      const pwfile = join(dir, "pw");
      writeFileSync(pwfile, "test\n");
      execFileSync(
        initdb,
        ["-D", join(dir, "data"), "-U", "test", "--pwfile", pwfile, "-A", "scram-sha-256"],
        {
          stdio: "ignore",
        },
      );
      execFileSync(
        pgCtl,
        [
          "-D",
          join(dir, "data"),
          "-l",
          join(dir, "log"),
          "-w",
          "start",
          "-o",
          `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`,
        ],
        { stdio: "ignore" },
      );
      await waitFor(() => {
        try {
          execFileSync(pgIsReady, ["-h", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      }, "postgres");
      databaseUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
      cleanups.push(() => {
        try {
          execFileSync(pgCtl, ["-D", join(dir, "data"), "-m", "immediate", "stop"], {
            stdio: "ignore",
          });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    } else reasons.push("Postgres binaries (initdb, pg_ctl) not found and TEST_DATABASE_URL unset");
  }

  if (!redisUrl) {
    const redisServer = findBin("redis-server");
    if (redisServer) {
      const port = await freePort();
      const child: ChildProcess = spawn(
        redisServer,
        ["--port", String(port), "--save", "", "--appendonly", "no"],
        {
          stdio: "ignore",
        },
      );
      let ready = false;
      const redisCli = findBin("redis-cli");
      await waitFor(() => {
        if (!redisCli) return (ready = true);
        try {
          ready =
            execFileSync(redisCli, ["-p", String(port), "ping"], { encoding: "utf8" }).trim() ===
            "PONG";
        } catch {
          ready = false;
        }
        return ready;
      }, "redis");
      redisUrl = `redis://127.0.0.1:${port}`;
      cleanups.push(() => child.kill("SIGKILL"));
    } else reasons.push("redis-server not found and TEST_REDIS_URL unset");
  }

  project.provide("databaseUrl", databaseUrl);
  project.provide("redisUrl", redisUrl);
  project.provide("servicesSkipReason", reasons.join("; "));
  return () => {
    for (const c of cleanups.reverse()) c();
  };
}

import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  ingestSubmission,
  InvalidSubmissionError,
  listBranches,
  listRepos,
  requeueJob,
  summarizeJob,
  UploadError,
  type GitHubSession,
  type HttpFetch,
  type UploadJob,
} from "@cst/core";
import { PlatformSchema, SettingsSchema, SubmissionEventSchema } from "@cst/shared";
import type { PgJobStore } from "./db/jobStore.js";
import type { InstallsRepo, SettingsRepo } from "./db/repos.js";
import { rateLimit } from "./http/rateLimit.js";
import type { Logger } from "./logger.js";

export interface Readiness {
  postgres: boolean;
  redis: boolean;
  migrations: boolean;
}

export interface AppDeps {
  store: PgJobStore;
  settings: SettingsRepo;
  installs: InstallsRepo;
  /** The GitHub session of a user (one instance per user, so its lock serializes). */
  session: (userId: string) => GitHubSession;
  /** Puts a runnable job on the queue. May fail when Redis is down; the reconciler catches up. */
  enqueue: (job: UploadJob) => Promise<void>;
  readiness: () => Promise<Readiness>;
  extensionOrigin: string;
  fetch: HttpFetch;
  now: () => number;
  newId: () => string;
  log: Logger;
  /** Requests per minute per IP for /v1 (pairing has its own, stricter limit). */
  rateLimitPerMinute?: number;
}

/** Authenticated install, attached by the bearer middleware. */
interface Authed {
  userId: string;
  installId: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const GitHubName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
const PairBody = z.strictObject({
  code: z.string().min(8).max(64),
  name: z.string().min(1).max(100).default("Chrome"),
});
const ForceBody = z.strictObject({
  platform: PlatformSchema,
  submissionId: z.string().min(1).max(100),
});
const RUNNABLE = new Set(["QUEUED", "RETRYING"]);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))];
    throw new HttpError(400, `Invalid request: ${fields.join(", ")}`);
  }
  return parsed.data;
}

type Handler = (req: Request, res: Response, auth: Authed) => Promise<unknown>;

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);

  // Access log: method, path, status, duration. Never bodies or headers.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () =>
      deps.log.info("request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      }),
    );
    next();
  });

  // CORS: only the configured extension origin. Requests without an Origin
  // (curl, health checks) are not browser requests and pass to auth.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined) return next();
    if (origin !== deps.extensionOrigin) {
      res.status(403).json({ error: "Origin not allowed." });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/readyz", async (_req, res) => {
    const r = await deps
      .readiness()
      .catch(() => ({ postgres: false, redis: false, migrations: false }));
    const ok = r.postgres && r.redis && r.migrations;
    res.status(ok ? 200 : 503).json({ ok, ...r });
  });

  const v1 = express.Router();
  v1.use(rateLimit({ windowMs: 60_000, max: deps.rateLimitPerMinute ?? 300 }));
  // Accepted source is at most 1 MB of characters; allow for JSON escaping.
  v1.use(express.json({ limit: "4mb", strict: true }));

  v1.post("/pair", rateLimit({ windowMs: 15 * 60_000, max: 10 }), async (req, res, next) => {
    try {
      const body = parse(PairBody, req.body);
      const paired = await deps.installs.redeem(body.code, body.name, deps.now());
      if (!paired) throw new HttpError(401, "Invalid or expired pairing code.");
      deps.log.info("install paired", { installId: paired.install.id });
      res.status(201).json({ token: paired.token, installId: paired.install.id });
    } catch (err) {
      next(err);
    }
  });

  // Everything below needs a paired install's bearer token.
  v1.use(async (req, res, next) => {
    try {
      const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization ?? "");
      const install = m ? await deps.installs.authenticate(m[1]!) : null;
      if (!install) {
        res.status(401).json({ error: "Not paired or token revoked." });
        return;
      }
      res.locals.auth = { userId: install.userId, installId: install.id } satisfies Authed;
      next();
    } catch (err) {
      next(err);
    }
  });

  const route =
    (fn: Handler) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const out = await fn(req, res, res.locals.auth as Authed);
        if (!res.headersSent) res.json(out ?? { ok: true });
      } catch (err) {
        next(err);
      }
    };

  /** Queue a job that became runnable; Redis trouble is logged, never fatal. */
  async function enqueueIfRunnable(job: UploadJob) {
    if (!RUNNABLE.has(job.status)) return;
    await deps
      .enqueue(job)
      .catch((err: unknown) =>
        deps.log.warn("enqueue failed; reconciler will retry", { jobId: job.id, err }),
      );
  }

  async function requeue(auth: Authed, job: UploadJob, force: boolean) {
    const settings = await deps.settings.get(auth.userId);
    const next = await requeueJob(deps.store, job, {
      userId: auth.userId,
      settings,
      now: deps.now(),
      force,
    });
    await enqueueIfRunnable(next);
    return next;
  }

  async function ownJob(auth: Authed, id: string) {
    const job = await deps.store.get(id);
    if (!job || job.userId !== auth.userId) throw new HttpError(404, "Upload not found.");
    return job;
  }

  /** Our GitHub errors are already redacted and actionable; anything else stays generic. */
  async function github<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof UploadError) throw new HttpError(502, err.message);
      if (err instanceof Error && err.message === "GitHub is not connected.")
        throw new HttpError(409, err.message);
      throw err;
    }
  }

  // ---- GitHub ---------------------------------------------------------------
  v1.get(
    "/github",
    route((_req, _res, a) => deps.session(a.userId).status()),
  );
  v1.post(
    "/github/device/start",
    route((_req, _res, a) => github(() => deps.session(a.userId).start())),
  );
  v1.post(
    "/github/device/poll",
    route(async (_req, _res, a) => {
      const progress = await github(() => deps.session(a.userId).poll());
      if (progress.state === "connected") {
        for (const job of await deps.store.listByStatus(a.userId, ["NEEDS_AUTH"]))
          await requeue(a, job, false);
      }
      return progress;
    }),
  );
  v1.delete(
    "/github",
    route(async (_req, _res, a) => {
      await deps.session(a.userId).disconnect();
      return { ok: true };
    }),
  );
  v1.get(
    "/github/repos",
    route((_req, _res, a) => {
      const session = deps.session(a.userId);
      return github(() => listRepos(() => session.getToken(), deps.fetch, deps.now));
    }),
  );
  v1.get(
    "/github/repos/:owner/:name/branches",
    route((req, _res, a) => {
      const owner = parse(GitHubName, req.params.owner);
      const name = parse(GitHubName, req.params.name);
      const session = deps.session(a.userId);
      return github(() =>
        listBranches(() => session.getToken(), deps.fetch, deps.now, owner, name),
      );
    }),
  );

  // ---- settings ---------------------------------------------------------------
  v1.get(
    "/settings",
    route((_req, _res, a) => deps.settings.get(a.userId)),
  );
  v1.put(
    "/settings",
    route((req, _res, a) => deps.settings.set(a.userId, parse(SettingsSchema, req.body))),
  );

  // ---- submissions and uploads -----------------------------------------------
  v1.post(
    "/submissions",
    route(async (req, res, a) => {
      const event = parse(SubmissionEventSchema, req.body);
      const settings = await deps.settings.get(a.userId);
      if (!settings.enabledPlatforms[event.platform]) return { decision: "platform-disabled" };
      try {
        const result = await ingestSubmission(deps.store, event, {
          userId: a.userId,
          settings,
          now: deps.now(),
          newId: deps.newId,
          hold: !settings.autoUpload,
        });
        await enqueueIfRunnable(result.job);
        res.status(result.decision === "existing" ? 200 : 201);
        return { decision: result.decision, upload: summarizeJob(result.job) };
      } catch (err) {
        if (err instanceof InvalidSubmissionError) throw new HttpError(422, err.message);
        throw err;
      }
    }),
  );
  v1.get(
    "/uploads",
    route(async (req, _res, a) => {
      const limit = parse(z.coerce.number().int().min(1).max(500).default(100), req.query.limit);
      const [jobs, uploadedCount] = await Promise.all([
        deps.store.listForUser(a.userId, limit),
        deps.store.countSuccess(a.userId),
      ]);
      return { uploads: jobs.map(summarizeJob), uploadedCount };
    }),
  );
  v1.post(
    "/uploads/force",
    route(async (req, _res, a) => {
      const body = parse(ForceBody, req.body);
      const job = await deps.store.findBySubmission(body.platform, body.submissionId);
      if (!job || job.userId !== a.userId) throw new HttpError(404, "Upload not found.");
      return { upload: summarizeJob(await requeue(a, job, true)) };
    }),
  );
  v1.post(
    "/uploads/retry-failed",
    route(async (_req, _res, a) => {
      let queued = 0;
      for (const job of await deps.store.listByStatus(a.userId, [
        "FAILED_PERMANENT",
        "NEEDS_AUTH",
      ])) {
        if ((await requeue(a, job, false)).status === "QUEUED") queued++;
      }
      return { queued };
    }),
  );
  v1.get(
    "/uploads/:id",
    route(async (req, _res, a) => ({
      upload: summarizeJob(await ownJob(a, String(req.params.id))),
    })),
  );
  v1.post(
    "/uploads/:id/retry",
    route(async (req, _res, a) => ({
      upload: summarizeJob(await requeue(a, await ownJob(a, String(req.params.id)), false)),
    })),
  );
  v1.delete(
    "/data",
    route(async (_req, _res, a) => {
      await deps.store.deleteAllForUser(a.userId);
      return { ok: true };
    }),
  );

  app.use("/v1", v1);
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  // Generic error bodies; details go to the (redacted) log only.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === "entity.too.large") {
      res.status(413).json({ error: "Request body too large." });
      return;
    }
    if (e?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Malformed JSON." });
      return;
    }
    deps.log.error("unhandled error", { err });
    res.status(500).json({ error: "Internal error." });
  });
  return app;
}

import type { RequestHandler } from "express";

/**
 * Fixed-window rate limit per client IP, in memory. Enough for a
 * single-user API bound to localhost; not shared across processes.
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  now?: () => number;
}): RequestHandler {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { start: number; count: number }>();
  return (req, res, next) => {
    const t = now();
    const key = req.ip ?? "unknown";
    let entry = hits.get(key);
    if (!entry || t - entry.start >= opts.windowMs) {
      entry = { start: t, count: 0 };
      hits.set(key, entry);
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (t - v.start >= opts.windowMs) hits.delete(k);
      }
    }
    entry.count++;
    if (entry.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.start + opts.windowMs - t) / 1000)));
      res.status(429).json({ error: "Too many requests." });
      return;
    }
    next();
  };
}

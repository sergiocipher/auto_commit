import { redact } from "@cst/core";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names whose values are never logged, whatever they contain. */
const SECRET_FIELDS =
  /token|secret|password|authorization|cookie|sourcecode|devicecode|encryption/i;

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function clean(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (typeof value === "string") return redact(value);
  if (depth > 3 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_FIELDS.test(k) ? "[REDACTED]" : clean(v, depth + 1);
  }
  return out;
}

/**
 * Structured JSON logs, one object per line. Values pass through the same
 * redaction as stored errors, and secret-looking field names are dropped.
 */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stdout.write(line + "\n"),
  base: LogFields = {},
): Logger {
  const log =
    (lvl: LogLevel) =>
    (msg: string, fields: LogFields = {}) => {
      if (ORDER[lvl] < ORDER[level]) return;
      const entry = clean({ ...base, ...fields }) as LogFields;
      write(
        JSON.stringify({ time: new Date().toISOString(), level: lvl, msg: redact(msg), ...entry }),
      );
    };
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: (fields) => createLogger(level, write, { ...base, ...fields }),
  };
}

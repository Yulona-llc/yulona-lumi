/** Structured JSON logger with key-based redaction. No dependencies. */
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|hash|csrf|credential|private/i;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[Truncated]";
  if (value === null || typeof value !== "object") {
    return typeof value === "string" && value.length > 2000 ? value.slice(0, 2000) + "…" : value;
  }
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(opts: {
  level?: LogLevel;
  service?: string;
  write?: (line: string) => void;
  bindings?: Record<string, unknown>;
} = {}): Logger {
  const min = LEVELS[opts.level ?? "info"];
  const write = opts.write ?? ((l: string) => process.stdout.write(l + "\n"));
  const bindings = opts.bindings ?? {};
  const emit = (level: Exclude<LogLevel, "silent">, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < min) return;
    const rec = { level, time: new Date().toISOString(), service: opts.service, msg, ...(redact({ ...bindings, ...fields }) as object) };
    write(JSON.stringify(rec));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (b) => createLogger({ ...opts, bindings: { ...bindings, ...b } }),
  };
}

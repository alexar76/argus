import type { Logger, LogLevel } from "./types.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOR: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

/**
 * Minimal leveled logger. Writes to stderr so the CLI's stdout stays clean for
 * agent output / piping. Honors ARGUS_LOG_LEVEL (default "info").
 */
export function createLogger(scope = "argus", level?: LogLevel): Logger {
  const threshold = LEVELS[level ?? (process.env.ARGUS_LOG_LEVEL as LogLevel) ?? "info"] ?? 20;
  const tty = process.stderr.isTTY;

  function emit(lvl: LogLevel, msg: string, args: unknown[]) {
    if (LEVELS[lvl] < threshold) return;
    const tag = tty ? `${COLOR[lvl]}${lvl.toUpperCase()}${RESET}` : lvl.toUpperCase();
    // Escape \n → ⏎ and \r → ∅ to prevent log-forging via newline injection.
    const safe = msg.replace(/\r/g, "∅").replace(/\n/g, "⏎");
    const line = `${tag} [${scope}] ${safe}`;
    const extra = args.length ? " " + args.map(fmt).join(" ") : "";
    process.stderr.write(line + extra + "\n");
  }

  return {
    debug: (m, ...a) => emit("debug", m, a),
    info: (m, ...a) => emit("info", m, a),
    warn: (m, ...a) => emit("warn", m, a),
    error: (m, ...a) => emit("error", m, a),
    child: (s) => createLogger(`${scope}:${s}`, level),
  };
}

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MIN_LEVEL: Level = (process.env.OWLCLAW_LOG_LEVEL as Level) ?? "info";

interface LogEvent {
  t: string;
  level: Level;
  scope: string;
  msg: string;
  [k: string]: unknown;
}

const RECENT_MAX = 500;
const recent: LogEvent[] = [];

function emit(event: LogEvent): void {
  if (LEVEL_ORDER[event.level] < LEVEL_ORDER[MIN_LEVEL]) return;
  recent.push(event);
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  const { t, level, scope, msg, ...rest } = event;
  const extras = Object.keys(rest).length > 0 ? " " + JSON.stringify(rest) : "";
  const line = `[${t}] ${level.toUpperCase().padEnd(5)} ${scope.padEnd(10)} ${msg}${extras}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(scope: string) {
  const log = (level: Level, msg: string, extra?: Record<string, unknown>): void => {
    emit({
      t: new Date().toISOString(),
      level,
      scope,
      msg,
      ...(extra ?? {}),
    });
  };
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => log("debug", msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => log("info", msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => log("warn", msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log("error", msg, extra),
  };
}

export function recentLogs(limit = 100): LogEvent[] {
  const n = Math.min(Math.max(limit, 1), recent.length);
  return recent.slice(-n);
}

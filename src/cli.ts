import { config } from "./config.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("cli");

export interface SpawnOptions {
  cmd: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export async function spawnProcess(opts: SpawnOptions): Promise<SpawnResult> {
  const start = Date.now();
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (config.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = config.anthropicBaseUrl;
  if (opts.extraEnv) Object.assign(env, opts.extraEnv);

  log.info("spawn", { cmd: opts.cmd[0], args: opts.cmd.slice(1), cwd: opts.cwd });

  const proc = Bun.spawn({
    cmd: opts.cmd,
    cwd: opts.cwd,
    env,
    stdin: opts.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }

  let timedOut = false;
  const killTimer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch (e) {
          log.warn("kill failed", { err: String(e) });
        }
      }, opts.timeoutMs)
    : null;

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (killTimer) clearTimeout(killTimer);

  const durationMs = Date.now() - start;
  log.info("spawn exit", {
    cmd: opts.cmd[0],
    exitCode,
    durationMs,
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    timedOut,
  });

  return { exitCode: exitCode ?? 1, stdout, stderr, durationMs, timedOut };
}

export async function isRunnable(binary: string): Promise<{ ok: boolean; version: string | null; error: string | null }> {
  if (!Bun.which(binary)) return { ok: false, version: null, error: "not installed" };
  try {
    const r = await spawnProcess({ cmd: [binary, "--version"], timeoutMs: 15_000 });
    if (r.exitCode === 0) {
      const v = (r.stdout || r.stderr).trim().split("\n")[0] ?? null;
      return { ok: true, version: v, error: null };
    }
    return { ok: false, version: null, error: (r.stderr || r.stdout).trim().slice(0, 500) };
  } catch (err) {
    return { ok: false, version: null, error: String(err) };
  }
}

/**
 * Patterns that indicate the call should be retried rather than failed.
 * Covers Claude API rate limits, overload, timeouts, and network hiccups
 * that typically resolve with backoff.
 */
const RETRYABLE_PATTERNS: RegExp[] = [
  /\brate.?limit/i,
  /\b429\b/,
  /\bquota\b/i,
  /\boverloaded\b/i,
  /service.{0,10}unavailable/i,
  /\b503\b/,
  /\b529\b/,
  /try.{0,5}again/i,
  /temporar(y|ily)/i,
  /timed?.?out/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /fetch failed/i,
];

export interface RetrySignal {
  retryable: boolean;
  sleepMs: number | null;
  reason: string | null;
}

export function detectRetrySignal(combined: string): RetrySignal {
  if (!combined) return { retryable: false, sleepMs: null, reason: null };

  for (const re of RETRYABLE_PATTERNS) {
    const m = combined.match(re);
    if (m) {
      return {
        retryable: true,
        sleepMs: parseRetryAfter(combined),
        reason: m[0],
      };
    }
  }
  return { retryable: false, sleepMs: null, reason: null };
}

/**
 * Try to extract an explicit wait hint from CLI output.
 * Supported shapes:
 *   - "retry-after: 1712999999"     (unix seconds timestamp, in future)
 *   - "retry-after: 42"             (seconds delta)
 *   - "reset at 2026-04-13T12:00:00Z"
 *   - "try again in 5 minutes"
 *   - "wait 30 seconds"
 * Returns ms delay or null when no hint is present.
 */
export function parseRetryAfter(text: string): number | null {
  const nowMs = Date.now();

  const headerMatch = text.match(/retry[-_ ]?after[":\s]+([0-9.]+)/i);
  if (headerMatch) {
    const n = Number.parseFloat(headerMatch[1]!);
    if (Number.isFinite(n) && n > 0) {
      if (n > 10_000_000_000) return Math.max(0, n - nowMs);
      if (n > 1_000_000_000) return Math.max(0, n * 1000 - nowMs);
      return n * 1000;
    }
  }

  const isoMatch = text.match(/reset(?:s|ting)?\s*(?:at|on)?[:\s]*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.\-Z+]+)/i);
  if (isoMatch) {
    const t = Date.parse(isoMatch[1]!);
    if (Number.isFinite(t)) return Math.max(0, t - nowMs);
  }

  const inMinutes = text.match(/\b(?:in|wait|sleep)\s+([0-9]+)\s*(?:minutes?|mins?)\b/i);
  if (inMinutes) return Number.parseInt(inMinutes[1]!, 10) * 60_000;

  const inSeconds = text.match(/\b(?:in|wait|sleep)\s+([0-9]+)\s*(?:seconds?|secs?)\b/i);
  if (inSeconds) return Number.parseInt(inSeconds[1]!, 10) * 1000;

  const inHours = text.match(/\b(?:in|wait|sleep)\s+([0-9]+)\s*(?:hours?|hrs?)\b/i);
  if (inHours) return Number.parseInt(inHours[1]!, 10) * 3_600_000;

  return null;
}

export interface RunWithRetryOptions extends SpawnOptions {
  label: string;
  onRetry?: (attempt: number, sleepMs: number, reason: string) => Promise<void> | void;
  shouldAbort?: () => boolean;
}

export interface RetryResult extends SpawnResult {
  attempts: number;
}

export async function runWithRetry(opts: RunWithRetryOptions): Promise<RetryResult> {
  const maxAttempts = Math.max(1, config.maxRetries + 1);
  let attempt = 0;
  let last: SpawnResult | null = null;

  while (attempt < maxAttempts) {
    attempt++;
    if (opts.shouldAbort && opts.shouldAbort()) {
      throw new Error(`${opts.label} aborted before attempt ${attempt}`);
    }
    const result = await spawnProcess(opts);
    last = result;

    if (result.exitCode === 0 && !result.timedOut) {
      return { ...result, attempts: attempt };
    }

    const combined = `${result.stdout}\n${result.stderr}`;
    const signal = result.timedOut
      ? { retryable: true, sleepMs: null, reason: "process timeout" }
      : detectRetrySignal(combined);

    if (!signal.retryable) {
      return { ...result, attempts: attempt };
    }

    if (attempt >= maxAttempts) {
      log.warn("retry budget exhausted", { label: opts.label, attempts: attempt });
      return { ...result, attempts: attempt };
    }

    const sleepMs = Math.min(
      Math.max(signal.sleepMs ?? config.retryIntervalSec * 1000, 1000),
      6 * 60 * 60 * 1000,
    );
    log.warn("retryable CLI failure, sleeping", {
      label: opts.label,
      attempt,
      sleepMs,
      reason: signal.reason,
    });
    if (opts.onRetry) await opts.onRetry(attempt, sleepMs, signal.reason ?? "unknown");
    await sleep(sleepMs, opts.shouldAbort);
  }

  return { ...(last as SpawnResult), attempts: attempt };
}

export async function sleep(ms: number, shouldAbort?: () => boolean): Promise<void> {
  const step = 500;
  let remaining = ms;
  while (remaining > 0) {
    if (shouldAbort && shouldAbort()) return;
    const chunk = Math.min(step, remaining);
    await new Promise((r) => setTimeout(r, chunk));
    remaining -= chunk;
  }
}

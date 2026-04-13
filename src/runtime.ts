import { spawn as nodeSpawn, type StdioOptions, type IOType } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";

/**
 * Node-runtime shims for the Bun APIs the rest of the codebase used to call.
 * Keeping them in one module so swapping them later (e.g. back to Bun, or to
 * Deno) is a one-file change.
 */

export interface SpawnIO {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | "inherit";
  stdoutMode?: "pipe" | "inherit";
  stderrMode?: "pipe" | "inherit";
  timeoutMs?: number;
}

export interface SpawnIOResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn a child process and resolve once it exits. Captures stdout/stderr by
 * default; either stream can be passed through with `*Mode: "inherit"`. If
 * `stdin` is a string it is written and the pipe is closed; "inherit" leaves
 * the parent's stdin attached (used by interactive sub-commands like
 * `tmux attach`).
 */
export function runProcess(opts: SpawnIO): Promise<SpawnIOResult> {
  return new Promise<SpawnIOResult>((resolve) => {
    const stdoutMode: IOType = opts.stdoutMode ?? "pipe";
    const stderrMode: IOType = opts.stderrMode ?? "pipe";
    const stdinMode: IOType = opts.stdin === "inherit" ? "inherit"
      : opts.stdin !== undefined ? "pipe" : "ignore";
    const stdio: StdioOptions = [stdinMode, stdoutMode, stderrMode];

    let proc;
    try {
      proc = nodeSpawn(opts.cmd[0]!, opts.cmd.slice(1), {
        cwd: opts.cwd,
        env: opts.env ?? (process.env as Record<string, string>),
        stdio,
      });
    } catch (err) {
      resolve({
        exitCode: 127,
        stdout: "",
        stderr: String(err instanceof Error ? err.message : err),
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });

    if (typeof opts.stdin === "string" && proc.stdin) {
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    }

    let timedOut = false;
    const killTimer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { proc.kill("SIGKILL"); } catch {}
        }, opts.timeoutMs)
      : null;

    const finish = (code: number, errMsg?: string) => {
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: code,
        stdout,
        stderr: errMsg ? (stderr ? `${stderr}\n${errMsg}` : errMsg) : stderr,
        timedOut,
      });
    };

    proc.on("close", (code) => finish(code ?? 1));
    proc.on("error", (err: NodeJS.ErrnoException) => {
      // ENOENT = command not found; surface a clean message that mirrors what
      // Bun used to throw, so the existing error handling stays intact.
      if (err.code === "ENOENT") {
        finish(127, `Executable not found in $PATH: "${opts.cmd[0]}"`);
      } else {
        finish(1, err.message);
      }
    });
  });
}

/**
 * Look up an executable on $PATH. Returns the absolute path or null.
 * Equivalent of `Bun.which(name)` / POSIX `which`.
 */
export function which(bin: string): string | null {
  // Absolute path? Only valid if it actually exists and is executable.
  if (bin.includes("/") || bin.includes("\\")) {
    return existsSync(bin) ? bin : null;
  }
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const p of paths) {
    const full = join(p, bin);
    try {
      const st = statSync(full);
      if (st.isFile() && (st.mode & 0o111)) return full;
    } catch { /* not on this path entry */ }
  }
  return null;
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

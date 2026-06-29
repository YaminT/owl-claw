import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Called with each stdout/stderr chunk as it arrives, for live streaming to
   * the UI. The full output is still accumulated and returned on close.
   */
  onData?: (chunk: string) => void;
}

/**
 * Spawn a child process scoped to `cwd`, capture stdout/stderr, optionally feed
 * stdin, and enforce a timeout. Portable across Bun + Node (node:child_process
 * works on both). Never throws on non-zero exit — the caller inspects `code`.
 */
export function execCommand(
  command: string,
  args: string[],
  opts: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    // Node's spawn rejects argv entries / stdin containing NUL bytes. Agent
    // output (a plan, a diff) gets fed into the next step's prompt and can carry
    // a stray NUL — strip them so a poisoned prompt doesn't crash the run.
    const safeArgs = args.map((a) => a.replace(/\0/g, ""));
    const child = spawn(command, safeArgs, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }

    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      opts.onData?.(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      opts.onData?.(s);
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

/** Returns true if a command resolves on PATH (used by health checks). */
export async function commandExists(command: string): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";
  const res = await execCommand(probe, [command], { cwd: process.cwd(), timeoutMs: 5000 });
  return res.code === 0;
}

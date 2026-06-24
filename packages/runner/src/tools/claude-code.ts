import { commandExists, execCommand } from "../exec.js";
import type { HealthResult, RunOptions, RunResult, Tool } from "./types.js";
import { parseUsage } from "./usage.js";

/**
 * Adapter for the `claude` CLI (Claude Code). Shells out non-interactively with
 * `--print` and, in auto mode, a permission mode that skips prompts. Execution
 * is strictly scoped to `opts.cwd` (worktree-isolation spec).
 */
export class ClaudeCodeTool implements Tool {
  readonly id = "claude-code";
  readonly displayName = "Claude Code";
  readonly defaultModels = ["opus-4.8", "sonnet-4.6"];
  private readonly bin = process.env.OWL_CLAUDE_BIN ?? "claude";

  async detect(): Promise<HealthResult> {
    if (!(await commandExists(this.bin))) {
      return { status: "unavailable", message: `\`${this.bin}\` not found on PATH` };
    }
    const res = await execCommand(this.bin, ["--version"], {
      cwd: process.cwd(),
      timeoutMs: 8000,
    });
    if (res.code !== 0) {
      return { status: "unavailable", message: `\`${this.bin} --version\` exited ${res.code}` };
    }
    return { status: "available", message: "claude CLI detected", version: res.stdout.trim() };
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const args = ["--print", "--model", opts.model, "--append-system-prompt", opts.systemPrompt];
    if (opts.autoApprove) {
      // --dangerously-skip-permissions bypasses every tool-permission prompt.
      // In --print (non-interactive) mode the one-time "are you sure" acceptance
      // dialog never renders, so there is nothing to confirm — the flag alone
      // grants full auto-approval.
      args.push("--dangerously-skip-permissions");
    }
    const res = await execCommand(this.bin, args, {
      cwd: opts.cwd,
      input: opts.prompt,
      timeoutMs: opts.timeoutMs,
    });
    const output = `$ ${this.bin} ${args.join(" ")}\n[exit ${res.code}]\n${res.stdout}\n${res.stderr}`;
    if (res.code !== 0 || res.timedOut) {
      throw new ToolRunError(this.id, res.code, res.timedOut, output);
    }
    return { output, report: res.stdout.trim(), usage: parseUsage(res.stdout + res.stderr) };
  }
}

export class ToolRunError extends Error {
  constructor(
    public readonly toolId: string,
    public readonly code: number | null,
    public readonly timedOut: boolean,
    public readonly output: string,
  ) {
    super(timedOut ? `${toolId} timed out` : `${toolId} exited with code ${code ?? "null"}`);
    this.name = "ToolRunError";
  }
}

import { commandExists, execCommand } from "../exec.js";
import { ToolRunError } from "./claude-code.js";
import type { HealthResult, RunOptions, RunResult, Tool } from "./types.js";
import { parseUsage } from "./usage.js";

/**
 * Adapter for the `codex` CLI. Runs non-interactively via `exec`; in auto mode
 * uses full-auto / bypass sandbox flags. Scoped to `opts.cwd`.
 */
export class CodexTool implements Tool {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly defaultModels = ["gpt-5.5"];
  private readonly bin = process.env.OWL_CODEX_BIN ?? "codex";

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
    return { status: "available", message: "codex CLI detected", version: res.stdout.trim() };
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const args = ["exec", "--model", opts.model];
    if (opts.autoApprove) {
      // Full auto-approval, no sandbox — the runner's equivalent of claude's
      // --dangerously-skip-permissions. Mutually exclusive with --full-auto
      // (codex rejects both together), so pass only the bypass flag.
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    args.push(`${opts.systemPrompt}\n\n${opts.prompt}`);

    const res = await execCommand(this.bin, args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      onData: opts.onChunk,
    });
    const output = `$ ${this.bin} ${args.slice(0, -1).join(" ")} <prompt>\n[exit ${res.code}]\n${res.stdout}\n${res.stderr}`;
    if (res.code !== 0 || res.timedOut) {
      throw new ToolRunError(this.id, res.code, res.timedOut, output);
    }
    return { output, report: res.stdout.trim(), usage: parseUsage(res.stdout + res.stderr) };
  }
}

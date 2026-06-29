import type { TokenUsage } from "@owl/shared";
import { commandExists, execCommand } from "../exec.js";
import type { HealthResult, RunOptions, RunResult, Tool } from "./types.js";
import { parseUsage } from "./usage.js";

/**
 * Adapter for the `claude` CLI (Claude Code). Runs non-interactively with
 * `--output-format stream-json --include-partial-messages` so output arrives
 * token-by-token (plain `--print` buffers everything until exit). A
 * StreamRenderer turns the JSON event stream into readable text — assistant
 * text as it types, tool calls, and tool results — forwarded live via
 * `opts.onChunk`. Execution is scoped to `opts.cwd` (worktree-isolation spec).
 */
export class ClaudeCodeTool implements Tool {
  readonly id = "claude-code";
  readonly displayName = "Claude Code";
  readonly defaultModels = ["opus", "sonnet", "haiku"];
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
    // stream-json requires --verbose in --print mode; --include-partial-messages
    // adds token-level deltas for a live, CLI-like view.
    const args = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--model",
      opts.model,
      "--append-system-prompt",
      opts.systemPrompt,
    ];
    if (opts.autoApprove) {
      // --dangerously-skip-permissions bypasses every tool-permission prompt.
      args.push("--dangerously-skip-permissions");
    }

    const render = new StreamRenderer((text) => opts.onChunk?.(text));
    const res = await execCommand(this.bin, args, {
      cwd: opts.cwd,
      input: opts.prompt,
      timeoutMs: opts.timeoutMs,
      onData: (chunk) => render.push(chunk),
    });
    render.flush();

    const header = `$ ${this.bin} --print --output-format stream-json --model ${opts.model}\n[exit ${res.code}]`;
    const output = `${header}\n${render.transcript}`;
    if (res.code !== 0 || res.timedOut) {
      throw new ToolRunError(this.id, res.code, res.timedOut, `${output}\n${res.stderr}`);
    }
    return {
      output,
      report: render.report || render.transcript.trim(),
      usage: render.usage ?? parseUsage(res.stdout),
    };
  }
}

/**
 * Incremental renderer for the claude CLI's `stream-json` output. Each line of
 * stdout is one JSON event; we buffer partial lines, parse complete ones, and
 * emit human-readable text (assistant tokens, `⏺ Tool(arg)` calls, `⎿ result`
 * summaries) both live (via the callback) and into `transcript` for the record.
 */
export class StreamRenderer {
  transcript = "";
  report = "";
  usage?: TokenUsage;
  private buf = "";
  private blocks = new Map<number, { type?: string; name?: string; json: string }>();

  constructor(private readonly onText: (text: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.handleLine(line);
    }
  }

  flush(): void {
    if (this.buf.trim()) this.handleLine(this.buf);
    this.buf = "";
  }

  private emit(text: string): void {
    if (!text) return;
    this.transcript += text;
    this.onText(text);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return; // ignore non-JSON noise
    }
    switch (obj.type) {
      case "stream_event":
        this.streamEvent(obj.event as Record<string, unknown> | undefined);
        break;
      case "user":
        this.toolResult(obj.message as Record<string, unknown> | undefined);
        break;
      case "result":
        if (typeof obj.result === "string") this.report = obj.result;
        this.usage = usageFromResult(obj);
        break;
      // "system"/"assistant" ignored: text already arrives via stream_event deltas.
    }
  }

  private streamEvent(ev?: Record<string, unknown>): void {
    if (!ev) return;
    if (ev.type === "content_block_start") {
      const cb = (ev.content_block as Record<string, unknown>) ?? {};
      const index = ev.index as number;
      this.blocks.set(index, { type: cb.type as string, name: cb.name as string, json: "" });
      if (cb.type === "tool_use") this.emit(`\n⏺ ${cb.name as string}`);
    } else if (ev.type === "content_block_delta") {
      const d = (ev.delta as Record<string, unknown>) ?? {};
      if (d.type === "text_delta") this.emit(d.text as string);
      else if (d.type === "input_json_delta") {
        const b = this.blocks.get(ev.index as number);
        if (b) b.json += (d.partial_json as string) ?? "";
      }
    } else if (ev.type === "content_block_stop") {
      const b = this.blocks.get(ev.index as number);
      if (b?.type === "tool_use") {
        const arg = firstArg(b.json);
        this.emit(arg ? `(${arg})\n` : "\n");
      } else if (b?.type === "text") {
        this.emit("\n");
      }
      this.blocks.delete(ev.index as number);
    }
  }

  private toolResult(message?: Record<string, unknown>): void {
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (part?.type !== "tool_result") continue;
      const text = toolResultText(part.content);
      if (text) this.emit(`  ⎿ ${truncate(text, 160)}\n`);
    }
  }
}

function firstArg(json: string): string {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const key = ["file_path", "path", "command", "pattern", "url", "query"].find(
      (k) => typeof obj[k] === "string",
    );
    return key ? truncate(String(obj[key]), 80) : "";
  } catch {
    return "";
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content.split("\n")[0];
  if (Array.isArray(content)) {
    const first = content.find((c) => c?.type === "text");
    return first ? String(first.text).split("\n")[0] : "";
  }
  return "";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function usageFromResult(obj: Record<string, unknown>): TokenUsage | undefined {
  const u = obj.usage as Record<string, unknown> | undefined;
  if (!u) return undefined;
  const inputTokens = Number(u.input_tokens ?? 0);
  const outputTokens = Number(u.output_tokens ?? 0);
  const costUsd = Number(obj.total_cost_usd ?? 0);
  return { inputTokens, outputTokens, costUsd, known: true };
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

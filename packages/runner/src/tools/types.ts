import type { Role, TokenUsage } from "@owl/shared";

export type HealthStatus = "available" | "unavailable";

export interface HealthResult {
  status: HealthStatus;
  /** Human-readable detail for the settings health-check UI. */
  message: string;
  /** Resolved version string when available. */
  version?: string;
}

export interface RunOptions {
  role: Role;
  model: string;
  systemPrompt: string;
  prompt: string;
  /** Working directory (the per-task worktree, or the working directory). */
  cwd: string;
  /** Auto mode: pass non-interactive / no-permission-prompt flags. */
  autoApprove: boolean;
  /** Optional timeout for this run. */
  timeoutMs?: number;
}

export interface RunResult {
  /** Raw combined output captured from the tool (also written to log.txt). */
  output: string;
  /** The role's written report (plan / developer notes / review). */
  report: string;
  /** Clarifying questions, if the tool raised any (planner park loop). */
  questions?: string[];
  /** Best-effort token usage parsed from the output. */
  usage?: TokenUsage;
}

/**
 * Pluggable coding-agent tool. New tools implement this interface and register
 * themselves; the pipeline never references concrete tools (tool-adapters spec).
 */
export interface Tool {
  id: string;
  displayName: string;
  defaultModels: string[];
  detect(): Promise<HealthResult>;
  run(opts: RunOptions): Promise<RunResult>;
}

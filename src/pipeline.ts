import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { runWithRetry, spawnProcess } from "./cli.js";
import {
  bumpRetry,
  finalize,
  moveToDone,
  updateStage,
  type TaskView,
} from "./store.js";

const log = createLogger("pipeline");

export interface PipelineDeps {
  shouldAbort?: () => boolean;
  onStage?: (stage: string, note?: string) => void | Promise<void>;
}

export interface PipelineOutcome {
  status: "DONE_SUCCESS" | "DONE_FAILED";
  error: string | null;
}

const EXEC_HEADER = `You are executing a development task for the project in the current working directory.
Follow the task in the # Instructions section literally and carry it out end-to-end.

Conventions:
- Keep changes scoped to what the task requires.
- Match existing code style and conventions.
- Do not commit unless the task asks for it.
- Do not push.
- When finished, briefly state what you did.`;

const EXEC_FOOTER = `# Output

When you are done, print a short summary of the changes you made and any files touched.
If you could not complete the task, print the reason explicitly.`;

function buildExecutionPrompt(taskContent: string): string {
  return `${EXEC_HEADER}\n\n# Instructions\n\n${taskContent.trim()}\n\n${EXEC_FOOTER}\n`;
}

async function readFrontendClaudeMd(): Promise<string> {
  const candidates = ["CLAUDE.md", "claude.md", ".claude/CLAUDE.md"];
  for (const rel of candidates) {
    const p = join(config.frontendDir, rel);
    if (existsSync(p)) {
      return await readFile(p, "utf8");
    }
  }
  throw new Error(`CLAUDE.md not found in ${config.frontendDir}`);
}

async function gitDiff(args: string[]): Promise<string> {
  const r = await spawnProcess({
    cmd: ["git", ...args],
    cwd: config.frontendDir,
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

interface StepOpts {
  label: string;
  stage: string;
  cmd: string[];
  stdin: string;
  timeoutMs: number;
  filename: string;
  deps: PipelineDeps;
}

async function runStep(opts: StepOpts): Promise<void> {
  const { label, stage, cmd, stdin, timeoutMs, filename, deps } = opts;
  const result = await runWithRetry({
    label,
    cmd,
    cwd: config.frontendDir,
    stdin,
    timeoutMs,
    shouldAbort: deps.shouldAbort,
    onRetry: async (attempt, sleepMs, reason) => {
      await bumpRetry(filename);
      await deps.onStage?.(`${stage}-retry`, `attempt ${attempt}, sleep ${Math.round(sleepMs / 1000)}s (${reason})`);
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${result.exitCode} after ${result.attempts} attempt(s): ${truncate(result.stderr || result.stdout)}`,
    );
  }
}

async function runClaudeExecution(taskContent: string, filename: string, deps: PipelineDeps): Promise<void> {
  const stdin = buildExecutionPrompt(taskContent);
  const cmd = [config.claudeBin, "--dangerously-skip-permissions", "--print"];
  for (let run = 1; run <= config.promptRuns; run++) {
    await deps.onStage?.("claude-exec", `run ${run}/${config.promptRuns}`);
    await runStep({
      label: `claude-exec-run-${run}`,
      stage: "claude-exec",
      cmd,
      stdin,
      timeoutMs: 120 * 60 * 1000,
      filename,
      deps,
    });
  }
}

async function runClaudeReview(filename: string, deps: PipelineDeps): Promise<void> {
  await deps.onStage?.("claude-review", "collecting diff");
  const claudeMd = await readFrontendClaudeMd();
  const diff = await gitDiff(["diff"]);
  const stdin = buildReviewPrompt({
    title: "Claude Code Review",
    claudeMd,
    diff,
    diffLabel: "git diff (unstaged changes)",
  });
  await runStep({
    label: "claude-review",
    stage: "claude-review",
    cmd: [config.claudeBin, "--dangerously-skip-permissions", "--print"],
    stdin,
    timeoutMs: 30 * 60 * 1000,
    filename,
    deps,
  });
}

async function runCodexReview(filename: string, deps: PipelineDeps): Promise<void> {
  await deps.onStage?.("codex-review", "collecting diff");
  const diff = await gitDiff(["diff", "HEAD"]);
  const stdin = buildReviewPrompt({
    title: "Codex Review",
    claudeMd: null,
    diff,
    diffLabel: "git diff HEAD (uncommitted changes)",
  });
  await runStep({
    label: "codex-review",
    stage: "codex-review",
    cmd: [config.codexBin, "exec", "--dangerously-bypass-approvals-and-sandbox", "-C", config.frontendDir, "-"],
    stdin,
    timeoutMs: 30 * 60 * 1000,
    filename,
    deps,
  });
}

function buildReviewPrompt(opts: {
  title: string;
  claudeMd: string | null;
  diff: string;
  diffLabel: string;
}): string {
  const sections: string[] = [
    `# ${opts.title}`,
    "",
    "Review the changes below for correctness, quality, consistency with the project conventions, and potential bugs or regressions.",
    "Be concrete. Point out specific lines. If the changes are fine, say so plainly.",
  ];
  if (opts.claudeMd) {
    sections.push("", "## Project instructions (CLAUDE.md)", "", opts.claudeMd.trim());
  }
  sections.push("", `## ${opts.diffLabel}`, "", "```diff", opts.diff.trim() || "(no changes)", "```");
  return sections.join("\n") + "\n";
}

function truncate(s: string, max = 1000): string {
  const t = (s ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export async function runPipeline(task: TaskView, deps: PipelineDeps = {}): Promise<PipelineOutcome> {
  log.info("pipeline start", { filename: task.filename });
  const reportStage = async (stage: string, note?: string) => {
    await updateStage(task.filename, note ? `${stage}: ${note}` : stage);
    await deps.onStage?.(stage, note);
  };

  const srcPath = join(config.instructionsDir, task.filename);
  let content: string;
  try {
    content = await readFile(srcPath, "utf8");
  } catch (err) {
    const msg = `Failed to read task file: ${String(err)}`;
    log.error(msg, { filename: task.filename });
    await finalize(task.filename, "DONE_FAILED", msg);
    return { status: "DONE_FAILED", error: msg };
  }

  let movedToDone = false;
  try {
    await runClaudeExecution(content, task.filename, { ...deps, onStage: reportStage });

    await reportStage("moving-to-done");
    await moveToDone(task.filename);
    movedToDone = true;

    await runClaudeReview(task.filename, { ...deps, onStage: reportStage });
    await runCodexReview(task.filename, { ...deps, onStage: reportStage });

    await finalize(task.filename, "DONE_SUCCESS", null);
    log.info("pipeline success", { filename: task.filename, movedToDone });
    return { status: "DONE_SUCCESS", error: null };
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    log.error("pipeline failed", { filename: task.filename, movedToDone, err: msg });
    await finalize(task.filename, "DONE_FAILED", msg);
    return { status: "DONE_FAILED", error: msg };
  }
}

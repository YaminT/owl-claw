#!/usr/bin/env bun
import { resolve, join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { arch as osArch, homedir } from "node:os";

// Resolve the OwlRun project root from this script's location. Walk up until
// we find a package.json whose name matches.
function findProjectRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 5; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const name = JSON.parse(readFileSync(pkg, "utf8")).name;
        if (name === "owlrun") return dir;
      } catch {}
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find OwlRun project root starting from ${here}`);
}

const PROJECT_ROOT = findProjectRoot();
const PKG_VERSION = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")).version ?? "0.0.0";

const OWLRUN_USER_HOME = join(homedir(), ".owlrun");
const TMUX_SESSION = process.env.OWLRUN_TMUX_SESSION ?? "owlrun";
const HOST = process.env.OWLRUN_HOST ?? "127.0.0.1";
const PORT = process.env.OWLRUN_PORT ?? "8090";
const BASE_URL = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`;
const DEFAULT_INS = process.env.OWLRUN_INSTRUCTIONS_DIR ?? join(OWLRUN_USER_HOME, "instructions");
const DEFAULT_FE = process.env.OWLRUN_FRONTEND_DIR ?? join(OWLRUN_USER_HOME, "frontend-target");
const LOG_FILE = process.env.OWLRUN_LOG_FILE ?? join(homedir(), "owlrun.log");

/* ANSI */
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};
const fmt = {
  ok: (s: string) => `${c.green}✓${c.reset} ${s}`,
  warn: (s: string) => `${c.yellow}⚠${c.reset} ${s}`,
  err: (s: string) => `${c.red}✗${c.reset} ${s}`,
  head: (s: string) => `${c.bold}${s}${c.reset}`,
  dim: (s: string) => `${c.dim}${s}${c.reset}`,
};

interface CommandResult { exitCode: number }
type Handler = (args: string[]) => Promise<CommandResult | void> | CommandResult | void;

/* ---------- helpers ---------- */

async function run(cmd: string[], opts: { allowFail?: boolean } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (!opts.allowFail && exitCode !== 0) {
    throw new Error(`${cmd[0]} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return { exitCode: exitCode ?? 1, stdout, stderr };
}

function which(bin: string): string | null {
  try { return Bun.which(bin); } catch { return null; }
}

async function fetchJson<T = unknown>(path: string): Promise<T> {
  const r = await fetch(`${BASE_URL}${path}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return await r.json() as T;
}

async function isTmuxSessionRunning(): Promise<boolean> {
  if (!which("tmux")) return false;
  const r = await run(["tmux", "has-session", "-t", TMUX_SESSION], { allowFail: true });
  return r.exitCode === 0;
}

const SYSTEMD_UNIT_PATHS = [
  "/etc/systemd/system/owlrun.service",
  "/usr/lib/systemd/system/owlrun.service",
];

function systemdUnitInstalled(): string | null {
  for (const p of SYSTEMD_UNIT_PATHS) if (existsSync(p)) return p;
  return null;
}

type Supervisor = "systemd" | "tmux";

function detectSupervisor(args: string[]): Supervisor {
  // Explicit overrides win.
  if (args.includes("--tmux")) return "tmux";
  if (args.includes("--systemd")) return "systemd";
  if (process.env.OWLRUN_SUPERVISOR === "systemd") return "systemd";
  if (process.env.OWLRUN_SUPERVISOR === "tmux") return "tmux";
  // Auto-detect: systemd unit present + systemctl available → systemd.
  if (systemdUnitInstalled() && which("systemctl")) return "systemd";
  return "tmux";
}

/**
 * Invoke systemctl, transparently using sudo if not root. Returns the result
 * and an error message suitable for printing on failure.
 */
async function systemctl(action: string): Promise<{ ok: boolean; message: string }> {
  const isRoot = process.getuid?.() === 0;
  const cmd = isRoot
    ? ["systemctl", action, "owlrun"]
    : ["sudo", "-p", "[sudo] password to control owlrun.service: ", "systemctl", action, "owlrun"];
  const proc = Bun.spawn({ cmd, stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if ((exitCode ?? 1) === 0) return { ok: true, message: stdout.trim() };
  let msg = (stderr || stdout).trim() || `systemctl ${action} owlrun failed (exit ${exitCode})`;
  // Make the no-tty failure actionable instead of cryptic.
  if (msg.includes("a terminal is required") || msg.includes("no askpass")) {
    msg = `sudo cannot prompt for a password from this shell. Run interactively or:\n  sudo systemctl ${action} owlrun`;
  }
  return { ok: false, message: msg };
}

async function isPortListening(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_URL}/api/worker`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

function printUsage(): void {
  console.log(`${fmt.head("OwlRun CLI")} v${PKG_VERSION}

${fmt.head("Usage:")}  owlrun <command> [options]

${fmt.head("Commands:")}
  ${c.cyan}doctor${c.reset}                  Check environment (bun, claude, codex, git, paths, supervisor)
  ${c.cyan}req${c.reset} [--yes] [tools]     Install missing requirements (claude, codex)
  ${c.cyan}start${c.reset} [--tmux|--systemd] Start OwlRun (auto-detects supervisor; flags force one)
  ${c.cyan}stop${c.reset}  [--tmux|--systemd] Stop the running instance
  ${c.cyan}restart${c.reset} [--tmux|--systemd]
  ${c.cyan}status${c.reset}                  Show worker status and task queue
  ${c.cyan}health${c.reset}                  Show /api/health snapshot
  ${c.cyan}logs${c.reset} [-f|-n N|--journal] Show log tail (-f follow, -n lines, --journal use journalctl)
  ${c.cyan}open${c.reset}                    Print (and open) the web UI URL
  ${c.cyan}attach${c.reset}                  Attach to the tmux session (tmux mode only)
  ${c.cyan}uninstall${c.reset} [--yes|--purge]  Remove OwlRun (sources, wrapper, systemd unit). --purge removes ~/.owlrun too.
  ${c.cyan}version${c.reset} ${c.cyan}help${c.reset}

${fmt.head("Supervisor detection:")}
  ${fmt.dim("Auto-selects systemd when /etc/systemd/system/owlrun.service exists,")}
  ${fmt.dim("otherwise tmux. Override per-call with --tmux / --systemd, or set")}
  ${fmt.dim("OWLRUN_SUPERVISOR=systemd|tmux.")}

${fmt.head("Environment:")}
  ${fmt.dim("OWLRUN_HOST")}                ${c.dim}(default 127.0.0.1 for CLI lookups)${c.reset}
  ${fmt.dim("OWLRUN_PORT")}                ${c.dim}(default 8090)${c.reset}
  ${fmt.dim("OWLRUN_INSTRUCTIONS_DIR")}    ${c.dim}(default ~/.owlrun/instructions)${c.reset}
  ${fmt.dim("OWLRUN_FRONTEND_DIR")}        ${c.dim}(default ~/.owlrun/frontend-target)${c.reset}
  ${fmt.dim("OWLRUN_LOG_FILE")}            ${c.dim}(default ~/owlrun.log)${c.reset}
  ${fmt.dim("OWLRUN_TMUX_SESSION")}        ${c.dim}(default "owlrun")${c.reset}
  ${fmt.dim("OWLRUN_SUPERVISOR")}          ${c.dim}systemd | tmux (overrides auto-detect)${c.reset}
`);
}

/* ---------- commands ---------- */

interface AuthResult { authed: boolean; detail: string }

/**
 * `claude auth status` returns JSON ({ loggedIn, authMethod, email, ... })
 * with exit 0 when logged in, exit 1 when not. Cheap — does not make an
 * API call.
 */
async function checkClaudeAuth(): Promise<AuthResult> {
  try {
    const r = await Bun.spawn({ cmd: ["claude", "auth", "status"], stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(r.stdout).text(),
      new Response(r.stderr).text(),
      r.exited,
    ]);
    const body = stdout.trim() || stderr.trim();
    try {
      const data = JSON.parse(body) as { loggedIn?: boolean; email?: string; authMethod?: string; subscriptionType?: string };
      if (data.loggedIn) {
        const who = data.email ?? data.authMethod ?? "logged in";
        const sub = data.subscriptionType ? `, ${data.subscriptionType}` : "";
        return { authed: true, detail: ` (${who}${sub})` };
      }
      return { authed: false, detail: "not logged in" };
    } catch {
      const ok = (exitCode ?? 1) === 0;
      return { authed: ok, detail: ok ? "" : "not logged in" };
    }
  } catch {
    return { authed: false, detail: "auth status check failed" };
  }
}

/**
 * `codex login status` prints "Logged in using <method>" with exit 0 when
 * authenticated, "Not logged in" with exit 1 otherwise.
 */
async function checkCodexAuth(): Promise<AuthResult> {
  try {
    // codex writes "Logged in using <method>" to stderr, not stdout.
    const r = await Bun.spawn({ cmd: ["codex", "login", "status"], stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(r.stdout).text(),
      new Response(r.stderr).text(),
      r.exited,
    ]);
    const combined = `${stdout}\n${stderr}`;
    if ((exitCode ?? 1) === 0) {
      const m = combined.match(/Logged in(?:\s+using\s+([^\n]+))?/i);
      const who = m?.[1]?.trim();
      return { authed: true, detail: who ? ` (${who})` : "" };
    }
    return { authed: false, detail: "not logged in" };
  } catch {
    return { authed: false, detail: "auth status check failed" };
  }
}

async function cmdDoctor(): Promise<CommandResult> {
  console.log(fmt.head("OwlRun doctor"));
  console.log();

  let errors = 0;
  let warnings = 0;

  // If a running instance is reachable, use its actual config paths. This
  // matters when the user starts OwlRun under different env (systemd unit,
  // tmux with inline env, etc.) than the shell running `owlrun doctor`.
  let runtimeFrontend = DEFAULT_FE;
  let runtimeInstructions = DEFAULT_INS;
  try {
    const h = await fetchJson<{ config: { frontendDir: string; instructionsDir: string } }>("/api/health");
    runtimeFrontend = h.config.frontendDir;
    runtimeInstructions = h.config.instructionsDir;
  } catch { /* server not running -- fall back to env/defaults */ }

  // Bun
  const bunPath = which("bun");
  if (bunPath) {
    const v = (await run(["bun", "--version"])).stdout.trim();
    console.log(fmt.ok(`bun ${v} ${fmt.dim("at " + bunPath)}`));
  } else {
    console.log(fmt.err("bun — not found on $PATH"));
    errors++;
  }

  // Git
  const gitPath = which("git");
  if (gitPath) {
    const v = (await run(["git", "--version"])).stdout.trim();
    console.log(fmt.ok(`${v} ${fmt.dim("at " + gitPath)}`));
  } else {
    console.log(fmt.err("git — not found on $PATH"));
    errors++;
  }

  // Claude (required for execution)
  const claudePath = which("claude");
  if (claudePath) {
    try {
      const v = (await run(["claude", "--version"])).stdout.trim().split("\n")[0];
      const auth = await checkClaudeAuth();
      if (auth.authed) {
        console.log(fmt.ok(`claude ${v}${auth.detail} ${fmt.dim("at " + claudePath)}`));
      } else {
        console.log(fmt.err(`claude ${v} — ${auth.detail || "not logged in"} ${fmt.dim("(run `claude` or `claude setup-token`)")}`));
        errors++;
      }
    } catch (e) {
      console.log(fmt.warn(`claude — installed but not runnable: ${String(e).slice(0, 120)}`));
      warnings++;
    }
  } else {
    console.log(fmt.err(`claude — not found on $PATH ${fmt.dim("(required for task execution)")}`));
    errors++;
  }

  // Codex (warning only)
  const codexPath = which("codex");
  if (codexPath) {
    try {
      const v = (await run(["codex", "--version"])).stdout.trim().split("\n")[0];
      const auth = await checkCodexAuth();
      if (auth.authed) {
        console.log(fmt.ok(`codex ${v}${auth.detail} ${fmt.dim("at " + codexPath)}`));
      } else {
        console.log(fmt.warn(`codex ${v} — ${auth.detail || "not logged in"} ${fmt.dim("(run `codex login`)")}`));
        warnings++;
      }
    } catch (e) {
      console.log(fmt.warn(`codex — installed but not runnable: ${String(e).slice(0, 120)}`));
      warnings++;
    }
  } else {
    console.log(fmt.warn(`codex — not found on $PATH ${fmt.dim("(optional; codex review phase will fail)")}`));
    warnings++;
  }

  // Tmux (needed for start/stop)
  if (which("tmux")) {
    console.log(fmt.ok(`tmux ${fmt.dim("(used by `owlrun start`)")}`));
  } else {
    console.log(fmt.warn(`tmux — not found ${fmt.dim("(start/stop/restart commands will not work)")}`));
    warnings++;
  }

  console.log();
  console.log(fmt.head("Paths:"));
  if (!checkPath("project root", PROJECT_ROOT, true)) errors++;
  checkPath("instructions", runtimeInstructions, false);
  const feOk = checkPath("frontend repo", runtimeFrontend, true);
  if (!feOk) errors++;
  if (feOk) {
    const claudeMd = ["CLAUDE.md", "claude.md", ".claude/CLAUDE.md"].map((r) => join(runtimeFrontend, r)).find(existsSync);
    if (claudeMd) {
      console.log(fmt.ok(`CLAUDE.md ${fmt.dim("at " + claudeMd)}`));
    } else {
      console.log(fmt.err(`CLAUDE.md — not found in ${runtimeFrontend} ${fmt.dim("(review phase will hard-fail)")}`));
      errors++;
    }
  }

  console.log();
  console.log(fmt.head("Runtime:"));
  const sup = detectSupervisor([]);
  const unitPath = systemdUnitInstalled();
  if (sup === "systemd") {
    console.log(fmt.ok(`supervisor: systemd ${fmt.dim("(unit at " + (unitPath ?? "?") + ")")}`));
  } else {
    console.log(fmt.ok(`supervisor: tmux ${fmt.dim('(session "' + TMUX_SESSION + '")')}`));
  }
  const running = await isPortListening();
  if (running) {
    console.log(fmt.ok(`OwlRun is responding at ${BASE_URL}`));
  } else {
    const tmuxAlive = await isTmuxSessionRunning();
    if (tmuxAlive) {
      console.log(fmt.warn(`tmux session "${TMUX_SESSION}" exists but ${BASE_URL} is not responding`));
      warnings++;
    } else {
      console.log(fmt.warn(`OwlRun is not running ${fmt.dim("(run `owlrun start`)")}`));
    }
  }

  console.log();
  if (errors === 0 && warnings === 0) {
    console.log(`${c.green}All checks passed.${c.reset}`);
  } else {
    console.log(`${errors === 0 ? c.yellow : c.red}${errors} error(s), ${warnings} warning(s).${c.reset}`);
  }
  return { exitCode: errors > 0 ? 1 : 0 };
}

function checkPath(label: string, p: string, required: boolean): boolean {
  if (existsSync(p)) {
    console.log(fmt.ok(`${label} ${fmt.dim(p)}`));
    return true;
  }
  if (required) console.log(fmt.err(`${label} ${fmt.dim(p)} (missing)`));
  else console.log(fmt.warn(`${label} ${fmt.dim(p)} (missing — will be created on start)`));
  return false;
}

async function waitForPort(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortListening()) return true;
    await Bun.sleep(500);
  }
  return false;
}

async function cmdStart(args: string[]): Promise<CommandResult> {
  const sup = detectSupervisor(args);
  if (sup === "systemd") return startSystemd();
  return startTmux();
}

async function cmdStop(args: string[]): Promise<CommandResult> {
  const sup = detectSupervisor(args);
  if (sup === "systemd") return stopSystemd();
  return stopTmux();
}

async function cmdRestart(args: string[]): Promise<CommandResult> {
  const sup = detectSupervisor(args);
  if (sup === "systemd") return restartSystemd();
  const stop = await stopTmux();
  if (stop.exitCode !== 0) return stop;
  await Bun.sleep(500);
  return await startTmux();
}

// --- systemd ---

async function startSystemd(): Promise<CommandResult> {
  if (await isPortListening()) {
    console.log(fmt.ok(`OwlRun is already running at ${BASE_URL} ${fmt.dim("(systemd)")}`));
    return { exitCode: 0 };
  }
  const r = await systemctl("start");
  if (!r.ok) { console.error(fmt.err(`systemctl start owlrun failed: ${r.message}`)); return { exitCode: 1 }; }
  if (await waitForPort()) {
    console.log(fmt.ok(`OwlRun started at ${BASE_URL} ${fmt.dim("(systemd unit)")}`));
    return { exitCode: 0 };
  }
  console.log(fmt.warn(`systemctl start succeeded but ${BASE_URL} did not respond within 5s`));
  console.log(fmt.dim("inspect: sudo journalctl -u owlrun -n 50"));
  return { exitCode: 1 };
}

async function stopSystemd(): Promise<CommandResult> {
  const r = await systemctl("stop");
  if (!r.ok) { console.error(fmt.err(`systemctl stop owlrun failed: ${r.message}`)); return { exitCode: 1 }; }
  console.log(fmt.ok("stopped systemd unit owlrun"));
  return { exitCode: 0 };
}

async function restartSystemd(): Promise<CommandResult> {
  const r = await systemctl("restart");
  if (!r.ok) { console.error(fmt.err(`systemctl restart owlrun failed: ${r.message}`)); return { exitCode: 1 }; }
  if (await waitForPort()) {
    console.log(fmt.ok(`OwlRun restarted at ${BASE_URL} ${fmt.dim("(systemd unit)")}`));
    return { exitCode: 0 };
  }
  console.log(fmt.warn("systemctl restart succeeded but the port did not respond within 5s"));
  return { exitCode: 1 };
}

// --- tmux ---

async function startTmux(): Promise<CommandResult> {
  if (!which("tmux")) {
    console.error(fmt.err("tmux is not installed; cannot use `owlrun start` in tmux mode"));
    return { exitCode: 1 };
  }
  if (await isTmuxSessionRunning()) {
    console.log(fmt.warn(`tmux session "${TMUX_SESSION}" already exists`));
    if (await isPortListening()) {
      console.log(fmt.ok(`OwlRun is already running at ${BASE_URL}`));
      return { exitCode: 0 };
    }
    console.log(fmt.dim("(session exists but port not responding; use `owlrun restart`)"));
    return { exitCode: 1 };
  }

  const bunBin = which("bun");
  if (!bunBin) {
    console.error(fmt.err("bun not found on $PATH"));
    return { exitCode: 1 };
  }

  // Build env line. Inherit OWLRUN_* vars from the current shell so users can
  // override paths by exporting them before running `owlrun start`.
  const envLine = Object.entries(process.env)
    .filter(([k]) => k.startsWith("OWLRUN_") || k === "ANTHROPIC_BASE_URL")
    .map(([k, v]) => `${k}=${shellQuote(v ?? "")}`)
    .join(" ");

  const cmd = `cd ${shellQuote(PROJECT_ROOT)} && ${envLine} ${shellQuote(bunBin)} run src/index.ts 2>&1 | tee ${shellQuote(LOG_FILE)}`;
  const r = await run(["tmux", "new-session", "-d", "-s", TMUX_SESSION, cmd], { allowFail: true });
  if (r.exitCode !== 0) {
    console.error(fmt.err(`tmux new-session failed: ${r.stderr.trim()}`));
    return { exitCode: 1 };
  }
  if (await waitForPort()) {
    console.log(fmt.ok(`OwlRun started at ${BASE_URL} ${fmt.dim(`(tmux session "${TMUX_SESSION}")`)}`));
    return { exitCode: 0 };
  }
  console.log(fmt.warn(`tmux session started but ${BASE_URL} did not respond within 5s`));
  console.log(fmt.dim(`check logs: owlrun logs`));
  return { exitCode: 1 };
}

async function stopTmux(): Promise<CommandResult> {
  if (!which("tmux")) {
    console.error(fmt.err("tmux is not installed"));
    return { exitCode: 1 };
  }
  if (!(await isTmuxSessionRunning())) {
    console.log(fmt.warn(`tmux session "${TMUX_SESSION}" is not running`));
    return { exitCode: 0 };
  }
  await run(["tmux", "kill-session", "-t", TMUX_SESSION]);
  console.log(fmt.ok(`stopped tmux session "${TMUX_SESSION}"`));
  return { exitCode: 0 };
}

async function cmdStatus(): Promise<CommandResult> {
  if (!(await isPortListening())) {
    console.log(fmt.err(`OwlRun is not responding at ${BASE_URL}`));
    const tmuxAlive = await isTmuxSessionRunning();
    if (tmuxAlive) console.log(fmt.dim(`tmux session "${TMUX_SESSION}" exists; check \`owlrun logs\``));
    return { exitCode: 1 };
  }
  type Worker = {
    running: boolean; currentFile: string | null; currentStage: string | null;
    lastOutcome: string | null; lastError: string | null; processedCount: number; startedAt: string;
  };
  type Task = { filename: string; status: string; stage: string | null; retries: number; location: string; updatedAt: string };
  const worker = await fetchJson<Worker>("/api/worker");
  const { tasks } = await fetchJson<{ tasks: Task[] }>("/api/instructions");

  console.log(fmt.head(`Worker`));
  console.log(`  state:       ${worker.running ? c.yellow + "busy" : c.green + "idle"}${c.reset}`);
  if (worker.currentFile) console.log(`  current:     ${worker.currentFile}`);
  if (worker.currentStage) console.log(`  stage:       ${worker.currentStage}`);
  console.log(`  processed:   ${worker.processedCount}`);
  if (worker.lastOutcome) console.log(`  last:        ${worker.lastOutcome === "DONE_SUCCESS" ? c.green : c.red}${worker.lastOutcome}${c.reset}`);
  if (worker.lastError) console.log(`  last error:  ${c.red}${worker.lastError}${c.reset}`);
  console.log(`  started:     ${worker.startedAt}`);
  console.log();

  console.log(fmt.head(`Queue (${tasks.length})`));
  if (tasks.length === 0) {
    console.log(fmt.dim("  (empty)"));
  } else {
    const pad = (s: string, n: number) => s.length >= n ? s : s + " ".repeat(n - s.length);
    const colorStatus = (s: string) =>
      s === "RUNNING" ? c.cyan + s + c.reset :
      s === "WAITING" ? c.yellow + s + c.reset :
      s === "DONE_SUCCESS" ? c.green + s + c.reset :
      s === "DONE_FAILED" ? c.red + s + c.reset : s;
    console.log(fmt.dim(`  ${pad("STATUS", 14)}${pad("FILE", 46)}${pad("STAGE", 22)}RETRIES`));
    for (const t of tasks) {
      console.log(`  ${pad(colorStatus(t.status), 14 + 9)}${pad(t.filename, 46)}${pad(t.stage ?? "—", 22)}${t.retries}`);
    }
  }
  return { exitCode: 0 };
}

async function cmdHealth(): Promise<CommandResult> {
  if (!(await isPortListening())) {
    console.error(fmt.err(`OwlRun is not responding at ${BASE_URL}`));
    return { exitCode: 1 };
  }
  type Health = {
    app: { name: string; version: string; startedAt: string };
    config: Record<string, unknown>;
    filesystem: Record<string, boolean>;
    tools: Record<string, { installed: boolean; runnable: boolean; version: string | null; error: string | null }>;
    worker: { running: boolean; processedCount: number };
  };
  const h = await fetchJson<Health>("/api/health");
  console.log(`${fmt.head(h.app.name)} v${h.app.version}  ${fmt.dim(h.app.startedAt)}`);
  console.log();
  console.log(fmt.head("Tools"));
  for (const [k, v] of Object.entries(h.tools)) {
    const state = v.runnable ? fmt.ok(`${k} ${v.version ?? ""}`) :
      v.installed ? fmt.warn(`${k} (installed, not runnable: ${v.error})`) :
      fmt.err(`${k} (not installed)`);
    console.log(`  ${state}`);
  }
  console.log();
  console.log(fmt.head("Filesystem"));
  for (const [k, v] of Object.entries(h.filesystem)) {
    console.log(`  ${v ? fmt.ok(k) : fmt.err(k)}`);
  }
  console.log();
  console.log(fmt.head("Config"));
  for (const [k, v] of Object.entries(h.config)) {
    console.log(`  ${fmt.dim(k.padEnd(20))} ${v ?? "(default)"}`);
  }
  console.log();
  console.log(fmt.head("Worker"));
  console.log(`  ${h.worker.running ? c.yellow + "busy" : c.green + "idle"}${c.reset}, processed ${h.worker.processedCount} tasks`);
  return { exitCode: 0 };
}

async function cmdLogs(args: string[]): Promise<CommandResult> {
  const follow = args.includes("-f") || args.includes("--follow");
  const useJournal = args.includes("--journal");
  let lines = 50;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-n" || a === "--lines") {
      const next = Number.parseInt(args[i + 1] ?? "", 10);
      if (Number.isFinite(next) && next > 0) lines = next;
    } else if (a.startsWith("-n") && a.length > 2) {
      const n = Number.parseInt(a.slice(2), 10);
      if (Number.isFinite(n) && n > 0) lines = n;
    }
  }

  // If --journal is forced OR systemd is the active supervisor and there's no
  // log file (e.g. unit overridden to log to journal only), use journalctl.
  const sup = detectSupervisor(args);
  const wantJournal = useJournal || (sup === "systemd" && !existsSync(LOG_FILE));
  if (wantJournal) {
    if (!which("journalctl")) {
      console.error(fmt.err("journalctl not available"));
      return { exitCode: 1 };
    }
    const cmd = follow
      ? ["journalctl", "-u", "owlrun", "-n", String(lines), "-f"]
      : ["journalctl", "-u", "owlrun", "-n", String(lines), "--no-pager"];
    const proc = Bun.spawn({ cmd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return { exitCode: (await proc.exited) ?? 0 };
  }

  if (!existsSync(LOG_FILE)) {
    console.error(fmt.err(`log file not found: ${LOG_FILE}`));
    if (sup === "systemd") console.error(fmt.dim("try: owlrun logs --journal"));
    return { exitCode: 1 };
  }
  const cmd = follow
    ? ["tail", "-n", String(lines), "-f", LOG_FILE]
    : ["tail", "-n", String(lines), LOG_FILE];
  const proc = Bun.spawn({ cmd, stdout: "inherit", stderr: "inherit" });
  return { exitCode: (await proc.exited) ?? 0 };
}

async function cmdAttach(args: string[]): Promise<CommandResult> {
  const sup = detectSupervisor(args);
  if (sup === "systemd") {
    console.error(fmt.warn("OwlRun is running under systemd; tmux attach is not applicable."));
    console.error(fmt.dim("To follow live output:"));
    console.error("  owlrun logs -f");
    console.error("  sudo journalctl -u owlrun -f");
    return { exitCode: 1 };
  }
  if (!which("tmux")) {
    console.error(fmt.err("tmux not installed"));
    return { exitCode: 1 };
  }
  if (!(await isTmuxSessionRunning())) {
    console.error(fmt.err(`tmux session "${TMUX_SESSION}" is not running`));
    return { exitCode: 1 };
  }
  const proc = Bun.spawn({ cmd: ["tmux", "attach", "-t", TMUX_SESSION], stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return { exitCode: (await proc.exited) ?? 0 };
}

async function cmdOpen(): Promise<CommandResult> {
  console.log(`${fmt.head("OwlRun UI:")} ${BASE_URL}`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (opener && which(opener)) {
    await run([opener, BASE_URL], { allowFail: true });
  }
  return { exitCode: 0 };
}

function cmdVersion(): CommandResult {
  console.log(`owlrun ${PKG_VERSION}`);
  return { exitCode: 0 };
}

/* ---------- uninstall ---------- */

async function cmdUninstall(args: string[]): Promise<CommandResult> {
  const installer = join(PROJECT_ROOT, "install.sh");
  if (!existsSync(installer)) {
    console.error(fmt.err(`installer not found at ${installer}`));
    console.error(fmt.dim("(this OwlRun was not installed via install.sh; remove the source tree manually)"));
    return { exitCode: 1 };
  }

  const yes = args.includes("--yes") || args.includes("-y");
  const purge = args.includes("--purge");

  console.log(fmt.head("This will remove:"));
  console.log(`  - source tree: ${fmt.dim(PROJECT_ROOT)}`);
  console.log(`  - wrapper script (owlrun)`);
  const unit = systemdUnitInstalled();
  if (unit) console.log(`  - systemd unit: ${fmt.dim(unit)}`);
  if (purge) console.log(`  - ${fmt.dim("user data:")} ${expandHome("~/.owlrun")} ${fmt.dim("(--purge)")}`);
  else console.log(`  ${fmt.dim("(user data in ~/.owlrun/ is kept; pass --purge to remove it too)")}`);
  console.log();

  if (!(await confirm("Proceed?", yes))) {
    console.log(fmt.dim("aborted"));
    return { exitCode: 0 };
  }

  // Stop any running instance first so the unit and process die cleanly.
  if (await isPortListening()) {
    console.log(fmt.dim("stopping running instance…"));
    const stopRes = unit ? await stopSystemd() : await stopTmux();
    if (stopRes.exitCode !== 0) {
      console.error(fmt.warn("stop failed; continuing with uninstall anyway"));
    }
  }

  // Need root if the install lives under /opt or /usr or there is a systemd unit.
  const needsSudo = PROJECT_ROOT.startsWith("/opt") || PROJECT_ROOT.startsWith("/usr") || unit !== null;
  const isRoot = process.getuid?.() === 0;
  const cmd = (needsSudo && !isRoot)
    ? ["sudo", "-p", "[sudo] password to uninstall OwlRun: ", "bash", installer, "--uninstall"]
    : ["bash", installer, "--uninstall"];

  const proc = Bun.spawn({ cmd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = (await proc.exited) ?? 1;

  if (exitCode === 0 && purge) {
    const userHome = expandHome("~/.owlrun");
    const logFile = expandHome("~/owlrun.log");
    if (existsSync(userHome)) {
      await run(["rm", "-rf", userHome]);
      console.log(fmt.ok(`removed ${userHome}`));
    }
    if (existsSync(logFile)) {
      await run(["rm", "-f", logFile]);
      console.log(fmt.ok(`removed ${logFile}`));
    }
  }

  return { exitCode };
}

/* ---------- requirements installer ---------- */

const KNOWN_TOOLS = ["claude", "codex"] as const;
type KnownTool = typeof KNOWN_TOOLS[number];

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

async function confirm(question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) {
    console.log(fmt.warn(`${question} ${fmt.dim("(non-TTY; pass --yes to accept non-interactively)")}`));
    return false;
  }
  process.stdout.write(`${question} [y/N] `);
  for await (const chunk of process.stdin) {
    const answer = (chunk.toString() as string).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }
  return false;
}

function archSlug(): { claude: string; codex: string } {
  const a = osArch();
  if (a === "x64") return { claude: "x86_64-unknown-linux-gnu", codex: "x86_64-unknown-linux-gnu" };
  if (a === "arm64") return { claude: "aarch64-unknown-linux-gnu", codex: "aarch64-unknown-linux-gnu" };
  throw new Error(`unsupported arch: ${a}`);
}

async function ensureLocalBin(): Promise<string> {
  const dir = expandHome("~/.local/bin");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function installClaude(): Promise<{ ok: boolean; message: string }> {
  // The official installer is idempotent. It detects the right arch and
  // writes to $HOME/.local/bin/claude (or similar).
  console.log(fmt.dim("Running Claude Code installer…"));
  const proc = Bun.spawn({
    cmd: ["bash", "-c", "curl -fsSL https://claude.ai/install.sh | bash"],
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = (await proc.exited) ?? 1;
  if (exitCode !== 0) return { ok: false, message: `installer exited with code ${exitCode}` };
  const found = which("claude") ?? (existsSync(expandHome("~/.local/bin/claude")) ? expandHome("~/.local/bin/claude") : null);
  if (!found) return { ok: false, message: "installer finished but `claude` is still not on $PATH" };
  return { ok: true, message: `claude installed at ${found}` };
}

async function installCodex(): Promise<{ ok: boolean; message: string }> {
  const { codex: triple } = archSlug();
  const binDir = await ensureLocalBin();
  const tmpDir = `/tmp/owlrun-codex-${process.pid}`;
  mkdirSync(tmpDir, { recursive: true });
  const asset = `codex-${triple}.tar.gz`;
  const url = `https://github.com/openai/codex/releases/latest/download/${asset}`;

  console.log(fmt.dim(`Downloading ${url}…`));
  const dl = await run(["curl", "-fL", "-o", join(tmpDir, asset), url], { allowFail: true });
  if (dl.exitCode !== 0) {
    return { ok: false, message: `download failed: ${(dl.stderr || dl.stdout).trim().slice(0, 200)}` };
  }

  console.log(fmt.dim(`Extracting to ${binDir}…`));
  const tar = await run(["tar", "-xzf", join(tmpDir, asset), "-C", tmpDir], { allowFail: true });
  if (tar.exitCode !== 0) {
    return { ok: false, message: `extract failed: ${(tar.stderr || tar.stdout).trim().slice(0, 200)}` };
  }

  // Locate the extracted codex binary. Codex releases usually ship a single
  // top-level binary file; we search for it rather than guess the layout.
  const findProc = await run(["find", tmpDir, "-type", "f", "-name", "codex*", "-executable"], { allowFail: true });
  const candidates = findProc.stdout.split("\n").map((s) => s.trim()).filter(Boolean).filter((p) => !p.endsWith(".tar.gz"));
  const binary = candidates.find((p) => /\/codex(-[^/]+)?$/.test(p)) ?? candidates[0];
  if (!binary) {
    return { ok: false, message: `could not locate the codex binary inside ${asset}` };
  }

  await run(["install", "-m", "755", binary, join(binDir, "codex")]);
  await run(["rm", "-rf", tmpDir], { allowFail: true });
  const found = Bun.which("codex") ?? join(binDir, "codex");
  if (!existsSync(found)) return { ok: false, message: "post-install: codex not found" };
  return { ok: true, message: `codex installed at ${found}` };
}

const INSTALLERS: Record<KnownTool, () => Promise<{ ok: boolean; message: string }>> = {
  claude: installClaude,
  codex: installCodex,
};

async function cmdReq(args: string[]): Promise<CommandResult> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    console.error(fmt.err(`\`owlrun req\` only supports linux and darwin (detected ${process.platform})`));
    return { exitCode: 1 };
  }

  const yes = args.includes("--yes") || args.includes("-y");
  const explicit = args.filter((a) => !a.startsWith("-")) as KnownTool[];
  for (const name of explicit) {
    if (!KNOWN_TOOLS.includes(name)) {
      console.error(fmt.err(`unknown tool: ${name} (known: ${KNOWN_TOOLS.join(", ")})`));
      return { exitCode: 2 };
    }
  }
  const wanted: KnownTool[] = explicit.length ? explicit : [...KNOWN_TOOLS];

  // Sanity: need curl + tar for the installers
  for (const dep of ["curl", "tar", "bash"]) {
    if (!which(dep)) {
      console.error(fmt.err(`\`${dep}\` is required for \`owlrun req\` but is not on $PATH`));
      return { exitCode: 1 };
    }
  }

  console.log(fmt.head(`Installing requirements: ${wanted.join(", ")}`));
  console.log();

  let failed = 0;
  for (const tool of wanted) {
    const have = which(tool);
    if (have) {
      console.log(fmt.ok(`${tool} already installed at ${have}`));
      continue;
    }
    const proceed = await confirm(`Install ${tool}?`, yes);
    if (!proceed) {
      console.log(fmt.warn(`skipped ${tool}`));
      continue;
    }
    try {
      const r = await INSTALLERS[tool]();
      if (r.ok) {
        console.log(fmt.ok(r.message));
      } else {
        console.log(fmt.err(`${tool}: ${r.message}`));
        failed++;
      }
    } catch (e) {
      console.log(fmt.err(`${tool}: ${String(e instanceof Error ? e.message : e)}`));
      failed++;
    }
    console.log();
  }

  console.log();
  console.log(fmt.head("Next steps"));
  if (wanted.includes("claude")) {
    console.log(`  ${fmt.dim("Authenticate Claude Code:")}    claude  ${fmt.dim("(first-time interactive auth)")}`);
    console.log(`  ${fmt.dim("Or setup a long-lived token:")}  claude setup-token`);
  }
  if (wanted.includes("codex")) {
    console.log(`  ${fmt.dim("Authenticate Codex:")}           codex login`);
  }
  console.log(`  ${fmt.dim("Verify:")}                       owlrun doctor`);
  console.log();
  if (!process.env.PATH?.split(":").includes(expandHome("~/.local/bin"))) {
    console.log(fmt.warn(`~/.local/bin is not on your $PATH; add this to your shell rc:`));
    console.log(`  export PATH="$HOME/.local/bin:$PATH"`);
  }

  return { exitCode: failed > 0 ? 1 : 0 };
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_/.:@=+,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/* ---------- dispatch ---------- */

const COMMANDS: Record<string, Handler> = {
  doctor: cmdDoctor,
  req: cmdReq,
  "install-requirements": cmdReq,
  requirements: cmdReq,
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  status: cmdStatus,
  health: cmdHealth,
  logs: cmdLogs,
  attach: cmdAttach,
  open: cmdOpen,
  uninstall: cmdUninstall,
  version: cmdVersion,
  "--version": cmdVersion,
  "-v": cmdVersion,
  help: () => { printUsage(); return { exitCode: 0 }; },
  "--help": () => { printUsage(); return { exitCode: 0 }; },
  "-h": () => { printUsage(); return { exitCode: 0 }; },
};

async function main(): Promise<void> {
  const [, , raw, ...rest] = process.argv;
  const cmd = raw ?? "help";
  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(fmt.err(`unknown command: ${cmd}`));
    console.error(`Run ${fmt.head("owlrun help")} for usage.`);
    process.exit(2);
  }
  try {
    const res = await handler(rest);
    const code = (res && typeof res === "object" && "exitCode" in res) ? res.exitCode : 0;
    process.exit(code);
  } catch (e) {
    console.error(fmt.err(String(e instanceof Error ? e.message : e)));
    process.exit(1);
  }
}

void main();

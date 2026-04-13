import { resolve } from "node:path";
import { homedir } from "node:os";

export interface Config {
  appName: string;
  webPort: number;
  host: string;
  instructionsDir: string;
  doneDir: string;
  frontendDir: string;
  maxRetries: number;
  retryIntervalSec: number;
  promptRuns: number;
  anthropicBaseUrl: string;
  pollIntervalMs: number;
  claudeBin: string;
  codexBin: string;
}

const HOME = homedir();
const OWLRUN_HOME = `${HOME}/.owlrun`;

function readEnv(name: string, fallback: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid integer for ${name}: "${raw}"`);
  }
  return n;
}

export function loadConfig(): Config {
  const instructionsDir = resolve(
    readEnv("OWLRUN_INSTRUCTIONS_DIR", `${OWLRUN_HOME}/instructions`),
  );
  const frontendDir = resolve(
    readEnv("OWLRUN_FRONTEND_DIR", `${OWLRUN_HOME}/frontend-target`),
  );

  return {
    appName: readEnv("OWLRUN_APP_NAME", "OwlRun"),
    webPort: readIntEnv("OWLRUN_PORT", 8090),
    host: readEnv("OWLRUN_HOST", "0.0.0.0"),
    instructionsDir,
    doneDir: resolve(instructionsDir, "done"),
    frontendDir,
    maxRetries: readIntEnv("OWLRUN_MAX_RETRIES", 20),
    retryIntervalSec: readIntEnv("OWLRUN_RETRY_INTERVAL", 1800),
    promptRuns: readIntEnv("OWLRUN_PROMPT_RUNS", 1),
    anthropicBaseUrl: readEnv("ANTHROPIC_BASE_URL", ""),
    pollIntervalMs: readIntEnv("OWLRUN_POLL_INTERVAL_MS", 2000),
    claudeBin: readEnv("OWLRUN_CLAUDE_BIN", "claude"),
    codexBin: readEnv("OWLRUN_CODEX_BIN", "codex"),
  };
}

export const config = loadConfig();

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
const OWLCLAW_HOME = `${HOME}/.owl-claw`;

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
    readEnv("OWLCLAW_INSTRUCTIONS_DIR", `${OWLCLAW_HOME}/instructions`),
  );
  const frontendDir = resolve(
    readEnv("OWLCLAW_FRONTEND_DIR", `${OWLCLAW_HOME}/frontend-target`),
  );

  return {
    appName: readEnv("OWLCLAW_APP_NAME", "OwlClaw"),
    webPort: readIntEnv("OWLCLAW_PORT", 8090),
    host: readEnv("OWLCLAW_HOST", "0.0.0.0"),
    instructionsDir,
    doneDir: resolve(instructionsDir, "done"),
    frontendDir,
    maxRetries: readIntEnv("OWLCLAW_MAX_RETRIES", 20),
    retryIntervalSec: readIntEnv("OWLCLAW_RETRY_INTERVAL", 1800),
    promptRuns: readIntEnv("OWLCLAW_PROMPT_RUNS", 1),
    anthropicBaseUrl: readEnv("ANTHROPIC_BASE_URL", ""),
    pollIntervalMs: readIntEnv("OWLCLAW_POLL_INTERVAL_MS", 2000),
    claudeBin: readEnv("OWLCLAW_CLAUDE_BIN", "claude"),
    codexBin: readEnv("OWLCLAW_CODEX_BIN", "codex"),
  };
}

export const config = loadConfig();

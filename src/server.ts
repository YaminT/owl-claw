import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { config } from "./config.ts";
import { createLogger, recentLogs } from "./logger.ts";
import { isRunnable } from "./cli.ts";
import { getWorkerStatus } from "./worker.ts";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  readTaskContent,
  requeue,
  sanitizeFilename,
  updateTaskContent,
} from "./store.ts";
import { waitForShutdown } from "./shutdown.ts";

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const TOOL_CHECK_TTL_MS = 60_000;

interface ToolCheck { ok: boolean; version: string | null; error: string | null }
interface CachedToolCheck { value: ToolCheck; expires: number }
const toolCheckCache = new Map<string, CachedToolCheck>();

async function cachedIsRunnable(binary: string): Promise<ToolCheck> {
  const now = Date.now();
  const hit = toolCheckCache.get(binary);
  if (hit && hit.expires > now) return hit.value;
  const value = await isRunnable(binary);
  toolCheckCache.set(binary, { value, expires: now + TOOL_CHECK_TTL_MS });
  return value;
}

const log = createLogger("server");

const publicDir = resolve(import.meta.dir, "..", "public");

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

function err(status: number, message: string): Response {
  return json({ error: message }, { status });
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const target = resolve(publicDir, "." + rel);
  const rootResolved = resolve(publicDir);
  if (!target.startsWith(rootResolved + "/") && target !== rootResolved) {
    return err(403, "forbidden");
  }
  if (!existsSync(target)) return err(404, "not found");
  const s = await stat(target);
  if (s.isDirectory()) return err(404, "not found");
  return new Response(Bun.file(target), { headers: { "cache-control": "no-cache" } });
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = req.method.toUpperCase();

  if (pathname === "/api/health" && method === "GET") {
    const [claude, codex] = await Promise.all([
      cachedIsRunnable(config.claudeBin),
      cachedIsRunnable(config.codexBin),
    ]);
    const doneExists = existsSync(config.doneDir);
    const instructionsExists = existsSync(config.instructionsDir);
    const frontendExists = existsSync(config.frontendDir);
    const worker = getWorkerStatus();
    return json({
      app: {
        name: config.appName,
        version: "0.1.0",
        startedAt: worker.startedAt,
      },
      config: {
        webPort: config.webPort,
        instructionsDir: config.instructionsDir,
        doneDir: config.doneDir,
        frontendDir: config.frontendDir,
        maxRetries: config.maxRetries,
        retryIntervalSec: config.retryIntervalSec,
        promptRuns: config.promptRuns,
        pollIntervalMs: config.pollIntervalMs,
        anthropicBaseUrl: config.anthropicBaseUrl || null,
      },
      filesystem: {
        instructionsDirExists: instructionsExists,
        doneDirExists: doneExists,
        frontendDirExists: frontendExists,
      },
      tools: {
        claude: {
          bin: config.claudeBin,
          installed: claude.ok || claude.error !== "not installed",
          runnable: claude.ok,
          version: claude.version,
          error: claude.error,
        },
        codex: {
          bin: config.codexBin,
          installed: codex.ok || codex.error !== "not installed",
          runnable: codex.ok,
          version: codex.version,
          error: codex.error,
        },
      },
      worker,
    });
  }

  if (pathname === "/api/worker" && method === "GET") {
    return json(getWorkerStatus());
  }

  if (pathname === "/api/logs" && method === "GET") {
    const n = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    return json({ logs: recentLogs(Number.isFinite(n) ? n : 100) });
  }

  if (pathname === "/api/instructions" && method === "GET") {
    const tasks = await listTasks();
    return json({ tasks });
  }

  if (pathname === "/api/instructions" && method === "POST") {
    const body = await safeJson(req);
    if (body === "too_large") return err(413, "request body too large");
    if (!body) return err(400, "invalid JSON body");
    const { filename, content } = body as { filename?: unknown; content?: unknown };
    if (typeof filename !== "string" || !filename.trim()) return err(400, "filename required");
    if (typeof content !== "string") return err(400, "content required");
    if (!sanitizeFilename(filename)) return err(400, "invalid filename");
    try {
      const view = await createTask(filename, content);
      return json({ task: view }, { status: 201 });
    } catch (e) {
      return err(400, String(e instanceof Error ? e.message : e));
    }
  }

  const match = pathname.match(/^\/api\/instructions\/([^/]+)(\/(requeue))?$/);
  if (match) {
    const raw = decodeURIComponent(match[1] ?? "");
    const sub = match[3];
    const safe = sanitizeFilename(raw);
    if (!safe) return err(400, "invalid filename");

    if (!sub && method === "GET") {
      const view = await getTask(safe);
      if (!view) return err(404, "not found");
      const body = await readTaskContent(safe);
      return json({ task: view, content: body?.content ?? "" });
    }

    if (!sub && method === "PUT") {
      const body = await safeJson(req);
      if (body === "too_large") return err(413, "request body too large");
      if (!body) return err(400, "invalid JSON body");
      const { content } = body as { content?: unknown };
      if (typeof content !== "string") return err(400, "content required");
      try {
        const view = await updateTaskContent(safe, content);
        return json({ task: view });
      } catch (e) {
        return err(409, String(e instanceof Error ? e.message : e));
      }
    }

    if (!sub && method === "DELETE") {
      try {
        await deleteTask(safe);
        return json({ ok: true });
      } catch (e) {
        return err(409, String(e instanceof Error ? e.message : e));
      }
    }

    if (sub === "requeue" && method === "POST") {
      try {
        const view = await requeue(safe);
        return json({ task: view });
      } catch (e) {
        return err(409, String(e instanceof Error ? e.message : e));
      }
    }
  }

  return err(404, "no route");
}

async function safeJson(req: Request): Promise<unknown | "too_large" | null> {
  const lenHeader = req.headers.get("content-length");
  if (lenHeader) {
    const n = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) return "too_large";
  }
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return "too_large";
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function runServer(): Promise<void> {
  const server = Bun.serve({
    port: config.webPort,
    hostname: config.host,
    idleTimeout: 255,
    development: false,
    fetch: async (req) => {
      const url = new URL(req.url);
      try {
        if (url.pathname.startsWith("/api/")) {
          return await handleApi(req, url);
        }
        return await serveStatic(url.pathname);
      } catch (e) {
        log.error("request failed", { url: url.pathname, err: String(e) });
        return err(500, "internal server error");
      }
    },
    error: (e) => {
      log.error("server error", { err: String(e) });
      return err(500, "internal server error");
    },
  });

  log.info("web server listening", {
    url: `http://${config.host}:${server.port}`,
  });

  await waitForShutdown();
  log.info("web server stopping");
  try {
    server.stop(true);
  } catch (e) {
    log.warn("server.stop failed", { err: String(e) });
  }
}

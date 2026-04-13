import { resolve, dirname, extname } from "node:path";
import { existsSync, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { Readable } from "node:stream";
import { config } from "./config.js";
import { createLogger, recentLogs } from "./logger.js";
import { isRunnable } from "./cli.js";
import { getWorkerStatus } from "./worker.js";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  readTaskContent,
  requeue,
  sanitizeFilename,
  updateTaskContent,
} from "./store.js";
import { waitForShutdown } from "./shutdown.js";

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "..", "..", "public");

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

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
  const ext = extname(target).toLowerCase();
  const type = STATIC_MIME[ext] ?? "application/octet-stream";
  // Stream the file via Node's createReadStream → Web ReadableStream.
  const stream = Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      "content-type": type,
      "content-length": String(s.size),
      "cache-control": "no-cache",
    },
  });
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

/**
 * Adapt a Node IncomingMessage into a fetch Request so the rest of the code
 * can stay framework-free. Body is buffered for non-GET/HEAD methods so the
 * handler can call req.text() / req.json().
 */
async function nodeReqToFetch(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? `${config.host}:${config.webPort}`;
  const url = `http://${host}${req.url ?? "/"}`;
  const method = (req.method ?? "GET").toUpperCase();
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
  }
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method, headers, body, duplex: "half" } as RequestInit & { duplex: string });
}

async function fetchRespToNode(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(value);
    }
  }
  res.end();
}

export async function runServer(): Promise<void> {
  const server: HttpServer = createServer(async (req, res) => {
    const startUrl = req.url ?? "/";
    try {
      const request = await nodeReqToFetch(req);
      const url = new URL(request.url);
      const response = url.pathname.startsWith("/api/")
        ? await handleApi(request, url)
        : await serveStatic(url.pathname);
      await fetchRespToNode(response, res);
    } catch (e) {
      log.error("request failed", { url: startUrl, err: String(e) });
      try {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "internal server error" }));
      } catch {}
    }
  });

  // 255s matches the previous Bun.serve idleTimeout.
  server.keepAliveTimeout = 255_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.webPort, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  log.info("web server listening", {
    url: `http://${config.host}:${config.webPort}`,
  });

  await waitForShutdown();
  log.info("web server stopping");
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Force-close any keep-alive sockets so we exit promptly.
    server.closeAllConnections?.();
  });
}

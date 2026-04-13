import { readdir, mkdir, readFile, writeFile, rename, stat, unlink } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("store");

export type TaskStatus = "WAITING" | "RUNNING" | "DONE_SUCCESS" | "DONE_FAILED";

export interface TaskRecord {
  status: TaskStatus;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  error: string | null;
  retries: number;
  stage: string | null;
}

export interface TaskView extends TaskRecord {
  filename: string;
  location: "root" | "done";
  size: number;
  mtime: string;
}

interface StateFile {
  version: 1;
  tasks: Record<string, TaskRecord>;
}

const STATE_FILENAME = ".owlrun-state.json";

function statePath(): string {
  return join(config.instructionsDir, STATE_FILENAME);
}

let dirsReady = false;
async function ensureDirs(): Promise<void> {
  if (dirsReady) return;
  await mkdir(config.instructionsDir, { recursive: true });
  await mkdir(config.doneDir, { recursive: true });
  dirsReady = true;
}

let writeChain: Promise<void> = Promise.resolve();

async function readStateFile(): Promise<StateFile> {
  const p = statePath();
  if (!existsSync(p)) return { version: 1, tasks: {} };
  try {
    const raw = await readFile(p, "utf8");
    const parsed = JSON.parse(raw) as StateFile;
    if (!parsed || typeof parsed !== "object" || !parsed.tasks) {
      throw new Error("malformed state file");
    }
    return parsed;
  } catch (err) {
    log.error("failed to read state file, starting fresh", { err: String(err) });
    return { version: 1, tasks: {} };
  }
}

async function writeStateFile(state: StateFile): Promise<void> {
  const p = statePath();
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, p);
}

/**
 * Serializes state file mutations. Multiple concurrent callers get ordered
 * read-modify-write execution so a later write cannot overwrite an earlier
 * committed change it never saw.
 */
async function mutateState<T>(fn: (state: StateFile) => Promise<T> | T): Promise<T> {
  let result!: T;
  const next = writeChain.then(async () => {
    const state = await readStateFile();
    result = await fn(state);
    await writeStateFile(state);
  });
  writeChain = next.catch(() => undefined);
  await next;
  return result;
}

export async function initStore(): Promise<void> {
  await ensureDirs();
  if (!existsSync(statePath())) {
    await writeStateFile({ version: 1, tasks: {} });
  }
  await reconcile();
}

/**
 * Align state.json with the filesystem:
 * - drop entries whose files no longer exist anywhere
 * - add missing entries for unknown files (WAITING if in root, DONE_SUCCESS if in done/)
 * - clear stale RUNNING that survived a crash (reset to WAITING)
 */
export async function reconcile(): Promise<void> {
  await mutateState(async (state) => {
    const rootFiles = await listMdFiles(config.instructionsDir);
    const doneFiles = await listMdFiles(config.doneDir);
    const rootSet = new Set(rootFiles);
    const doneSet = new Set(doneFiles);

    for (const name of Object.keys(state.tasks)) {
      if (!rootSet.has(name) && !doneSet.has(name)) {
        delete state.tasks[name];
      }
    }

    const now = new Date().toISOString();
    for (const name of rootFiles) {
      const existing = state.tasks[name];
      if (!existing) {
        state.tasks[name] = {
          status: "WAITING",
          startedAt: null,
          completedAt: null,
          updatedAt: now,
          error: null,
          retries: 0,
          stage: null,
        };
      } else if (existing.status === "RUNNING") {
        log.warn("resetting stale RUNNING task in root to WAITING", { name });
        existing.status = "WAITING";
        existing.startedAt = null;
        existing.error = "Interrupted by process restart";
        existing.updatedAt = now;
        existing.stage = null;
      }
    }
    for (const name of doneFiles) {
      const existing = state.tasks[name];
      if (!existing) {
        state.tasks[name] = {
          status: "DONE_SUCCESS",
          startedAt: null,
          completedAt: now,
          updatedAt: now,
          error: null,
          retries: 0,
          stage: null,
        };
      } else if (existing.status === "RUNNING" || existing.status === "WAITING") {
        log.warn("resetting stale status for file already in done/", { name, prev: existing.status });
        existing.status = "DONE_FAILED";
        existing.completedAt = now;
        existing.updatedAt = now;
        existing.stage = null;
        existing.error = existing.error ?? "Interrupted by process restart after moving to done/";
      }
    }
  });
}

async function listMdFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

export async function listTasks(): Promise<TaskView[]> {
  await ensureDirs();
  const [state, rootFiles, doneFiles] = await Promise.all([
    readStateFile(),
    listMdFiles(config.instructionsDir),
    listMdFiles(config.doneDir),
  ]);

  const builders: Array<Promise<TaskView>> = [];
  for (const name of rootFiles) {
    builders.push(buildView(state, name, "root", join(config.instructionsDir, name)));
  }
  for (const name of doneFiles) {
    builders.push(buildView(state, name, "done", join(config.doneDir, name)));
  }
  const views = await Promise.all(builders);
  views.sort((a, b) => {
    const loc = locationRank(a) - locationRank(b);
    if (loc !== 0) return loc;
    return a.filename.localeCompare(b.filename);
  });
  return views;
}

async function buildView(state: StateFile, name: string, location: "root" | "done", path: string): Promise<TaskView> {
  const rec = state.tasks[name] ?? defaultRecord(location === "root" ? "WAITING" : "DONE_SUCCESS");
  const st = await stat(path);
  return {
    ...rec,
    filename: name,
    location,
    size: st.size,
    mtime: st.mtime.toISOString(),
  };
}

function locationRank(v: TaskView): number {
  if (v.status === "RUNNING") return 0;
  if (v.status === "WAITING") return 1;
  return 2;
}

function defaultRecord(status: TaskStatus): TaskRecord {
  const now = new Date().toISOString();
  return {
    status,
    startedAt: null,
    completedAt: status === "DONE_SUCCESS" || status === "DONE_FAILED" ? now : null,
    updatedAt: now,
    error: null,
    retries: 0,
    stage: null,
  };
}

export async function getTask(filename: string): Promise<TaskView | null> {
  await ensureDirs();
  const rootPath = join(config.instructionsDir, filename);
  const donePath = join(config.doneDir, filename);
  const [state, rootStat, doneStat] = await Promise.all([
    readStateFile(),
    stat(rootPath).catch(() => null),
    stat(donePath).catch(() => null),
  ]);
  if (rootStat) {
    const rec = state.tasks[filename] ?? defaultRecord("WAITING");
    return {
      ...rec,
      filename,
      location: "root",
      size: rootStat.size,
      mtime: rootStat.mtime.toISOString(),
    };
  }
  if (doneStat) {
    const rec = state.tasks[filename] ?? defaultRecord("DONE_SUCCESS");
    return {
      ...rec,
      filename,
      location: "done",
      size: doneStat.size,
      mtime: doneStat.mtime.toISOString(),
    };
  }
  return null;
}

export async function readTaskContent(filename: string): Promise<{ content: string; location: "root" | "done" } | null> {
  const safe = sanitizeFilename(filename);
  if (!safe) return null;
  const rootPath = join(config.instructionsDir, safe);
  const donePath = join(config.doneDir, safe);
  if (existsSync(rootPath)) return { content: await readFile(rootPath, "utf8"), location: "root" };
  if (existsSync(donePath)) return { content: await readFile(donePath, "utf8"), location: "done" };
  return null;
}

/**
 * Next WAITING task to execute. Alphabetical codepoint order, deterministic.
 * Skips RUNNING (there should be at most one anyway).
 */
export async function pickNextWaiting(): Promise<string | null> {
  const state = await readStateFile();
  const rootFiles = await listMdFiles(config.instructionsDir);
  const waiting = rootFiles
    .filter((name) => {
      const rec = state.tasks[name];
      return !rec || rec.status === "WAITING";
    })
    .sort();
  return waiting[0] ?? null;
}

/**
 * Atomically claim a waiting task by flipping its state to RUNNING.
 * Returns false if the file vanished or is already not in WAITING state.
 */
export async function claimForRun(filename: string): Promise<boolean> {
  return mutateState((state) => {
    const rootPath = join(config.instructionsDir, filename);
    if (!existsSync(rootPath)) return false;
    const rec = state.tasks[filename];
    if (rec && rec.status !== "WAITING") return false;
    const now = new Date().toISOString();
    state.tasks[filename] = {
      status: "RUNNING",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      error: null,
      retries: 0,
      stage: "starting",
    };
    return true;
  });
}

export async function updateStage(filename: string, stage: string, extra?: Partial<TaskRecord>): Promise<void> {
  await mutateState((state) => {
    const rec = state.tasks[filename];
    if (!rec) return;
    rec.stage = stage;
    rec.updatedAt = new Date().toISOString();
    if (extra) Object.assign(rec, extra);
  });
}

export async function bumpRetry(filename: string): Promise<number> {
  return mutateState((state) => {
    const rec = state.tasks[filename];
    if (!rec) return 0;
    rec.retries += 1;
    rec.updatedAt = new Date().toISOString();
    return rec.retries;
  });
}

export async function finalize(
  filename: string,
  outcome: "DONE_SUCCESS" | "DONE_FAILED",
  error?: string | null,
): Promise<void> {
  await mutateState((state) => {
    const now = new Date().toISOString();
    const rec = state.tasks[filename] ?? defaultRecord(outcome);
    rec.status = outcome;
    rec.completedAt = now;
    rec.updatedAt = now;
    rec.stage = null;
    rec.error = error ?? null;
    state.tasks[filename] = rec;
  });
}

export async function moveToDone(filename: string): Promise<void> {
  const src = join(config.instructionsDir, filename);
  const dst = join(config.doneDir, filename);
  await mkdir(config.doneDir, { recursive: true });
  await rename(src, dst);
}

export function sanitizeFilename(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let name = raw.trim();
  if (!name) return null;
  name = basename(name);
  name = name.replace(/[\\/]/g, "");
  name = name.replace(/^\.+/, "");
  name = name.replace(/[\u0000-\u001f]/g, "");
  name = name.replace(/\s+/g, "-");
  name = name.replace(/[^a-zA-Z0-9._-]/g, "-");
  name = name.replace(/-+/g, "-");
  name = name.replace(/^-+|-+$/g, "");
  if (!name) return null;
  if (!name.toLowerCase().endsWith(".md")) name = `${name}.md`;
  if (name.length > 200) name = name.slice(0, 200);
  if (name === ".md") return null;
  const root = resolve(config.instructionsDir);
  const resolved = resolve(root, name);
  const rel = resolved.slice(root.length + 1);
  if (rel !== name) return null;
  return name;
}

export async function uniqueFilename(desired: string): Promise<string> {
  const safe = sanitizeFilename(desired);
  if (!safe) throw new Error("Invalid filename");
  const rootPath = join(config.instructionsDir, safe);
  const donePath = join(config.doneDir, safe);
  if (!existsSync(rootPath) && !existsSync(donePath)) return safe;
  const stem = safe.replace(/\.md$/i, "");
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}.md`;
    if (!existsSync(join(config.instructionsDir, candidate)) && !existsSync(join(config.doneDir, candidate))) {
      return candidate;
    }
  }
  throw new Error("Could not find a unique filename");
}

export async function createTask(rawName: string, content: string): Promise<TaskView> {
  await ensureDirs();
  const name = await uniqueFilename(rawName);
  const target = join(config.instructionsDir, name);
  if (existsSync(target)) throw new Error("File already exists after uniqueness check");
  await writeFile(target, content, "utf8");
  await mutateState((state) => {
    const now = new Date().toISOString();
    state.tasks[name] = {
      status: "WAITING",
      startedAt: null,
      completedAt: null,
      updatedAt: now,
      error: null,
      retries: 0,
      stage: null,
    };
  });
  const v = await getTask(name);
  if (!v) throw new Error("Could not read created task");
  return v;
}

export async function updateTaskContent(filename: string, content: string): Promise<TaskView> {
  const safe = sanitizeFilename(filename);
  if (!safe) throw new Error("Invalid filename");
  const view = await getTask(safe);
  if (!view) throw new Error("Task not found");
  if (view.status === "RUNNING") throw new Error("Cannot edit a running task");
  if (view.status === "DONE_SUCCESS" || view.status === "DONE_FAILED") {
    throw new Error("Cannot edit a finished task (requeue it first to reopen)");
  }
  if (view.location !== "root") throw new Error("Cannot edit a task that has been moved to done/");
  const target = join(config.instructionsDir, safe);
  await writeFile(target, content, "utf8");
  await mutateState((state) => {
    const rec = state.tasks[safe];
    if (rec) rec.updatedAt = new Date().toISOString();
  });
  const v = await getTask(safe);
  if (!v) throw new Error("Could not read updated task");
  return v;
}

export async function deleteTask(filename: string): Promise<void> {
  const safe = sanitizeFilename(filename);
  if (!safe) throw new Error("Invalid filename");
  const view = await getTask(safe);
  if (!view) throw new Error("Task not found");
  if (view.status === "RUNNING") throw new Error("Cannot delete a running task");
  const path = view.location === "root"
    ? join(config.instructionsDir, safe)
    : join(config.doneDir, safe);
  if (existsSync(path)) await unlink(path);
  await mutateState((state) => {
    delete state.tasks[safe];
  });
}

export async function requeue(filename: string): Promise<TaskView> {
  const safe = sanitizeFilename(filename);
  if (!safe) throw new Error("Invalid filename");
  const view = await getTask(safe);
  if (!view) throw new Error("Task not found");
  if (view.status === "RUNNING") throw new Error("Task is currently running");
  if (view.location === "done") {
    const src = join(config.doneDir, safe);
    const dst = join(config.instructionsDir, safe);
    if (existsSync(dst)) throw new Error("A task with this name already exists in the queue");
    await rename(src, dst);
  }
  await mutateState((state) => {
    const now = new Date().toISOString();
    state.tasks[safe] = {
      status: "WAITING",
      startedAt: null,
      completedAt: null,
      updatedAt: now,
      error: null,
      retries: 0,
      stage: null,
    };
  });
  const v = await getTask(safe);
  if (!v) throw new Error("Could not read requeued task");
  return v;
}

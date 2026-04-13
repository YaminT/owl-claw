"use strict";

const state = {
  tasks: [],
  route: { name: "list", param: null },
  editor: null,
  lastTaskSig: "",
  lastHealthSig: "",
  pollHandle: null,
  beforeUnloadBound: false,
};

const api = {
  async list() {
    const r = await fetch("/api/instructions");
    if (!r.ok) throw new Error(await errMsg(r));
    return (await r.json()).tasks;
  },
  async get(name) {
    const r = await fetch(`/api/instructions/${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error(await errMsg(r));
    return await r.json();
  },
  async create(filename, content) {
    const r = await fetch("/api/instructions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename, content }),
    });
    if (!r.ok) throw new Error(await errMsg(r));
    return (await r.json()).task;
  },
  async update(name, content) {
    const r = await fetch(`/api/instructions/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) throw new Error(await errMsg(r));
    return (await r.json()).task;
  },
  async remove(name) {
    const r = await fetch(`/api/instructions/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!r.ok) throw new Error(await errMsg(r));
  },
  async requeue(name) {
    const r = await fetch(`/api/instructions/${encodeURIComponent(name)}/requeue`, { method: "POST" });
    if (!r.ok) throw new Error(await errMsg(r));
    return (await r.json()).task;
  },
  async health() {
    const r = await fetch("/api/health");
    if (!r.ok) throw new Error(await errMsg(r));
    return await r.json();
  },
};

async function errMsg(response) {
  try {
    const body = await response.json();
    return body.error || response.statusText;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

function toast(msg, kind = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 3200);
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(+d)) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

/* ---------- routing ---------- */

function parseRoute() {
  const h = (location.hash || "#/").slice(1);
  if (h === "/new") return { name: "new", param: null };
  if (h.startsWith("/edit/")) return { name: "edit", param: decodeURIComponent(h.slice(6)) };
  if (h === "/config") return { name: "config", param: null };
  return { name: "list", param: null };
}

function navigate(path, { replace = false } = {}) {
  const target = "#" + path;
  if (replace) history.replaceState(null, "", target);
  else location.hash = target;
  if (replace) applyRoute();
}

function confirmLeaveEditor() {
  if (!state.editor?.dirty) return true;
  return confirm("You have unsaved changes. Discard them?");
}

async function applyRoute() {
  const next = parseRoute();

  if (state.editor && (next.name !== "edit" || next.param !== state.route.param) && next.name !== "edit") {
    if (!confirmLeaveEditor()) {
      history.replaceState(null, "", "#/edit/" + encodeURIComponent(state.route.param ?? ""));
      return;
    }
  }
  if (state.editor && next.name === "edit" && next.param !== state.route.param) {
    if (!confirmLeaveEditor()) {
      history.replaceState(null, "", "#/edit/" + encodeURIComponent(state.route.param ?? ""));
      return;
    }
  }
  if (state.editor && next.name === "new" && state.route.name === "new") {
    return;
  }

  state.route = next;
  showView(next.name);
  updateNavActive();

  if (next.name === "list") {
    state.editor = null;
    await refreshTasks(true);
  } else if (next.name === "new") {
    openNewEditor();
  } else if (next.name === "edit") {
    await openEditEditor(next.param);
  } else if (next.name === "config") {
    state.editor = null;
    await refreshHealth(true);
  }
}

function showView(name) {
  const map = { list: "view-list", new: "view-editor", edit: "view-editor", config: "view-config" };
  const target = map[name];
  for (const el of document.querySelectorAll(".view")) {
    el.classList.toggle("active", el.id === target);
  }
}

function updateNavActive() {
  const isConfig = state.route.name === "config";
  for (const a of document.querySelectorAll(".nav-btn")) {
    const nav = a.dataset.nav;
    a.classList.toggle("active", (isConfig && nav === "configuration") || (!isConfig && nav === "instructions"));
  }
}

/* ---------- list view ---------- */

function taskListSig(tasks) {
  return tasks
    .map((t) => `${t.filename}|${t.status}|${t.stage ?? ""}|${t.updatedAt ?? ""}|${t.retries}|${t.location}`)
    .join(";");
}

async function refreshTasks(force = false) {
  try {
    const tasks = await api.list();
    const sig = taskListSig(tasks);
    if (!force && sig === state.lastTaskSig) {
      if (state.editor) syncEditorFromList(tasks);
      return;
    }
    state.lastTaskSig = sig;
    state.tasks = tasks;
    renderSidebarCounts();
    if (state.route.name === "list") renderTaskList();
    if (state.editor) syncEditorFromList(tasks);
  } catch (e) {
    if (force) toast(`Failed to load: ${e.message}`, "err");
  }
}

function renderTaskList() {
  const tbody = document.getElementById("task-tbody");
  if (!state.tasks.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">No instructions yet. Click <a href="#/new">+ New instruction</a> to create one.</td></tr>`;
    return;
  }
  tbody.innerHTML = state.tasks.map((t) => {
    const fnClass = t.location === "done" ? "filename-cell done" : "filename-cell";
    const stage = t.status === "RUNNING" && t.stage ? escapeHtml(t.stage) : "—";
    const updated = fmtTime(t.updatedAt || t.mtime);
    const retries = t.retries > 0 ? String(t.retries) : "—";
    const href = "#/edit/" + encodeURIComponent(t.filename);
    return `
      <tr data-href="${escapeHtml(href)}">
        <td class="${fnClass}">${escapeHtml(t.filename)}${t.location === "done" ? '<div class="muted-cell">done/</div>' : ""}</td>
        <td><span class="status-pill" data-status="${t.status}">${t.status.replace("DONE_", "")}</span></td>
        <td class="muted-cell">${stage}</td>
        <td class="muted-cell">${retries}</td>
        <td class="muted-cell">${updated}</td>
      </tr>`;
  }).join("");
  for (const row of tbody.querySelectorAll("tr[data-href]")) {
    row.addEventListener("click", () => {
      location.hash = row.dataset.href;
    });
  }
}

function renderSidebarCounts() {
  const waiting = state.tasks.filter((t) => t.status === "WAITING").length;
  const running = state.tasks.filter((t) => t.status === "RUNNING").length;
  const countEl = document.querySelector('.nav-count[data-count="waiting"]');
  if (countEl) countEl.textContent = running > 0 ? `${waiting}+${running}` : String(waiting);
}

/* ---------- editor view ---------- */

const DEFAULT_TEMPLATE = `# Task title

Describe the work to do in plain terms. Claude will execute this against the configured frontend repo.

## Context

(optional background, links, constraints)

## Acceptance

- A clear outcome you can verify
- Another check
`;

function defaultFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `task-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.md`;
}

function openNewEditor() {
  state.editor = {
    mode: "new",
    task: null,
    filename: defaultFilename(),
    content: DEFAULT_TEMPLATE,
    dirty: false,
  };
  bindEditorDom();
  const fn = document.getElementById("editor-filename");
  if (fn) { fn.focus(); fn.select(); }
}

async function openEditEditor(name) {
  try {
    const body = await api.get(name);
    state.editor = {
      mode: "edit",
      task: body.task,
      filename: body.task.filename,
      content: body.content,
      dirty: false,
    };
    bindEditorDom();
  } catch (e) {
    toast(`Failed to open: ${e.message}`, "err");
    navigate("/", { replace: true });
  }
}

function bindEditorDom() {
  const heading = document.getElementById("editor-heading");
  const filenameInput = document.getElementById("editor-filename");
  const contentArea = document.getElementById("editor-content");
  const saveBtn = document.getElementById("save-btn");
  const deleteBtn = document.getElementById("delete-btn");
  const requeueBtn = document.getElementById("requeue-btn");

  const { mode, task, filename, content } = state.editor;
  const isNew = mode === "new";
  const isRunning = task?.status === "RUNNING";
  const isDone = task?.status === "DONE_SUCCESS" || task?.status === "DONE_FAILED";

  heading.textContent = isNew ? "New instruction" : filename;

  filenameInput.value = filename;
  filenameInput.disabled = !isNew;
  contentArea.value = content;
  contentArea.readOnly = isRunning || isDone;

  saveBtn.hidden = isDone;
  saveBtn.disabled = isRunning;
  saveBtn.textContent = isNew ? "Create" : "Save";
  deleteBtn.hidden = isNew || isRunning;
  requeueBtn.hidden = !isDone;

  filenameInput.oninput = () => { state.editor.filename = filenameInput.value; state.editor.dirty = true; };
  contentArea.oninput = () => { state.editor.content = contentArea.value; state.editor.dirty = true; };
  saveBtn.onclick = onSave;
  deleteBtn.onclick = onDelete;
  requeueBtn.onclick = onRequeue;

  renderEditorStatus(task);
}

function renderEditorStatus(task) {
  const pill = document.getElementById("editor-status-pill");
  const meta = document.getElementById("editor-meta");
  if (!pill || !meta) return;
  if (!task) {
    pill.dataset.status = "";
    pill.textContent = "NEW";
    meta.innerHTML = "";
    return;
  }
  pill.dataset.status = task.status;
  pill.textContent = task.status.replace("DONE_", "");
  const parts = [];
  parts.push(`location: ${task.location}`);
  if (task.startedAt) parts.push(`started ${fmtTime(task.startedAt)}`);
  if (task.completedAt) parts.push(`completed ${fmtTime(task.completedAt)}`);
  if (task.retries > 0) parts.push(`retries: ${task.retries}`);
  if (task.stage) parts.push(`stage: ${task.stage}`);
  let html = parts.map((p) => `<span>${escapeHtml(p)}</span>`).join("");
  if (task.error) html += `<div class="error">${escapeHtml(task.error)}</div>`;
  meta.innerHTML = html;
}

function syncEditorFromList(tasks) {
  if (!state.editor || state.editor.mode !== "edit") return;
  const updated = tasks.find((t) => t.filename === state.editor.filename);
  if (!updated) return;
  const prev = state.editor.task;
  state.editor.task = updated;
  if (prev?.status !== updated.status) {
    const contentArea = document.getElementById("editor-content");
    const isRunning = updated.status === "RUNNING";
    const isDone = updated.status === "DONE_SUCCESS" || updated.status === "DONE_FAILED";
    if (contentArea) contentArea.readOnly = isRunning || isDone;
    const saveBtn = document.getElementById("save-btn");
    const deleteBtn = document.getElementById("delete-btn");
    const requeueBtn = document.getElementById("requeue-btn");
    if (saveBtn) { saveBtn.hidden = isDone; saveBtn.disabled = isRunning; }
    if (deleteBtn) deleteBtn.hidden = isRunning;
    if (requeueBtn) requeueBtn.hidden = !isDone;
  }
  renderEditorStatus(updated);
}

async function onSave() {
  const ed = state.editor;
  if (!ed) return;
  const name = (ed.filename || "").trim();
  if (!name) { toast("Filename is required", "err"); return; }
  try {
    if (ed.mode === "new") {
      const task = await api.create(name, ed.content);
      ed.dirty = false;
      toast(`Created ${task.filename}`, "ok");
      navigate("/");
    } else {
      const task = await api.update(ed.task.filename, ed.content);
      ed.task = task;
      ed.dirty = false;
      renderEditorStatus(task);
      toast(`Saved ${task.filename}`, "ok");
    }
    await refreshTasks(true);
  } catch (e) {
    toast(`Save failed: ${e.message}`, "err");
  }
}

async function onDelete() {
  const ed = state.editor;
  if (!ed?.task) return;
  if (!confirm(`Delete ${ed.task.filename}?`)) return;
  try {
    await api.remove(ed.task.filename);
    ed.dirty = false;
    toast("Deleted", "ok");
    await refreshTasks(true);
    navigate("/");
  } catch (e) {
    toast(`Delete failed: ${e.message}`, "err");
  }
}

async function onRequeue() {
  const ed = state.editor;
  if (!ed?.task) return;
  if (!confirm(`Re-run ${ed.task.filename}? It will be moved back to the queue as WAITING.`)) return;
  try {
    const task = await api.requeue(ed.task.filename);
    ed.dirty = false;
    toast("Re-queued", "ok");
    await refreshTasks(true);
    navigate("/edit/" + encodeURIComponent(task.filename));
  } catch (e) {
    toast(`Requeue failed: ${e.message}`, "err");
  }
}

/* ---------- config / health ---------- */

function healthSig(h) {
  const w = h.worker;
  return [
    h.tools.claude.runnable, h.tools.claude.version,
    h.tools.codex.runnable, h.tools.codex.version,
    h.filesystem.frontendDirExists, h.filesystem.doneDirExists,
    w.running, w.currentFile, w.currentStage, w.processedCount,
    w.lastOutcome, w.lastError, w.lastStartedAt, w.lastFinishedAt,
  ].join("|");
}

async function refreshHealth(force) {
  try {
    const data = await api.health();
    const sig = healthSig(data);
    if (!force && sig === state.lastHealthSig) return;
    state.lastHealthSig = sig;
    if (state.route.name === "config") renderHealth(data);
    renderSidebarHealth(data);
  } catch (e) {
    if (force) toast(`Health check failed: ${e.message}`, "err");
  }
}

function renderHealth(h) {
  const claudeCard = document.getElementById("claude-card");
  const codexCard = document.getElementById("codex-card");
  const pathsCard = document.getElementById("paths-card");
  const runnerCard = document.getElementById("runner-card");
  const workerCard = document.getElementById("worker-card");
  if (!claudeCard || !codexCard || !pathsCard || !runnerCard || !workerCard) return;

  claudeCard.innerHTML = renderToolKv(h.tools.claude);
  codexCard.innerHTML = renderToolKv(h.tools.codex);
  pathsCard.innerHTML = `
    <dt>instructions</dt><dd>${escapeHtml(h.config.instructionsDir)}</dd>
    <dt>done/</dt><dd class="${h.filesystem.doneDirExists ? "ok" : "err"}">${escapeHtml(h.config.doneDir)} ${h.filesystem.doneDirExists ? "(exists)" : "(missing)"}</dd>
    <dt>frontend repo</dt><dd class="${h.filesystem.frontendDirExists ? "ok" : "err"}">${escapeHtml(h.config.frontendDir)} ${h.filesystem.frontendDirExists ? "(exists)" : "(missing)"}</dd>
  `;
  runnerCard.innerHTML = `
    <dt>web port</dt><dd>${h.config.webPort}</dd>
    <dt>max retries</dt><dd>${h.config.maxRetries}</dd>
    <dt>retry interval</dt><dd>${h.config.retryIntervalSec}s</dd>
    <dt>prompt runs</dt><dd>${h.config.promptRuns}</dd>
    <dt>poll interval</dt><dd>${h.config.pollIntervalMs}ms</dd>
    <dt>ANTHROPIC_BASE_URL</dt><dd>${h.config.anthropicBaseUrl ? escapeHtml(h.config.anthropicBaseUrl) : "(default)"}</dd>
  `;
  const w = h.worker;
  workerCard.innerHTML = `
    <dt>state</dt><dd class="${w.running ? "warn" : "ok"}">${w.running ? "busy" : "idle"}</dd>
    <dt>current</dt><dd>${w.currentFile ? escapeHtml(w.currentFile) : "—"}</dd>
    <dt>stage</dt><dd>${w.currentStage ? escapeHtml(w.currentStage) : "—"}</dd>
    <dt>processed</dt><dd>${w.processedCount}</dd>
    <dt>last started</dt><dd>${fmtTime(w.lastStartedAt)}</dd>
    <dt>last finished</dt><dd>${fmtTime(w.lastFinishedAt)}</dd>
    <dt>last outcome</dt><dd class="${w.lastOutcome === "DONE_SUCCESS" ? "ok" : w.lastOutcome === "DONE_FAILED" ? "err" : ""}">${w.lastOutcome ?? "—"}</dd>
    ${w.lastError ? `<dt>last error</dt><dd class="err">${escapeHtml(w.lastError)}</dd>` : ""}
    <dt>started</dt><dd>${fmtTime(w.startedAt)}</dd>
  `;
}

function renderToolKv(tool) {
  return `
    <dt>binary</dt><dd>${escapeHtml(tool.bin)}</dd>
    <dt>installed</dt><dd class="${tool.installed ? "ok" : "err"}">${tool.installed ? "yes" : "no"}</dd>
    <dt>runnable</dt><dd class="${tool.runnable ? "ok" : "err"}">${tool.runnable ? "yes" : "no"}</dd>
    <dt>version</dt><dd>${tool.version ? escapeHtml(tool.version) : "—"}</dd>
    ${tool.error ? `<dt>error</dt><dd class="err">${escapeHtml(tool.error)}</dd>` : ""}
  `;
}

function renderSidebarHealth(h) {
  const dot = document.getElementById("worker-state-dot");
  const label = document.getElementById("worker-state-label");
  const current = document.getElementById("worker-current");
  const navDot = document.getElementById("nav-health-dot");
  if (!dot || !label || !current) return;
  const w = h.worker;
  if (w.running) {
    dot.className = "dot running";
    label.textContent = "worker busy";
    current.textContent = w.currentFile ?? "";
  } else {
    dot.className = "dot idle";
    label.textContent = "worker idle";
    current.textContent = "";
  }
  if (navDot) {
    const healthy = h.tools.claude.runnable && h.tools.codex.runnable && h.filesystem.frontendDirExists;
    navDot.style.color = healthy ? "var(--ok)" : "var(--err)";
  }
}

/* ---------- boot ---------- */

function bindStaticUi() {
  document.getElementById("refresh-btn").addEventListener("click", () => refreshTasks(true));
  document.getElementById("refresh-health-btn").addEventListener("click", () => refreshHealth(true));

  window.addEventListener("hashchange", applyRoute);
  window.addEventListener("beforeunload", (e) => {
    if (state.editor?.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

function startPolling() {
  state.pollHandle = setInterval(async () => {
    try {
      await refreshTasks();
      await refreshHealth(false);
    } catch {}
  }, 2000);
}

async function boot() {
  bindStaticUi();
  await applyRoute();
  await refreshHealth(true);
  startPolling();
}

boot();

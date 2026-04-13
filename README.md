<p align="center">
  <img src="public/owl-icon.png" width="120" alt="OwlRun" />
</p>
<h1 align="center">OwlRun</h1>
<p align="center"><em>A persistent, self-healing runner for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> and <a href="https://github.com/openai/codex">Codex</a> tasks. Drop a Markdown file in a folder, watch it ship.</em></p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#install">Install</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#web-portal">Web</a> ·
  <a href="#configuration">Config</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#faq">FAQ</a>
</p>

---

## What it does

You write tasks as plain Markdown. OwlRun runs them — **strictly one at a time** — through the same loop you'd run by hand:

1. **Claude executes** the task against your frontend repo (writes code, runs commands, the works).
2. The file is **moved to `done/`** so the queue keeps moving.
3. **Claude reviews** the unstaged diff, with the repo's `CLAUDE.md` injected as context.
4. **Codex reviews** all uncommitted changes for a second opinion.
5. **Status lands** as `DONE_SUCCESS` or `DONE_FAILED`.

A web UI lets you queue, edit, observe, and re-queue; a CLI does everything from the terminal; rate-limit / overload / 429 / 503 responses get retried with `retry-after` parsing; the worker survives crashes via an in-process supervisor and (optionally) systemd. Bun under the hood — one process, 40 KB bundle, no node_modules at runtime past `@types/bun`.

```
┌─────────────┐  poll/claim   ┌──────────────────────────┐
│  web UI     │──────────────▶│  Bun process             │
│  :8090      │  status JSON  │  ┌────────┐ ┌────────┐   │──▶ claude / codex / git
│  & CLI      │◀──────────────│  │ server │ │ worker │   │
└─────────────┘               │  └────────┘ └────────┘   │
                              └──────────────────────────┘
                                         │
                                         ▼
                          ~/.owlrun/instructions/
                          ~/.owlrun/frontend-target/   (your real repo)
```

---

## Quickstart

```sh
# 1. Install via npm (Node 20+).
#    Package name is `owlrunner` (the unscoped `owlrun` is squatted on npm
#    by an unrelated 2020 package). The CLI command stays `owlrun`.
npm install -g owlrunner
# OR via the tarball installer (no Node required, bundles its own runtime):
#   tar -xzf owlrun-0.1.0.tar.gz && cd owlrun-0.1.0 && ./install.sh

# 2. Install + log in to Claude / Codex
owlrun req --yes
claude          # browser-based first-time auth
codex login

# 3. Start it
owlrun start
owlrun open
```

That's it. Drop a `.md` file in `~/.owlrun/instructions/` — or hit **+ New instruction** in the UI — and the worker picks it up within 2 seconds.

> **This branch (`npm-package`)** ports the runtime from Bun to Node so OwlRun can be installed via `npm install -g owlrunner`. The `main` branch is the original Bun-native build with the `install.sh` installer. Both are functionally identical from a user's perspective; only the install/runtime mechanism differs.

---

## Install

The installer is **idempotent**. Re-running redeploys the source and refreshes deps without nuking your data.

| Command | Where it lives | Wrapper | Survives reboot |
|---|---|---|---|
| `./install.sh` | `~/.local/share/owlrun` | `~/.local/bin/owlrun` | no — start it manually |
| `sudo ./install.sh --system` | `/opt/owlrun` | `/usr/local/bin/owlrun` | no — start it manually |
| `sudo ./install.sh --systemd` | `/opt/owlrun` | `/usr/local/bin/owlrun` | **yes** — `systemd` unit |

The installer:

▸ **installs Bun** into `~/.bun` if missing — handles the `unzip`-missing case via a Python fallback (because that's what most fresh Ubuntu boxes look like)<br>
▸ runs `bun install`, **verifies a clean build**<br>
▸ writes the `owlrun` wrapper<br>
▸ creates `~/.owlrun/{instructions,frontend-target}` with a stub git repo + `CLAUDE.md`, so `owlrun start` works **out of the box**<br>
▸ with `--systemd`: installs an `enable`d unit, sandboxed (`ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`), `Restart=always`, runs as the invoking sudo user

### Got `unzip`-less Ubuntu/Debian?

Use the tarball, or extract with Python:

```sh
python3 -c "import zipfile; zipfile.ZipFile('owlrun-0.1.0.zip').extractall()"
chmod +x owlrun-0.1.0/install.sh
cd owlrun-0.1.0 && ./install.sh
```

### Uninstall

```sh
owlrun uninstall                  # interactive
owlrun uninstall --yes            # no prompt
owlrun uninstall --yes --purge    # nuke ~/.owlrun and ~/owlrun.log too
# or directly:
sudo ./install.sh --uninstall
```

Both probe **every** install location (user + system) and remove what they find — wrapper, source tree, systemd unit, port-bound process, lingering tmux session. Your data in `~/.owlrun/` is preserved unless you pass `--purge`.

### From source (development)

```sh
cd owlRun
bun install
bun link            # registers `owlrun` in Bun's global bin dir
bun run dev         # hot-reload server
```

---

## First-time setup

### Install the CLIs

```sh
owlrun req               # interactive, one-by-one
owlrun req --yes         # install everything that's missing
owlrun req claude        # specific tool
```

▸ **Claude Code** via `curl -fsSL https://claude.ai/install.sh | bash` → `~/.local/bin/claude`<br>
▸ **Codex** from GitHub Releases (auto-detects x86_64 / aarch64) → `~/.local/bin/codex`

### Log in

```sh
claude                   # opens a browser flow
# or
claude setup-token       # long-lived token (subscription)

codex login              # browser flow
```

Both checked by `owlrun doctor` — claude unauthed is an **error** (execution dies), codex unauthed is a **warning** (only the codex review phase breaks).

### Point at your real frontend repo

```sh
export OWLRUN_FRONTEND_DIR=/path/to/real/frontend
owlrun restart
```

The repo **must** contain `CLAUDE.md` (or `claude.md` / `.claude/CLAUDE.md`) — the review phase reads it as context, missing file = hard fail.

### Verify

```sh
$ owlrun doctor
✓ bun 1.3.12
✓ git version 2.43.0
✓ claude 2.1.104 (Claude Code) (you@example.com, team)
✓ codex codex-cli 0.120.0 (ChatGPT)
✓ tmux
✓ project root, instructions, frontend repo, CLAUDE.md
✓ supervisor: systemd
✓ OwlRun is responding at http://127.0.0.1:8090
All checks passed.
```

---

## Daily use

OwlRun ships **two supervisors** — pick one and forget about it:

| | tmux mode | systemd mode |
|---|---|---|
| Auto-detect | when no unit installed | when `/etc/systemd/system/owlrun.service` exists |
| `owlrun start` | `tmux new-session -d -s owlrun ...` | `sudo systemctl start owlrun` |
| `owlrun stop` | `tmux kill-session -t owlrun` | `sudo systemctl stop owlrun` |
| `owlrun restart` | stop + start | `sudo systemctl restart owlrun` |
| `owlrun attach` | `tmux attach -t owlrun` | refuses, points at `journalctl` |
| Survives reboot | no | **yes** |
| Self-heal on crash | yes (in-process supervisor) | **yes** (in-process **+** systemd `Restart=always`) |

Override the auto-detection per call with `--tmux` / `--systemd`, or set `OWLRUN_SUPERVISOR=systemd|tmux`.

---

## CLI

```
owlrun <command> [options]

doctor                         Check bun/git/claude/codex/tmux + paths + auth + supervisor + running instance
req [--yes] [tools]            Install missing requirements (claude, codex)
start [--tmux|--systemd]       Start OwlRun (auto-detects supervisor; flags force one)
stop  [--tmux|--systemd]
restart [--tmux|--systemd]
status                         Worker state + colored task queue
health                         Full /api/health snapshot
logs [-f|-n N|--journal]       Tail logs (-f follow, -n lines, --journal use journalctl)
open                           Print (and open) the web UI URL
attach                         tmux attach (refuses under systemd)
uninstall [--yes|--purge]      Remove OwlRun. --purge also wipes ~/.owlrun.
version | help
```

All commands talk to `http://$OWLRUN_HOST:$OWLRUN_PORT` (default `127.0.0.1:8090` for CLI lookups; the server itself binds `0.0.0.0` by default).

---

## Web portal

Open `http://localhost:8090`. Hash-routed SPA, vanilla JS, no framework, polls every 2 s with signature-based diffing so the DOM only updates when something actually changed.

| Route | What it does |
|---|---|
| `#/` | Full-width task list. Filename, status, current stage, retry count, last update. Click a row → editor. |
| `#/new` | Full-page Markdown editor for a new instruction. **Save** creates the file, returns to the list. |
| `#/edit/<filename>` | Full-page editor. WAITING tasks: editable. RUNNING: read-only with live stage. DONE: read-only with **Reopen as waiting** and **Delete**. |
| `#/config` | Health cards: Claude/Codex install + version, paths, runner config, live worker state. |

Unsaved-edit guards prevent accidental navigation away.

---

## Configuration

Everything via env vars. Defaults are sensible.

### Runtime (server + worker)

| Var | Default | Meaning |
|---|---|---|
| `OWLRUN_PORT` | `8090` | Web portal port |
| `OWLRUN_HOST` | `0.0.0.0` | Bind host |
| `OWLRUN_INSTRUCTIONS_DIR` | `~/.owlrun/instructions` | Where `.md` task files live (`done/` auto-created) |
| `OWLRUN_FRONTEND_DIR` | `~/.owlrun/frontend-target` | Target repo for execution + reviews. Must have `CLAUDE.md`. |
| `OWLRUN_MAX_RETRIES` | `20` | Max retries per CLI invocation when a retryable signal is detected |
| `OWLRUN_RETRY_INTERVAL` | `1800` | Default sleep between retries (seconds) when no explicit hint is in CLI output |
| `OWLRUN_PROMPT_RUNS` | `1` | Times to re-run the Claude execution prompt per task |
| `OWLRUN_POLL_INTERVAL_MS` | `2000` | Worker poll interval when idle |
| `OWLRUN_CLAUDE_BIN` | `claude` | Claude CLI binary name or path |
| `OWLRUN_CODEX_BIN` | `codex` | Codex CLI binary name or path |
| `OWLRUN_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `ANTHROPIC_BASE_URL` | *(unset)* | Forwarded to `claude` via env |

### CLI-only

| Var | Default | Used by |
|---|---|---|
| `OWLRUN_LOG_FILE` | `~/owlrun.log` | `owlrun logs` (file mode), tmux supervisor's `tee` target |
| `OWLRUN_TMUX_SESSION` | `owlrun` | tmux session name |
| `OWLRUN_SUPERVISOR` | *(auto)* | `systemd` or `tmux` — overrides auto-detection |

### Env propagation

`owlrun start` (tmux mode) captures every `OWLRUN_*` and `ANTHROPIC_BASE_URL` from your current shell into the launched session — so this works:

```sh
OWLRUN_FRONTEND_DIR=/srv/api OWLRUN_PORT=9000 owlrun start
```

For systemd, edit `/etc/systemd/system/owlrun.service`, then `sudo systemctl daemon-reload && sudo systemctl restart owlrun`.

---

## Task lifecycle

Four statuses, one source of truth (`~/.owlrun/instructions/.owlrun-state.json`, reconciled with the filesystem on every startup):

| Status | Meaning |
|---|---|
| `WAITING` | Queued. Editable. |
| `RUNNING` | Currently being processed. Editing blocked. |
| `DONE_SUCCESS` | Full pipeline (exec + both reviews) green. |
| `DONE_FAILED` | Non-retryable error, or retries exhausted. |

Two non-obvious truths:

1. **A `DONE_FAILED` task can have its file in `done/`.** The pipeline moves the file there *after* a successful Claude execution, *before* the reviews. Reviews failing leaves the file in `done/` but the status reflects the overall outcome.
2. **Crash recovery is automatic.** Stale `RUNNING` entries get reset to `WAITING` (if still in root) or `DONE_FAILED` (if already in `done/`) on the next startup.

Pick order: **first WAITING file alphabetically** (codepoint sort, deterministic). Name files `001-foo.md`, `002-bar.md`, etc., for sequencing.

---

## HTTP API

JSON in, JSON out. POST/PUT bodies capped at 10 MB.

| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | — | Full snapshot: app, config, filesystem, tools, worker |
| `GET` | `/api/worker` | — | Worker state only |
| `GET` | `/api/logs?limit=N` | — | Recent in-memory log events |
| `GET` | `/api/instructions` | — | List all tasks (root + done/) |
| `POST` | `/api/instructions` | `{filename, content}` | Create. Filename sanitized; collisions auto-suffix. |
| `GET` | `/api/instructions/:name` | — | Task metadata + content |
| `PUT` | `/api/instructions/:name` | `{content}` | Update (WAITING only; 409 on RUNNING/DONE) |
| `DELETE` | `/api/instructions/:name` | — | Delete file + state |
| `POST` | `/api/instructions/:name/requeue` | — | Move from `done/` back to root as WAITING |

---

## Logs and observability

```sh
owlrun logs              # last 50 lines from the file
owlrun logs -f           # follow
owlrun logs -n 200       # last 200
owlrun logs --journal    # via journalctl (auto when systemd is active and the file is missing)
owlrun status            # quick worker + queue summary
owlrun health            # full health
```

Under systemd, output is **both** in `~/owlrun.log` and `journalctl -u owlrun` — pick whichever you prefer.

---

## Where things live

After `--systemd`:

| Path | Purpose |
|---|---|
| `/opt/owlrun/` | OwlRun source + `node_modules` |
| `/usr/local/bin/owlrun` | CLI wrapper |
| `/etc/systemd/system/owlrun.service` | systemd unit |
| `~/.owlrun/instructions/` | Task queue |
| `~/.owlrun/instructions/done/` | Completed/failed task files |
| `~/.owlrun/instructions/.owlrun-state.json` | Persistent task state |
| `~/.owlrun/frontend-target/` | Default target repo (placeholder) |
| `~/owlrun.log` | App log (also goes to journal) |

For a default user install, swap `/opt/owlrun` → `~/.local/share/owlrun` and `/usr/local/bin/owlrun` → `~/.local/bin/owlrun`. Everything else is the same.

---

## Project layout

```
owlRun/
├── bin/owlrun.ts         The owlrun CLI (registered as a Bun bin)
├── src/
│   ├── index.ts          Entry: signals + supervisors
│   ├── config.ts         Env → Config
│   ├── logger.ts         Structured log + in-memory tail
│   ├── shutdown.ts       Shared shutdown signal
│   ├── store.ts          state.json, fs ops, sanitization, atomic claim
│   ├── cli.ts            Spawn + retry detection + retry-after parsing
│   ├── pipeline.ts       Exec prompt, reviews, status transitions
│   ├── worker.ts         Polling loop, sequential execution
│   └── server.ts         HTTP API + static files
├── public/               SPA shell (vanilla JS, hash routing)
├── deploy/               Standalone systemd unit + remote-install playbook
├── scripts/              build-release.sh — produces dist/owlrun-<v>.{tar.gz,zip}
├── install.sh            Portable installer (Linux/macOS)
├── package.json          Bun entry, bin registration, file allowlist
├── tsconfig.json
├── LICENSE               MIT
└── README.md             You are here
```

---

## Safety

▸ **Filenames sanitized** before any fs op: path separators stripped, leading dots removed, control chars dropped, whitespace replaced. Result must resolve inside `OWLRUN_INSTRUCTIONS_DIR` (defense-in-depth path-traversal check).<br>
▸ **No shell** — CLIs invoked via `Bun.spawn` with arrays. No injection surface for `claude`/`codex`/`git`.<br>
▸ **Concurrent state writes serialized** through a single mutate chain. No lost updates.<br>
▸ **10 MB body cap** on POST/PUT.<br>
▸ **systemd hardening**: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` with explicit `ReadWritePaths`, `PrivateTmp=true`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `✗ claude — not found on $PATH` | `owlrun req` to install. Or set `OWLRUN_CLAUDE_BIN` to the absolute path. |
| `✗ claude … — not logged in` | `claude` (browser flow) or `claude setup-token`. |
| `Not logged in · Please run /login` in task errors | Same as above — claude isn't authed. |
| `CLAUDE.md not found in <frontendDir>` | Add a `CLAUDE.md` to your frontend repo, or change `OWLRUN_FRONTEND_DIR`. |
| Task stuck in `RUNNING` after a crash | Restart OwlRun. The store reconciles stale RUNNING entries on startup. |
| systemd `status=226/NAMESPACE` | Re-run `sudo ./install.sh --systemd`; the installer pre-creates the `ReadWritePaths`. |
| `sudo cannot prompt for a password from this shell` | Run interactively, configure NOPASSWD for `systemctl owlrun`, or use the suggested `sudo systemctl …` fallback. |
| Rate-limit retry never fires | `owlrun logs` — find the raw CLI output. Pattern list lives in `src/cli.ts:RETRYABLE_PATTERNS`; extend it. |
| Port 8090 in use | `owlrun stop`, or `OWLRUN_PORT=9000 owlrun restart`. |
| Tarball/zip won't extract on a fresh box | Tarball needs `tar` (always present). Zip needs `unzip` (often missing on minimal Ubuntu) — use the Python fallback above. |

---

## Building a release

```sh
bun run release          # → dist/owlrun-<version>.{tar.gz,zip} + .sha256
```

Both archives contain `bin/`, `src/`, `public/`, `deploy/`, `scripts/`, `install.sh`, `package.json`, `tsconfig.json`, `LICENSE`, `README.md`. Top-level dir inside is `owlrun-<version>/` so they extract into a clean folder. The zip preserves unix file modes (`install.sh` stays executable on extract).

---

## FAQ

### How do I run Claude Code unattended for hours?

That's exactly what OwlRun does. Drop your tasks as Markdown files in `~/.owlrun/instructions/`, then `owlrun start`. The worker polls every 2 seconds and runs them sequentially, retrying on rate limits / overload / 503 / `retry-after` hints up to `OWLRUN_MAX_RETRIES` times (default 20). Pair it with `--systemd` so the unit comes back automatically after reboots and process crashes — a multi-hour run will survive an OOM, a kernel panic, or you killing the process by accident.

### How do I run Claude Code in the background?

`owlrun start` detaches into a tmux session named `owlrun` (or starts the systemd unit if installed). Both options keep the worker running after you log out. Inspect from anywhere with `owlrun status`, `owlrun logs -f`, or `owlrun attach` (tmux mode). For a true server install, prefer `sudo ./install.sh --systemd` — that way Claude Code keeps running across reboots without you doing anything.

### Can I run multiple Claude Code agents in parallel?

OwlRun is **deliberately sequential** inside a single instance — running multiple Claude Code workers against the same git repo at the same time corrupts state in subtle ways (overlapping diffs, lockfile races, conflicting commits). If you need parallelism, run **multiple OwlRun instances** on different ports targeting different repos:

```sh
OWLRUN_PORT=8090 OWLRUN_INSTRUCTIONS_DIR=~/.owlrun/api OWLRUN_FRONTEND_DIR=~/code/api owlrun start
OWLRUN_PORT=8091 OWLRUN_INSTRUCTIONS_DIR=~/.owlrun/web OWLRUN_FRONTEND_DIR=~/code/web owlrun start
```

Or just put your tasks in order with numeric prefixes (`001-foo.md`, `002-bar.md`) and let one worker burn through them — usually faster than coordinating many.

### How does OwlRun handle Claude Code rate limits?

Every CLI invocation is wrapped in a retry loop. If the output matches `rate limit`, `429`, `503`, `529`, `quota`, `overloaded`, or various timeout / connection patterns, OwlRun parses the wait hint (`retry-after: N`, ISO reset timestamp, "try again in 5 minutes", future unix timestamp) and sleeps for that long — falling back to `OWLRUN_RETRY_INTERVAL` (default 1800 s = 30 min) if no hint is present. After `OWLRUN_MAX_RETRIES` attempts the task is marked `DONE_FAILED`. Pattern list lives in `src/cli.ts:RETRYABLE_PATTERNS` if you need to extend it.

### Can OwlRun run Codex tasks too?

Yes — the pipeline runs **Claude Code execution** + **Claude Code review** + **Codex review** for every task. Codex is the second opinion on the diff. Both CLIs need to be installed (`owlrun req`) and authenticated (`claude`, `codex login`). If you only have Claude installed, the Codex review step fails and the task is marked `DONE_FAILED` — there's no Codex-only mode today.

### How do I queue Claude Code tasks?

Two ways:

1. **Web UI** — open `http://localhost:8090`, click `+ New instruction`, write Markdown, save.
2. **API** — `curl -X POST http://localhost:8090/api/instructions -H 'content-type: application/json' -d '{"filename":"task-001.md","content":"# Refactor X to Y"}'`

The next WAITING task alphabetically is picked up within `OWLRUN_POLL_INTERVAL_MS` (default 2 s).

### How is OwlRun different from a CI/CD pipeline?

CI runs on push events, parallelizes across runners, and is meant for tests. OwlRun runs an **interactive coding agent** sequentially against an **always-checked-out repo**, with retries tuned for AI-API quirks (rate limits, overloads, hour-long backoffs). Think of it as cron-meets-Claude rather than GitHub Actions: one machine, one repo, your queue of "things you want done".

### How do I know if my Claude Code or Codex CLI is authenticated?

```sh
owlrun doctor
```

Doctor calls `claude auth status` and `codex login status` — both are local lookups, no API call, free. You'll see something like `✓ claude 2.1.104 (you@example.com, team)` when authed, or `✗ claude 2.1.104 — not logged in (run \`claude\` or \`claude setup-token\`)` when not.

### Can I see what Claude Code is doing right now?

```sh
owlrun status              # one-line worker state + queue
owlrun logs -f             # follow the live log
owlrun health              # full snapshot
```

Or open the web UI — the task list shows a **stage** column that updates live for the RUNNING task (`claude-exec: run 1/1` → `moving-to-done` → `claude-review: collecting diff` → `codex-review`).

### Is OwlRun affiliated with Anthropic or OpenAI?

No. OwlRun is an independent open-source tool that integrates with the official Claude Code and Codex CLIs. See [Trademarks](#trademarks).

---

## Trademarks

"Anthropic", "Claude" and "Claude Code" are trademarks of Anthropic PBC. "OpenAI" and "Codex" are trademarks of OpenAI. OwlRun is an independent project and is **not affiliated with, endorsed by, or sponsored by** Anthropic or OpenAI. Names are used here in their nominative sense to describe compatibility and integration.

---

## License

MIT — see [LICENSE](LICENSE).

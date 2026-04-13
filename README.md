# OwlRun

A persistent local runner for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex) instruction files, with a web portal, a CLI, and self-healing supervisors.

OwlRun watches a directory for Markdown task files. For each file it asks Claude to execute the task against your frontend repo, then runs Claude and Codex code reviews on the resulting diff. Tasks run **strictly one at a time**. The web UI lets you queue, edit, observe, and re-queue tasks. The whole thing keeps itself alive — server and worker live in one Bun process supervised by an internal restart loop, and optionally by `systemd` on top of that.

```
┌──────────┐   poll & claim   ┌────────────────────────────┐
│ web UI   │───────────▶ ──── │  Bun process               │
│ (8090)   │ ◀─── status ──── │  ┌──────┐    ┌─────────┐   │
└──────────┘                  │  │server│    │ worker  │── │── claude / codex / git
                              │  └──────┘    └─────────┘   │
                              └────────────────────────────┘
                                  │
                                  ▼
                         ~/.owlrun/instructions/
                         ~/.owlrun/frontend-target/
```

## Quickstart

```sh
# 1. Install (Linux/macOS, no root needed)
tar -xzf owlrun-0.1.0.tar.gz
cd owlrun-0.1.0
./install.sh
export PATH="$HOME/.local/bin:$PATH"   # if not already

# 2. Install Claude + Codex CLIs and authenticate
owlrun req --yes
claude                  # browser-based first-time auth
codex login

# 3. Run
owlrun start
owlrun open             # prints (and on Mac/Linux opens) http://localhost:8090
owlrun status
```

That's it. Drop a `.md` file into `~/.owlrun/instructions/` (or use the web UI) and the worker picks it up within 2 seconds.

---

## What it does (in detail)

For each `.md` task file, **in order**:

1. **Read** the file from `~/.owlrun/instructions/`.
2. **Build a prompt** wrapping the file in an execution header + footer.
3. **Run Claude execution** (`claude --dangerously-skip-permissions --print`) in your frontend repo, `OWLRUN_PROMPT_RUNS` times (default 1). Claude does the real work — edits files, runs commands, etc.
4. **Move the file to `done/`** so the queue advances even if the reviews fail.
5. **Run Claude review** on the unstaged diff (`git diff`), with the frontend repo's `CLAUDE.md` injected as context.
6. **Run Codex review** on uncommitted changes (`git diff HEAD`).
7. Mark the task `DONE_SUCCESS`. If any of steps 2–6 fails non-retryably (or retries are exhausted), it's `DONE_FAILED`.

Rate-limit / overload / 429 / 503 responses from either CLI are detected automatically and trigger a sleep + retry up to `OWLRUN_MAX_RETRIES` times. If the CLI output contains a parseable hint (`retry-after: 42`, future unix timestamp, `try again in 5 minutes`, ISO reset timestamp), that drives the sleep duration; otherwise `OWLRUN_RETRY_INTERVAL` seconds (default 1800).

---

## Prerequisites

- **Linux** (Ubuntu/Debian tested) or **macOS** for the runtime
- `curl`, `tar`, `git`, `python3` (for the Bun installer fallback when `unzip` is missing)
- A target **frontend repo** containing a `CLAUDE.md` (used as review context)

The installer pulls in **Bun** (≥ 1.1) automatically. **Claude Code** and **Codex** CLIs are installed by `owlrun req` after the OwlRun install. Both must be authenticated separately — OwlRun does not manage credentials.

---

## Install

### Option A — release tarball (recommended)

```sh
tar -xzf owlrun-0.1.0.tar.gz
cd owlrun-0.1.0
./install.sh
```

Three install modes:

| Command | Where it goes | Wrapper | Auto-restart on reboot |
| --- | --- | --- | --- |
| `./install.sh` | `~/.local/share/owlrun` | `~/.local/bin/owlrun` | no (use `owlrun start`) |
| `sudo ./install.sh --system` | `/opt/owlrun` | `/usr/local/bin/owlrun` | no (use `owlrun start`) |
| `sudo ./install.sh --systemd` | `/opt/owlrun` | `/usr/local/bin/owlrun` | **yes** (managed by `systemd`) |

The installer is idempotent — re-running redeploys the source and refreshes deps. It will:

- install Bun into `~/.bun` if missing (handles `unzip`-missing via a Python fallback)
- run `bun install` and verify a clean build
- write the `owlrun` wrapper
- create `~/.owlrun/{instructions,frontend-target}` (the second is a placeholder git repo with a stub `CLAUDE.md` so `owlrun start` works out of the box)
- with `--systemd`, install and enable `/etc/systemd/system/owlrun.service` (runs as the invoking sudo user)

After install, ensure the bin dir is on your `PATH`:

```sh
# user install
export PATH="$HOME/.local/bin:$PATH"
# system install — already on PATH
```

### Option B — from source (development)

```sh
cd owlRun
bun install
bun link              # registers `owlrun` globally via Bun
bun run start         # or: owlrun start
```

Hot reload during dev:

```sh
bun run dev
```

### Uninstall

```sh
./install.sh --uninstall              # user install
sudo ./install.sh --uninstall         # if --system or --systemd was used
```

`--uninstall` probes both user and system locations and removes whatever it finds (wrapper, source tree, systemd unit). User data in `~/.owlrun/` is **kept**; remove it manually if you don't need it.

---

## First-time setup

### 1. Install required CLIs

```sh
owlrun req               # interactive — prompts before each install
owlrun req --yes         # non-interactive
owlrun req claude        # one specific tool
```

`req` installs:

- **Claude Code** via `curl -fsSL https://claude.ai/install.sh | bash` → `~/.local/bin/claude`
- **Codex** from GitHub Releases (auto-detects x86_64 / aarch64) → `~/.local/bin/codex`

### 2. Authenticate

```sh
claude                   # opens a browser-based login flow
# OR
claude setup-token       # long-lived token (subscription required)

codex login              # browser auth
```

Without auth, every task ends in `DONE_FAILED` with a clear error like *"Not logged in · Please run /login"*.

### 3. Point at your real frontend repo (optional)

By default OwlRun targets `~/.owlrun/frontend-target/` — a placeholder. Either replace that directory with your real repo, or set `OWLRUN_FRONTEND_DIR` to point elsewhere:

```sh
export OWLRUN_FRONTEND_DIR=/path/to/real/frontend
owlrun restart
```

For the `--systemd` install, edit `/etc/systemd/system/owlrun.service` and run `sudo systemctl daemon-reload && sudo systemctl restart owlrun`.

The frontend repo **must** contain `CLAUDE.md` at its root, `claude.md`, or `.claude/CLAUDE.md` — the review phase reads it as context and a missing file is a hard failure.

### 4. Verify

```sh
owlrun doctor
```

A green doctor looks like:

```
✓ bun 1.3.12
✓ git version 2.43.0
✓ claude 2.1.104 (Claude Code)
✓ codex codex-cli 0.120.0
✓ tmux
✓ project root, instructions, frontend repo, CLAUDE.md
✓ supervisor: systemd (or tmux)
✓ OwlRun is responding at http://127.0.0.1:8090
All checks passed.
```

---

## Running OwlRun

The CLI auto-detects whether you have a `systemd` install or not, and dispatches accordingly. You can override per-call with `--tmux` / `--systemd` or via `OWLRUN_SUPERVISOR=systemd|tmux`.

| Command | tmux mode | systemd mode |
| --- | --- | --- |
| `owlrun start` | `tmux new-session -d -s owlrun '… bun run src/index.ts …'` | `sudo systemctl start owlrun` |
| `owlrun stop` | `tmux kill-session -t owlrun` | `sudo systemctl stop owlrun` |
| `owlrun restart` | stop + start | `sudo systemctl restart owlrun` |
| `owlrun attach` | `tmux attach -t owlrun` | (refuses; points at `journalctl`) |

Both supervisors give you self-healing: `systemd` restarts the unit on crash (within `RestartSec=5`), and the in-process supervisor inside the Bun process restarts the worker or the HTTP server independently if either throws.

---

## CLI reference

```
owlrun <command> [options]

doctor                   Check bun/git/claude/codex/tmux + paths + supervisor + running instance
req [--yes] [tools]      Install missing requirements (claude, codex)
start [--tmux|--systemd] Start OwlRun (auto-detects supervisor; flags force one)
stop  [--tmux|--systemd]
restart [--tmux|--systemd]
status                   Worker state + colored task queue
health                   Full /api/health snapshot
logs [-f|-n N|--journal] Tail logs (-f follow, -n lines, --journal use journalctl)
open                     Print (and open in browser) the UI URL
attach                   tmux attach (tmux mode only; refuses under systemd)
version
help
```

All commands talk to `http://$OWLRUN_HOST:$OWLRUN_PORT` — defaults to `127.0.0.1:8090` for CLI lookups (the server itself binds to `0.0.0.0` by default).

---

## Web portal

Open `http://localhost:8090` (or whatever `OWLRUN_PORT` you configured).

- **Instructions** (`#/`) — full-width task list. Filename, status, current stage (for RUNNING tasks), retry count, last update.
- **`+ New instruction`** (`#/new`) — full-page Markdown editor. Save creates the file in `~/.owlrun/instructions/` and returns to the list.
- **Edit a task** (`#/edit/<filename>`) — full-page editor. WAITING tasks are editable; RUNNING tasks are read-only with live stage updates; DONE tasks are read-only with a "Reopen as waiting" button (requeue) and "Delete".
- **Configuration** (`#/config`) — health cards: Claude/Codex install + version, paths (instructions, done/, frontend), runner config (port, retries, prompt runs), live worker state.

The UI polls every 2 seconds and uses signature-based diffing to skip re-renders when nothing changed. Unsaved-edit guards prevent accidental navigation away from the editor.

---

## Configuration

All settings come from environment variables.

### Runtime (read by the OwlRun server/worker)

| Variable | Default | Meaning |
| --- | --- | --- |
| `OWLRUN_PORT` | `8090` | Web portal port |
| `OWLRUN_HOST` | `0.0.0.0` | Bind host |
| `OWLRUN_INSTRUCTIONS_DIR` | `~/.owlrun/instructions` | Where `.md` task files live (the `done/` subdir is created automatically) |
| `OWLRUN_FRONTEND_DIR` | `~/.owlrun/frontend-target` | Target repo for execution + reviews. Must contain `CLAUDE.md`. |
| `OWLRUN_MAX_RETRIES` | `20` | Max retries per CLI invocation when a retryable signal is detected |
| `OWLRUN_RETRY_INTERVAL` | `1800` | Default sleep between retries (seconds) when no explicit hint is in the CLI output |
| `OWLRUN_PROMPT_RUNS` | `1` | How many times to re-run the Claude execution prompt per task |
| `OWLRUN_POLL_INTERVAL_MS` | `2000` | Worker poll interval when the queue is empty |
| `OWLRUN_CLAUDE_BIN` | `claude` | Claude CLI binary name or path |
| `OWLRUN_CODEX_BIN` | `codex` | Codex CLI binary name or path |
| `OWLRUN_APP_NAME` | `OwlRun` | Display name |
| `OWLRUN_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `ANTHROPIC_BASE_URL` | *(unset)* | Forwarded to `claude` via env |

### CLI-only (read by the `owlrun` command)

| Variable | Default | Used by |
| --- | --- | --- |
| `OWLRUN_LOG_FILE` | `~/owlrun.log` | `owlrun logs` (file mode) and the tmux supervisor's `tee` target |
| `OWLRUN_TMUX_SESSION` | `owlrun` | tmux session name used by `start`/`stop`/`attach` |
| `OWLRUN_SUPERVISOR` | *(auto)* | `systemd` or `tmux` — overrides auto-detection |

### `owlrun start` propagates env

When you run `owlrun start` (tmux mode), every `OWLRUN_*` and `ANTHROPIC_BASE_URL` env var in your current shell is captured into the launched tmux session — so this works:

```sh
OWLRUN_FRONTEND_DIR=/srv/api OWLRUN_PORT=9000 owlrun start
```

For systemd, edit the unit file (`/etc/systemd/system/owlrun.service`) and `daemon-reload` + `restart`.

---

## Task lifecycle

A task has exactly one of four statuses:

- **WAITING** — new file, queued
- **RUNNING** — currently being processed (web edit is blocked)
- **DONE_SUCCESS** — full pipeline (exec + both reviews) completed
- **DONE_FAILED** — non-retryable error, or retries exhausted

Two important nuances:

1. **A task can be `DONE_FAILED` while its file is in `done/`.** Step 4 of the pipeline (move to `done/`) runs after a successful Claude execution, *before* the reviews. If a review fails, the file stays in `done/` but the status reflects the overall failure.
2. **Crash recovery is automatic.** State persists to `~/.owlrun/instructions/.owlrun-state.json`. On startup, `reconcile()` aligns state with the filesystem — stale RUNNING entries are reset (to WAITING if still in root, to DONE_FAILED if already in `done/`).

The next task picked is the **first WAITING file alphabetically** — deterministic codepoint order, so you can name files `001-foo.md`, `002-bar.md` for sequencing.

---

## HTTP API

All endpoints return JSON. POST/PUT bodies are JSON, capped at 10 MB.

| Method | Path | Body / Query | Description |
| --- | --- | --- | --- |
| GET | `/api/health` | — | Full snapshot: app, config, filesystem, tools, worker |
| GET | `/api/worker` | — | Worker state only |
| GET | `/api/logs?limit=N` | — | Recent in-memory log events |
| GET | `/api/instructions` | — | List all tasks (root + done/) |
| POST | `/api/instructions` | `{filename, content}` | Create. Filename is sanitized; collisions auto-suffix |
| GET | `/api/instructions/:name` | — | Task metadata + content |
| PUT | `/api/instructions/:name` | `{content}` | Update (WAITING only; 409 on RUNNING/DONE) |
| DELETE | `/api/instructions/:name` | — | Delete file + state |
| POST | `/api/instructions/:name/requeue` | — | Move from `done/` back to root as WAITING |

---

## Logs and observability

```sh
owlrun logs              # last 50 lines
owlrun logs -f           # follow
owlrun logs -n 200       # last 200
owlrun logs --journal    # via journalctl (auto if systemd unit is active)
owlrun status            # quick worker + queue summary
owlrun health            # full health
```

Under systemd, both the file (`~/owlrun.log`) and `journalctl -u owlrun` are populated. Use whichever you prefer.

---

## Where things live

After a `--systemd` install:

| Path | Purpose |
| --- | --- |
| `/opt/owlrun/` | OwlRun source + `node_modules` |
| `/usr/local/bin/owlrun` | CLI wrapper |
| `/etc/systemd/system/owlrun.service` | systemd unit (managed) |
| `~/.owlrun/instructions/` | Task queue |
| `~/.owlrun/instructions/done/` | Completed/failed task files |
| `~/.owlrun/instructions/.owlrun-state.json` | Persistent task state |
| `~/.owlrun/frontend-target/` | Default target repo (placeholder) |
| `~/owlrun.log` | App log (also goes to journal under systemd) |

After a default user install: replace `/opt/owlrun` with `~/.local/share/owlrun` and `/usr/local/bin/owlrun` with `~/.local/bin/owlrun`.

---

## Project layout

```
owlRun/
├── bin/
│   └── owlrun.ts            # the `owlrun` CLI (registered as a bun bin)
├── src/
│   ├── index.ts             # entry: signals + supervisors
│   ├── config.ts            # env → Config
│   ├── logger.ts            # structured log + in-memory tail
│   ├── shutdown.ts          # shared shutdown signal
│   ├── store.ts             # state.json, fs ops, sanitization, atomic claim
│   ├── cli.ts               # spawn + retry detection + retry-after parsing
│   ├── pipeline.ts          # exec prompt, reviews, status transitions
│   ├── worker.ts            # polling loop, sequential execution
│   └── server.ts            # HTTP API + static files
├── public/
│   ├── index.html           # SPA shell with hash routing
│   ├── styles.css
│   └── app.js               # vanilla JS, no framework
├── deploy/
│   ├── owlrun.service       # standalone systemd unit (templated by install.sh)
│   ├── remote-install.sh    # rsync-based deployer for an existing checkout
│   └── README.md            # deploy playbook
├── scripts/
│   └── build-release.sh     # builds dist/owlrun-<v>.tar.gz + sha256
├── install.sh               # portable installer
├── package.json
├── tsconfig.json
├── LICENSE                  # MIT
└── README.md
```

---

## Safety notes

- **Filenames are sanitized** before any filesystem operation: path separators stripped, leading dots removed, control chars dropped, whitespace replaced, the result must resolve inside `OWLRUN_INSTRUCTIONS_DIR`.
- **No shell**. CLI invocations use `Bun.spawn` directly with arrays — no shell injection surface for `claude`/`codex`/`git`.
- **Concurrent state writes are serialized** through a single mutate chain so a later write cannot overwrite changes it never saw.
- **Body size cap** of 10 MB on POST/PUT.
- **systemd hardening**: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` with explicit `ReadWritePaths` for the data dirs only, `PrivateTmp=true`.

---

## Troubleshooting

**`✗ claude — not found on $PATH`** — run `owlrun req` to install. If it's installed but not detected, set `OWLRUN_CLAUDE_BIN` to the absolute path.

**`Not logged in · Please run /login`** in task errors — Claude is installed but not authenticated. Run `claude` (browser flow) or `claude setup-token`.

**`CLAUDE.md not found in <frontendDir>`** — the review phase needs it. Either add a `CLAUDE.md` to the frontend repo or change `OWLRUN_FRONTEND_DIR`.

**Task stuck in `RUNNING` after a crash** — restart OwlRun. The store reconciles stale RUNNING entries on startup.

**`status=226/NAMESPACE` from systemd** — the `ReadWritePaths=` directives reference paths that don't exist. Re-run `sudo ./install.sh --systemd`; the installer pre-creates them.

**`sudo cannot prompt for a password from this shell`** — your shell is non-interactive (e.g. `ssh host 'owlrun stop'`). Run interactively, configure NOPASSWD for `systemctl owlrun`, or use the suggested fallback (`sudo systemctl …`).

**Rate-limit retry never fires** — check `owlrun logs` (or `/api/logs`) for the raw CLI output. The pattern list is in `src/cli.ts:RETRYABLE_PATTERNS` — extend it if your CLI returns a wording not yet matched.

**Port 8090 already in use** — change `OWLRUN_PORT`, or find/kill the conflicting process. If the conflict is an old OwlRun, use `owlrun stop`.

---

## Building a release

```sh
bun run release          # → dist/owlrun-<version>.tar.gz + .sha256
```

The tarball contains `bin/`, `src/`, `public/`, `deploy/`, `scripts/`, `install.sh`, `package.json`, `tsconfig.json`, `LICENSE`, `README.md` — everything `install.sh` needs. Top-level dir inside is `owlrun-<version>/` so `tar -xzf` lands in a clean folder.

---

## License

MIT — see [LICENSE](LICENSE).

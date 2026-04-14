<p align="center">
  <img src="public/owl-icon.png" width="120" alt="OwlClaw" />
</p>
<h1 align="center">OwlClaw</h1>
<p align="center"><em>A persistent, self-healing task runner for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> and <a href="https://github.com/openai/codex">Codex</a>. Queue Markdown instructions, owl runs them.</em></p>

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

You write tasks as plain Markdown. OwlClaw runs them — **strictly one at a time** — through the same loop you'd run by hand:

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
                          ~/.owl-claw/instructions/
                          ~/.owl-claw/frontend-target/   (your real repo)
```

---

## Quickstart

```sh
# 1. Install (Linux/macOS, no root needed)
tar -xzf owl-claw-0.1.0.tar.gz   # or: unzip owl-claw-0.1.0.zip
cd owl-claw-0.1.0
./install.sh
export PATH="$HOME/.local/bin:$PATH"   # if not already

# 2. Install + log in to Claude / Codex
owl-claw req --yes
claude          # browser-based first-time auth
codex login

# 3. Start it
owl-claw start
owl-claw open
```

That's it. Drop a `.md` file in `~/.owl-claw/instructions/` — or hit **+ New instruction** in the UI — and the worker picks it up within 2 seconds.

---

## Install

The installer is **idempotent**. Re-running redeploys the source and refreshes deps without nuking your data.

| Command | Where it lives | Wrapper | Survives reboot |
|---|---|---|---|
| `./install.sh` | `~/.local/share/owl-claw` | `~/.local/bin/owl-claw` | no — start it manually |
| `sudo ./install.sh --system` | `/opt/owl-claw` | `/usr/local/bin/owl-claw` | no — start it manually |
| `sudo ./install.sh --systemd` | `/opt/owl-claw` | `/usr/local/bin/owl-claw` | **yes** — `systemd` unit |

The installer:

▸ **installs Bun** into `~/.bun` if missing — handles the `unzip`-missing case via a Python fallback (because that's what most fresh Ubuntu boxes look like)<br>
▸ runs `bun install`, **verifies a clean build**<br>
▸ writes the `owl-claw` wrapper<br>
▸ creates `~/.owl-claw/{instructions,frontend-target}` with a stub git repo + `CLAUDE.md`, so `owl-claw start` works **out of the box**<br>
▸ with `--systemd`: installs an `enable`d unit, sandboxed (`ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`), `Restart=always`, runs as the invoking sudo user

### Got `unzip`-less Ubuntu/Debian?

Use the tarball, or extract with Python:

```sh
python3 -c "import zipfile; zipfile.ZipFile('owl-claw-0.1.0.zip').extractall()"
chmod +x owl-claw-0.1.0/install.sh
cd owl-claw-0.1.0 && ./install.sh
```

### Uninstall

```sh
owl-claw uninstall                  # interactive
owl-claw uninstall --yes            # no prompt
owl-claw uninstall --yes --purge    # nuke ~/.owl-claw and ~/owl-claw.log too
# or directly:
sudo ./install.sh --uninstall
```

Both probe **every** install location (user + system) and remove what they find — wrapper, source tree, systemd unit, port-bound process, lingering tmux session. Your data in `~/.owl-claw/` is preserved unless you pass `--purge`.

### From source (development)

```sh
cd owl-claw
bun install
bun link            # registers `owl-claw` in Bun's global bin dir
bun run dev         # hot-reload server
```

---

## First-time setup

### Install the CLIs

```sh
owl-claw req               # interactive, one-by-one
owl-claw req --yes         # install everything that's missing
owl-claw req claude        # specific tool
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

Both checked by `owl-claw doctor` — claude unauthed is an **error** (execution dies), codex unauthed is a **warning** (only the codex review phase breaks).

### Point at your real frontend repo

```sh
export OWLCLAW_FRONTEND_DIR=/path/to/real/frontend
owl-claw restart
```

The repo **must** contain `CLAUDE.md` (or `claude.md` / `.claude/CLAUDE.md`) — the review phase reads it as context, missing file = hard fail.

### Verify

```sh
$ owl-claw doctor
✓ bun 1.3.12
✓ git version 2.43.0
✓ claude 2.1.104 (Claude Code) (you@example.com, team)
✓ codex codex-cli 0.120.0 (ChatGPT)
✓ tmux
✓ project root, instructions, frontend repo, CLAUDE.md
✓ supervisor: systemd
✓ OwlClaw is responding at http://127.0.0.1:8090
All checks passed.
```

---

## Daily use

OwlClaw ships **two supervisors** — pick one and forget about it:

| | tmux mode | systemd mode |
|---|---|---|
| Auto-detect | when no unit installed | when `/etc/systemd/system/owl-claw.service` exists |
| `owl-claw start` | `tmux new-session -d -s owl-claw ...` | `sudo systemctl start owl-claw` |
| `owl-claw stop` | `tmux kill-session -t owl-claw` | `sudo systemctl stop owl-claw` |
| `owl-claw restart` | stop + start | `sudo systemctl restart owl-claw` |
| `owl-claw attach` | `tmux attach -t owl-claw` | refuses, points at `journalctl` |
| Survives reboot | no | **yes** |
| Self-heal on crash | yes (in-process supervisor) | **yes** (in-process **+** systemd `Restart=always`) |

Override the auto-detection per call with `--tmux` / `--systemd`, or set `OWLCLAW_SUPERVISOR=systemd|tmux`.

---

## CLI

```
owl-claw <command> [options]

doctor                         Check bun/git/claude/codex/tmux + paths + auth + supervisor + running instance
req [--yes] [tools]            Install missing requirements (claude, codex)
start [--tmux|--systemd]       Start OwlClaw (auto-detects supervisor; flags force one)
stop  [--tmux|--systemd]
restart [--tmux|--systemd]
status                         Worker state + colored task queue
health                         Full /api/health snapshot
logs [-f|-n N|--journal]       Tail logs (-f follow, -n lines, --journal use journalctl)
open                           Print (and open) the web UI URL
attach                         tmux attach (refuses under systemd)
uninstall [--yes|--purge]      Remove OwlClaw. --purge also wipes ~/.owl-claw.
version | help
```

All commands talk to `http://$OWLCLAW_HOST:$OWLCLAW_PORT` (default `127.0.0.1:8090` for CLI lookups; the server itself binds `0.0.0.0` by default).

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
| `OWLCLAW_PORT` | `8090` | Web portal port |
| `OWLCLAW_HOST` | `0.0.0.0` | Bind host |
| `OWLCLAW_INSTRUCTIONS_DIR` | `~/.owl-claw/instructions` | Where `.md` task files live (`done/` auto-created) |
| `OWLCLAW_FRONTEND_DIR` | `~/.owl-claw/frontend-target` | Target repo for execution + reviews. Must have `CLAUDE.md`. |
| `OWLCLAW_MAX_RETRIES` | `20` | Max retries per CLI invocation when a retryable signal is detected |
| `OWLCLAW_RETRY_INTERVAL` | `1800` | Default sleep between retries (seconds) when no explicit hint is in CLI output |
| `OWLCLAW_PROMPT_RUNS` | `1` | Times to re-run the Claude execution prompt per task |
| `OWLCLAW_POLL_INTERVAL_MS` | `2000` | Worker poll interval when idle |
| `OWLCLAW_CLAUDE_BIN` | `claude` | Claude CLI binary name or path |
| `OWLCLAW_CODEX_BIN` | `codex` | Codex CLI binary name or path |
| `OWLCLAW_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `ANTHROPIC_BASE_URL` | *(unset)* | Forwarded to `claude` via env |

### CLI-only

| Var | Default | Used by |
|---|---|---|
| `OWLCLAW_LOG_FILE` | `~/owl-claw.log` | `owl-claw logs` (file mode), tmux supervisor's `tee` target |
| `OWLCLAW_TMUX_SESSION` | `owl-claw` | tmux session name |
| `OWLCLAW_SUPERVISOR` | *(auto)* | `systemd` or `tmux` — overrides auto-detection |

### Env propagation

`owl-claw start` (tmux mode) captures every `OWLCLAW_*` and `ANTHROPIC_BASE_URL` from your current shell into the launched session — so this works:

```sh
OWLCLAW_FRONTEND_DIR=/srv/api OWLCLAW_PORT=9000 owl-claw start
```

For systemd, edit `/etc/systemd/system/owl-claw.service`, then `sudo systemctl daemon-reload && sudo systemctl restart owl-claw`.

---

## Task lifecycle

Four statuses, one source of truth (`~/.owl-claw/instructions/.owl-claw-state.json`, reconciled with the filesystem on every startup):

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
owl-claw logs              # last 50 lines from the file
owl-claw logs -f           # follow
owl-claw logs -n 200       # last 200
owl-claw logs --journal    # via journalctl (auto when systemd is active and the file is missing)
owl-claw status            # quick worker + queue summary
owl-claw health            # full health
```

Under systemd, output is **both** in `~/owl-claw.log` and `journalctl -u owl-claw` — pick whichever you prefer.

---

## Where things live

After `--systemd`:

| Path | Purpose |
|---|---|
| `/opt/owl-claw/` | OwlClaw source + `node_modules` |
| `/usr/local/bin/owl-claw` | CLI wrapper |
| `/etc/systemd/system/owl-claw.service` | systemd unit |
| `~/.owl-claw/instructions/` | Task queue |
| `~/.owl-claw/instructions/done/` | Completed/failed task files |
| `~/.owl-claw/instructions/.owl-claw-state.json` | Persistent task state |
| `~/.owl-claw/frontend-target/` | Default target repo (placeholder) |
| `~/owl-claw.log` | App log (also goes to journal) |

For a default user install, swap `/opt/owl-claw` → `~/.local/share/owl-claw` and `/usr/local/bin/owl-claw` → `~/.local/bin/owl-claw`. Everything else is the same.

---

## Project layout

```
owl-claw/
├── bin/owl-claw.ts         The owl-claw CLI (registered as a Bun bin)
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
├── scripts/              build-release.sh — produces dist/owl-claw-<v>.{tar.gz,zip}
├── install.sh            Portable installer (Linux/macOS)
├── package.json          Bun entry, bin registration, file allowlist
├── tsconfig.json
├── LICENSE               MIT
└── README.md             You are here
```

---

## Safety

▸ **Filenames sanitized** before any fs op: path separators stripped, leading dots removed, control chars dropped, whitespace replaced. Result must resolve inside `OWLCLAW_INSTRUCTIONS_DIR` (defense-in-depth path-traversal check).<br>
▸ **No shell** — CLIs invoked via `Bun.spawn` with arrays. No injection surface for `claude`/`codex`/`git`.<br>
▸ **Concurrent state writes serialized** through a single mutate chain. No lost updates.<br>
▸ **10 MB body cap** on POST/PUT.<br>
▸ **systemd hardening**: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` with explicit `ReadWritePaths`, `PrivateTmp=true`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `✗ claude — not found on $PATH` | `owl-claw req` to install. Or set `OWLCLAW_CLAUDE_BIN` to the absolute path. |
| `✗ claude … — not logged in` | `claude` (browser flow) or `claude setup-token`. |
| `Not logged in · Please run /login` in task errors | Same as above — claude isn't authed. |
| `CLAUDE.md not found in <frontendDir>` | Add a `CLAUDE.md` to your frontend repo, or change `OWLCLAW_FRONTEND_DIR`. |
| Task stuck in `RUNNING` after a crash | Restart OwlClaw. The store reconciles stale RUNNING entries on startup. |
| systemd `status=226/NAMESPACE` | Re-run `sudo ./install.sh --systemd`; the installer pre-creates the `ReadWritePaths`. |
| `sudo cannot prompt for a password from this shell` | Run interactively, configure NOPASSWD for `systemctl owl-claw`, or use the suggested `sudo systemctl …` fallback. |
| Rate-limit retry never fires | `owl-claw logs` — find the raw CLI output. Pattern list lives in `src/cli.ts:RETRYABLE_PATTERNS`; extend it. |
| Port 8090 in use | `owl-claw stop`, or `OWLCLAW_PORT=9000 owl-claw restart`. |
| Tarball/zip won't extract on a fresh box | Tarball needs `tar` (always present). Zip needs `unzip` (often missing on minimal Ubuntu) — use the Python fallback above. |

---

## Building a release

```sh
bun run release          # → dist/owl-claw-<version>.{tar.gz,zip} + .sha256
```

Both archives contain `bin/`, `src/`, `public/`, `deploy/`, `scripts/`, `install.sh`, `package.json`, `tsconfig.json`, `LICENSE`, `README.md`. Top-level dir inside is `owl-claw-<version>/` so they extract into a clean folder. The zip preserves unix file modes (`install.sh` stays executable on extract).

---

## FAQ

### How do I run Claude Code unattended for hours?

That's exactly what OwlClaw does. Drop your tasks as Markdown files in `~/.owl-claw/instructions/`, then `owl-claw start`. The worker polls every 2 seconds and runs them sequentially, retrying on rate limits / overload / 503 / `retry-after` hints up to `OWLCLAW_MAX_RETRIES` times (default 20). Pair it with `--systemd` so the unit comes back automatically after reboots and process crashes — a multi-hour run will survive an OOM, a kernel panic, or you killing the process by accident.

### How do I run Claude Code in the background?

`owl-claw start` detaches into a tmux session named `owl-claw` (or starts the systemd unit if installed). Both options keep the worker running after you log out. Inspect from anywhere with `owl-claw status`, `owl-claw logs -f`, or `owl-claw attach` (tmux mode). For a true server install, prefer `sudo ./install.sh --systemd` — that way Claude Code keeps running across reboots without you doing anything.

### Can I run multiple Claude Code agents in parallel?

OwlClaw is **deliberately sequential** inside a single instance — running multiple Claude Code workers against the same git repo at the same time corrupts state in subtle ways (overlapping diffs, lockfile races, conflicting commits). If you need parallelism, run **multiple OwlClaw instances** on different ports targeting different repos:

```sh
OWLCLAW_PORT=8090 OWLCLAW_INSTRUCTIONS_DIR=~/.owl-claw/api OWLCLAW_FRONTEND_DIR=~/code/api owl-claw start
OWLCLAW_PORT=8091 OWLCLAW_INSTRUCTIONS_DIR=~/.owl-claw/web OWLCLAW_FRONTEND_DIR=~/code/web owl-claw start
```

Or just put your tasks in order with numeric prefixes (`001-foo.md`, `002-bar.md`) and let one worker burn through them — usually faster than coordinating many.

### How does OwlClaw handle Claude Code rate limits?

Every CLI invocation is wrapped in a retry loop. If the output matches `rate limit`, `429`, `503`, `529`, `quota`, `overloaded`, or various timeout / connection patterns, OwlClaw parses the wait hint (`retry-after: N`, ISO reset timestamp, "try again in 5 minutes", future unix timestamp) and sleeps for that long — falling back to `OWLCLAW_RETRY_INTERVAL` (default 1800 s = 30 min) if no hint is present. After `OWLCLAW_MAX_RETRIES` attempts the task is marked `DONE_FAILED`. Pattern list lives in `src/cli.ts:RETRYABLE_PATTERNS` if you need to extend it.

### Can OwlClaw run Codex tasks too?

Yes — the pipeline runs **Claude Code execution** + **Claude Code review** + **Codex review** for every task. Codex is the second opinion on the diff. Both CLIs need to be installed (`owl-claw req`) and authenticated (`claude`, `codex login`). If you only have Claude installed, the Codex review step fails and the task is marked `DONE_FAILED` — there's no Codex-only mode today.

### How do I queue Claude Code tasks?

Two ways:

1. **Web UI** — open `http://localhost:8090`, click `+ New instruction`, write Markdown, save.
2. **API** — `curl -X POST http://localhost:8090/api/instructions -H 'content-type: application/json' -d '{"filename":"task-001.md","content":"# Refactor X to Y"}'`

The next WAITING task alphabetically is picked up within `OWLCLAW_POLL_INTERVAL_MS` (default 2 s).

### How is OwlClaw different from a CI/CD pipeline?

CI runs on push events, parallelizes across runners, and is meant for tests. OwlClaw runs an **interactive coding agent** sequentially against an **always-checked-out repo**, with retries tuned for AI-API quirks (rate limits, overloads, hour-long backoffs). Think of it as cron-meets-Claude rather than GitHub Actions: one machine, one repo, your queue of "things you want done".

### How do I know if my Claude Code or Codex CLI is authenticated?

```sh
owl-claw doctor
```

Doctor calls `claude auth status` and `codex login status` — both are local lookups, no API call, free. You'll see something like `✓ claude 2.1.104 (you@example.com, team)` when authed, or `✗ claude 2.1.104 — not logged in (run \`claude\` or \`claude setup-token\`)` when not.

### Can I see what Claude Code is doing right now?

```sh
owl-claw status              # one-line worker state + queue
owl-claw logs -f             # follow the live log
owl-claw health              # full snapshot
```

Or open the web UI — the task list shows a **stage** column that updates live for the RUNNING task (`claude-exec: run 1/1` → `moving-to-done` → `claude-review: collecting diff` → `codex-review`).

### Is OwlClaw affiliated with Anthropic or OpenAI?

No. OwlClaw is an independent open-source tool that integrates with the official Claude Code and Codex CLIs. See [Trademarks](#trademarks).

---

## Trademarks

"Anthropic", "Claude" and "Claude Code" are trademarks of Anthropic PBC. "OpenAI" and "Codex" are trademarks of OpenAI. OwlClaw is an independent project and is **not affiliated with, endorsed by, or sponsored by** Anthropic or OpenAI. Names are used here in their nominative sense to describe compatibility and integration.

---

## License

MIT — see [LICENSE](LICENSE).

# OwlRun — Remote deployment

This directory contains the artifacts needed to deploy OwlRun to a Linux server. The
initial deploy was a one-shot install to `batman@49.13.25.232`; this document captures
exactly what was done so the next deploy can be fully automated.

## Files

| File | Purpose |
| --- | --- |
| `remote-install.sh` | Idempotent installer + redeployer. Runs from a workstation with SSH access. |
| `owlrun.service`    | systemd unit for promoting the tmux-based install to a system service with auto-restart on reboot. Requires sudo on the target. |
| `README.md`         | This playbook. |

## What the initial deploy did

Target: `batman@49.13.25.232` (Ubuntu 24.04 LTS, x86_64, no passwordless sudo).

1. **Authorized my SSH key** — user added my public key to `~/.ssh/authorized_keys` on the target.
2. **Surveyed the box** — confirmed: git, curl, rsync, tmux, python3, systemctl present; bun, node, claude, codex absent; port 8090 free; no existing OwlRun install.
3. **Installed Bun** into `~/.bun` on the target. The official Bun installer (`curl -fsSL https://bun.sh/install | bash`) requires `unzip`, which was not installed and could not be apt-installed (no passwordless sudo). Worked around by downloading the release zip and extracting with `python3 -c 'import zipfile; …'`. `~/.bin` added to `PATH` via `~/.bashrc`.
4. **Rsynced the repo** to `~/owlRun/` on the target (excluded `node_modules`, `instructions/`, `bun.lockb`, `*.log`, `.DS_Store`).
5. **Ran `bun install`** on the target; verified `bun build src/index.ts` produces a clean 39 KB bundle.
6. **Created runtime paths:**
   - `~/owlrun-ins/` — the instructions directory (initially empty).
   - `~/frontend-target/` — a placeholder git repo with a stub `CLAUDE.md`. Replace with the real frontend repo when wiring OwlRun to an actual codebase.
7. **Started the app in a detached tmux session** named `owlrun`, logging combined stdout/stderr to `~/owlrun.log`, with `OWLRUN_HOST=0.0.0.0` and `OWLRUN_PORT=8090`.
8. **Smoke test** (end-to-end): posted a `smoketest.md` task via the API; worker picked it up within 2s; pipeline failed cleanly with `"Executable not found in $PATH: \"claude\""` and the task was marked `DONE_FAILED`. Deleted the task. The app kept running, worker returned to idle.
9. **Reachability check** — `curl http://49.13.25.232:8090/api/health` from the local Mac returned HTTP 200 in ~30 ms. Cloud firewall is already open on 8090.

## How to re-deploy (the automation-ready path)

From the workstation, with this repo checked out and SSH access to the target:

```sh
./deploy/remote-install.sh batman@49.13.25.232
```

The script is idempotent. Safe to re-run after code changes — it will rsync the diff, reinstall dependencies, and restart the tmux session. Tunable via environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OWLRUN_PORT` | `8090` | Remote HTTP port. |
| `OWLRUN_REMOTE_HOME` | `/home/$USER_FROM_TARGET` | Remote home directory (inferred from `user@host`). |

After a successful run the script prints:

```
>>> UI:      http://49.13.25.232:8090
>>> log:     ssh batman@49.13.25.232 'tail -f ~/owlrun.log'
>>> attach:  ssh -t batman@49.13.25.232 tmux attach -t owlrun
>>> stop:    ssh batman@49.13.25.232 tmux kill-session -t owlrun
```

## What still needs manual steps

These require either interactive input or sudo on the target and were intentionally left out of `remote-install.sh`:

### Install the Claude CLI

```sh
ssh batman@49.13.25.232 'curl -fsSL https://claude.ai/install.sh | bash'
# Then authenticate, interactively:
ssh -t batman@49.13.25.232 claude  # runs the first-time auth flow, or
ssh -t batman@49.13.25.232 'claude setup-token'
```

Until this is done, `/api/health` will report `claude.installed: false` and any task the worker picks up will fail with `Executable not found in $PATH: "claude"`.

### Install the Codex CLI

```sh
# The Codex CLI ships as a npm package; simplest on a node-less box is a direct
# binary download from https://github.com/openai/codex/releases.
# Or install Node first (via nvm, no sudo):
ssh batman@49.13.25.232 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash'
ssh batman@49.13.25.232 '. "$HOME/.nvm/nvm.sh" && nvm install --lts && npm i -g @openai/codex'
ssh -t batman@49.13.25.232 'codex login'
```

### Promote tmux to systemd (survives reboot, proper auto-restart)

On the target (requires sudo):

```sh
sudo cp ~/owlRun/deploy/owlrun.service /etc/systemd/system/owlrun.service
sudo systemctl daemon-reload
sudo systemctl enable --now owlrun
# Stop the tmux session so both aren't trying to bind to 8090 at once:
tmux kill-session -t owlrun 2>/dev/null || true
sudo systemctl status owlrun --no-pager
tail -f ~/owlrun.log
```

Rollback: `sudo systemctl disable --now owlrun` + restart the tmux session via `./deploy/remote-install.sh`.

### Point at the real frontend repo

The placeholder at `~/frontend-target` is only for the smoke test. When you have the real frontend repo on the box:

```sh
# Edit the env var in either the tmux start command or /etc/systemd/system/owlrun.service:
OWLRUN_FRONTEND_DIR=/path/to/real/frontend
# Then reload the unit or restart the tmux session.
```

The real frontend repo **must** contain a `CLAUDE.md` at its root (or at `.claude/CLAUDE.md`) — the review phase reads that as context and a missing file is a hard failure.

### TLS / reverse proxy

Currently the app is served as plain HTTP on `:8090`. If you need TLS or to expose it under a path on a domain, terminate with nginx/caddy in front of it. Example with Caddy (on the target, as root):

```sh
sudo apt-get install -y caddy
sudo tee /etc/caddy/Caddyfile <<'EOF'
owlrun.example.com {
  reverse_proxy 127.0.0.1:8090
}
EOF
sudo systemctl reload caddy
```

And bind OwlRun to loopback only:

```
OWLRUN_HOST=127.0.0.1
```

## Current server state (as deployed)

- OwlRun 0.1.0 running under `tmux` session `owlrun` on `batman@49.13.25.232:8090`, exposed to the internet.
- Instructions directory: `/home/batman/owlrun-ins/` (empty).
- Frontend directory: `/home/batman/frontend-target/` (placeholder repo, stub CLAUDE.md).
- Claude / Codex CLIs: **not installed** — the worker can service the queue as far as marking tasks `DONE_FAILED` when asked to run them, and the portal + API are fully functional.
- Log: `/home/batman/owlrun.log`.

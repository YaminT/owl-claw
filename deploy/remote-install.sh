#!/usr/bin/env bash
# OwlRun remote install / redeploy script.
#
# Usage (from a workstation that has this repo checked out and SSH access):
#   ./deploy/remote-install.sh [user@host]
#
# Defaults to the dev server batman@49.13.25.232. Idempotent: safe to re-run.
# Assumes: Debian/Ubuntu target, SSH key auth, rsync on both sides.
#
# What it does:
#   1. Installs Bun into ~/.bun on the remote (no sudo required).
#   2. Rsyncs this repo to ~/owlRun on the remote (excludes node_modules and local state).
#   3. Runs `bun install` there.
#   4. Creates ~/owlrun-ins and a placeholder git repo at ~/frontend-target (with CLAUDE.md).
#   5. Starts OwlRun in a detached tmux session named `owlrun`, logging to ~/owlrun.log.
#
# Tmux is the transient supervisor. For a persistent auto-restart install, see
# deploy/owlrun.service and the "promote to systemd" section of deploy/README.md.

set -euo pipefail

TARGET="${1:-batman@49.13.25.232}"
REMOTE_HOME_DEFAULT="/home/$(echo "$TARGET" | cut -d@ -f1)"
REMOTE_HOME="${OWLRUN_REMOTE_HOME:-$REMOTE_HOME_DEFAULT}"
REPO_DST="$REMOTE_HOME/owlRun"
INS_DIR="$REMOTE_HOME/owlrun-ins"
FRONTEND_DIR="$REMOTE_HOME/frontend-target"
PORT="${OWLRUN_PORT:-8090}"

echo ">>> deploying to $TARGET"
echo ">>> repo -> $REPO_DST"
echo ">>> instructions -> $INS_DIR"
echo ">>> frontend -> $FRONTEND_DIR"
echo ">>> port -> $PORT"

# 1. Bun — install if missing. The official installer needs `unzip`; if it's
#    missing we fall back to a manual download + python3 extraction.
ssh "$TARGET" bash -s <<'REMOTE_BUN'
set -euo pipefail
if [ -x "$HOME/.bun/bin/bun" ]; then
  echo "bun already installed: $($HOME/.bun/bin/bun --version)"
  exit 0
fi
mkdir -p "$HOME/.bun/bin"
if command -v unzip >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
else
  echo "unzip missing -- falling back to python3 extraction"
  command -v python3 >/dev/null || { echo "python3 required"; exit 1; }
  cd /tmp
  curl -fsSL -o bun.zip https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip
  python3 -c "import zipfile; zipfile.ZipFile('bun.zip').extractall()"
  mv bun-linux-x64/bun "$HOME/.bun/bin/bun"
  chmod +x "$HOME/.bun/bin/bun"
  rm -rf bun.zip bun-linux-x64
fi
grep -q "BUN_INSTALL" "$HOME/.bashrc" 2>/dev/null || {
  echo >> "$HOME/.bashrc"
  echo 'export BUN_INSTALL="$HOME/.bun"' >> "$HOME/.bashrc"
  echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> "$HOME/.bashrc"
}
echo "bun installed: $($HOME/.bun/bin/bun --version)"
REMOTE_BUN

# 2. Rsync the code. Exclude transient + locally-specific state.
echo ">>> syncing code"
rsync -az \
  --exclude 'node_modules' \
  --exclude 'instructions/' \
  --exclude 'bun.lockb' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  "$(dirname "$0")/.."/ "$TARGET:$REPO_DST/"

# 3. bun install + build sanity check
ssh "$TARGET" bash -s -- "$REPO_DST" <<'REMOTE_INSTALL'
set -euo pipefail
REPO="$1"
cd "$REPO"
"$HOME/.bun/bin/bun" install
"$HOME/.bun/bin/bun" build src/index.ts --target=bun --outfile=/tmp/owlrun-build-check.js >/dev/null
rm -f /tmp/owlrun-build-check.js
echo "bun install + build OK"
REMOTE_INSTALL

# 4. Placeholder paths
ssh "$TARGET" bash -s -- "$INS_DIR" "$FRONTEND_DIR" <<'REMOTE_DIRS'
set -euo pipefail
INS_DIR="$1"
FRONTEND_DIR="$2"
mkdir -p "$INS_DIR"
mkdir -p "$FRONTEND_DIR"
cd "$FRONTEND_DIR"
if [ ! -d .git ]; then
  git init -q
  git -c user.email=batman@local -c user.name=batman commit -q --allow-empty -m "init"
fi
if [ ! -f CLAUDE.md ]; then
  cat > CLAUDE.md <<'MD'
# Frontend target (placeholder)

Replace with the real frontend repo path when wiring OwlRun to an actual codebase.

## Conventions
- Describe real conventions here once a real repo is wired in.
MD
fi
REMOTE_DIRS

# 5. Start (or restart) the tmux session
ssh "$TARGET" bash -s -- "$REPO_DST" "$INS_DIR" "$FRONTEND_DIR" "$PORT" <<'REMOTE_START'
set -euo pipefail
REPO="$1"; INS="$2"; FE="$3"; PORT="$4"
tmux kill-session -t owlrun 2>/dev/null || true
tmux new-session -d -s owlrun "cd $REPO && \
  OWLRUN_INSTRUCTIONS_DIR=$INS \
  OWLRUN_FRONTEND_DIR=$FE \
  OWLRUN_PORT=$PORT \
  OWLRUN_HOST=0.0.0.0 \
  $HOME/.bun/bin/bun run src/index.ts 2>&1 | tee $HOME/owlrun.log"
sleep 2
ss -tlnp 2>/dev/null | grep -E ":$PORT\b" || { echo "!! port $PORT not listening"; tail -30 $HOME/owlrun.log; exit 1; }
echo "owlrun is up on port $PORT"
REMOTE_START

echo ">>> done"
echo ">>> UI:        http://${TARGET#*@}:$PORT"
echo ">>> log:       ssh $TARGET 'tail -f ~/owlrun.log'"
echo ">>> attach:    ssh -t $TARGET tmux attach -t owlrun"
echo ">>> stop:      ssh $TARGET tmux kill-session -t owlrun"

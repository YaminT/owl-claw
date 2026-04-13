#!/usr/bin/env bash
# OwlRun installer for Linux (and macOS as a courtesy).
#
# Usage:
#   ./install.sh                     # install to ~/.local/share/owlrun with wrapper at ~/.local/bin/owlrun
#   ./install.sh --system            # install to /opt/owlrun with wrapper at /usr/local/bin/owlrun (needs root)
#   ./install.sh --prefix DIR        # custom install prefix
#   ./install.sh --bin-dir DIR       # custom wrapper location
#   ./install.sh --systemd           # also install a system-wide systemd unit (implies --system)
#   ./install.sh --no-bun            # skip installing Bun even if missing (you're on your own)
#   ./install.sh --uninstall         # remove everything this installer wrote
#   ./install.sh --help
#
# Environment overrides:
#   OWLRUN_PREFIX, OWLRUN_BIN_DIR    same as --prefix / --bin-dir
#
# Idempotent: safe to re-run. Installing an already-installed OwlRun redeploys
# the code and preserves user data in ~/.owlrun/.

set -euo pipefail

H_DIM=$'\033[2m'; H_RST=$'\033[0m'
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '\033[2m%s\033[0m\n' "$*"; }
head() { printf '\033[1m%s\033[0m\n' "$*"; }

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

# --- arg parsing ---------------------------------------------------------
MODE="user"
INSTALL_SYSTEMD=0
SKIP_BUN=0
UNINSTALL=0
EXPLICIT_PREFIX=""
EXPLICIT_BIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --system)     MODE="system" ;;
    --systemd)    INSTALL_SYSTEMD=1; MODE="system" ;;
    --prefix)     EXPLICIT_PREFIX="$2"; shift ;;
    --bin-dir)    EXPLICIT_BIN="$2"; shift ;;
    --no-bun)     SKIP_BUN=1 ;;
    --uninstall)  UNINSTALL=1 ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "unknown arg: $1" ;;
  esac
  shift
done

if [ "$MODE" = "system" ] && [ "$(id -u)" -ne 0 ]; then
  die "--system install requires root (re-run with sudo)"
fi

# --- defaults ------------------------------------------------------------
if [ "$MODE" = "system" ]; then
  PREFIX="${EXPLICIT_PREFIX:-${OWLRUN_PREFIX:-/opt/owlrun}}"
  BIN_DIR="${EXPLICIT_BIN:-${OWLRUN_BIN_DIR:-/usr/local/bin}}"
else
  PREFIX="${EXPLICIT_PREFIX:-${OWLRUN_PREFIX:-$HOME/.local/share/owlrun}}"
  BIN_DIR="${EXPLICIT_BIN:-${OWLRUN_BIN_DIR:-$HOME/.local/bin}}"
fi
WRAPPER="$BIN_DIR/owlrun"

# --- uninstall path ------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  head "Uninstalling OwlRun"

  # Stop any running instance first. If we leave a bun process alive while
  # removing the source tree, it keeps the port bound (and its now-orphaned
  # source loaded in memory) until it eventually crashes or is killed.
  if command -v tmux >/dev/null 2>&1 && tmux has-session -t owlrun 2>/dev/null; then
    tmux kill-session -t owlrun 2>/dev/null && ok "stopped tmux session owlrun" || true
  fi
  # Belt-and-suspenders: kill anything still bound to the OwlRun port.
  if command -v fuser >/dev/null 2>&1; then
    if fuser -k "${OWLRUN_PORT:-8090}/tcp" 2>/dev/null; then
      ok "freed port ${OWLRUN_PORT:-8090}"
    fi
  fi

  if [ -f /etc/systemd/system/owlrun.service ] && command -v systemctl >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
      systemctl disable --now owlrun 2>/dev/null || true
      rm -f /etc/systemd/system/owlrun.service
      systemctl daemon-reload || true
      ok "removed systemd unit"
    else
      warn "systemd unit exists at /etc/systemd/system/owlrun.service — re-run with sudo to remove it"
    fi
  fi
  if [ -e "/usr/local/bin/owlrun" ]; then
    if [ "$(id -u)" -eq 0 ]; then rm -f /usr/local/bin/owlrun; ok "removed /usr/local/bin/owlrun";
    else warn "/usr/local/bin/owlrun exists — re-run with sudo to remove it"; fi
  fi
  if [ -d "/opt/owlrun" ]; then
    if [ "$(id -u)" -eq 0 ]; then rm -rf /opt/owlrun; ok "removed /opt/owlrun";
    else warn "/opt/owlrun exists — re-run with sudo to remove it"; fi
  fi
  if [ -e "$HOME/.local/bin/owlrun" ]; then rm -f "$HOME/.local/bin/owlrun"; ok "removed $HOME/.local/bin/owlrun"; fi
  if [ -d "$HOME/.local/share/owlrun" ]; then rm -rf "$HOME/.local/share/owlrun"; ok "removed $HOME/.local/share/owlrun"; fi

  info "Note: user data in ~/.owlrun/ is kept. Remove it manually if you don't need it anymore."
  exit 0
fi

# --- locate source -------------------------------------------------------
# If invoked from inside an OwlRun checkout, install from there. Otherwise
# we expect OWLRUN_TARBALL to point at a .tar.gz containing the source.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/package.json" ] && grep -q '"name": "owlrun"' "$SCRIPT_DIR/package.json"; then
  SRC_MODE="local"
  SRC_DIR="$SCRIPT_DIR"
elif [ -n "${OWLRUN_TARBALL:-}" ]; then
  SRC_MODE="tarball"
  SRC_DIR=""
else
  die "run ./install.sh from inside the owlRun checkout, or set OWLRUN_TARBALL=<path-or-url>"
fi

# --- preflight -----------------------------------------------------------
head "OwlRun installer"
info "mode         $MODE"
info "prefix       $PREFIX"
info "bin-dir      $BIN_DIR"
info "source       $SRC_MODE${SRC_DIR:+ ($SRC_DIR)}"
info "systemd unit $([ "$INSTALL_SYSTEMD" -eq 1 ] && echo yes || echo no)"
echo

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar  >/dev/null 2>&1 || die "tar is required"
command -v git  >/dev/null 2>&1 || warn "git is missing; the pipeline needs it for the review phases"

# --- Bun -----------------------------------------------------------------
install_bun() {
  if command -v bun >/dev/null 2>&1; then
    ok "bun already installed: $(bun --version)"
    return
  fi
  # Non-interactive SSH sessions don't source ~/.bashrc, so bun may be on disk
  # but not on $PATH. Re-export before concluding that it's missing.
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
    ok "bun already installed: $($HOME/.bun/bin/bun --version) ${H_DIM}(at $HOME/.bun/bin, not previously on \$PATH)${H_RST}"
    return
  fi
  # For --system installs run under sudo, prefer the invoking user's bun
  # so that the service user can actually exec it (root's $HOME is usually 700).
  if [ "$MODE" = "system" ] && [ -n "${SUDO_USER:-}" ]; then
    local sudo_home
    sudo_home="$(getent passwd "$SUDO_USER" | cut -d: -f6 || true)"
    if [ -n "$sudo_home" ] && [ -x "$sudo_home/.bun/bin/bun" ]; then
      export PATH="$sudo_home/.bun/bin:$PATH"
      ok "bun already installed: $("$sudo_home/.bun/bin/bun" --version) ${H_DIM}(at $sudo_home/.bun/bin)${H_RST}"
      return
    fi
  fi
  if [ "$SKIP_BUN" -eq 1 ]; then
    warn "bun is missing and --no-bun was passed; install Bun manually before running owlrun"
    return
  fi
  head "Installing Bun"
  if command -v unzip >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
  else
    warn "unzip not installed; using python3 extraction fallback"
    command -v python3 >/dev/null 2>&1 || die "python3 needed when unzip is missing"
    local arch tmp asset_arch
    arch="$(uname -m)"
    case "$arch" in
      x86_64|amd64) asset_arch="x64" ;;
      aarch64|arm64) asset_arch="aarch64" ;;
      *) die "unsupported arch: $arch" ;;
    esac
    tmp="$(mktemp -d)"
    ( cd "$tmp"
      curl -fsSL -o bun.zip "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-$asset_arch.zip"
      python3 -c "import zipfile; zipfile.ZipFile('bun.zip').extractall()"
    )
    mkdir -p "$HOME/.bun/bin"
    cp "$tmp/bun-linux-$asset_arch/bun" "$HOME/.bun/bin/bun"
    chmod +x "$HOME/.bun/bin/bun"
    rm -rf "$tmp"
    grep -q "BUN_INSTALL" "$HOME/.bashrc" 2>/dev/null || {
      echo >> "$HOME/.bashrc"
      echo 'export BUN_INSTALL="$HOME/.bun"' >> "$HOME/.bashrc"
      echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> "$HOME/.bashrc"
    }
  fi
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "bun installed but still not on PATH"
  ok "bun installed: $(bun --version)"
}
install_bun

# Resolve the bun binary we'll hard-code into the wrapper.
# For --system installs, we need a bun that the *service user* can exec —
# /root/.bun/* is typically 700 so prefer a location that's accessible.
if [ "$MODE" = "system" ]; then
  SERVICE_USER_CANDIDATE="${OWLRUN_SERVICE_USER:-${SUDO_USER:-root}}"
  SERVICE_HOME_CANDIDATE="$(getent passwd "$SERVICE_USER_CANDIDATE" | cut -d: -f6 || true)"
  if [ -n "$SERVICE_HOME_CANDIDATE" ] && [ -x "$SERVICE_HOME_CANDIDATE/.bun/bin/bun" ]; then
    BUN_BIN="$SERVICE_HOME_CANDIDATE/.bun/bin/bun"
  else
    # Fallback: stage bun to /usr/local/bin/bun so every user can exec it.
    if [ ! -x /usr/local/bin/bun ] && [ -x "$(command -v bun)" ]; then
      install -m 0755 "$(command -v bun)" /usr/local/bin/bun
      ok "copied bun to /usr/local/bin/bun (accessible to all users)"
    fi
    BUN_BIN="/usr/local/bin/bun"
  fi
else
  BUN_BIN="$(command -v bun)"
fi
ok "using bun at $BUN_BIN"

# --- sync source ---------------------------------------------------------
head "Installing OwlRun to $PREFIX"
mkdir -p "$PREFIX"

if [ "$SRC_MODE" = "local" ]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude 'node_modules' --exclude 'instructions/' --exclude 'bun.lockb' \
      --exclude '.git' --exclude '.DS_Store' --exclude '*.log' --exclude 'dist' \
      "$SRC_DIR/" "$PREFIX/"
  else
    # Portable fallback without rsync: tar pipe
    ( cd "$SRC_DIR" && tar --exclude='./node_modules' --exclude='./instructions' \
        --exclude='./bun.lockb' --exclude='./.git' --exclude='./.DS_Store' \
        --exclude='./dist' -cf - . ) | ( cd "$PREFIX" && tar -xf - )
  fi
else
  tmp="$(mktemp -d)"
  if [[ "${OWLRUN_TARBALL}" == http*://* ]]; then
    curl -fsSL -o "$tmp/src.tar.gz" "$OWLRUN_TARBALL"
  else
    cp "$OWLRUN_TARBALL" "$tmp/src.tar.gz"
  fi
  tar -xzf "$tmp/src.tar.gz" -C "$PREFIX" --strip-components=1
  rm -rf "$tmp"
fi

# --- bun install ---------------------------------------------------------
head "Installing dependencies"
( cd "$PREFIX" && "$BUN_BIN" install )
( cd "$PREFIX" && "$BUN_BIN" build src/index.ts --target=bun --outfile=/tmp/owlrun-build-check.js >/dev/null && rm -f /tmp/owlrun-build-check.js )
ok "build check passed"

# --- wrapper -------------------------------------------------------------
head "Installing wrapper"
mkdir -p "$BIN_DIR"
cat > "$WRAPPER" <<WRAPPER_EOF
#!/usr/bin/env bash
# OwlRun CLI wrapper -- generated by install.sh
export OWLRUN_HOME_INSTALL="$PREFIX"
exec "$BUN_BIN" run "$PREFIX/bin/owlrun.ts" "\$@"
WRAPPER_EOF
chmod +x "$WRAPPER"
ok "wrote $WRAPPER"

# --- user data dir -------------------------------------------------------
if [ "$MODE" = "system" ]; then
  info '~/.owlrun/ will be created per-user on first `owlrun start`'
else
  mkdir -p "$HOME/.owlrun/instructions"
  if [ ! -d "$HOME/.owlrun/frontend-target" ]; then
    mkdir -p "$HOME/.owlrun/frontend-target"
    ( cd "$HOME/.owlrun/frontend-target"
      git init -q
      git -c user.email="$USER@local" -c user.name="$USER" commit -q --allow-empty -m init
      cat > CLAUDE.md <<'MD'
# Frontend target (placeholder)

Replace this directory with the real frontend repo, or set OWLRUN_FRONTEND_DIR
to point elsewhere.

## Conventions
- (describe the project conventions here so the review phase has context)
MD
    )
  fi
  ok "prepared $HOME/.owlrun/{instructions,frontend-target}"
fi

# --- systemd unit --------------------------------------------------------
if [ "$INSTALL_SYSTEMD" -eq 1 ]; then
  head "Installing systemd unit"
  [ "$(id -u)" -eq 0 ] || die "--systemd requires root"
  # If a specific user is targeted, accept OWLRUN_SERVICE_USER; default to the
  # user who invoked sudo, falling back to root.
  SERVICE_USER="${OWLRUN_SERVICE_USER:-${SUDO_USER:-root}}"
  SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
  # Pre-create the data dirs and log file that ReadWritePaths references.
  # Without these, the mount namespace setup fails with status=226/NAMESPACE.
  sudo -u "$SERVICE_USER" -H mkdir -p "$SERVICE_HOME/.owlrun/instructions"
  if [ ! -d "$SERVICE_HOME/.owlrun/frontend-target" ]; then
    sudo -u "$SERVICE_USER" -H mkdir -p "$SERVICE_HOME/.owlrun/frontend-target"
    sudo -u "$SERVICE_USER" -H bash -c "
      cd '$SERVICE_HOME/.owlrun/frontend-target'
      git init -q
      git -c user.email='$SERVICE_USER@local' -c user.name='$SERVICE_USER' commit -q --allow-empty -m init
      cat > CLAUDE.md <<'MD'
# Frontend target (placeholder)

Replace this directory with the real frontend repo, or set OWLRUN_FRONTEND_DIR
to point elsewhere.

## Conventions
- (describe the project conventions here so the review phase has context)
MD
    "
  fi
  # Ensure the log file exists and is writable by the service user.
  # If a stale root-owned log exists from a previous attempt, fix the perms.
  touch "$SERVICE_HOME/owlrun.log"
  chown "$SERVICE_USER:" "$SERVICE_HOME/owlrun.log"
  chown -R "$SERVICE_USER:" "$SERVICE_HOME/.owlrun"
  ok "prepared $SERVICE_HOME/{.owlrun,owlrun.log} for systemd"
  UNIT_PATH="/etc/systemd/system/owlrun.service"
  cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=OwlRun — Claude/Codex instruction runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PREFIX
Environment=HOME=$SERVICE_HOME
Environment=PATH=$SERVICE_HOME/.bun/bin:$SERVICE_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin
Environment=OWLRUN_PORT=8090
Environment=OWLRUN_HOST=0.0.0.0
Environment=OWLRUN_INSTRUCTIONS_DIR=$SERVICE_HOME/.owlrun/instructions
Environment=OWLRUN_FRONTEND_DIR=$SERVICE_HOME/.owlrun/frontend-target
ExecStart=$BUN_BIN run src/index.ts
Restart=always
RestartSec=5
StandardOutput=append:$SERVICE_HOME/owlrun.log
StandardError=append:$SERVICE_HOME/owlrun.log
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$SERVICE_HOME/.owlrun $SERVICE_HOME/owlrun.log
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable owlrun >/dev/null
  ok "installed systemd unit at $UNIT_PATH (user: $SERVICE_USER)"
  info "start with:  sudo systemctl start owlrun"
  info "logs:        journalctl -u owlrun -f"
fi

# --- done ----------------------------------------------------------------
echo
head "✓ OwlRun installed"
info "wrapper:      $WRAPPER"
info "sources:      $PREFIX"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) warn "$BIN_DIR is not on your \$PATH — add:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo
info "Next steps:"
info "  owlrun doctor        # check what's left to install/configure"
info "  owlrun req           # install claude / codex CLIs (interactive)"
info "  owlrun start         # start OwlRun in a tmux session"
info "  owlrun open          # print the web UI URL"

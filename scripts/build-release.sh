#!/usr/bin/env bash
# Build a portable OwlClaw release tarball.
#
# Usage:
#   ./scripts/build-release.sh              # produces dist/owl-claw-<version>.tar.gz
#   OUT_DIR=/tmp ./scripts/build-release.sh # override output dir
#
# The tarball unpacks into a single top-level directory `owl-claw-<version>/`
# that already contains install.sh, so:
#
#   curl -fsSL <url>/owl-claw-0.1.0.tar.gz | tar xz
#   cd owl-claw-0.1.0
#   ./install.sh

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(grep -m1 '"version"' package.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
[ -n "$VERSION" ] || { echo "could not read version from package.json" >&2; exit 1; }

OUT_DIR="${OUT_DIR:-$ROOT/dist}"
NAME="owl-claw-$VERSION"
TAR_PATH="$OUT_DIR/$NAME.tar.gz"
mkdir -p "$OUT_DIR"

echo ">>> typecheck"
bunx tsc --noEmit

echo ">>> build sanity"
bun build src/index.ts --target=bun --outfile=/tmp/owl-claw-release-build.js >/dev/null
rm -f /tmp/owl-claw-release-build.js

echo ">>> staging"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
DST="$STAGE/$NAME"
mkdir -p "$DST"

# List of files/dirs to include. Keeps the tarball small and predictable.
for p in bin src public deploy scripts install.sh package.json tsconfig.json README.md LICENSE; do
  if [ -e "$p" ]; then
    cp -R "$p" "$DST/"
  fi
done

echo ">>> packaging tarball"
# COPYFILE_DISABLE avoids macOS AppleDouble "._*" metadata inside the archive,
# which otherwise confuses GNU tar on Linux.
( cd "$STAGE" && COPYFILE_DISABLE=1 tar --owner=0 --group=0 --numeric-owner -czf "$TAR_PATH" "$NAME" )
TAR_SHA="$(shasum -a 256 "$TAR_PATH" | cut -d' ' -f1)"
echo "$TAR_SHA  $NAME.tar.gz" > "$OUT_DIR/$NAME.tar.gz.sha256"

echo ">>> packaging zip"
ZIP_PATH="$OUT_DIR/$NAME.zip"
rm -f "$ZIP_PATH"
# zip -r preserves unix file modes by default. -X strips extra attributes
# (uid/gid, system-specific) so the archive is reproducible across machines.
( cd "$STAGE" && COPYFILE_DISABLE=1 zip -r -X -q "$ZIP_PATH" "$NAME" )
ZIP_SHA="$(shasum -a 256 "$ZIP_PATH" | cut -d' ' -f1)"
echo "$ZIP_SHA  $NAME.zip" > "$OUT_DIR/$NAME.zip.sha256"

echo
echo "✓ $TAR_PATH"
echo "  sha256: $TAR_SHA"
echo "  size:   $(du -h "$TAR_PATH" | cut -f1)"
echo
echo "✓ $ZIP_PATH"
echo "  sha256: $ZIP_SHA"
echo "  size:   $(du -h "$ZIP_PATH" | cut -f1)"
echo
echo "Inspect: tar -tzf $TAR_PATH | head"
echo "         unzip -l $ZIP_PATH | head"

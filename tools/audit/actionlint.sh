#!/usr/bin/env bash
# actionlint.sh: run the pinned actionlint over a repository's workflows.
#
# usage: tools/audit/actionlint.sh [<repository root>]   (default: the git top level)
# Fetches actionlint's release archive for this host once, checks it against the archive sha256
# pinned below (the release's checksums file and GitHub's asset digest agree on each), extracts
# only the binary, checks the binary's pinned sha256 and caches it under $T3CP_TOOLS_CACHE
# (default ${XDG_CACHE_HOME:-$HOME/.cache}/t3cp-tools). A cached binary is checked again on every
# run and replaced when it is not the pinned build. The shellcheck and pyflakes integrations are
# off, so CI and a laptop give the same result. Exit 0 clean, 2 findings, 1 error (fail closed).
set -euo pipefail

VERSION=1.7.12
die() { echo "actionlint.sh: ERROR: $*" >&2; exit 1; }
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)
    PLATFORM=darwin_arm64
    ARCHIVE_SHA256=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f
    BINARY_SHA256=8db11704dc296f096216db4db65d86cd7f0ebfdf4c38453a1da276b137b88388 ;;
  Darwin/x86_64)
    PLATFORM=darwin_amd64
    ARCHIVE_SHA256=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644
    BINARY_SHA256=d1f7cee75ae2873609bd9567b4600bebc5315a5e733e73202987a44fafdd53b2 ;;
  Linux/x86_64)
    PLATFORM=linux_amd64
    ARCHIVE_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
    BINARY_SHA256=c872d6db8c6bf83a8eaa704fc93999f027d55dffbc63b8a6abdccb47df5f4cd4 ;;
  Linux/aarch64|Linux/arm64)
    PLATFORM=linux_arm64
    ARCHIVE_SHA256=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6
    BINARY_SHA256=ac0323433c2853ec3fb978c611430c5b3dc5d43c58d1a1ec031b00ab572beb60 ;;
  *) die "no pinned actionlint build for $(uname -s)/$(uname -m)" ;;
esac

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

ROOT=${1:-$(git rev-parse --show-toplevel)}
[ -d "$ROOT" ] || die "$ROOT is not a directory"
CACHE=${T3CP_TOOLS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/t3cp-tools}
BIN="$CACHE/actionlint-$VERSION/actionlint"

if ! [ -f "$BIN" ] || [ "$(sha256 "$BIN")" != "$BINARY_SHA256" ]; then
  command -v curl >/dev/null 2>&1 || die "curl not found"
  NAME="actionlint_${VERSION}_${PLATFORM}.tar.gz"
  DOWNLOAD=$(mktemp -d "${TMPDIR:-/tmp}/t3cp-actionlint-download.XXXXXX")
  trap 'rm -rf "$DOWNLOAD"' EXIT
  curl -fsSL --proto '=https' --tlsv1.2 -o "$DOWNLOAD/$NAME" \
    "https://github.com/rhysd/actionlint/releases/download/v$VERSION/$NAME" || die "cannot download $NAME"
  [ "$(sha256 "$DOWNLOAD/$NAME")" = "$ARCHIVE_SHA256" ] || die "$NAME does not match its pinned sha256"
  mkdir "$DOWNLOAD/extract"
  tar -xzf "$DOWNLOAD/$NAME" -C "$DOWNLOAD/extract" actionlint || die "cannot extract actionlint from $NAME"
  [ "$(sha256 "$DOWNLOAD/extract/actionlint")" = "$BINARY_SHA256" ] || die "the extracted actionlint does not match its pinned sha256"
  mkdir -p "$(dirname "$BIN")"
  chmod 0755 "$DOWNLOAD/extract/actionlint"
  mv -f "$DOWNLOAD/extract/actionlint" "$BIN.new.$$"
  mv -f "$BIN.new.$$" "$BIN"
  [ "$(sha256 "$BIN")" = "$BINARY_SHA256" ] || die "the cached actionlint does not match its pinned sha256"
fi

cd "$ROOT"
shopt -s nullglob
FILES=(.github/workflows/*.yml .github/workflows/*.yaml)
[ "${#FILES[@]}" -gt 0 ] || die "no workflow files under $ROOT/.github/workflows"
set +e
"$BIN" -no-color -shellcheck= -pyflakes= "${FILES[@]}"
rc=$?
set -e
case "$rc" in
  0) echo "actionlint $VERSION: ${#FILES[@]} workflows, 0 findings" ;;
  1) echo "actionlint $VERSION: findings in ${#FILES[@]} workflows" >&2; exit 2 ;;
  *) die "actionlint exited $rc" ;;
esac

#!/usr/bin/env bash
# build-fork.sh: build and verify a T3 Code server release archive from a clean checkout of the
# performance fork (or of upstream) at one commit, in upstream's release layout.
#
# usage: build-fork.sh --src <checkout> --out <new-dir> [--node <dir>] [--archive-name <file>]
#                      [--allow-dirty] [--no-verify] [--port <n>]
#        build-fork.sh --print-version --src <checkout>
#        build-fork.sh --normalize-archive <in.tar.gz> <out.tar.gz> <epoch seconds>
#
#   --src          git checkout of the tree to build (a public fork tag, or an upstream commit)
#   --out          output directory; must not exist or must be empty
#   --node         a Node.js install directory (an unpacked nodejs.org tarball) to put first on
#                  PATH; its version must equal <src>/package.json engines.node. Without it the
#                  node already first on PATH must be that version.
#   --archive-name the archive's file name instead of t3-<version>-<os>-<arch>.tar.gz (for an
#                  upstream base tree, whose version is upstream's); the directory inside keeps
#                  upstream's name, t3-<version>-<os>-<arch>/
#   --allow-dirty  build a checkout with uncommitted or untracked changes, or a repo .env (recorded)
#   --no-verify    skip the checks after the build (archive smoke, t3 --version, scratch t3 serve)
#   --port         port on 127.0.0.1 for the scratch `serve` checks (default 3791)
#   --print-version print the version the tree's build stamps (the one the checks expect) and exit
#   --normalize-archive repack an archive so the same members give the same bytes (see below) and exit
#
# Builds for the host it runs on: linux-x64 (or linux-arm64) on Debian or Ubuntu, which needs
# patchelf, ldd, dpkg-query and libatomic1; darwin-arm64 on macOS, which needs codesign (ad hoc
# unless T3CODE_CLI_MAC_SIGN_IDENTITY is set). Needs vp (Vite+), cargo, git, tar, GNU tar (tar or
# gtar), GNU gzip, curl and the network (npm registry, crates.io).
#
# The archive is the same bytes for the same members, whichever run or machine builds it with the same
# GNU tar and GNU gzip (a record built again must give the archive an earlier attempt recorded; the
# manifest names both versions): SOURCE_DATE_EPOCH is the commit's time for the whole build, and the
# archive build-cli-archive.ts writes is repacked with GNU tar sorted by name, every mtime that time,
# owner and group 0, modes 0755 for directories and anything executable and 0644 for the rest (no
# setuid, setgid or sticky bit), and gzip -n -9, both run with nothing from the environment but PATH.
#
# Output in --out: t3-<version>-<os>-<arch>.tar.gz (or --archive-name) with t3-<version>-<os>-<arch>/{t3, client/,
# resource-monitor/, node_modules/, ...} inside, the archive's sha256 in <archive>.sha256
# (sha256sum format), build-manifest.txt (commit, toolchain, step seconds, sha256s, verification)
# and logs/<step>.log. The manifest records versions and hashes, never a host name or a path.
# Exit codes: 0 built (and verified), 1 build or verification failed, 2 usage, 3 refused (preflight).
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
usage() { sed -n '2,40p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//' >&2; exit 2; }
die() { echo "build-fork: ERROR: $*" >&2; exit 1; }
refuse() { echo "build-fork: REFUSED: $*" >&2; exit 3; }

# GNU tar, by name (tar on Linux; gtar where tar is bsdtar), or nothing.
gnu_tar() {
  local t
  for t in tar gtar; do
    if command -v "$t" >/dev/null 2>&1 && "$t" --version 2>/dev/null | head -n 1 | grep -q 'GNU tar'; then
      echo "$t"; return 0
    fi
  done
}

# GNU gzip by name, or nothing. The archive's bytes are its deflate output: another implementation (Apple's gzip, for
# one) compresses the same tar differently.
gnu_gzip() {
  if command -v gzip >/dev/null 2>&1 && gzip --version 2>/dev/null | head -n 1 | grep -Eq '^gzip [0-9]' \
    && gzip --version 2>/dev/null | grep -q 'Free Software Foundation'; then
    echo gzip
  fi
}

# The versions the archive's bytes depend on, for the manifest: "GNU tar <v>; gzip <v>".
archive_tools() {
  echo "$("$(gnu_tar)" --version | head -n 1 | sed 's/^tar (GNU tar) /GNU tar /'); $(gzip --version | head -n 1)"
}

# A command with nothing from the environment but PATH, in the C locale: TAR_OPTIONS or GZIP would change the bytes.
clean_env() { env -i PATH="$PATH" LC_ALL=C "$@"; }

# Directories and anything executable 0755, the rest 0644: setuid, setgid and sticky bits cleared first.
ARCHIVE_MODE='a-st,u=rwX,go=rX'

# normalize_archive <in.tar.gz> <out.tar.gz> <epoch>: the same members, repacked so that nothing but their bytes,
# names, link targets and executable bits reaches the archive. <out> may be <in>; it is replaced by renaming a scratch
# file of this run's own beside it, so nothing else at or near <out> is written or removed.
normalize_archive() {
  local in=$1 out=$2 epoch=$3 tar_cmd gzip_cmd work top tmp
  tar_cmd=$(gnu_tar)
  [ -n "$tar_cmd" ] || refuse "a reproducible archive needs GNU tar (tar or gtar on PATH; on macOS: brew install gnu-tar)"
  gzip_cmd=$(gnu_gzip)
  [ -n "$gzip_cmd" ] || refuse "a reproducible archive needs GNU gzip (gzip on PATH; another gzip compresses differently; on macOS: brew install gzip)"
  [ -f "$in" ] || die "--normalize-archive: no archive $in"
  [ ! -d "$out" ] || die "--normalize-archive: $out is a directory"
  work=$(mktemp -d "${TMPDIR:-/tmp}/build-fork-repack.XXXXXX")
  if ! clean_env "$tar_cmd" -xzpf "$in" -C "$work" --no-same-owner; then
    chmod -R u+rwX -- "$work" 2>/dev/null || true; rm -rf "$work"; die "--normalize-archive: cannot unpack $in"
  fi
  # The owner may read and write every member and search every directory, so the repack can read them all and the
  # scratch tree can be removed. chmod -R follows no symbolic link it meets, X adds no executable bit to a regular
  # file that had none, and the mode rule below sets every mode again.
  chmod -R u+rwX -- "$work"
  top=$(cd "$work" && ls -A)
  if [ -z "$top" ] || [ "$(printf '%s\n' "$top" | wc -l | tr -d ' ')" != 1 ] || [ ! -d "$work/$top" ] || [ -L "$work/$top" ]; then
    rm -rf "$work"; die "--normalize-archive: $in is not one top directory"
  fi
  if ! tmp=$(mktemp "$(dirname -- "$out")/.build-fork-repack.XXXXXX"); then
    rm -rf "$work"; die "--normalize-archive: cannot create a scratch file beside $out"
  fi
  if ! (cd "$work" && clean_env "$tar_cmd" --create --format=gnu --sort=name --hard-dereference \
      --mtime="@$epoch" --owner=0 --group=0 --numeric-owner --mode="$ARCHIVE_MODE" --file=- -- "$top") \
      | clean_env "$gzip_cmd" -n -9 >"$tmp"; then
    rm -rf "$work"; rm -f -- "$tmp"; die "--normalize-archive: cannot repack $in"
  fi
  rm -rf "$work"
  chmod 0644 "$tmp"
  mv -f -- "$tmp" "$out"
}

if [ "${1:-}" = --normalize-archive ]; then
  [ $# -eq 4 ] || { echo "build-fork: usage: build-fork.sh --normalize-archive <in.tar.gz> <out.tar.gz> <epoch seconds>" >&2; exit 2; }
  case "$4" in ''|*[!0-9]*) echo "build-fork: --normalize-archive: the epoch must be whole seconds: '$4'" >&2; exit 2 ;; esac
  normalize_archive "$2" "$3" "$4"
  exit 0
fi

SRC="" OUT="" NODE_DIR="" ARCHIVE_NAME_OPT="" ALLOW_DIRTY=0 VERIFY=1 PORT=3791 PRINT_VERSION=0
while [ $# -gt 0 ]; do
  case "$1" in
    --src) [ $# -ge 2 ] || usage; SRC=$2; shift 2 ;;
    --out) [ $# -ge 2 ] || usage; OUT=$2; shift 2 ;;
    --node) [ $# -ge 2 ] || usage; NODE_DIR=$2; shift 2 ;;
    --archive-name) [ $# -ge 2 ] || usage; ARCHIVE_NAME_OPT=$2; ARCHIVE_NAME_SET=1; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    --port) [ $# -ge 2 ] || usage; PORT=$2; shift 2 ;;
    --print-version) PRINT_VERSION=1; shift ;;
    -h|--help) usage ;;
    *) echo "build-fork: unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$SRC" ] || usage
[ -n "$OUT" ] || [ "$PRINT_VERSION" -eq 1 ] || usage
case "$PORT" in ''|*[!0-9]*) echo "build-fork: --port must be a number" >&2; usage ;; esac
if [ "${ARCHIVE_NAME_SET:-0}" -eq 1 ]; then
  case "$ARCHIVE_NAME_OPT" in
    */*|.tar.gz|'') bad_name=1 ;;
    *[!A-Za-z0-9._-]*) bad_name=1 ;;
    *.tar.gz) bad_name=0 ;;
    *) bad_name=1 ;;
  esac
  if [ "$bad_name" -eq 1 ]; then
    echo "build-fork: --archive-name must be a file name ending in .tar.gz (letters, digits, '.', '_', '-'): '$ARCHIVE_NAME_OPT'" >&2
    exit 2
  fi
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
SCRIPT_SHA256=$(sha256 "$SCRIPT_PATH")

[ -d "$SRC" ] || die "--src $SRC does not exist"
SRC=$(cd "$SRC" && pwd -P)
[ -f "$SRC/package.json" ] && [ -f "$SRC/scripts/build-cli-archive.ts" ] \
  || die "--src is not a T3 Code checkout (no scripts/build-cli-archive.ts)"
git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1 || die "--src is not a git checkout"

# The version the tree's own server build stamps into the binary (apps/server/vite.config.ts): the archive is named
# after it, and the smoke and the --version check expect it. APP_VERSION where the tree reads it (the release
# packagers' knob); else the tree's own scripts/lib/tagged-source-version.ts (upstream #36350, 2026-11-13: a commit
# with exactly one vX.Y.Z tag and unedited release manifests stamps that version, as a release commit does before
# its manifest bump lands); else, in a tree older than that resolver, the manifest. Sets VERSION, VERSION_SOURCE
# and MANIFEST_VERSION; a resolver that cannot run fails the build.
resolve_build_version() {
  local app strip=()
  MANIFEST_VERSION=$(node -p "require(process.argv[1]).version" "$SRC/apps/server/package.json") \
    || die "cannot read the version in apps/server/package.json"
  # Trimmed with JavaScript's own trim(), as the server's build trims it (newlines and tabs included).
  app=$(node -e 'process.stdout.write((process.env.APP_VERSION ?? "").trim())')
  if [ -n "$app" ] && grep -qs APP_VERSION "$SRC/apps/server/vite.config.ts" "$SRC/scripts/lib/tagged-source-version.ts"; then
    VERSION=$app VERSION_SOURCE=app_version
  elif [ -f "$SRC/scripts/lib/tagged-source-version.ts" ]; then
    # The build's node (engines.node) strips types itself; an older node (--print-version) needs the flag.
    [ "$(node -p 'String(process.features.typescript ?? false)')" != false ] || strip=(--experimental-strip-types --no-warnings)
    VERSION=$(node ${strip[@]+"${strip[@]}"} --input-type=module -e '
      const [file, root, manifest] = process.argv.slice(1);
      const { pathToFileURL } = await import("node:url");
      const resolved = (await import(pathToFileURL(file).href)).resolveTaggedSourceVersion(root, manifest);
      if (typeof resolved !== "string" || resolved.trim() === "") throw new Error("no version");
      process.stdout.write(resolved.trim());
    ' "$SRC/scripts/lib/tagged-source-version.ts" "$SRC" "$MANIFEST_VERSION") \
      || die "the tree's scripts/lib/tagged-source-version.ts could not resolve the build version"
    VERSION_SOURCE=tree_resolver
  else
    VERSION=$MANIFEST_VERSION VERSION_SOURCE=manifest
  fi
}

if [ "$PRINT_VERSION" -eq 1 ]; then
  command -v node >/dev/null 2>&1 || die "--print-version needs node on PATH"
  resolve_build_version
  echo "build-fork: version $VERSION ($VERSION_SOURCE; manifest $MANIFEST_VERSION)" >&2
  printf '%s\n' "$VERSION"
  exit 0
fi

# cargo and vp from their standard per-user installs when not already on PATH: the vp installer
# writes an env file, CI's setup action a bin directory.
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  set +u; . "$HOME/.cargo/env"; set -u
fi
if ! command -v vp >/dev/null 2>&1; then
  if [ -f "$HOME/.config/vite-plus/env" ]; then
    set +u; . "$HOME/.config/vite-plus/env"; set -u
  elif [ -x "$HOME/.vite-plus/bin/vp" ]; then
    PATH="$HOME/.vite-plus/bin:$PATH"
    export PATH
  fi
fi

# --node goes first on PATH, after the vp env, whose node shims would otherwise come first.
if [ -n "$NODE_DIR" ]; then
  [ -x "$NODE_DIR/bin/node" ] || refuse "--node: no executable bin/node in $NODE_DIR"
  NODE_DIR=$(cd "$NODE_DIR" && pwd -P)
  PATH="$NODE_DIR/bin:$PATH"
  export PATH
  hash -r
fi

# ---- preflight: Node must be exactly engines.node -------------------------------------------
command -v node >/dev/null 2>&1 || refuse "no node on PATH (pass --node <dir>)"
REQUIRED_NODE=$(node -e 'const e = require(process.argv[1]).engines; process.stdout.write(String((e && e.node) || ""))' "$SRC/package.json")
case "$REQUIRED_NODE" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die "package.json engines.node is '$REQUIRED_NODE', not an exact version" ;;
esac
PATH_NODE=$(node -p process.versions.node)
[ "$PATH_NODE" = "$REQUIRED_NODE" ] \
  || refuse "node on PATH is $PATH_NODE; this tree requires engines.node $REQUIRED_NODE exactly (pass --node <dir> with that version)"
command -v vp >/dev/null 2>&1 || refuse "vp (Vite+) not found; install it per the tree's docs/operations/development.md"
VP_NODE=$(cd "$SRC" && vp exec node -p process.versions.node 2>/dev/null | tail -n 1 || true)
[ "$VP_NODE" = "$REQUIRED_NODE" ] \
  || refuse "vp runs node '${VP_NODE:-?}' in the checkout; requires $REQUIRED_NODE (put that node first on PATH)"

# ---- preflight: host, tools, checkout --------------------------------------------------------
case "$(uname -s)" in
  Darwin) PLATFORM=mac OSKEY=darwin ;;
  Linux) PLATFORM=linux OSKEY=linux ;;
  *) refuse "unsupported build OS $(uname -s)" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) refuse "unsupported build arch $(uname -m)" ;;
esac
KEY="$OSKEY-$ARCH"

need() { for t in "$@"; do command -v "$t" >/dev/null 2>&1 || refuse "required tool '$t' not found"; done; }
need git tar curl cargo gzip
[ -n "$(gnu_tar)" ] || refuse "a reproducible archive needs GNU tar (tar or gtar on PATH; on macOS: brew install gnu-tar)"
[ -n "$(gnu_gzip)" ] || refuse "a reproducible archive needs GNU gzip (gzip on PATH; another gzip compresses differently; on macOS: brew install gzip)"
if [ "$PLATFORM" = mac ]; then
  need codesign
else
  need patchelf ldd dpkg-query
  # build-cli-archive.ts copies the libatomic.so.1 that Node links; resolve it the same way.
  ldd "$(command -v node)" | grep -q 'libatomic\.so\.1 => /' \
    || refuse "libatomic.so.1 does not resolve for node (install libatomic1)"
fi

DIRTY=$(git -C "$SRC" status --porcelain)
REPO_ENV=""
for f in .env .env.local; do [ -e "$SRC/$f" ] && REPO_ENV="$REPO_ENV $f"; done
if [ "$ALLOW_DIRTY" -eq 0 ]; then
  [ -z "$DIRTY" ] || refuse "the checkout has uncommitted or untracked changes (commit them or pass --allow-dirty):
$DIRTY"
  # apps/server/vite.config.ts bakes .env and .env.local values into the bundle.
  [ -z "$REPO_ENV" ] || refuse "the checkout has${REPO_ENV}, whose values are baked into the build (remove or pass --allow-dirty)"
fi

if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then die "--out $OUT exists and is not empty"; fi
mkdir -p "$OUT/logs"
OUT=$(cd "$OUT" && pwd -P)

if [ "$VERIFY" -eq 1 ]; then
  set +e; curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; rc=$?; set -e
  [ "$rc" -eq 7 ] || refuse "port $PORT on 127.0.0.1 is in use (or not refusing connections); pick --port"
fi

# ---- helpers ---------------------------------------------------------------------------------
MANIFEST="$OUT/build-manifest.txt"
: >"$MANIFEST"
m() { printf '%s=%s\n' "$1" "$2" >>"$MANIFEST"; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
secs_since() { awk -v a="$1" -v b="$(now_ms)" 'BEGIN { printf "%.1f", (b - a) / 1000 }'; }
fsize() { wc -c <"$1" | tr -d ' '; }
step() {
  local name=$1; shift
  local log="$OUT/logs/$name.log" t0 rc
  echo "== $name: $*"
  t0=$(now_ms)
  set +e
  (cd "$SRC" && "$@") >"$log" 2>&1
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    m "step_${name}" "FAILED exit $rc"
    echo "   FAILED (exit $rc); last lines of logs/$name.log:" >&2
    tail -n 40 "$log" >&2
    exit 1
  fi
  local s; s=$(secs_since "$t0")
  m "time_${name}_s" "$s"
  echo "   ok in ${s}s"
}

resolve_build_version
COMMIT=$(git -C "$SRC" rev-parse HEAD)
# Every tool that honours it stamps the commit's time, not the build's; the archive's mtimes are this time too.
SOURCE_DATE_EPOCH=$(git -C "$SRC" log -1 --format=%ct HEAD)
export SOURCE_DATE_EPOCH
TAGS_AT_COMMIT=$(git -C "$SRC" tag --points-at HEAD | tr '\n' ' ' | sed 's/ $//')
if [ "$PLATFORM" = mac ]; then
  OS_DESC="macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
else
  OS_DESC="$(. /etc/os-release && echo "$PRETTY_NAME") (debian_version $(cat /etc/debian_version 2>/dev/null || echo n/a))"
fi
m commit "$COMMIT"
m tags_at_commit "${TAGS_AT_COMMIT:-none}"
m dirty "$([ -z "$DIRTY" ] && echo no || echo "yes (--allow-dirty)")"
m repo_env_files "${REPO_ENV:- none}"
m version "$VERSION"
m version_source "$VERSION_SOURCE"
m manifest_version "$MANIFEST_VERSION"
m platform_key "$KEY"
m build_os "$OS_DESC / $(uname -sr)"
m build_cpus "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo n/a)"
m built_at_utc "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
m build_script_sha256 "$SCRIPT_SHA256"
m source_date_epoch "$SOURCE_DATE_EPOCH"
m node "$PATH_NODE"
m vp "$(vp --version 2>/dev/null | awk 'NR == 1')"
m package_manager "$(node -p "require(process.argv[1]).packageManager" "$SRC/package.json")"
m cargo "$(cargo --version)"
m rustc "$(rustc --version 2>/dev/null || echo n/a)"
m telemetry_channel "${T3CODE_TELEMETRY_CHANNEL:-dev (default; unset)}"

echo "build-fork: $COMMIT ($VERSION) for $KEY with node $PATH_NODE"
T_TOTAL=$(now_ms)

# ---- build (the steps of upstream's release workflow for the CLI archive) --------------------
step install vp i --frozen-lockfile
step build vp run --filter t3 build
step build_exe vp run --filter t3 build:exe
step resource_monitor vp run build:resource-monitor

EXE="$SRC/apps/server/dist-exe/t3"
RM_BIN="$SRC/native/resource-monitor/target/release/t3-resource-monitor"
[ -x "$EXE" ] || die "build:exe did not produce apps/server/dist-exe/t3"
[ -x "$RM_BIN" ] || die "build:resource-monitor did not produce native/resource-monitor/target/release/t3-resource-monitor"
[ -f "$SRC/apps/server/dist/bin.mjs" ] || die "build did not produce apps/server/dist/bin.mjs"
[ -f "$SRC/apps/server/dist/client/index.html" ] || die "build did not bundle the web client"
# The layout the release workflow stages: <dir>/<platform-key>/t3-resource-monitor.
mkdir -p "$OUT/stage/resource-monitor/$KEY"
cp "$RM_BIN" "$OUT/stage/resource-monitor/$KEY/t3-resource-monitor"

step archive node scripts/build-cli-archive.ts --platform "$PLATFORM" --arch "$ARCH" \
  --version "$VERSION" --resource-monitor-dir "$OUT/stage/resource-monitor" --output-dir "$OUT"
BUILT_NAME="t3-$VERSION-$KEY.tar.gz"
[ -f "$OUT/$BUILT_NAME" ] || die "build-cli-archive.ts did not write $BUILT_NAME"
normalize_archive "$OUT/$BUILT_NAME" "$OUT/$BUILT_NAME" "$SOURCE_DATE_EPOCH"
m archive_tools "$(archive_tools)"
m archive_normalized "GNU tar --sort=name --mtime=@$SOURCE_DATE_EPOCH --owner=0 --group=0 --mode=$ARCHIVE_MODE; gzip -n -9"
ARCHIVE_NAME="${ARCHIVE_NAME_OPT:-$BUILT_NAME}"
ARCHIVE="$OUT/$ARCHIVE_NAME"
[ "$ARCHIVE_NAME" = "$BUILT_NAME" ] || mv "$OUT/$BUILT_NAME" "$ARCHIVE"
rm -rf "$OUT/stage"
m time_build_total_s "$(secs_since "$T_TOTAL")"

ARCHIVE_SHA256=$(sha256 "$ARCHIVE")
(cd "$OUT" && printf '%s  %s\n' "$ARCHIVE_SHA256" "$ARCHIVE_NAME" >"$ARCHIVE_NAME.sha256")
m archive "$ARCHIVE_NAME"
m archive_inner_dir "t3-$VERSION-$KEY"
m archive_bytes "$(fsize "$ARCHIVE")"
m archive_sha256 "$ARCHIVE_SHA256"
m dist_exe_t3_sha256_unsigned "$(sha256 "$EXE")"
m resource_monitor_sha256 "$(sha256 "$RM_BIN")"
if [ "$PLATFORM" = mac ]; then
  if grep -q 'Signed ad hoc' "$OUT/logs/archive.log"; then
    m codesign "ad hoc (codesign --sign -; T3CODE_CLI_MAC_SIGN_IDENTITY unset)"
  else
    m codesign "identity from T3CODE_CLI_MAC_SIGN_IDENTITY (see logs/archive.log)"
  fi
fi
m tree_after_build "$([ -z "$(git -C "$SRC" status --porcelain)" ] && echo clean || echo DIRTY)"

if [ "$VERIFY" -eq 0 ]; then
  m verify "skipped (--no-verify)"
  echo; cat "$MANIFEST"; exit 0
fi

# ---- verify ----------------------------------------------------------------------------------
# Upstream's release smoke test: layout, bundled libatomic (linux), --version, serve answers on /.
step smoke node scripts/smoke-cli-archive.ts --archive "$ARCHIVE" --expect-version "$VERSION"

VDIR="$OUT/verify"
mkdir -p "$VDIR/extract" "$VDIR/home"
tar -xzf "$ARCHIVE" -C "$VDIR/extract"
ROOT="$VDIR/extract/t3-$VERSION-$KEY"
T3="$ROOT/t3"
[ -x "$T3" ] || die "the archive has no executable t3-$VERSION-$KEY/t3"
for d in client resource-monitor node_modules; do
  [ -d "$ROOT/$d" ] || die "the archive has no t3-$VERSION-$KEY/$d/ (not upstream's release layout)"
done
m archive_layout "$(cd "$ROOT" && ls -1A | tr '\n' ' ' | sed 's/ $//')"
m extracted_t3_sha256 "$(sha256 "$T3")"
# The spawner helper embeds the random temporary path upstream builds it from: its hash shows where builds differ.
m extracted_process_spawner_sha256 "$(if [ -f "$ROOT/t3-process-spawner" ]; then sha256 "$ROOT/t3-process-spawner"; else echo none; fi)"
if [ "$PLATFORM" = mac ]; then
  m extracted_t3_signature "$(codesign -dv "$T3" 2>&1 | grep -E '^(Signature|TeamIdentifier|Identifier)=' | tr '\n' ' ')"
fi

# Host Node is kept off PATH so the archive proves it runs without it.
VERSION_OUT=$(env -i PATH=/usr/bin:/bin HOME="$VDIR/home" "$T3" --version 2>&1) || die "t3 --version failed: $VERSION_OUT"
m archive_t3_version "$VERSION_OUT"
case "$VERSION_OUT" in *"$VERSION"*) ;; *) die "t3 --version printed '$VERSION_OUT', expected $VERSION" ;; esac
echo "== t3 --version: $VERSION_OUT"

serve_check() {
  local label=$1; shift
  local base="$VDIR/$label-base" home="$VDIR/$label-home" log="$OUT/logs/serve-$label.log"
  local t0 pid ready=0 i=0 envjson rc
  mkdir -p "$base" "$home"
  echo "== serve ($label): serve --port $PORT --host 127.0.0.1 in a scratch base dir"
  t0=$(now_ms)
  env -i PATH=/usr/bin:/bin HOME="$home" TMPDIR="$VDIR" T3CODE_TELEMETRY_ENABLED=false \
    T3CODE_LOG_LEVEL=Debug "$@" serve --base-dir "$base" --port "$PORT" --host 127.0.0.1 --no-browser \
    >"$log" 2>&1 &
  pid=$!
  while [ "$i" -lt 900 ]; do
    if grep -q 'startup phase: complete' "$log"; then ready=1; break; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
    i=$((i + 1))
  done
  local took; took=$(secs_since "$t0")
  envjson=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/.well-known/t3/environment" 2>/dev/null || true)
  kill -TERM "$pid" 2>/dev/null || true
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 75 ]; do sleep 0.2; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
    m "serve_${label}_stop" "did not exit within 15 s of SIGTERM; killed"
  fi
  set +e; wait "$pid" 2>/dev/null; rc=$?; set -e
  if [ "$ready" -ne 1 ]; then
    m "serve_${label}" "FAILED: no 'startup phase: complete' (exit $rc)"
    echo "   FAILED; last lines of logs/serve-$label.log:" >&2
    tail -n 30 "$log" >&2
    exit 1
  fi
  m "serve_${label}_startup_complete_s" "$took"
  m "serve_${label}_exit_after_sigterm" "$rc"
  m "serve_${label}_server_version" "$(printf '%s' "$envjson" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(`${j.serverVersion} (${j.platform.os}-${j.platform.arch})`)}catch{process.stdout.write("no /.well-known/t3/environment response")}})')"
  echo "   startup phase: complete after ${took}s; stopped (exit $rc)"
}

serve_check archive "$T3"
# Benchmarks may also run the JS bundle directly; check that path from the same build.
m source_bin_version "$(env -i PATH=/usr/bin:/bin HOME="$VDIR/home" "$(command -v node)" "$SRC/apps/server/dist/bin.mjs" --version 2>&1)"
serve_check source "$(command -v node)" "$SRC/apps/server/dist/bin.mjs"

rm -rf "$VDIR"
m verify ok
echo
cat "$MANIFEST"

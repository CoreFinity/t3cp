#!/usr/bin/env bash
# t3cp record runner: one benchmark record of one release on this machine, resumable attempt by attempt.
#
# usage: run-record.sh --spec <spec.json> --out <dir> --harness <harness dir> --work <scratch dir>
#                      [--settings <provider settings.json>]
#
# The spec (schema/record-spec-1.json) names the release archive, the era fixture and the suite. The runner:
#   1. checks the spec, the platform, the CPU model (spec.cpu_model, default "AMD EPYC 7B13" on linux-x64:
#      anything else exits 3 with reason cpu_mismatch before any attempt), the harness and the exporter, the
#      archive's sha256 and the fixture's sha256 (a mismatch exits 3 before anything else starts);
#   2. unpacks the archive (the harness's release.ts) and migrates the era fixture once with the release
#      (runner/migrate.mjs on a reflink copy: the migration chain, an extra);
#   3. runs every attempt whose <out>/attempts/<cell>-<n>/attempt.json does not exist, in the interleaved order
#      (1, 50, 100, 150, 200, 250, then 1e, round after round), each from a reflink restore of the migrated
#      fixture (run.ts restores it), with the counts and driver arguments of the spec's load profile
#      (suite.profile, default real3: a row of runner/profiles.json for the 1-agent cell, 1e on an empty
#      database, and the ladder);
#      --runs 1 --retries 2 and the suite's warm-up and window; the bench's server environment (telemetry
#      off, log level Warn, no cwd bootstrap, a chosen 8192 MiB heap limit; run.ts adds the preload and the
#      resource monitor),
#      a seeded compaction marker and the pinned --now; on Linux the server on CPUs 0-5,8-13 and the driver,
#      procmon.py and the host guard on 6,7,14,15. A try whose window shows foreign CPU or steal above the
#      thresholds is contaminated and is retried once; both tries are recorded;
#   4. exports each attempt (tools/t3cp/export.mjs, fail closed), calls $T3CP_ON_ATTEMPT <out>/attempts/<cell>-<n>
#      and on Linux deletes the raw attempt directory;
#   5. measures the record extras (runner/startup.mjs: three cold and three warm starts on the era fixture and
#      on an empty database; an extras run with the 1-agent profile: one full snapshot GET of the largest
#      fixture thread after its window, and the first turn) and exports them;
#   6. writes done.json. Heartbeats are new files (heartbeats/<UTC timestamp>.json) at least every 240 s and on
#      every state change: storage is append-only, so nothing the runner hands to a hook is ever rewritten.
# A scenario record (suite.scenario {id, version}: a row of the scenario catalogue, T3CP_SCENARIOS or the repository's
# scenarios.json) runs the row's cells in place of the ladder: its attempts cell by cell, round after round
# (<cell>-<n>), each with the cell's counts, driver mode and turn gap, warm-up and window, the compaction marker seeded
# only when the cell says so, and after each try the cell's post step (runner/scenario-post.mjs), which writes
# <raw>/scenario.json; it measures no record extras. A row the catalogue does not have, or a retired one, is refused
# before any attempt (scenario_unknown, exit 2), and so is a harness other than the one the row pins (harness_missing,
# exit 3).
# Layout of <out> and <work>, exit codes and reason codes: schema/record-spec-1.json ($defs). The runner knows no
# bucket, host, region or token: storage is the launcher's, through the hooks:
#   T3CP_ON_ATTEMPT <attempt dir>   after each attempt.json (an executable; retried 3 times, then hook_failed)
#   T3CP_ON_DIAGNOSTICS <file>      a failed attempt's or runner's diagnostics, <work>/diagnostics/...: for PRIVATE
#                                   storage only, never published (a failing hook is logged, never fatal)
#   T3CP_ON_UPDATE <file>           after each heartbeat, extras, done and failure file (every one a new name)
# Calibration and test knobs: T3CP_GUARD_FOREIGN_PCT, T3CP_GUARD_STEAL_PCT (contamination thresholds, % of the
# host, window means), T3CP_HEARTBEAT_S (240), T3CP_EXPORTER, T3CP_PROC_CPUINFO, T3CP_PROC_STAT (the host guard's
# input, /proc/stat), T3CP_PIN=0 (no CPU pinning; recorded), T3CP_STARTUP_BUDGET_S (900 per start),
# T3CP_EXTRA_TIMEOUT_S (1800), T3CP_EXTRAS_TIMEOUT_S (2700), T3CP_EXTRAS_RUN_MIN_S (60),
# T3CP_RECORD_DEADLINE (absolute epoch seconds, UTC: the VM launcher sets it per record; at it the record's work stops
# and it fails record_timeout, exit 5; on a VM, where T3CP_VM or T3CP_BUCKET is set, it is required),
# T3CP_KEEP_RAW=1 (keep raw attempt directories on Linux: validation).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
LIB=$HERE/runner/lib.mjs
SCHEMA=$REPO/schema/record-spec-1.json
NODE=${T3CP_NODE:-node}
PY=${T3CP_PYTHON:-python3}
EXPORTER=${T3CP_EXPORTER:-$REPO/tools/t3cp/export.mjs}
CPUINFO=${T3CP_PROC_CPUINFO:-/proc/cpuinfo}
PROC_STAT=${T3CP_PROC_STAT:-/proc/stat}
HEARTBEAT_S=${T3CP_HEARTBEAT_S:-240}
SERVER_CPUS=0-5,8-13
DRIVER_CPUS=6,7,14,15
# The bench's server environment of every run.ts invocation (run.ts adds the preload and the resource monitor of
# the archive itself). The heap limit is a chosen bench parameter, 8192 MiB: explicit, because the harness needs
# one to check a build's semi-space flags, and over 5 times the highest server heap peak of a full validation
# record (1484.4 MiB).
SERVER_ENV=(--server-env T3CODE_TELEMETRY_ENABLED=false --server-env T3CODE_LOG_LEVEL=Warn
  --server-env T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false
  --server-env "NODE_OPTIONS=--max-old-space-size=8192")

SPEC="" OUT="" HARNESS="" WORK="" SETTINGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --spec) SPEC=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --harness) HARNESS=$2; shift 2 ;;
    --work) WORK=$2; shift 2 ;;
    --settings) SETTINGS=$2; shift 2 ;;
    *) echo "run-record.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
if [ -z "$SPEC" ] || [ -z "$OUT" ] || [ -z "$HARNESS" ] || [ -z "$WORK" ]; then
  echo "usage: run-record.sh --spec <spec.json> --out <dir> --harness <dir> --work <dir> [--settings <file>]" >&2
  exit 2
fi
# Scratch inside <out> would be handed on (raw attempts, diagnostics): such a --work is refused below, with the
# runner's own scratch in a temporary directory instead, so nothing is written inside <out> but the failure.
WORK_IN_OUT=0
if "$PY" -I -c 'import os, sys
o, w = (os.path.realpath(p) for p in sys.argv[1:3])
sys.exit(0 if w == o or w.startswith(o + os.sep) else 1)' "$OUT" "$WORK"; then
  WORK_IN_OUT=1
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/t3cp-refused.XXXXXX")
fi
mkdir -p "$OUT/attempts" "$WORK/pids" "$WORK/raw"
OUT=$(cd "$OUT" && pwd)
WORK=$(cd "$WORK" && pwd)
# One command substitution per command: a trap that fires during one of two side by side fails to parse in bash 5.2
# (runner/trap-safe.test.mjs).
spec_dir=$(cd "$(dirname "$SPEC")" && pwd)
spec_base=$(basename "$SPEC")
SPEC=$spec_dir/$spec_base
HARNESS=$(cd "$HARNESS" 2>/dev/null && pwd || echo "$HARNESS")
SETTINGS=${SETTINGS:-$HARNESS/tools/server-bench/settings/std.json}
RECORD_ID="" LEASE=0 STATE=preparing
RUN_STARTED=$(date -u +%FT%TZ)
RUN_T0=$(date +%s)
FAIL_EXTRA=()
IS_LINUX=0
[ "$(uname -s)" = Linux ] && IS_LINUX=1
PIN=0
[ "$IS_LINUX" = 1 ] && [ "${T3CP_PIN:-1}" = 1 ] && PIN=1

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$WORK/runner.log" >&2; }
now_ms() { # bash 5 has the time built in; older shells ask node
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local t=${EPOCHREALTIME/[.,]/}
    echo "${t:0:${#t}-3}"
  else
    "$NODE" -p 'Date.now()'
  fi
}
lib() { "$NODE" "$LIB" "$@"; }

# A new session and process group in <cwd>, so a restart can stop what a killed runner left behind. Only ever
# called as `launch_group ... &`: it execs, so the background job's $! is the process itself and its group id
# (without exec, bash may keep a subshell in between whose death leaves the group running).
launch_group() {
  local cwd=$1
  shift
  exec "$PY" -I -c 'import os, sys; os.setsid(); os.chdir(sys.argv[1]); os.execvp(sys.argv[2], sys.argv[2:])' "$cwd" "$@"
}
track() { echo "$2" > "$WORK/pids/$1.pid"; }
# A helper that starts its own servers (migrate.mjs, startup.mjs): in a tracked process group of its own, with
# T3CP_TRACK_DIR so each server it starts (a group of its own, server.mjs) is tracked too. A runner killed while it
# runs leaves both to the restart, which stops them first (reap_leftovers); a runner that stops stops them.
run_tracked() { # name cmd...: exit code of cmd
  local name=$1 pid rc=0
  shift
  local -a pin=()
  [ "$PIN" = 1 ] && pin=(taskset -c "$SERVER_CPUS")
  T3CP_TRACK_DIR=$WORK/pids launch_group "$WORK" ${pin[@]+"${pin[@]}"} "$@" >> "$WORK/runner.log" 2>&1 &
  pid=$!
  track "$name" "$pid"
  wait "$pid" || rc=$?
  untrack "$name"
  return "$rc"
}
untrack() { rm -f "$WORK/pids/$1.pid"; }
# A long step in the record's foreground (hashing the fixture, unpacking the release, an export): in a tracked process
# group of its own, waited for. bash runs a trap only between foreground commands but ends a wait at once, so a
# deadline (USR1) is handled while the step runs, and stop_tracked ends the step with the record. The other foreground
# steps read or write small files (the archive's hash, lib's JSON commands, extras-collect) and end within seconds.
fg_step() { # name cwd cmd...: exit code of cmd
  local name=$1 cwd=$2 pid rc=0
  shift 2
  launch_group "$cwd" "$@" &
  pid=$!
  track "$name" "$pid"
  wait "$pid" || rc=$?
  untrack "$name"
  return "$rc"
}
# stop_tree pid: its process group (stop_pid), then every descendant that leads a group of its own and carries this
# work dir. The tree is read before anything is signalled (once the leader dies its children belong to init): a server
# started in a group of its own outlives its parent's group stop when the parent was too stuck to stop it.
stop_tree() {
  local pid=$1 kid
  local -a kids=()
  valid_pid "$pid" && read -r -a kids <<< "$(descendants "$pid")"
  stop_pid "$pid"
  for kid in ${kids[@]+"${kids[@]}"}; do
    gone "$kid" && continue
    [ "$(ps -o pgid= -p "$kid" 2>/dev/null | tr -d ' ')" = "$kid" ] || continue
    if ps -ww -o args= -p "$kid" 2>/dev/null | grep -qF -- "$WORK"; then stop_pid "$kid"; fi
  done
}
descendants() { # pid: every process under it, from one ps snapshot, as pids on one line
  ps -A -o pid=,ppid= 2>/dev/null | awk -v root="$1" '
    { kids[$2] = kids[$2] " " $1 }
    END {
      n = split(kids[root], queue, " ")
      out = ""
      for (i = 1; i <= n; i++) {
        p = queue[i]
        if (p == "") continue
        out = out " " p
        m = split(kids[p], more, " ")
        for (j = 1; j <= m; j++) if (more[j] != "") queue[++n] = more[j]
      }
      print out
    }'
}
# An extra: like run_tracked, in a tracked process group of its own (in <cwd>, output to <log>), but stopped once it
# has run <limit> seconds: its own group, then every server it started (tracked under <work>/pids, and carrying this
# work dir in their arguments), and nothing else. Returns 124 then, else the command's exit code.
run_bounded() { # name limit cwd log cmd...
  local name=$1 limit=$2 cwd=$3 out=$4 pid rc=0 deadline f spid
  shift 4
  local -a pin=()
  [ "$PIN" = 1 ] && pin=(taskset -c "$SERVER_CPUS")
  T3CP_TRACK_DIR=$WORK/pids launch_group "$cwd" ${pin[@]+"${pin[@]}"} "$@" >> "$out" 2>&1 &
  pid=$!
  track "$name" "$pid"
  deadline=$(($(date +%s) + limit))
  while ! gone "$pid"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      stop_tree "$pid"
      wait "$pid" 2>/dev/null || true
      untrack "$name"
      for f in "$WORK"/pids/server-*.pid; do
        [ -e "$f" ] || continue
        spid=$(cat "$f")
        if valid_pid "$spid" && ps -ww -o args= -p "$spid" 2>/dev/null | grep -qF -- "$WORK"; then stop_pid "$spid"; fi
        rm -f "$f"
      done
      return 124
    fi
    sleep 0.2
  done
  wait "$pid" || rc=$?
  untrack "$name"
  return "$rc"
}
gone() { # pid: not running (no such process, or a zombie waiting for its parent)
  local state
  kill -0 "$1" 2>/dev/null || return 0
  state=$(ps -o stat= -p "$1" 2>/dev/null) || return 0
  case "$state" in Z*) return 0 ;; esac
  return 1
}
# A pid the runner may signal: a whole number above 1 that is not the runner itself. Anything else (0 and -1 would
# signal a whole group or every process, a blank or a word nothing at all) is refused and logged, never signalled.
valid_pid() {
  case "$1" in '' | *[!0-9]* | 0* ) return 1 ;; esac
  [ "$1" -gt 1 ] && [ "$1" != "$$" ] && [ "$1" != "${BASHPID:-$$}" ]
}
stop_pid() { # pid: its process group when it leads one (or the process alone), TERM then KILL after 10 s
  local pid=$1 i pgid
  if ! valid_pid "$pid"; then
    log "refused to signal '$pid' (not a process the runner may stop)"
    return 0
  fi
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ') || return 0
  [ -n "$pgid" ] || return 0
  if [ "$pgid" = "$pid" ]; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || return 0
  else
    kill -TERM "$pid" 2>/dev/null || return 0
  fi
  for i in $(seq 1 100); do
    gone "$pid" && return 0
    sleep 0.1
  done
  if [ "$pgid" = "$pid" ]; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  else
    kill -KILL "$pid" 2>/dev/null || true
  fi
  for i in $(seq 1 50); do
    gone "$pid" && return 0
    sleep 0.1
  done
}
reap_leftovers() { # processes a killed runner left (tracked, and still carrying this work dir in their arguments)
  local f pid
  for f in "$WORK"/pids/*.pid; do
    [ -e "$f" ] || continue
    pid=$(cat "$f")
    if [ -n "$pid" ] && ps -ww -o args= -p "$pid" 2>/dev/null | grep -qF -- "$WORK"; then
      log "stopping $(basename "$f" .pid) ($pid) left by an earlier run"
      stop_pid "$pid"
    fi
    rm -f "$f"
  done
}
stop_tracked() { # everything this runner launched, but its heartbeat loop (stop_heartbeats lets a write finish)
  local f
  for f in "$WORK"/pids/*.pid; do
    [ -e "$f" ] || continue
    [ "$(basename "$f")" = heartbeat.pid ] && continue
    stop_tree "$(cat "$f")"
    rm -f "$f"
  done
}

HOOK_TIMEOUT_S=${T3CP_HOOK_TIMEOUT_S:-600}
HOOK_BACKOFF_S=${T3CP_HOOK_BACKOFF_S:-5}
hook_once() { # cmd arg: one try, in <out>, pinned, in a process group of its own, stopped with it after HOOK_TIMEOUT_S
  local cmd=$1 arg=$2 pid rc=0 deadline
  local -a pin=()
  [ "$PIN" = 1 ] && pin=(taskset -c "$DRIVER_CPUS")
  launch_group "$OUT" ${pin[@]+"${pin[@]}"} "$cmd" "$arg" >> "$WORK/hooks.log" 2>&1 &
  pid=$!
  # Tracked, so a stop of the record (its deadline) ends a hook in flight before fail() hands its failure on.
  track hook "$pid"
  deadline=$(($(date +%s) + HOOK_TIMEOUT_S))
  while ! gone "$pid"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "hook $(basename "$cmd") timed out after $HOOK_TIMEOUT_S s"
      stop_pid "$pid"
      wait "$pid" 2>/dev/null || true
      untrack hook
      return 124
    fi
    sleep 0.2
  done
  wait "$pid" || rc=$?
  untrack hook
  return "$rc"
}
hook() { # cmd file-or-dir: run the hook, retried 3 times; a try that hangs is stopped like one that fails
  local cmd=$1 arg=$2 i
  [ -n "$cmd" ] || return 0
  for i in 1 2 3; do
    hook_once "$cmd" "$arg" && return 0
    log "hook $(basename "$cmd") failed on try $i"
    [ "$i" = 3 ] || sleep $((i * HOOK_BACKOFF_S))
  done
  return 1
}
# A file handed to a hook is first marked under <work>/handover and unmarked once its hook succeeded: a run that
# finds a mark (its hook failed, or the runner died before it ran) hands the file over again before anything else.
handover_mark() { mkdir -p "$WORK/handover" && echo "$2" > "$WORK/handover/$1"; }
handover_done() { rm -f "$WORK/handover/$1"; }
update_hook() { hook "${T3CP_ON_UPDATE:-}" "$1"; }
diagnose() { # file: hand a diagnostics bundle (private storage only) to its hook; a failing hook is logged, never fatal
  [ -n "$1" ] || return 0
  log "diagnostics: $1"
  hook "${T3CP_ON_DIAGNOSTICS:-}" "$1" || log "diagnostics hook failed on $1"
}
diagnose_runner() { # reason detail: the runner's own logs for a failure, before it exits
  diagnose "$(lib diagnostics-runner "$WORK" "$WORK/diagnostics/runner" "${RECORD_ID:-}" "$1" "$2" 2>> "$WORK/runner.log" || true)"
}

write_heartbeat() { # a new heartbeats/<UTC timestamp>.json (storage is append-only), handed to the update hook
  local st cell file spec=- at
  # Named for a moment before the state is read: a state set after this read always gets a later name.
  at=$(now_ms)
  read -r st cell < "$WORK/state" 2>/dev/null || return 0
  [ -n "$RECORD_ID" ] && spec=$SPEC
  file=$(lib heartbeat "$OUT" "$spec" "$RECORD_ID" "$LEASE" "$st" "$cell" "${ATTEMPTS_TOTAL:-0}" "$at" 2>/dev/null) || return 0
  update_hook "$file" || log "update hook failed on a heartbeat"
}
set_state() { # a final state stops the heartbeat loop first, so its heartbeat is the last one written
  STATE=$1
  case $1 in done | failed | interrupted) stop_heartbeats ;; esac
  printf '%s %s\n' "$1" "${2:--}" > "$WORK/state.tmp"
  mv "$WORK/state.tmp" "$WORK/state"
  write_heartbeat
}
# A heartbeat every HEARTBEAT_S while the runner lives. TERM ends the loop, but never in the middle of a write:
# the trap only sets a flag (and cuts the nap short), and the loop leaves once the write in flight is done.
heartbeat_loop() {
  HB_STOP=0 HB_NAP=""
  trap 'HB_STOP=1; [ -z "$HB_NAP" ] || kill "$HB_NAP" 2>/dev/null || true' TERM
  while :; do
    sleep "$HEARTBEAT_S" &
    HB_NAP=$!
    [ "$HB_STOP" = 0 ] || kill "$HB_NAP" 2>/dev/null || true
    wait "$HB_NAP" 2>/dev/null || true
    HB_NAP=""
    if [ "$HB_STOP" != 0 ] || ! kill -0 $$ 2>/dev/null; then break; fi
    write_heartbeat
  done
}
stop_heartbeats() { # ends the loop and waits for it: a write in flight completes before this returns
  local pid=${HB_PID:-}
  HB_PID=""
  if [ -z "$pid" ] || ! kill -TERM "$pid" 2>/dev/null; then untrack heartbeat; return 0; fi
  wait "$pid" 2>/dev/null || true
  untrack heartbeat
}

fail() { # reason retryable exit-code detail
  local reason=$1 retryable=$2 code=$3 detail=${4:-} file=""
  log "FAILED $reason: $detail"
  trap - EXIT
  stop_tracked
  stop_heartbeats
  file=$(lib write-new "$OUT/failures" s:schema=t3cp/failure/1 s:record_id="$RECORD_ID" i:lease="$LEASE" \
    s:reason="$reason" b:retryable="$retryable" s:at="$(date -u +%FT%TZ)" s:detail="$detail" \
    ${FAIL_EXTRA[@]+"${FAIL_EXTRA[@]}"}) || true
  [ -n "$file" ] && { update_hook "$file" || true; }
  diagnose_runner "$reason" "$detail"
  set_state failed
  # The stand-in scratch of a refused --work inside --out has been handed on: nothing of it is left behind.
  [ "$WORK_IN_OUT" = 0 ] || rm -rf "$WORK"
  exit "$code"
}
# shellcheck disable=SC2329 # invoked by the traps below
on_signal() {
  local code=$1
  log "interrupted (signal), stopping"
  trap - EXIT TERM INT
  stop_tracked
  stop_heartbeats
  set_state interrupted
  exit "$code"
}
# shellcheck disable=SC2329 # invoked by the trap below
on_exit() {
  local rc=$?
  stop_tracked
  stop_heartbeats
  if [ "$rc" != 0 ] && [ "$STATE" != failed ] && [ "$STATE" != "done" ]; then
    local file
    file=$(lib write-new "$OUT/failures" s:schema=t3cp/failure/1 s:record_id="$RECORD_ID" i:lease="$LEASE" \
      s:reason=runner_error b:retryable=true s:at="$(date -u +%FT%TZ)" s:detail="exit $rc in state $STATE") &&
      { update_hook "$file" || true; }
    diagnose_runner runner_error "exit $rc in state $STATE"
    STATE=failed
    set_state failed
  fi
}
trap 'on_signal 143' TERM
trap 'on_signal 130' INT
trap on_exit EXIT

reap_leftovers
set_state preparing

# 1. Checks, cheapest first. Nothing below starts before every one has passed.
[ "$WORK_IN_OUT" = 0 ] || fail spec_invalid false 2 "--work lies inside --out: its raw attempts and diagnostics would be handed on"
if ! lib validate "$SPEC" "$SCHEMA" 2>> "$WORK/runner.log"; then
  fail spec_invalid false 2 "the spec does not match schema/record-spec-1.json"
fi
RECORD_ID="" PLATFORM="" REL_TAG="" REL_SHA="" REL_VERSION="" REL_ARCHIVE_SHA256="" REL_ARCHIVE_PATH=""
FX_ID="" FX_PATH="" FX_SHA256="" FX_MIGRATION="" SUITE_ID="" PROFILE="" WARMUP_S="" WINDOW_S="" EXTRAS=1 NOW="" SEED="" CPU_MODEL_EXPECTED=""
ORDER="" ATTEMPTS_TOTAL=0 SCENARIO_REF=""
eval "$(lib spec-sh "$SPEC")"
if [ -n "$SCENARIO_REF" ]; then
  # A scenario record: the row's attempts, from the catalogue (every lib and scenarios.mjs call reads the same one).
  SCENARIOS=${T3CP_SCENARIOS:-$REPO/scenarios.json}
  export T3CP_SCENARIOS=$SCENARIOS
  SC_FIXTURE="" SC_HARNESS="" SC_PLATFORMS="" SC_ORDER="" SC_ATTEMPTS_TOTAL=0 SC_JSON=""
  sc_err=$WORK/scenario.err
  sc_sh=$("$NODE" "$HERE/runner/scenarios.mjs" order "$SCENARIOS" "$SCENARIO_REF" 2> "$sc_err") ||
    fail scenario_unknown false 2 "$(tail -c 400 "$sc_err" | tr '\n' ' ')"
  eval "$sc_sh"
  [ "$SUITE_ID" = "$SCENARIO_REF" ] || fail spec_invalid false 2 "suite.id $SUITE_ID is not the scenario's id@version $SCENARIO_REF"
  [ "$SC_FIXTURE" = "$FX_ID" ] || fail spec_invalid false 2 "scenario $SCENARIO_REF runs on fixture $SC_FIXTURE, the spec names $FX_ID"
  case " $SC_PLATFORMS " in
    *" $PLATFORM "*) ;;
    *) fail spec_invalid false 2 "scenario $SCENARIO_REF does not run on $PLATFORM" ;;
  esac
  ORDER=$SC_ORDER ATTEMPTS_TOTAL=$SC_ATTEMPTS_TOTAL EXTRAS=0
  log "record $RECORD_ID: $REL_TAG, fixture $FX_ID, scenario $SCENARIO_REF, $ATTEMPTS_TOTAL attempts"
else
  [ -n "$PROFILE" ] || PROFILE=$("$NODE" "$HERE/runner/profiles.mjs" default)
  "$NODE" "$HERE/runner/profiles.mjs" json "$PROFILE" 1 "$FX_ID" > /dev/null 2>> "$WORK/runner.log" ||
    fail spec_invalid false 2 "suite.profile is not in tools/t3cp/runner/profiles.json"
  log "record $RECORD_ID: $REL_TAG, fixture $FX_ID, suite $SUITE_ID, profile $PROFILE, $ATTEMPTS_TOTAL attempts"
fi
HB_PID=""
heartbeat_loop &
HB_PID=$!
# Tracked like everything else a SIGKILLed runner leaves behind: the restart stops it first (reap_leftovers).
track heartbeat "$HB_PID"

# The record's deadline: a record never outlives it. At it, a watchdog signals the runner, which stops all its work
# (stop_tracked: every group and the servers they started) and fails record_timeout (not retryable, exit 5) with the
# deadline and its own elapsed seconds: a measured outcome, never a silent loss. On a VM a record never runs uncapped.
# shellcheck disable=SC2329 # invoked by the trap below, or directly when the deadline has already passed
on_deadline() {
  trap - USR1
  local elapsed=$(($(date +%s) - RUN_T0))
  FAIL_EXTRA=(i:deadline_epoch_s="$RECORD_DEADLINE" i:elapsed_s="$elapsed")
  fail record_timeout false 5 "the record's deadline was reached after $elapsed s of this run; its work is stopped"
}
RECORD_DEADLINE=${T3CP_RECORD_DEADLINE:-}
if [ -z "$RECORD_DEADLINE" ]; then
  if [ -n "${T3CP_VM:-}" ] || [ -n "${T3CP_BUCKET:-}" ]; then
    fail deadline_missing false 3 "no T3CP_RECORD_DEADLINE on a VM: a record never runs without one"
  fi
  log "no record deadline (not on a VM)"
else
  case "$RECORD_DEADLINE" in
    *[!0-9]*) fail deadline_invalid false 3 "T3CP_RECORD_DEADLINE is not a whole number of epoch seconds" ;;
  esac
  [ "$(date +%s)" -lt "$RECORD_DEADLINE" ] || on_deadline
  trap on_deadline USR1
  RUNNER_PID=$$
  # A process of its own (its $$ is its own pid on any bash), checking every second. It signals only while the runner
  # that started it is alive and still its parent: a runner killed outright leaves it to init, and the pid may then be
  # another process's, so it leaves at once instead (checked before each sleep and right before the signal).
  # shellcheck disable=SC2016 # the script is single-quoted on purpose: it runs in a shell of its own
  "$BASH" -c '
    runner=$1 deadline=$2
    parent() { ps -o ppid= -p "$$" 2> /dev/null | tr -d " "; }
    while [ "$(date +%s)" -lt "$deadline" ]; do
      [ "$(parent)" = "$runner" ] || exit 0
      sleep 1
    done
    [ "$(parent)" = "$runner" ] && kill -USR1 "$runner" 2> /dev/null
    exit 0' watchdog "$RUNNER_PID" "$RECORD_DEADLINE" &
  track watchdog "$!"
  log "record deadline in $((RECORD_DEADLINE - $(date +%s))) s"
fi

HOST_PLATFORM=$(lib host-platform)
[ "$HOST_PLATFORM" = "$PLATFORM" ] || fail platform_mismatch true 3 "record platform $PLATFORM, host ${HOST_PLATFORM:-unsupported}"

if [ -r "$CPUINFO" ]; then
  CPU_MODEL=$(lib cpu-model "$CPUINFO")
else
  CPU_MODEL=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)
fi
if [ -n "$CPU_MODEL_EXPECTED" ] && [ "$CPU_MODEL" != "$CPU_MODEL_EXPECTED" ]; then
  fail cpu_mismatch true 3 "host CPU model: ${CPU_MODEL:-unknown}"
fi

[ -f "$HARNESS/tools/server-bench/run.ts" ] && [ -f "$HARNESS/tools/server-bench/release.ts" ] ||
  fail harness_missing true 3 "run.ts or release.ts missing in the harness directory"
[ -f "$SETTINGS" ] || fail harness_missing true 3 "provider settings file missing"
# run.ts takes --archive (the verified release archive, below) from t3cp-harness/2.0.0 on; an older run.ts refuses
# the flag on every attempt, so an older harness, or one that does not name itself, is refused here, once.
HARNESS_MIN=t3cp-harness/2.0.0
harness_version=$(lib json-get "$HARNESS/t3cp-harness.json" version 2>/dev/null || true)
lib version-at-least "${harness_version:-none}" "$HARNESS_MIN" ||
  fail harness_missing true 3 "harness ${harness_version:-without t3cp-harness.json or a version}: $HARNESS_MIN or later needed"
# A scenario row pins its harness, and the exporter takes an attempt only from that one: any other installation would
# run every attempt for nothing, so it is refused here, once.
if [ -n "$SCENARIO_REF" ] && [ "$harness_version" != "$SC_HARNESS" ]; then
  fail harness_missing true 3 "harness $harness_version: scenario $SCENARIO_REF pins $SC_HARNESS"
fi
[ -f "$EXPORTER" ] || fail exporter_missing true 3 "tools/t3cp/export.mjs missing"
# The exporter refuses every attempt without a usable private pattern list: found out now, not after 21 attempts.
pp_error=$(lib private-patterns 2>&1) || fail exporter_missing true 3 "the exporter cannot run: $pp_error"

[ -f "$REL_ARCHIVE_PATH" ] || fail archive_missing true 3 "release archive missing"
got=$(lib sha256 "$REL_ARCHIVE_PATH")
[ "$got" = "$REL_ARCHIVE_SHA256" ] || fail archive_sha256_mismatch false 3 "archive sha256 $got, spec $REL_ARCHIVE_SHA256"

file_stamp() { stat -c '%s %Y' "$1" 2>/dev/null || stat -f '%z %m' "$1"; }
if [ "$FX_ID" != none ]; then
  [ -f "$FX_PATH" ] || fail fixture_missing true 3 "fixture $FX_ID missing"
  stamp="$FX_PATH $(file_stamp "$FX_PATH") $FX_SHA256"
  if [ "$(cat "$WORK/fixture.verified" 2>/dev/null)" != "$stamp" ]; then
    log "hashing fixture $FX_ID"
    fg_step fixture-hash "$PWD" "$NODE" "$LIB" sha256 "$FX_PATH" > "$WORK/fixture.sha256" ||
      fail fixture_sha256_mismatch false 3 "fixture $FX_ID could not be hashed"
    got=$(cat "$WORK/fixture.sha256")
    [ "$got" = "$FX_SHA256" ] || fail fixture_sha256_mismatch false 3 "fixture $FX_ID sha256 $got, spec $FX_SHA256"
    echo "$stamp" > "$WORK/fixture.verified"
  fi
fi

HOST_JSON=$WORK/host.json
lib host "$SPEC" "$CPUINFO" > "$HOST_JSON"
RUNNER_JSON=$WORK/runner.json
lib runner-identity "$HERE" > "$RUNNER_JSON"
BUILD_JSON=$(lib json-get "$SPEC" release.build)
[ -n "$BUILD_JSON" ] || BUILD_JSON=null
HARNESS_JSON=$WORK/harness.json
preload=$HARNESS/tools/server-bench/preload/bench-preload.cjs
preload_sha=""
[ -f "$preload" ] && preload_sha=$(lib sha256 "$preload")
harness_meta=$HARNESS/t3cp-harness.json
if [ -f "$harness_meta" ]; then
  h_version=$(lib json-get "$harness_meta" version)
  h_sha=$(lib json-get "$harness_meta" sha)
  h_files=$(lib json-get "$harness_meta" files_sha256)
  lib write-json "$HARNESS_JSON" s:version="$h_version" s:sha="$h_sha" s:files_sha256="$h_files" s:preload_sha256="$preload_sha"
else
  lib write-json "$HARNESS_JSON" n:version= n:sha= n:files_sha256= s:preload_sha256="$preload_sha"
fi

all_present() {
  local c
  for c in $ORDER; do [ -f "$OUT/attempts/$c/attempt.json" ] || return 1; done
  if [ "$EXTRAS" = 1 ]; then
    for c in startup migration snapshot first_turn; do [ -f "$OUT/extras/$c.json" ] || return 1; done
  fi
  return 0
}
finish() {
  local timings status
  timings=$WORK/timings.json
  lib write-json "$timings" s:started_at="$RUN_STARTED" s:ended_at="$(date -u +%FT%TZ)" \
    f:migration_s="${MIGRATION_S:-}" f:attempts_s="${ATTEMPTS_S:-}" f:extras_s="${EXTRAS_S:-}"
  handover_mark done.json "$OUT/done.json"
  status=$(lib write-done "$OUT" "$SPEC" "$HOST_JSON" "$timings")
  log "done: $status"
  update_hook "$OUT/done.json" || fail hook_failed true 4 "update hook failed on done.json"
  handover_done done.json
  set_state "done"
  exit 0
}
rehand() { # every file whose handover a run did not finish: handed over again, before anything else
  local m what file
  for m in "$WORK"/handover/*; do
    [ -e "$m" ] || continue
    what=$(basename "$m")
    file=$(cat "$m")
    if [ ! -e "$file" ]; then
      handover_done "$what" # it never reached <out>: it is made again below
      continue
    fi
    log "handing $file over again (its hook did not finish)"
    case $what in
      attempt-*) hook "${T3CP_ON_ATTEMPT:-}" "$file" || fail hook_failed true 4 "attempt hook failed on ${what#attempt-}" ;;
      *) update_hook "$file" || fail hook_failed true 4 "update hook failed on $(basename "$file")" ;;
    esac
    handover_done "$what"
  done
}
# A run reuses only its own work: an attempt or extra in <out> another runner made, or one that names no runner
# (attempts and extras record the runner in their pipeline), fails the record closed before anything runs. Mixing
# them would publish a record no single run of one runner made.
foreign=$(lib foreign-work "$OUT" "$RUNNER_JSON")
if [ -n "$foreign" ]; then
  foreign_n=$(printf '%s\n' "$foreign" | wc -l | tr -d ' ')
  foreign_first=$(printf '%s\n' "$foreign" | head -5 | paste -sd ';' -)
  fail foreign_attempts false 3 "$foreign_n file(s) in <out> not made by this runner: $foreign_first"
fi
rehand
if all_present; then
  log "every attempt and extra is present"
  if [ -f "$OUT/done.json" ]; then
    set_state "done"
    exit 0
  fi
  finish
fi

# 2. The release, and the era fixture migrated once by it.
set_state unpacking
REL_DONE="$REL_ARCHIVE_SHA256 $REL_TAG"
if [ "$(cat "$WORK/release.done" 2>/dev/null)" != "$REL_DONE" ]; then
  rm -rf "$WORK/release"
  mkdir -p "$WORK/release"
  fg_step unpack "$HARNESS" "$NODE" tools/server-bench/release.ts unpack --archive "$REL_ARCHIVE_PATH" \
    --sha256 "$REL_ARCHIVE_SHA256" --tag "$REL_TAG" --commit "$REL_SHA" --dest "$WORK/release" >> "$WORK/runner.log" 2>&1 ||
    fail unpack_failed true 4 "release.ts unpack failed"
  echo "$REL_DONE" > "$WORK/release.done"
fi
RELEASE_DIR=""
for d in "$WORK"/release/*/; do
  [ -f "${d}release.json" ] && RELEASE_DIR=${d%/}
done
[ -n "$RELEASE_DIR" ] && [ -f "$RELEASE_DIR/t3" ] || fail unpack_failed true 4 "no unpacked release with release.json"
# How the release schedules history compaction, read from its server binary once: every attempt then records the
# passes in its window, or why they cannot be counted (maintenance_in_window, runner/maintenance.mjs).
MAINT_CLASS=$(lib maintenance-class "$RELEASE_DIR/t3")
log "compaction scheduling: $MAINT_CLASS"

mkdir -p "$WORK/raw-extras" "$OUT/extras"
export_extras() { # exporter on the raw extras; only files not yet in <out>/extras are moved there
  local tmp="$OUT/extras/.tmp" rc=0 f b
  rm -rf "$tmp"
  mkdir -p "$tmp"
  # On the driver CPUs (pinned), so it never competes with the server.
  local -a dpin=()
  [ "$PIN" = 1 ] && dpin=(taskset -c "$DRIVER_CPUS")
  fg_step export "$PWD" ${dpin[@]+"${dpin[@]}"} "$NODE" "$EXPORTER" --extras "$WORK/raw-extras" --out "$tmp" --spec "$SPEC" \
    > "$WORK/extras-export.log" 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then
    log "extras export refused (exit $rc)"
    rm -rf "$tmp"
    return 0
  fi
  for f in "$tmp"/*.json; do
    [ -e "$f" ] || continue
    b=$(basename "$f")
    [ -e "$OUT/extras/$b" ] && continue
    # The exporter leaves the runner fields null; this runner names itself, so a later run can tell its own work.
    lib stamp-runner "$f" "$RUNNER_JSON" || fail runner_error true 4 "extras/$b names another runner"
    handover_mark "extras-$b" "$OUT/extras/$b"
    mv "$f" "$OUT/extras/$b"
    update_hook "$OUT/extras/$b" || fail hook_failed true 4 "update hook failed on extras/$b"
    handover_done "extras-$b"
  done
  rm -rf "$tmp"
}

MIGRATED=""
if [ "$FX_ID" != none ]; then
  set_state migrating
  t0=$(date +%s)
  MIG_DONE="$FX_SHA256 $REL_ARCHIVE_SHA256"
  MIGRATED=$WORK/fixture/base/userdata/statev2.sqlite
  if [ "$(cat "$WORK/fixture.done" 2>/dev/null)" != "$MIG_DONE" ] || [ ! -f "$MIGRATED" ]; then
    rm -rf "$WORK/fixture"
    rm -f "$WORK/fixture.done"
    run_tracked migrate "$NODE" "$HERE/runner/migrate.mjs" --t3 "$RELEASE_DIR/t3" --fixture "$FX_PATH" \
      --dest "$WORK/fixture" --out "$WORK/raw-extras/migration.json" --sampler "$WORK/raw-extras/migration-sampler.tsv" \
      --fixture-id "$FX_ID" --fixture-migration "$FX_MIGRATION" --budget-s "${T3CP_MIGRATION_BUDGET_S:-3600}" ||
      fail migration_failed true 4 "the release did not migrate the era fixture"
    echo "$MIG_DONE" > "$WORK/fixture.done"
  fi
  MIGRATION_S=$(($(date +%s) - t0))
  if [ "$EXTRAS" = 1 ] && [ ! -f "$OUT/extras/migration.json" ] && [ -f "$WORK/raw-extras/migration.json" ]; then
    export_extras
  fi
fi

# 3. The attempts.
ATTEMPTS_T0=$(date +%s)
one_try() { # cell try fixture-arg: one run.ts invocation with its sidecars (the cell's P_* profile), then try.json
  local cell=$1 try=$2 fixture_arg=$3
  local raw=$WORK/raw/$cell t0 t1 started ended rc=0 pid gpid="" ppid="" disk contaminated a
  rm -rf "$raw"
  mkdir -p "$raw/work"
  [ -f "$WORK/fixture-hashes.json" ] && cp "$WORK/fixture-hashes.json" "$raw/work/fixture-hashes.json"
  local -a args=(tools/server-bench/run.ts --ref "release=sea:$RELEASE_DIR" --archive "release=$REL_ARCHIVE_PATH" --fixture "$fixture_arg"
    --settings "$SETTINGS" --out "$raw" --work "$raw/work" --runs 1 --retries 2
    --warmup "${P_WARMUP_S}s" --window "${P_WINDOW_S}s" --sessions "$P_SESSIONS" --subscribers "$P_SUBSCRIBERS"
    --now "$NOW")
  # Every ladder cell, and a scenario cell unless it says otherwise, starts with a fresh compaction marker, so no
  # compaction pass is due in its window; a scenario cell that measures the compaction starts without one.
  [ "$P_SEED_COMPACTED" = 1 ] && args+=(--seed-compacted-at)
  args+=(--otlp-interval-ms 1000
    --startup-timeout 900s --keep-runs "${SERVER_ENV[@]}" "--driver-arg=--seed" "--driver-arg=$SEED")
  # Counts above zero are run.ts flags; the turn gap, a zero poller count and the rest are driver options, one
  # token per --driver-arg= (the profile lists them).
  [ "$P_POLLERS" -gt 0 ] && args+=(--pollers "$P_POLLERS")
  for a in $P_DRIVER_ARGS; do args+=("--driver-arg=$a"); done
  [ "$PIN" = 1 ] && args+=(--server-cpus "$SERVER_CPUS" --driver-cpus "$DRIVER_CPUS")
  # A cell that names mark_age_days starts each try with the migrated fixture's prune mark that many days old (run.ts
  # restores the fixture from that file), so the try reads the row's age, not the time since the fixture was made. A
  # mark that cannot be written stops the record before the try: the post step would measure the fixture's own mark.
  if [ -n "$P_MARK_AGE_DAYS" ]; then
    local mark_set
    if [ "$fixture_arg" = none ]; then
      log "$cell try $try: no era fixture, no prune mark to set"
    elif mark_set=$("$PY" -I "$HERE/runner/prune-mark.py" --db "$fixture_arg" --set-age-days "$P_MARK_AGE_DAYS" \
        --now-ms "$(now_ms)" 2>> "$WORK/runner.log"); then
      case $mark_set in
        *'"set": true'*) log "$cell try $try: prune mark set $P_MARK_AGE_DAYS days before the try ($mark_set)" ;;
        *) log "$cell try $try: no prune mark to set ($mark_set)" ;;
      esac
    else
      fail runner_error true 4 "$cell try $try: the prune mark could not be set (${mark_set:-no result})"
    fi
  fi
  started=$(date -u +%FT%TZ)
  t0=$(now_ms)
  local -a pin=()
  [ "$PIN" = 1 ] && pin=(taskset -c "$DRIVER_CPUS")
  if [ "$IS_LINUX" = 1 ]; then
    launch_group "$WORK" ${pin[@]+"${pin[@]}"} "$PY" -I "$HERE/runner/host-guard.py" --out "$raw/host-guard.ndjson" \
      --parent-pid $$ --stat "$PROC_STAT" > /dev/null 2>&1 &
    gpid=$!
    track "guard-$cell" "$gpid"
  fi
  launch_group "$HARNESS" "$NODE" "${args[@]}" > "$raw/run.log" 2>&1 &
  pid=$!
  track "run-$cell" "$pid"
  if [ "$IS_LINUX" = 1 ]; then
    disk=$(basename "$(findmnt -no SOURCE --target "$WORK" 2>/dev/null || echo sda)")
    local -a stats=()
    [ -d "$HARNESS/state/fake-stats" ] && stats=(--stats-dir "$HARNESS/state/fake-stats")
    # The prune-mark post step reads the run's database after the try: the sidecar keeps it for that cell.
    [ "$P_POST" = prune-mark ] && stats+=(--keep-db)
    launch_group "$WORK" ${pin[@]+"${pin[@]}"} nice -n 5 "$PY" -I "$HERE/runner/procmon.py" --work "$raw/work" \
      --parent-pid "$pid" --disk "$disk" --log "$raw/procmon.log" ${stats[@]+"${stats[@]}"} &
    ppid=$!
    track "procmon-$cell" "$ppid"
  fi
  wait "$pid" || rc=$?
  untrack "run-$cell"
  if [ -n "$ppid" ]; then
    wait "$ppid" 2>/dev/null || true
    untrack "procmon-$cell"
  fi
  if [ -n "$gpid" ]; then
    stop_pid "$gpid"
    wait "$gpid" 2>/dev/null || true
    untrack "guard-$cell"
  fi
  [ -f "$raw/work/fixture-hashes.json" ] && cp "$raw/work/fixture-hashes.json" "$WORK/fixture-hashes.json"
  t1=$(now_ms)
  ended=$(date -u +%FT%TZ)
  contaminated=$(lib finish-try "$raw" "$try" "$started" "$ended" "$((t1 - t0))" "$rc" "$MAINT_CLASS")
  log "$cell try $try: run.ts exit $rc, contaminated $contaminated"
  TRY_CONTAMINATED=$contaminated
  # A scenario cell's post step reads the kept run (its trace, loop samples or database) into <raw>/scenario.json. A
  # failed one is logged; the attempt then has no scenario file, and the exporter says so.
  if [ "$P_POST" != none ]; then
    fg_step "post-$cell" "$WORK" "$NODE" "$HERE/runner/scenario-post.mjs" "$P_POST" "$raw" "$SCENARIO_REF" >> "$WORK/runner.log" 2>&1 ||
      log "$cell try $try: post step $P_POST failed"
  fi
}

run_attempt() {
  local cell=$1 name=${1%-*} n=${1##*-} level fixture_arg fixture_id profile_json TRY_CONTAMINATED=false
  local raw=$WORK/raw/$cell tmp dest rc=0 cell_sh scenario_json
  # shellcheck disable=SC2034 # P_MODE and P_TURN_GAP are set by the profile's eval and recorded through profile_json
  local P_SESSIONS P_SUBSCRIBERS P_POLLERS P_MODE P_TURN_GAP P_FIXTURE P_DRIVER_ARGS P_WARMUP_S P_WINDOW_S P_SEED_COMPACTED P_POST
  local P_MARK_AGE_DAYS=""
  local -a scenario_meta=()
  profile_json=$WORK/raw/$cell.profile.json
  if [ -n "$SCENARIO_REF" ]; then
    # The row's cell: its counts, mode, turn gap, intervals, compaction seeding and post step. Its entry (scenario,
    # profile, timings) goes to <work>/raw/<cell>.scenario.json, and attempt-meta.json records the profile part.
    scenario_json=$WORK/raw/$cell.scenario.json
    cell_sh=$("$NODE" "$HERE/runner/scenarios.mjs" sh "$SCENARIOS" "$SCENARIO_REF" "$name" "$scenario_json" 2>> "$WORK/runner.log") ||
      fail runner_error true 4 "scenario $SCENARIO_REF: cell $name cannot be read"
    eval "$cell_sh"
    lib json-get "$scenario_json" profile > "$profile_json"
    level=$P_SESSIONS
    scenario_meta=(j:scenario="$SC_JSON")
    # A cell started without a fresh compaction marker measures the compaction: a pass in its window is its point.
    [ "$P_SEED_COMPACTED" = 1 ] || scenario_meta+=(b:maintenance_expected=true)
  else
    if [ "$name" = 1e ]; then level=1; else level=$name; fi
    eval "$("$NODE" "$HERE/runner/profiles.mjs" sh "$PROFILE" "$name" "$FX_ID" "$profile_json")"
    P_WARMUP_S=$WARMUP_S P_WINDOW_S=$WINDOW_S P_SEED_COMPACTED=1 P_POST=none P_MARK_AGE_DAYS=""
  fi
  if [ "$P_FIXTURE" = none ]; then
    fixture_arg=none fixture_id=none
  else
    fixture_arg=$MIGRATED fixture_id=$FX_ID
  fi
  set_state attempt "$cell"
  rm -f "$WORK/raw/$cell.try1.json"
  one_try "$cell" 1 "$fixture_arg"
  local tries=("$raw/try.json")
  if [ "$TRY_CONTAMINATED" = true ]; then
    log "$cell: contaminated ($(lib json-get "$raw/try.json" contamination_reasons)), retrying once"
    mv "$raw/try.json" "$WORK/raw/$cell.try1.json"
    [ "$IS_LINUX" = 1 ] && rm -rf "$raw"
    one_try "$cell" 2 "$fixture_arg"
    tries=("$WORK/raw/$cell.try1.json" "$raw/try.json")
  fi
  mv "$profile_json" "$raw/profile.json"
  profile_json=$raw/profile.json
  [ -n "$SCENARIO_REF" ] && mv "$scenario_json" "$raw/scenario-cell.json"
  lib merge-tries "$raw/attempt-meta.json" "${tries[@]}" -- s:schema=t3cp/attempt-meta/1 \
    s:record_id="$RECORD_ID" s:cell="$name" i:n="$n" i:level="$level" s:label=release \
    @:profile="$profile_json" s:fixture="$fixture_id" s:suite.id="$SUITE_ID" \
    i:suite.warmup_s="$P_WARMUP_S" i:suite.window_s="$P_WINDOW_S" s:now="$NOW" s:seed="$SEED" \
    s:release.tag="$REL_TAG" s:release.sha="$REL_SHA" s:release.version="$REL_VERSION" \
    s:cpus.server="$SERVER_CPUS" s:cpus.driver="$DRIVER_CPUS" b:cpus.pinned="$PIN" \
    @:host="$HOST_JSON" @:harness="$HARNESS_JSON" @:runner="$RUNNER_JSON" j:build="$BUILD_JSON" \
    ${scenario_meta[@]+"${scenario_meta[@]}"}
  set_state exporting "$cell"
  dest=$OUT/attempts/$cell
  tmp=$OUT/attempts/.$cell.tmp
  rm -rf "$tmp"
  mkdir -p "$tmp"
  # On the driver CPUs (pinned), so it never competes with the server.
  local -a dpin=()
  [ "$PIN" = 1 ] && dpin=(taskset -c "$DRIVER_CPUS")
  fg_step export "$PWD" ${dpin[@]+"${dpin[@]}"} "$NODE" "$EXPORTER" "$raw" --out "$tmp" --spec "$SPEC" \
    > "$WORK/raw/$cell.export.log" 2>&1 || rc=$?
  diagnose "$(lib diagnostics-attempt "$raw" "$WORK/diagnostics/$cell" "$rc" "$WORK/raw/$cell.export.log" 2>> "$WORK/runner.log" || true)"
  if [ "$rc" != 0 ] || [ ! -f "$tmp/attempt.json" ]; then
    log "$cell: export refused (exit $rc); the record will be partial"
    rm -rf "$tmp"
    echo "$cell" >> "$WORK/export-failed.list"
    return 0
  fi
  mv "$WORK/raw/$cell.export.log" "$tmp/export.log"
  rm -rf "$dest"
  handover_mark "attempt-$cell" "$dest"
  mv "$tmp" "$dest"
  hook "${T3CP_ON_ATTEMPT:-}" "$dest" || fail hook_failed true 4 "attempt hook failed on $cell"
  handover_done "attempt-$cell"
  if [ "$IS_LINUX" = 1 ] && [ "${T3CP_KEEP_RAW:-0}" != 1 ]; then rm -rf "$raw" "$WORK/raw/$cell.try1.json"; fi
}

for cell in $ORDER; do
  [ -f "$OUT/attempts/$cell/attempt.json" ] && continue
  run_attempt "$cell"
done
ATTEMPTS_S=$(($(date +%s) - ATTEMPTS_T0))

# 5. The record extras. None can stall a record: each extra runs at most EXTRA_TIMEOUT_S and the phase at most
# EXTRAS_TIMEOUT_S (run_bounded stops a timed-out extra's own process group and the servers it started). A timed-out
# extra's raw file says so (timed_out, and extra_timeout for each value it left unmeasured), and the record goes on.
if [ "$EXTRAS" = 1 ]; then
  EXTRAS_T0=$(date +%s)
  EXTRA_TIMEOUT_S=${T3CP_EXTRA_TIMEOUT_S:-1800}
  EXTRAS_DEADLINE=$((EXTRAS_T0 + ${T3CP_EXTRAS_TIMEOUT_S:-2700}))
  # The extras run needs its warm-up (10 s), window (30 s) and a server start and stop: with less left, it is not
  # started and says extra_timeout.
  EXTRAS_RUN_MIN_S=${T3CP_EXTRAS_RUN_MIN_S:-60}
  extra_limit() { # seconds the next extra may run: its own limit, cut to what is left of the phase (0 when none is)
    local left=$((EXTRAS_DEADLINE - $(date +%s)))
    [ "$left" -gt 0 ] || left=0
    [ "$EXTRA_TIMEOUT_S" -lt "$left" ] && left=$EXTRA_TIMEOUT_S
    echo "$left"
  }
  set_state extras
  if [ ! -f "$OUT/extras/migration.json" ] && [ "$FX_ID" = none ]; then
    lib write-json "$WORK/raw-extras/migration.json" s:schema=t3cp/extras-migration/1 s:fixture_id=none \
      j:migrations='[]' n:chain_s= j:reasons='{"chain_s":"no_fixture","migrations":"no_fixture"}'
  fi
  if [ ! -f "$OUT/extras/startup.json" ]; then
    limit=$(extra_limit) rc=0
    startup_budget_s=${T3CP_STARTUP_BUDGET_S:-900}
    # Its own total budget ends the starts a little before the hard stop, so a slow release still ends cleanly.
    total_s=$limit
    [ "$limit" -gt 60 ] && total_s=$((limit - 30))
    startup_args=(--t3 "$RELEASE_DIR/t3" --work "$WORK/startup" --out "$WORK/raw-extras/startup.json" --runs 3
      --budget-s "$startup_budget_s" --total-budget-s "$total_s")
    [ "$FX_ID" != none ] && startup_args+=(--fixture "$FX_PATH")
    rm -f "$WORK/raw-extras/startup.json"
    if [ "$limit" -gt 0 ]; then
      run_bounded startup "$limit" "$WORK" "$WORK/runner.log" "$NODE" "$HERE/runner/startup.mjs" "${startup_args[@]}" || rc=$?
    else
      rc=124
    fi
    [ "$rc" = 124 ] && lib startup-timed-out "$WORK/raw-extras/startup.json" 3 "$startup_budget_s"
    if [ -f "$WORK/raw-extras/startup.json" ] && [ "$(lib json-get "$WORK/raw-extras/startup.json" timed_out)" = true ]; then
      log "startup extra timed out after $limit s; startup.json keeps the starts that finished"
    elif [ "$rc" != 0 ]; then
      log "startup extras failed; startup.json says what is missing"
    fi
  fi
  if [ ! -f "$OUT/extras/snapshot.json" ] || [ ! -f "$OUT/extras/first_turn.json" ]; then
    run_extras_run() { # limit: seconds it may run (0: not started)
      local limit=$1 raw=$WORK/raw-extras/run fixture_arg=none mode=fresh rc=0
      local -a timed=()
      # On the era fixture the session continues the fixture's history (mixed, like every fixture-backed run), so
      # its first turn is dispatched at the driver's warm-up mark and the runner times it (first-turn.mjs).
      [ "$FX_ID" != none ] && fixture_arg=$MIGRATED mode=mixed
      rm -rf "$raw"
      mkdir -p "$raw/work"
      [ -f "$WORK/fixture-hashes.json" ] && cp "$WORK/fixture-hashes.json" "$raw/work/fixture-hashes.json"
      local -a args=(tools/server-bench/run.ts --ref "release=sea:$RELEASE_DIR" --archive "release=$REL_ARCHIVE_PATH" --fixture "$fixture_arg"
        --settings "$SETTINGS" --out "$raw" --work "$raw/work" --runs 1 --retries 1 --warmup 10s --window 30s
        --sessions 1 --subscribers 1 --now "$NOW" --seed-compacted-at
        --otlp-interval-ms 1000 --startup-timeout 900s --keep-runs --driver "$HERE/runner/extras-driver.mjs"
        "${SERVER_ENV[@]}"
        "--driver-arg=--seed" "--driver-arg=$SEED" "--driver-arg=--mode" "--driver-arg=$mode"
        "--driver-arg=--turn-gap" "--driver-arg=5s" "--driver-arg=--pollers" "--driver-arg=0"
        "--driver-arg=--setup-concurrency" "--driver-arg=1")
      [ "$PIN" = 1 ] && args+=(--server-cpus "$SERVER_CPUS" --driver-cpus "$DRIVER_CPUS")
      export T3CP_DRIVER_TS=$HARNESS/tools/server-bench/driver.ts T3CP_SNAPSHOT_LARGEST=0 T3CP_FIRST_TURN=0
      [ "$FX_ID" != none ] && T3CP_SNAPSHOT_LARGEST=1 T3CP_FIRST_TURN=1
      if [ "$limit" -gt 0 ]; then
        run_bounded extras-run "$limit" "$HARNESS" "$raw/run.log" "$NODE" "${args[@]}" || rc=$?
        [ "$rc" = 124 ] && log "extras run timed out after $limit s"
      else
        rc=124
        log "extras run not started: $((EXTRAS_DEADLINE - $(date +%s))) s left of the extras phase"
      fi
      [ "$rc" = 124 ] && timed=(--timed-out)
      [ -f "$raw/work/fixture-hashes.json" ] && cp "$raw/work/fixture-hashes.json" "$WORK/fixture-hashes.json"
      "$NODE" "$HERE/runner/extras-collect.mjs" --run "$raw" --out-dir "$WORK/raw-extras" --run-exit "$rc" \
        --fixture-id "$FX_ID" ${timed[@]+"${timed[@]}"} >> "$WORK/runner.log" 2>&1 || log "extras collection failed"
    }
    set_state extras extras-run
    limit=$(extra_limit)
    [ $((EXTRAS_DEADLINE - $(date +%s))) -lt "$EXTRAS_RUN_MIN_S" ] && limit=0
    run_extras_run "$limit"
  fi
  export_extras
  EXTRAS_S=$(($(date +%s) - EXTRAS_T0))
  [ "$IS_LINUX" = 1 ] && [ "${T3CP_KEEP_RAW:-0}" != 1 ] && rm -rf "$WORK/raw-extras/run" "$WORK/startup"
fi

finish

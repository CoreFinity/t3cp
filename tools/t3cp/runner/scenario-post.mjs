// t3cp record runner: a scenario cell's post step, run after each try on the kept run (the valid run.ts run of the
// raw attempt directory), writing <raw>/scenario.json (schema t3cp/scenario-raw/1):
//   {schema, scenario {id, version}, post, window {start_ms, end_ms, run, valid}, metrics {<metric id>: {value,
//   reason}}, detail}
// with every metric the step measures. A value that cannot be measured is null with its reason, never 0.
//   turn-start-gap  over the first 10 ProviderTurnStartService.start spans of the server trace (and its rotated
//                   files) that start in the window:
//                   turn_start_history_gap_ms   the longest event-loop block while they ran: the largest delay.max_ms
//                                               of the preload's 1 Hz loop samples (loop-1hz.ndjson; a sample at t
//                                               covers [t - dt_ms, t]) that overlap one; none: no_loop_samples;
//                   turn_start_long_thread_ms   the median of their durations.
//                   Fewer than 10 starts in the window: both turn_start_incomplete.
//   prune-mark      prune_mark_age_days: the event log's prune mark in the run's database at the window's end,
//                   read-only (prune-mark.py): its age past the one retained day, in days; no mark: no_event_prune.
// No valid run.ts run with a window (an invalid run is never measured): every metric of the step null with
// no_run_window.
//
//   node scenario-post.mjs <post> <raw attempt dir> <id@version>
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./is-main.mjs";
import { attemptWindow, writeJsonAtomic } from "./lib.mjs";

export const RAW_SCHEMA = "t3cp/scenario-raw/1";
export const TURN_START_SPAN = "ProviderTurnStartService.start";
export const TURN_STARTS = 10;
/** The metrics each post step measures (data's exporter maps the raw file's metrics to the catalogue's). */
export const POST_METRICS = {
  "turn-start-gap": ["turn_start_history_gap_ms", "turn_start_long_thread_ms"],
  "prune-mark": ["prune_mark_age_days"],
};

const here = dirname(fileURLToPath(import.meta.url));

/** Each line of a file, read in chunks: a trace may be far larger than one string can hold. */
function* lines(file, chunkSize = 4 * 1024 * 1024) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(chunkSize);
    let rest = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, buf, 0, chunkSize, null);
      if (n === 0) break;
      let data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      let at;
      while ((at = data.indexOf(10)) >= 0) {
        yield data.subarray(0, at).toString("utf8");
        data = data.subarray(at + 1);
      }
      rest = Buffer.from(data);
    }
    if (rest.length) yield rest.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The server trace and its rotated files (.1, .2 ...) of a run directory, oldest last. */
function traceFiles(runDir) {
  const base = join(runDir, "base", "userdata", "logs", "server.trace.ndjson");
  const files = [];
  for (let i = 0; ; i++) {
    const file = i === 0 ? base : `${base}.${i}`;
    if (!existsSync(file)) break;
    files.push(file);
  }
  return files;
}

/** Spans of one name in the run's trace, as [start ms, end ms], each counted once, by start. */
export function spansNamed(runDir, name) {
  const seen = new Set();
  const spans = [];
  for (const file of traceFiles(runDir)) {
    for (const line of lines(file)) {
      if (!line.includes(name)) continue;
      let span;
      try {
        span = JSON.parse(line);
      } catch {
        continue;
      }
      if (span?.name !== name) continue;
      const dur = Number(span.durationMs);
      let start = span.startTimeUnixNano !== undefined ? Number(span.startTimeUnixNano) / 1e6 : Number.NaN;
      let end = span.endTimeUnixNano !== undefined ? Number(span.endTimeUnixNano) / 1e6 : Number.NaN;
      if (!Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(dur)) start = end - dur;
      if (!Number.isFinite(end) && Number.isFinite(start) && Number.isFinite(dur)) end = start + dur;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) continue;
      const key = span.spanId !== undefined ? `${span.traceId ?? ""}/${span.spanId}` : line;
      if (seen.has(key)) continue;
      seen.add(key);
      spans.push([start, end]);
    }
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const r3 = (x) => (x === null ? null : Math.round(x * 1000) / 1000);

/** The turn-start block of a run directory over the attempt's window {start, end} (ms). */
export function turnStartGap(runDir, window) {
  const starts = spansNamed(runDir, TURN_START_SPAN)
    .filter(([s]) => s >= window.start && s <= window.end)
    .slice(0, TURN_STARTS);
  const detail = {
    starts_completed: starts.length,
    start_p50_ms: r3(median(starts.map(([s, e]) => e - s))),
    loop_samples: 0,
  };
  if (starts.length < TURN_STARTS) return { value: null, reason: "turn_start_incomplete", detail };
  const loop = join(runDir, "loop-1hz.ndjson");
  if (!existsSync(loop)) return { value: null, reason: "no_loop_samples", detail };
  let value = null;
  for (const line of lines(loop)) {
    if (!line) continue;
    let sample;
    try {
      sample = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Number(sample?.t);
    const dt = Number(sample?.dt_ms);
    const max = Number(sample?.delay?.max_ms);
    if (!Number.isFinite(t) || !Number.isFinite(dt) || !Number.isFinite(max)) continue;
    if (!starts.some(([s, e]) => t - dt < e && t > s)) continue;
    detail.loop_samples++;
    value = value === null ? max : Math.max(value, max);
  }
  if (value === null) return { value: null, reason: "no_loop_samples", detail };
  return { value: r3(value), reason: null, detail };
}

/** The prune mark in the run's database at the window's end (prune-mark.py, read-only). */
export function pruneMark(runDir, window, python = process.env.T3CP_PYTHON || "python3") {
  const db = join(runDir, "base", "userdata", "statev2.sqlite");
  const r = spawnSync(python, ["-I", join(here, "prune-mark.py"), "--db", db, "--end-ms", String(Math.round(window.end))], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`prune-mark.py exited ${r.status}: ${(r.stderr ?? "").trim().slice(-400)}`);
  return JSON.parse(r.stdout);
}

const all = (ids, reason) => Object.fromEntries(ids.map((id) => [id, { value: null, reason }]));

/** The raw scenario file of one try: every metric of the post step over the valid run's window. */
export function scenarioRaw(post, raw, scenario) {
  const ids = POST_METRICS[post];
  if (!ids) throw new Error(`unknown post step ${post}`);
  const window = attemptWindow(raw);
  const out = { schema: RAW_SCHEMA, scenario, post, window: { start_ms: window.start, end_ms: window.end, run: window.run, valid: window.valid } };
  if (window.valid !== true || !Number.isInteger(window.run) || window.start === null || window.end === null) {
    return { ...out, metrics: all(ids, "no_run_window"), detail: {} };
  }
  const runDir = join(raw, "work", "runs", "release", `attempt-${window.run}`);
  if (post === "prune-mark") {
    const mark = pruneMark(runDir, window);
    return { ...out, metrics: { prune_mark_age_days: { value: mark.value, reason: mark.reason } }, detail: mark.detail };
  }
  const gap = turnStartGap(runDir, window);
  const complete = gap.detail.starts_completed >= TURN_STARTS;
  return {
    ...out,
    metrics: {
      turn_start_history_gap_ms: { value: gap.value, reason: gap.reason },
      turn_start_long_thread_ms: complete ? { value: gap.detail.start_p50_ms, reason: null } : { value: null, reason: "turn_start_incomplete" },
    },
    detail: gap.detail,
  };
}

if (isMain(import.meta.url)) {
  const [post, raw, ref] = process.argv.slice(2);
  try {
    const m = /^([a-z0-9][a-z0-9-]*)@([1-9][0-9]*)$/.exec(ref ?? "");
    if (!post || !raw || !m) throw new Error("usage: scenario-post.mjs <post> <raw attempt dir> <id@version>");
    writeJsonAtomic(join(raw, "scenario.json"), scenarioRaw(post, raw, { id: m[1], version: Number(m[2]) }));
  } catch (error) {
    process.stderr.write(`scenario-post.mjs: ${error.message}\n`);
    process.exit(1);
  }
}

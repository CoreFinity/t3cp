// Diagnostics of a failed or invalid attempt, or of a failed runner, so a failure is diagnosable without SSH. The
// bundle is for the PRIVATE bucket only: run-record.sh writes it under <work>/diagnostics (never under <out>, so it is
// never exported, aggregated or published) and hands it to T3CP_ON_DIAGNOSTICS. It is bounded (each log tail and the
// whole bundle are capped) and scrubbed: the private pattern list (T3CP_PRIVATE_PATTERNS), the host name and secret
// shapes never reach it.
//
// Every try also keeps, for the same PRIVATE storage, its attempt-logs bundle (t3cp/attempt-logs/1, attemptLogs):
// each run.ts run's server log (its head and tail) and every compaction or prune pass in its trace with its own
// start, end and exit, relative to the window, so maintenance timing is measured, not inferred. No pass is ever
// dropped: those that do not fit the bundle go, in order, into its parts (attemptLogsParts), each also within the cap.
// run-record.sh writes them under <work>/attempt-logs/<cell>-<n>/ as <UTC stamp>.attempt-logs.json and
// <UTC stamp>.attempt-logs.part-<i>.json and hands each to T3CP_ON_DIAGNOSTICS after the try (never inside a window);
// the exporter never reads them, and they are bounded and scrubbed as above.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { PUBLIC_PATTERNS } from "../lib/scan.mjs";
import { maintenanceSpans } from "./maintenance.mjs";

export const DIAG_SCHEMA = "t3cp/diagnostics/1";
export const TAIL_BYTES = 16_384;
export const TOTAL_BYTES = 262_144;

/** The end of a file, at most maxBytes, starting at a line start; null when the file is missing. */
export function tailText(file, maxBytes) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const bytes = fstatSync(fd).size;
    const length = Math.min(bytes, maxBytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, bytes - length);
    let start = 0;
    if (length < bytes) {
      const nl = buf.indexOf(0x0a);
      start = nl < 0 ? 0 : nl + 1;
    }
    return { bytes, truncated: length < bytes, text: buf.subarray(start).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

// Whole secret bodies, not just the prefixes the public scan detects them by: a key block from its BEGIN line to
// its END line (or to the end of the text when the tail was cut), then token shapes with their whole body.
const SECRET_SHAPES = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu,
  /\bya29\.[A-Za-z0-9._-]+/gu,
  /\bxox[a-z]-[A-Za-z0-9-]+/gu,
  /\bghp_[A-Za-z0-9]{20,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/gu,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/gu,
  // and whatever else the public scan calls a secret token, from its prefix to the end of the word
  ...PUBLIC_PATTERNS.filter((p) => p.id === "secret_token").map((p) => new RegExp(`(?:${p.re.source})[A-Za-z0-9._~+/=-]*`, "gu")),
];
const KEY_VALUE = /\b(authorization|proxy-authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|api[_-]?key)\b(\s*[:=]\s*)(?:bearer\s+|basic\s+)?("[^"\n]*"|'[^'\n]*'|[^\s,;"']+)/giu;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A scrub function: private patterns -> [private], the host name -> [host], secret shapes and key=value -> [secret]/[redacted]. */
export function scrubber({ patterns = [], hostname: host = hostname() } = {}) {
  const hostRe = host ? new RegExp(escapeRe(host), "giu") : null;
  return (text) => {
    let out = String(text);
    for (const re of patterns) out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), "[private]");
    if (hostRe) out = out.replace(hostRe, "[host]");
    for (const re of SECRET_SHAPES) out = out.replace(re, "[secret]");
    return out.replace(KEY_VALUE, (_, key, sep) => `${key}${sep}[redacted]`);
  };
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Why an attempt needs diagnostics (empty when it does not), from its attempt-meta and the exporter's exit. Whether a
 * run was valid is the last try's window: valid_run names the run whose window was used, the last one when none was.
 */
export function attemptReasons(meta, exportRc) {
  const reasons = [];
  const validRun = meta?.tries?.at(-1)?.window?.valid === true;
  if (Number.isInteger(meta?.run_ts_exit) && meta.run_ts_exit !== 0) reasons.push(`run_ts_exit_${meta.run_ts_exit}`);
  if (!validRun) reasons.push("no_valid_run");
  if (Number(exportRc) !== 0) reasons.push("export_refused");
  // What the exporter invalidates an otherwise measured attempt for.
  if (meta?.contaminated === true) reasons.push("contaminated");
  if (meta?.contaminated === null) reasons.push("host_guard_unavailable");
  const m = meta?.maintenance_in_window;
  if (typeof m === "number" && m > 0) reasons.push("maintenance_in_window");
  if (m === null && validRun) reasons.push("maintenance_unverified");
  return reasons;
}

/** A log entry: the scrubbed tail and its sizes. */
const logEntry = (file, maxBytes, scrub) => {
  const t = tailText(file, maxBytes);
  return t === null ? null : { bytes: t.bytes, truncated: t.truncated, text: scrub(t.text) };
};

/** The size the bundle is written at (lib.mjs writeNew: indented by one). */
export const writtenBytes = (bundle) => Buffer.byteLength(`${JSON.stringify(bundle, null, 1)}\n`);

/**
 * Fits the bundle under totalBytes by halving the log tails' budget (the oldest lines go first) until it fits; a
 * bundle still too large without logs keeps only its reasons.
 */
function fit(build, tailBytes, totalBytes) {
  let budget = tailBytes;
  let bundle = build(budget);
  while (writtenBytes(bundle) > totalBytes && budget > 256) {
    budget = Math.floor(budget / 2);
    bundle = build(budget);
    bundle.truncated = true;
  }
  if (writtenBytes(bundle) > totalBytes) {
    const { schema, kind, record_id, cell, n, at, reasons } = bundle;
    bundle = { schema, kind, record_id, cell, n, at, reasons, truncated: true, dropped: "over the size cap" };
  }
  return bundle;
}

/** Scrubs every string in a JSON value (keys too), in place of the serialised text, so the value never stops parsing. */
function scrubJson(value, scrub) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubJson(v, scrub));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k), scrubJson(v, scrub)]));
  return value;
}

/** Diagnostics of one attempt: every run.ts run's problems and driver detail, its driver and server log tails, run.ts output. */
export function attemptDiagnostics(raw, meta, { reasons, scrub = scrubber(), tailBytes = TAIL_BYTES, totalBytes = TOTAL_BYTES, exportLog = null } = {}) {
  const runsDir = join(raw, "work", "runs", "release");
  const runIds = existsSync(runsDir)
    ? readdirSync(runsDir)
        .filter((d) => /^attempt-\d+$/.test(d))
        .map((d) => Number(d.slice(8)))
        .sort((a, b) => a - b)
    : [];
  const build = (budget) => {
    const runs = runIds.map((k) => {
      const dir = join(runsDir, `attempt-${k}`);
      const run = readJson(join(dir, "run.json")) ?? {};
      return {
        run: k,
        valid: run.valid ?? null,
        problems: scrubJson(run.problems ?? null, scrub),
        driver: scrubJson(run.driver ?? null, scrub),
        driver_failure: scrubJson(run.driver_failure ?? null, scrub),
        server: scrubJson(run.server ? { exit_before_stop: run.server.exit_before_stop ?? null, stop: run.server.stop ?? null } : null, scrub),
        logs: {
          "driver.log": logEntry(join(dir, "driver.log"), budget, scrub),
          "server.log": logEntry(join(dir, "server.log"), budget, scrub),
        },
      };
    });
    return {
      schema: DIAG_SCHEMA,
      kind: "attempt",
      record_id: meta?.record_id ?? null,
      cell: meta?.cell ?? null,
      n: meta?.n ?? null,
      at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      reasons,
      attempt: {
        run_ts_exit: meta?.run_ts_exit ?? null,
        valid_run: meta?.valid_run ?? null,
        contaminated: meta?.contaminated ?? null,
        cycle_s: meta?.cycle_s ?? null,
        maintenance_in_window: meta?.maintenance_in_window ?? null,
      },
      runs,
      logs: {
        "run.log": logEntry(join(raw, "run.log"), budget, scrub),
        "export.log": exportLog ? logEntry(exportLog, budget, scrub) : null,
      },
      truncated: false,
    };
  };
  return fit(build, tailBytes, totalBytes);
}

/** Diagnostics of a runner failure: the reason, the detail, and the tails of the runner's own logs. */
export function runnerDiagnostics(work, failure, { scrub = scrubber(), tailBytes = TAIL_BYTES, totalBytes = TOTAL_BYTES } = {}) {
  const build = (budget) => ({
    schema: DIAG_SCHEMA,
    kind: "runner",
    record_id: failure?.record_id || null,
    at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    reasons: [failure?.reason ?? "unknown"],
    detail: failure?.detail ? scrub(failure.detail) : null,
    logs: Object.fromEntries(
      ["runner.log", "hooks.log", "extras-export.log", "fixture/server.log"].map((f) => [f, logEntry(join(work, f), budget, scrub)]),
    ),
    truncated: false,
  });
  return fit(build, tailBytes, totalBytes);
}

export const LOGS_SCHEMA = "t3cp/attempt-logs/1";
export const LOG_HEAD_BYTES = 32_768;
export const LOG_TAIL_BYTES = 163_840;

/** The start of a file, at most maxBytes, ending at a line end; null when the file is missing. */
export function headText(file, maxBytes) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const bytes = fstatSync(fd).size;
    const length = Math.min(bytes, maxBytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, 0);
    let end = length;
    if (length < bytes) {
      const nl = buf.lastIndexOf(0x0a);
      end = nl < 0 ? length : nl + 1;
    }
    return { bytes, truncated: length < bytes, text: buf.subarray(0, end).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

const isoMs = (ms) => new Date(ms).toISOString();
const tenths = (ms) => Math.round(ms / 100) / 10;

/** The longest exit a pass keeps: one pass always fits a part. */
const EXIT_CHARS = 256;
/** A part number or count no real one is longer than, for sizing a bundle before the count is known. */
const SIZING_NUMBER = Number.MAX_SAFE_INTEGER;

/** The largest n in [lo, max] with fits(n), given fits(lo) and fits monotone (true, then false). */
function most(fits, lo, max) {
  let good = lo;
  let step = 1;
  while (good + step <= max && fits(good + step)) {
    good += step;
    step *= 2;
  }
  let bad = Math.min(good + step, max + 1);
  while (bad - good > 1) {
    const mid = Math.floor((good + bad) / 2);
    if (fits(mid)) good = mid;
    else bad = mid;
  }
  return good;
}

/**
 * A try's attempt-logs (PRIVATE storage only), as one or more bundles of at most totalBytes each: for each run.ts run
 * of the try, its server log (whole when it fits headBytes + tailBytes, else its head and tail) and every compaction
 * or prune pass in its trace with its start, end, duration and exit, relative to the try's window. No pass is dropped.
 * The first bundle (kind attempt_logs) has the logs and as many passes as fit beside them, those overlapping the window
 * first, then the nearest to it (the latest first without a window); each run counts the passes it left to the parts in
 * maintenance_spans_in_parts, and `parts` is the number of bundles. The rest go, in that order, into parts (kind
 * attempt_logs_passes, part 2..parts), each as full as the cap allows; within a bundle a run's passes are in start
 * order. Only a log too large for the cap is cut: its budgets are halved, then it is dropped (its size kept); a first
 * bundle that cannot fit even so keeps only its identity, and its passes all go to the parts. Scrubbed as the
 * diagnostics are.
 */
export async function attemptLogsParts(raw, { record_id = null, cell = null, try: tryN = null } = {}, { scrub = scrubber(), headBytes = LOG_HEAD_BYTES, tailBytes = LOG_TAIL_BYTES, totalBytes = TOTAL_BYTES } = {}) {
  const w = readJson(join(raw, "try.json"))?.window ?? null;
  const hasWindow = Number.isFinite(w?.start) && Number.isFinite(w?.end);
  const window = hasWindow ? { start: isoMs(w.start), end: isoMs(w.end), run: w.run ?? null, valid: w.valid ?? null } : null;
  const runsDir = join(raw, "work", "runs", "release");
  const runIds = existsSync(runsDir)
    ? readdirSync(runsDir)
        .filter((d) => /^attempt-\d+$/.test(d))
        .map((d) => Number(d.slice(8)))
        .sort((a, b) => a - b)
    : [];
  // Each run's passes (null without a trace), and every pass in the order the bundles take them: overlapping the
  // window first, then by distance to it (the latest first without a window), then by start.
  const passes = new Map();
  const order = [];
  const distance = (s) => (!hasWindow ? -s.end_ms : s.start_ms < w.end && s.end_ms > w.start ? -Infinity : Math.min(Math.abs(s.start_ms - w.end), Math.abs(w.start - s.end_ms)));
  for (const k of runIds) {
    const spans = await maintenanceSpans(join(runsDir, `attempt-${k}`, "base", "userdata", "logs", "server.trace.ndjson"));
    passes.set(k, spans === null ? null : spans.length);
    for (const s of spans ?? []) {
      order.push({
        run: k,
        rank: distance(s),
        ms: s.start_ms,
        entry: {
          name: scrub(s.name),
          start: isoMs(s.start_ms),
          end: isoMs(s.end_ms),
          duration_ms: Math.round(s.end_ms - s.start_ms),
          exit: s.exit === null ? null : scrub(s.exit).slice(0, EXIT_CHARS),
          start_after_window_start_s: hasWindow ? tenths(s.start_ms - w.start) : null,
          end_after_window_end_s: hasWindow ? tenths(s.end_ms - w.end) : null,
          overlaps_window: hasWindow ? s.start_ms < w.end && s.end_ms > w.start : null,
        },
      });
    }
  }
  order.sort((a, b) => a.rank - b.rank || a.ms - b.ms || a.run - b.run);
  /** A slice of the order as each run's passes, in start order. */
  const byRun = (slice) => {
    const runs = new Map();
    for (const p of slice) {
      if (!runs.has(p.run)) runs.set(p.run, []);
      runs.get(p.run).push(p);
    }
    for (const list of runs.values()) list.sort((a, b) => a.ms - b.ms);
    return runs;
  };
  const serverLog = (file, head, tail, drop) => {
    const whole = headText(file, head + tail);
    if (whole === null) return null;
    if (drop) return { bytes: whole.bytes, truncated: true, head: "", tail: "", dropped: "over the size cap" };
    if (!whole.truncated) return { bytes: whole.bytes, truncated: false, head: scrub(whole.text), tail: "" };
    return { bytes: whole.bytes, truncated: true, head: scrub(headText(file, head).text), tail: scrub(tailText(file, tail).text) };
  };
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const identity = (kind) => ({ schema: LOGS_SCHEMA, kind, record_id, cell, try: tryN, at, window });
  // The first bundle with its first `kept` passes of the order; the logs are read once per budget.
  const logs = new Map();
  const logsAt = (scale, drop) => {
    const key = `${scale}/${drop}`;
    if (!logs.has(key)) logs.set(key, new Map(runIds.map((k) => [k, serverLog(join(runsDir, `attempt-${k}`, "server.log"), Math.floor(headBytes * scale), Math.floor(tailBytes * scale), drop)])));
    return logs.get(key);
  };
  const first = (scale, drop, kept, parts) => {
    const mine = byRun(order.slice(0, kept));
    const runLogs = logsAt(scale, drop);
    return {
      ...identity("attempt_logs"),
      parts,
      runs: runIds.map((k) => {
        const total = passes.get(k);
        const here = mine.get(k) ?? [];
        return {
          run: k,
          server_log: runLogs.get(k),
          maintenance_spans: total === null ? null : here.map((p) => p.entry),
          ...(total !== null && total > here.length ? { maintenance_spans_in_parts: total - here.length } : {}),
        };
      }),
      truncated: scale < 1 || drop,
    };
  };
  const part = (slice, n, parts) => ({
    ...identity("attempt_logs_passes"),
    part: n,
    parts,
    runs: [...byRun(slice)].sort(([a], [b]) => a - b).map(([k, list]) => ({ run: k, maintenance_spans: list.map((p) => p.entry) })),
  });
  const fits = (bundle) => writtenBytes(bundle) <= totalBytes;
  // The logs: halved until the first bundle fits with no pass beside them, then dropped.
  let scale = 1;
  let drop = false;
  while (!fits(first(scale, drop, 0, SIZING_NUMBER)) && (headBytes + tailBytes) * scale > 512) scale /= 2;
  if (!fits(first(scale, drop, 0, SIZING_NUMBER))) drop = true;
  const bare = !fits(first(scale, drop, 0, SIZING_NUMBER));
  // As many passes as fit beside them, then the rest in parts, each as full as it can be.
  const kept = bare ? 0 : most((n) => fits(first(scale, drop, n, SIZING_NUMBER)), 0, order.length);
  const slices = [];
  for (let i = kept; i < order.length; ) {
    const n = most((c) => fits(part(order.slice(i, i + c), SIZING_NUMBER, SIZING_NUMBER)), 0, order.length - i);
    if (n === 0) throw new Error("attempt logs: one maintenance pass is over the size cap");
    slices.push(order.slice(i, i + n));
    i += n;
  }
  const parts = slices.length + 1;
  const head = bare
    ? { ...identity("attempt_logs"), parts, runs: [], truncated: true, dropped: "over the size cap" }
    : first(scale, drop, kept, parts);
  return [head, ...slices.map((slice, i) => part(slice, i + 2, parts))];
}

/** A try's first attempt-logs bundle (attemptLogsParts): the logs and the passes that fit beside them. */
export async function attemptLogs(raw, ids = {}, options = {}) {
  return (await attemptLogsParts(raw, ids, options))[0];
}

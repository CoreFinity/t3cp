// maintenance_in_window: whether the server's history compaction (or prune) pass overlapped an attempt's measured
// window.
//
// run.ts seeds <base>/userdata/compacted-at = now (--seed-compacted-at). A server that reads that marker schedules
// its first pass min(6 h, max(1 min, marker + 6 h - now)) after start, so no pass is due during an attempt. Servers
// from before the marker start a full pass one minute after every start, about when the window opens. Which kind a
// release is comes from its own server binary, not from its version string, so nightly, fork and base records are
// told apart alike:
//   no "compacted-at" in the binary                         -> "unscheduled_pre_marker"
//   the marker, but no named compaction or prune span       -> "unobserved_no_span" (held off, but not countable)
//   the marker and a named span                             -> "count": the spans overlapping the window
// A pass still running when the harness stops the server is counted too: on SIGTERM the server's runtime
// interrupts it and writes its span (exit Interrupted) before the process exits (seen on a validation VM: an
// unseeded 10-31 attempt's compactEventStore span, Interrupted 0.5 s after the window, counted). After a SIGKILL (the
// harness sends one when its stop grace runs out) such spans may be missing, so a count is trusted only when the
// server stopped on SIGTERM; otherwise the value is null.
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const MAINTENANCE_SPANS = ["ProjectionMaintenance.compactEventStore", "ProjectionMaintenance.pruneEventStore"];
const MARKER = "compacted-at";

/** Which of the needles occur in the file, read in chunks (a needle split across two chunks is still found). */
async function occurring(file, needles, chunkSize) {
  const found = new Set();
  const keep = Math.max(...needles.map((n) => Buffer.byteLength(n))) - 1;
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { highWaterMark: chunkSize })) {
    const buf = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    for (const needle of needles) if (!found.has(needle) && buf.includes(needle)) found.add(needle);
    if (found.size === needles.length) break;
    tail = buf.subarray(Math.max(0, buf.length - keep));
  }
  return found;
}

/** The release's compaction scheduling from its server binary: "count", "unscheduled_pre_marker", "unobserved_no_span", or null. */
export async function maintenanceClass(serverBinary, { chunkSize = 8 * 1024 * 1024 } = {}) {
  if (!existsSync(serverBinary)) return null;
  const found = await occurring(serverBinary, [MARKER, ...MAINTENANCE_SPANS], chunkSize);
  if (!found.has(MARKER)) return "unscheduled_pre_marker";
  return MAINTENANCE_SPANS.some((name) => found.has(name)) ? "count" : "unobserved_no_span";
}

/**
 * Every compaction or prune span in the trace (and its rotated files .1, .2 ...), each once, by start:
 * {name, start_ms, end_ms, exit} (exit the span's exit tag, e.g. Success or Interrupt, else null); null without a
 * trace. A span without a start starts at its end less its duration.
 */
export async function maintenanceSpans(tracePath) {
  if (!existsSync(tracePath)) return null;
  const seen = new Set();
  const spans = [];
  for (let index = 0; ; index++) {
    const file = index === 0 ? tracePath : `${tracePath}.${index}`;
    if (!existsSync(file)) break;
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      if (!line.includes("ProjectionMaintenance.")) continue;
      let span;
      try {
        span = JSON.parse(line);
      } catch {
        continue;
      }
      if (!MAINTENANCE_SPANS.includes(span?.name)) continue;
      const end = Number(span.endTimeUnixNano) / 1e6;
      const start = span.startTimeUnixNano !== undefined ? Number(span.startTimeUnixNano) / 1e6 : end - Number(span.durationMs);
      if (!Number.isFinite(end) || !Number.isFinite(start) || end <= 0) continue;
      const key = span.spanId !== undefined ? `${span.traceId ?? ""}/${span.spanId}` : line;
      if (seen.has(key)) continue;
      seen.add(key);
      spans.push({ name: span.name, start_ms: start, end_ms: end, exit: typeof span.exit?._tag === "string" ? span.exit._tag : null });
    }
  }
  return spans.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
}

/**
 * Compaction or prune spans in the trace (and its rotated files) that overlap [startMs, endMs], each counted once;
 * null without a trace or a window.
 */
export async function maintenanceInWindow(tracePath, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !existsSync(tracePath)) return null;
  return (await maintenanceSpans(tracePath)).filter((s) => s.start_ms < endMs && s.end_ms > startMs).length;
}

/**
 * The shortest stop grace any harness gives the server before its SIGKILL (run.ts stopGroup(server, 30_000) in the
 * harness before server.stop; --stop-timeout, default 120 s, after it). Used only when run.json has no server.stop,
 * so it errs on the side of "maybe forced".
 */
export const STOP_GRACE_MS = 30_000;

const readJsonOrNull = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Whether the run's server stopped on SIGTERM. run.json's server.stop.forced decides when the harness records it;
 * else the server must have been gone (server-exit.json, procmon) less than STOP_GRACE_MS after the driver's teardown,
 * which precedes the SIGTERM, so the SIGKILL cannot have come. Unknown is not graceful.
 */
export function stoppedGracefully(runDir) {
  const forced = readJsonOrNull(join(runDir, "run.json"))?.server?.stop?.forced;
  if (typeof forced === "boolean") return !forced;
  const gone = Number(readJsonOrNull(join(runDir, "server-exit.json"))?.gone_ms);
  const teardown = Date.parse(readJsonOrNull(join(runDir, "driver", "driver.json"))?.timeline?.teardown ?? "");
  return Number.isFinite(gone) && Number.isFinite(teardown) && gone - teardown < STOP_GRACE_MS;
}

/**
 * The value for one try: the release's class, or the count from the valid run's trace; null without a valid run, a
 * trace, or a SIGTERM stop.
 */
export async function tryMaintenance(raw, window, cls) {
  if (cls === "unscheduled_pre_marker" || cls === "unobserved_no_span") return cls;
  if (cls !== "count" || !window?.valid || !Number.isInteger(window.run)) return null;
  const runDir = join(raw, "work", "runs", "release", `attempt-${window.run}`);
  if (!stoppedGracefully(runDir)) return null;
  return maintenanceInWindow(join(runDir, "base", "userdata", "logs", "server.trace.ndjson"), window.start, window.end);
}

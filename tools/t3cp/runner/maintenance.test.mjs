// maintenance_in_window: which kind of compaction scheduling a release's server has (from its own binary), and how
// many compaction or prune spans of an attempt's valid run overlap the measured window.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { maintenanceClass, maintenanceInWindow, tryMaintenance } from "./maintenance.mjs";

const root = mkdtempSync(join(tmpdir(), "t3cp-maintenance-"));
after(() => rmSync(root, { recursive: true, force: true }));

const binary = (name, text) => {
  const file = join(root, name);
  // Real server binaries are large and mostly not text: the strings sit among other bytes.
  writeFileSync(file, Buffer.concat([Buffer.alloc(5000, 0xfe), Buffer.from(text), Buffer.alloc(5000, 0x00)]));
  return file;
};

test("a server binary without the compaction marker never reads it: unscheduled_pre_marker", async () => {
  assert.equal(await maintenanceClass(binary("a", "statev2.sqlite ProjectionMaintenance.ts")), "unscheduled_pre_marker");
});

test("a server binary that reads the marker but names no pass span cannot be counted: unobserved_no_span", async () => {
  assert.equal(await maintenanceClass(binary("b", 'path.join(dir,"compacted-at") ProjectionMaintenance.ts')), "unobserved_no_span");
});

test("a server binary with the marker and a named compaction or prune span is counted", async () => {
  assert.equal(await maintenanceClass(binary("c", '"compacted-at" Effect.fn("ProjectionMaintenance.compactEventStore")')), "count");
  assert.equal(await maintenanceClass(binary("e", '"compacted-at" Effect.fn("ProjectionMaintenance.pruneEventStore")')), "count");
});

test("a string split across two read chunks is still found", async () => {
  const file = binary("split", '"compacted-at" ProjectionMaintenance.pruneEventStore');
  for (const chunkSize of [7, 64, 5003, 5010, 5020]) assert.equal(await maintenanceClass(file, { chunkSize }), "count", `chunk ${chunkSize}`);
});

test("a missing server binary has no class", async () => {
  assert.equal(await maintenanceClass(join(root, "no-such-binary")), null);
});

const span = (name, startMs, endMs, extra = {}) =>
  JSON.stringify({ name, durationMs: endMs - startMs, endTimeUnixNano: String(BigInt(Math.round(endMs)) * 1_000_000n), ...extra });

test("spans that overlap the window are counted, from the live trace and its rotated files, once each", async () => {
  const dir = join(root, "logs");
  mkdirSync(dir, { recursive: true });
  const trace = join(dir, "server.trace.ndjson");
  const ws = 1_800_000_000_000;
  const we = ws + 300_000;
  writeFileSync(
    trace,
    [
      span("ProjectionMaintenance.pruneEventStore", ws + 10_000, ws + 130_000, { spanId: "a" }), // inside
      span("ProjectionMaintenance.compactEventStore", ws - 60_000, ws + 5_000, { spanId: "b" }), // started before, ends inside
      span("ProjectionMaintenance.pruneEventStore", we - 1_000, we + 119_000, { spanId: "c" }), // starts inside, ends after
      span("ProjectionMaintenance.pruneEventStore", ws - 200_000, ws - 80_000, { spanId: "d" }), // before
      span("ProjectionMaintenance.pruneEventStore", we + 1, we + 120_000, { spanId: "e" }), // after
      span("Sqlite.setup", ws + 1_000, ws + 2_000), // another span
      "not json",
      "",
    ].join("\n"),
  );
  // A rotated file: one more overlapping span, and the live file's first span again (a rotation during the copy).
  writeFileSync(
    `${trace}.1`,
    `${span("ProjectionMaintenance.compactEventStore", ws + 200_000, ws + 210_000, { spanId: "f" })}\n${span("ProjectionMaintenance.pruneEventStore", ws + 10_000, ws + 130_000, { spanId: "a" })}\n`,
  );
  assert.equal(await maintenanceInWindow(trace, ws, we), 4);
});

test("a missing trace or window gives null, a trace with no such span 0", async () => {
  const ws = 1_800_000_000_000;
  assert.equal(await maintenanceInWindow(join(root, "nowhere", "server.trace.ndjson"), ws, ws + 1000), null);
  const quiet = join(root, "quiet.ndjson");
  writeFileSync(quiet, `${span("Sqlite.setup", ws, ws + 10)}\n`);
  assert.equal(await maintenanceInWindow(quiet, ws, ws + 1000), 0);
  assert.equal(await maintenanceInWindow(quiet, null, null), null);
});

test("a pass still running when the server stops is counted: its span is written, Interrupted, as the server shuts down", async () => {
  const trace = join(root, "interrupted.ndjson");
  const ws = 1_800_000_000_000;
  const we = ws + 300_000;
  // Started 20 s before the window ended; SIGTERM 1.8 s after the window interrupted it, and the runtime ended its span.
  writeFileSync(trace, `${span("ProjectionMaintenance.pruneEventStore", we - 20_000, we + 1_800, { exit: { _tag: "Interrupted", cause: "interrupted" } })}\n`);
  assert.equal(await maintenanceInWindow(trace, ws, we), 1);
});

/** A raw attempt dir whose run <k> has a trace (spans), the driver's teardown mark and, unless omitted, server-exit.json. */
function rawAttempt(name, { run = 2, spans = 1, goneAfterTeardownMs = 1_800, stop } = {}) {
  const raw = join(root, name);
  const runDir = join(raw, "work", "runs", "release", `attempt-${run}`);
  const logs = join(runDir, "base", "userdata", "logs");
  mkdirSync(logs, { recursive: true });
  mkdirSync(join(runDir, "driver"), { recursive: true });
  const ws = 1_800_000_000_000;
  const teardown = ws + 300_200;
  const lines = [];
  for (let i = 0; i < spans; i++) lines.push(span("ProjectionMaintenance.pruneEventStore", ws + 1 + i, ws + 2 + i));
  writeFileSync(join(logs, "server.trace.ndjson"), `${lines.join("\n")}\n`);
  writeFileSync(join(runDir, "driver", "driver.json"), JSON.stringify({ timeline: { teardown: new Date(teardown).toISOString() } }));
  if (goneAfterTeardownMs !== null) writeFileSync(join(runDir, "server-exit.json"), JSON.stringify({ gone_ms: teardown + goneAfterTeardownMs }));
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ valid: true, server: stop === undefined ? {} : { stop } }));
  return { raw, window: { start: ws, end: ws + 300_000, run, valid: true } };
}

test("an attempt's value follows the release's class, and is counted from the valid run's trace", async () => {
  const { raw, window } = rawAttempt("raw-class");
  assert.equal(await tryMaintenance(raw, window, "count"), 1);
  assert.equal(await tryMaintenance(raw, window, "unscheduled_pre_marker"), "unscheduled_pre_marker");
  assert.equal(await tryMaintenance(raw, window, "unobserved_no_span"), "unobserved_no_span");
  assert.equal(await tryMaintenance(raw, { ...window, valid: false }, "count"), null, "no valid run");
  assert.equal(await tryMaintenance(raw, { ...window, run: 3 }, "count"), null, "no trace for that run");
  assert.equal(await tryMaintenance(raw, window, null), null, "no class (no server binary)");
});

test("a count is only trusted when the server stopped on SIGTERM, before the harness's SIGKILL: else null", async () => {
  // The harness SIGTERMs the server after the driver's teardown and SIGKILLs it 30 s later. Gone within 30 s of
  // teardown, it shut down on SIGTERM: the runtime ended (and wrote) every span still open, an unfinished pass's too.
  const graceful = rawAttempt("raw-graceful", { goneAfterTeardownMs: 1_800 });
  assert.equal(await tryMaintenance(graceful.raw, graceful.window, "count"), 1);
  const late = rawAttempt("raw-late", { goneAfterTeardownMs: 30_000 });
  assert.equal(await tryMaintenance(late.raw, late.window, "count"), null, "may have been SIGKILLed: spans ended at shutdown may be missing");
  const unknown = rawAttempt("raw-unknown", { goneAfterTeardownMs: null });
  assert.equal(await tryMaintenance(unknown.raw, unknown.window, "count"), null, "no record of when the server went");
  // A harness that records the stop itself decides, whatever the timing.
  const forced = rawAttempt("raw-forced", { goneAfterTeardownMs: 1_800, stop: { forced: true } });
  assert.equal(await tryMaintenance(forced.raw, forced.window, "count"), null);
  const clean = rawAttempt("raw-clean", { goneAfterTeardownMs: null, stop: { forced: false } });
  assert.equal(await tryMaintenance(clean.raw, clean.window, "count"), 1);
  // The release's class needs no trace and no stop.
  assert.equal(await tryMaintenance(late.raw, late.window, "unscheduled_pre_marker"), "unscheduled_pre_marker");
});

test("a saturated run that is valid and stopped on SIGTERM gets a real count", async () => {
  const { raw, window } = rawAttempt("raw-saturated", { spans: 2, goneAfterTeardownMs: 1_800 });
  const run = join(raw, "work", "runs", "release", "attempt-2", "run.json");
  writeFileSync(run, JSON.stringify({
    valid: true,
    saturated: true,
    sessions_served: 31,
    sessions_total: 50,
    problems: [{ code: "sessions_starved", kind: "saturation" }],
    server: { stop: { forced: false, signal_to_exit_ms: 1_200 } },
  }));
  // The window comes from the runner's choice of run (lib attemptWindow: run.json valid), so valid is what counts.
  assert.equal(await tryMaintenance(raw, window, "count"), 2);
});

// Each try's server log and its maintenance passes' times are kept for PRIVATE storage only: one bounded, scrubbed
// bundle per try under <work>/attempt-logs (never under <out>), so pass times are measured, not inferred. The
// published export is the same bytes with and without them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { fakeSpec, writeRawAttempt } from "../lib/fake-raw.mjs";
import { attemptLogs, scrubber, writtenBytes } from "./diagnostics.mjs";
import { maintenanceInWindow, maintenanceSpans } from "./maintenance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "t3cp-attempt-logs-"));
  temps.push(d);
  return d;
};
const ns = (ms) => String(BigInt(Math.round(ms)) * 1000000n);
const WS = 1_795_000_000_000;
const WE = WS + 300_000;
const span = (name, startMs, endMs, extra = {}) => JSON.stringify({ name, startTimeUnixNano: ns(startMs), endTimeUnixNano: ns(endMs), durationMs: endMs - startMs, ...extra });

/** A raw try directory: try.json with the window, run attempt-<k> with the given server log and trace lines. */
function rawTry(root, { serverLog = null, trace = null, rotated = null, window = { start: WS, end: WE, run: 1, valid: true } } = {}) {
  const raw = join(root, "100-1");
  const run = join(raw, "work", "runs", "release", "attempt-1");
  mkdirSync(join(run, "base", "userdata", "logs"), { recursive: true });
  writeFileSync(join(raw, "try.json"), JSON.stringify({ try: 1, window }));
  if (serverLog !== null) writeFileSync(join(run, "server.log"), serverLog);
  const tracePath = join(run, "base", "userdata", "logs", "server.trace.ndjson");
  if (trace !== null) writeFileSync(tracePath, `${trace.join("\n")}\n`);
  if (rotated !== null) writeFileSync(`${tracePath}.1`, `${rotated.join("\n")}\n`);
  return { raw, run, tracePath };
}

test("the maintenance passes' own times come from the trace and its rotated files, each pass once", async () => {
  const { tracePath } = rawTry(tempDir(), {
    trace: [
      span("ProjectionMaintenance.pruneEventStore", WS - 30_000, WE + 4_000, { spanId: "a", traceId: "t", exit: { _tag: "Interrupt" } }),
      span("ProjectionMaintenance.pruneEventStore", WS - 30_000, WE + 4_000, { spanId: "a", traceId: "t", exit: { _tag: "Interrupt" } }),
      span("ProviderTurnStartService.start", WS + 1_000, WS + 1_100),
      "not json",
      // No start: it is the end less the duration, as maintenanceInWindow reads it.
      JSON.stringify({ name: "ProjectionMaintenance.compactEventStore", durationMs: 2_000, endTimeUnixNano: ns(WS - 100_000), spanId: "b" }),
    ],
    rotated: [span("ProjectionMaintenance.pruneEventStore", WS + 10_000, WS + 20_000, { spanId: "c", exit: { _tag: "Success" } })],
  });
  const spans = await maintenanceSpans(tracePath);
  assert.deepEqual(spans, [
    { name: "ProjectionMaintenance.compactEventStore", start_ms: WS - 102_000, end_ms: WS - 100_000, exit: null },
    { name: "ProjectionMaintenance.pruneEventStore", start_ms: WS - 30_000, end_ms: WE + 4_000, exit: "Interrupt" },
    { name: "ProjectionMaintenance.pruneEventStore", start_ms: WS + 10_000, end_ms: WS + 20_000, exit: "Success" },
  ]);
  // The count the attempt publishes is unchanged: the passes overlapping the window.
  assert.equal(await maintenanceInWindow(tracePath, WS, WE), 2);
  assert.deepEqual(await maintenanceSpans(join(tempDir(), "none.ndjson")), null);
});

test("a try's server log and maintenance pass times go into one bounded, scrubbed bundle for private storage", async () => {
  const middle = "x".repeat(200).concat("\n").repeat(20_000);
  const serverLog = `BOOT-LINE started\nkey acme-internal-42 on hostX\n${middle}token=abc123 LAST-LINE\n`;
  const { raw } = rawTry(tempDir(), {
    serverLog,
    trace: [span("ProjectionMaintenance.pruneEventStore", WS - 30_000, WE + 4_000, { spanId: "a", exit: { _tag: "Interrupt" } })],
  });
  // The host name the scrub must hide, held in a variable: a quoted host field reads as a real host to the public scan.
  const box = "hostX";
  const scrub = scrubber({ patterns: [/acme-internal-\d+/], hostname: box });
  const bundle = await attemptLogs(raw, { record_id: "2026-11-15.linux-x64.nightly", cell: "100-1", try: 1 }, { scrub, headBytes: 4_096, tailBytes: 65_536 });
  assert.equal(bundle.schema, "t3cp/attempt-logs/1");
  assert.deepEqual([bundle.kind, bundle.record_id, bundle.cell, bundle.try], ["attempt_logs", "2026-11-15.linux-x64.nightly", "100-1", 1]);
  assert.deepEqual(bundle.window, { start: new Date(WS).toISOString(), end: new Date(WE).toISOString(), run: 1, valid: true });
  assert.equal(bundle.runs.length, 1);
  const [run] = bundle.runs;
  assert.equal(run.run, 1);
  assert.equal(run.server_log.bytes, Buffer.byteLength(serverLog));
  assert.equal(run.server_log.truncated, true);
  assert.ok(run.server_log.head.startsWith("BOOT-LINE started\n"), "the head starts the log");
  assert.ok(run.server_log.tail.endsWith("LAST-LINE\n"), "the tail ends it");
  const text = JSON.stringify(bundle);
  assert.ok(!text.includes("acme-internal-42") && !text.includes("hostX") && !text.includes("abc123"), "scrubbed");
  assert.ok(text.includes("[private]") && text.includes("[host]"));
  assert.deepEqual(run.maintenance_spans, [
    {
      name: "ProjectionMaintenance.pruneEventStore",
      start: new Date(WS - 30_000).toISOString(),
      end: new Date(WE + 4_000).toISOString(),
      duration_ms: 334_000,
      exit: "Interrupt",
      start_after_window_start_s: -30,
      end_after_window_end_s: 4,
      overlaps_window: true,
    },
  ]);
  assert.ok(writtenBytes(bundle) <= 262_144);
  assert.equal(bundle.truncated, false);
});

test("a log too large for the cap halves its budget and keeps every pass; a try with no log or trace says so", async () => {
  const big = "y".repeat(1_000).concat("\n").repeat(2_000);
  const { raw } = rawTry(tempDir(), { serverLog: big, trace: [span("ProjectionMaintenance.pruneEventStore", WS + 1, WS + 2, { spanId: "z" })] });
  const bundle = await attemptLogs(raw, { record_id: "r", cell: "100-1", try: 2 }, { scrub: scrubber({ hostname: "" }), headBytes: 200_000, tailBytes: 200_000, totalBytes: 65_536 });
  assert.ok(writtenBytes(bundle) <= 65_536, String(writtenBytes(bundle)));
  assert.equal(bundle.truncated, true);
  assert.equal(bundle.runs[0].maintenance_spans.length, 1);
  const bare = await attemptLogs(rawTry(tempDir(), { window: null }).raw, { record_id: "r", cell: "100-1", try: 1 }, { scrub: scrubber({ hostname: "" }) });
  assert.deepEqual(bare.window, null);
  assert.deepEqual(bare.runs, [{ run: 1, server_log: null, maintenance_spans: null }]);
});

const exporter = join(here, "..", "export.mjs");
const lib = join(here, "lib.mjs");
const filesUnder = (dir) => readdirSync(dir, { recursive: true }).map((f) => join(dir, f)).filter((f) => statSync(f).isFile());

test("the published export is byte-identical with and without the private bundle, and never carries the log text", () => {
  const root = tempDir();
  const spec = structuredClone(fakeSpec());
  spec.fixture.path = join(root, "fixture.sqlite");
  spec.release.archive_path = join(root, "archive.tar.gz");
  writeFileSync(spec.fixture.path, Buffer.alloc(4096));
  writeFileSync(spec.release.archive_path, Buffer.alloc(2048));
  const specFile = join(root, "spec.json");
  writeFileSync(specFile, JSON.stringify(spec));
  const raw = writeRawAttempt(join(root, "raw"), { cell: "100", n: 1, spec });
  // The raw try as the harness leaves it: its server log (the exporter counts its lines, never copies them) and a
  // trace with a prune pass. Both are there whether or not the runner keeps a private bundle.
  const run = join(raw, "work", "runs", "release", "attempt-1");
  mkdirSync(join(run, "base", "userdata", "logs"), { recursive: true });
  writeFileSync(join(run, "server.log"), `${readFileSync(join(run, "server.log"), "utf8")}CANARY-server-log-7f3a pass started\n`);
  writeFileSync(join(run, "base", "userdata", "logs", "server.trace.ndjson"), `${span("ProjectionMaintenance.pruneEventStore", WS, WS + 9_000, { spanId: "p" })}\n`);
  writeFileSync(join(raw, "try.json"), JSON.stringify({ try: 1, window: { start: WS, end: WE, run: 1, valid: true } }));
  const exportTo = (out) => spawnSync(process.execPath, [exporter, raw, "--out", out, "--spec", specFile, "--no-private-patterns"], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" } });
  const without = join(root, "out-without", "100-1");
  const a = exportTo(without);
  assert.equal(a.status, 0, a.stderr);
  const rawBefore = filesUnder(raw).map((f) => [f, readFileSync(f).toString("base64")]);
  const logsDir = join(root, "work", "attempt-logs", "100-1");
  const made = spawnSync(process.execPath, [lib, "attempt-logs", raw, logsDir, spec.record_id, "100-1", "1"], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" } });
  assert.equal(made.status, 0, made.stderr);
  const bundleFile = made.stdout.trim();
  assert.equal(dirname(bundleFile), logsDir);
  assert.match(bundleFile, /\/\d{8}T\d{9}Z(-\d+)?\.attempt-logs\.json$/, "named apart from a failure bundle in the same part");
  const bundle = JSON.parse(readFileSync(bundleFile, "utf8"));
  assert.ok(bundle.runs[0].server_log.head.includes("CANARY-server-log-7f3a"), "the private bundle has the log");
  assert.equal(bundle.runs[0].maintenance_spans.length, 1);
  assert.deepEqual(filesUnder(raw).map((f) => [f, readFileSync(f).toString("base64")]), rawBefore, "the raw try is read, never written");
  const withBundle = join(root, "out-with", "100-1");
  const b = exportTo(withBundle);
  assert.equal(b.status, 0, b.stderr);
  const names = (dir) => filesUnder(dir).map((f) => f.slice(dir.length)).sort();
  assert.deepEqual(names(withBundle), names(without));
  // The exporter stamps each export with its own time (pipeline.exported_at, to the second): that value alone is
  // masked; every other byte must be the same.
  const bytesOf = (file) => readFileSync(file, "utf8").replace(/"exported_at":\s*"[^"]*"/g, '"exported_at": "<export time>"');
  for (const rel of names(without)) assert.equal(bytesOf(join(withBundle, rel)), bytesOf(join(without, rel)), `${rel}: byte-identical but for the export time`);
  for (const f of [...filesUnder(join(root, "out-without")), ...filesUnder(join(root, "out-with"))]) {
    assert.ok(!readFileSync(f, "utf8").includes("CANARY-server-log-7f3a"), `${f}: no log text is published`);
  }
});

test("passes alone over the cap: the bundle still fits, keeping the window's passes first and saying how many it dropped", async () => {
  const trace = [];
  // 1,497 passes long before the window, three overlapping it: far over 256 KiB as spans alone.
  for (let i = 0; i < 1_497; i++) trace.push(span("ProjectionMaintenance.pruneEventStore", WS - 10_000_000 + i * 5_000, WS - 10_000_000 + i * 5_000 + 1_000, { spanId: `old-${i}` }));
  for (let i = 0; i < 3; i++) trace.push(span("ProjectionMaintenance.compactEventStore", WS + i * 60_000, WS + i * 60_000 + 30_000, { spanId: `win-${i}` }));
  const { raw } = rawTry(tempDir(), { serverLog: "a short log\n", trace });
  const bundle = await attemptLogs(raw, { record_id: "r", cell: "100-1", try: 1 }, { scrub: scrubber({ hostname: "" }) });
  assert.ok(writtenBytes(bundle) <= 262_144, String(writtenBytes(bundle)));
  assert.equal(bundle.truncated, true);
  const [run] = bundle.runs;
  assert.ok(run.maintenance_spans.length >= 3 && run.maintenance_spans.length < 1_500, String(run.maintenance_spans.length));
  assert.equal(run.maintenance_spans.filter((s) => s.overlaps_window).length, 3, "every pass in the window is kept");
  assert.equal(run.maintenance_spans_dropped, 1_500 - run.maintenance_spans.length);
  const starts = run.maintenance_spans.map((s) => Date.parse(s.start));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "kept in start order");
});

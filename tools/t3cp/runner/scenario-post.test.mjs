// A scenario cell's post step turns its run directory into the raw scenario file: the long thread's turn-start block
// (the server trace's turn-start spans against the preload's per-second loop samples) and the event log's prune mark
// (read-only from the kept run's database). A value that cannot be measured is null with its reason, never 0.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { POST_METRICS, scenarioRaw, turnStartGap } from "./scenario-post.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "t3cp-scenario-post-"));
after(() => rmSync(root, { recursive: true, force: true }));
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const ns = (ms) => String(BigInt(Math.round(ms)) * 1000000n);

/** A run directory with turn-start spans at the given [start, end] ms offsets and the given loop samples. */
function runDir(name, spans, samples) {
  const dir = join(root, name);
  mkdirSync(join(dir, "base", "userdata", "logs"), { recursive: true });
  const lines = spans.map(([s, e]) => JSON.stringify({ name: "ProviderTurnStartService.start", startTimeUnixNano: ns(T0 + s), endTimeUnixNano: ns(T0 + e), durationMs: e - s }));
  lines.push(JSON.stringify({ name: "Sqlite.query", startTimeUnixNano: ns(T0 + 5), endTimeUnixNano: ns(T0 + 6), durationMs: 1 }));
  writeFileSync(join(dir, "base", "userdata", "logs", "server.trace.ndjson"), `${lines.join("\n")}\n`);
  if (samples) writeFileSync(join(dir, "loop-1hz.ndjson"), `${samples.map(([t, dt, max]) => JSON.stringify({ t: T0 + t, dt_ms: dt, delay: { max_ms: max } })).join("\n")}\n`);
  return dir;
}
const window = { start: T0, end: T0 + 600_000 };

test("the turn-start block is the largest loop delay over the samples that overlap the first 10 turn starts in the window", () => {
  // Starts every 30 s from 10 s; each takes 1 s, the 4th 4 s (a long block).
  const spans = Array.from({ length: 12 }, (_, i) => [10_000 + i * 30_000, 10_000 + i * 30_000 + (i === 3 ? 4_000 : 1_000)]);
  const samples = [
    [11_000, 1_000, 40], // overlaps start 1
    [104_000, 4_000, 3_900], // the 4th start's block
    [200_000, 1_000, 9_999], // between starts: not counted
    [341_000, 1_000, 8_888], // overlaps the 12th start: past the first 10, not counted
  ];
  const result = turnStartGap(runDir("ten", spans, samples), window);
  assert.equal(result.value, 3_900);
  assert.equal(result.reason, null);
  assert.equal(result.detail.starts_completed, 10);
});

test("fewer than 10 turn starts in the window: null with turn_start_incomplete, never a number", () => {
  const spans = Array.from({ length: 6 }, (_, i) => [10_000 + i * 30_000, 11_000 + i * 30_000]);
  const result = turnStartGap(runDir("six", spans, [[11_000, 1_000, 40]]), window);
  assert.equal(result.value, null);
  assert.equal(result.reason, "turn_start_incomplete");
  assert.equal(result.detail.starts_completed, 6);
  // A start before the window does not count towards the 10.
  const early = Array.from({ length: 10 }, (_, i) => [i === 0 ? -5_000 : 10_000 + i * 30_000, (i === 0 ? -4_000 : 11_000 + i * 30_000)]);
  assert.equal(turnStartGap(runDir("early", early, [[11_000, 1_000, 40]]), window).reason, "turn_start_incomplete");
});

test("no loop samples: null with no_loop_samples", () => {
  const spans = Array.from({ length: 10 }, (_, i) => [10_000 + i * 30_000, 11_000 + i * 30_000]);
  const result = turnStartGap(runDir("noloop", spans, null), window);
  assert.equal(result.value, null);
  assert.equal(result.reason, "no_loop_samples");
});

/** A database with (or without) the prune mark, made with Python's sqlite3, as the runner reads it. */
function database(name, markIso) {
  const db = join(root, `${name}.sqlite`);
  const sql = [
    "CREATE TABLE orchestration_v2_projection_metadata (projection_name TEXT PRIMARY KEY, schema_version INTEGER, last_sequence INTEGER, updated_at TEXT)",
    ...(markIso ? [`INSERT INTO orchestration_v2_projection_metadata VALUES ('event-log-prune-mark', 2, 151, '${markIso}')`] : []),
  ];
  const made = spawnSync("python3", ["-I", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); [c.execute(s) for s in sys.argv[2:]]; c.commit(); c.close()", db, ...sql], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  return db;
}
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const markOf = (db, endMs) => {
  const r = spawnSync("python3", ["-I", join(here, "prune-mark.py"), "--db", db, "--end-ms", String(endMs)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("the prune mark's age past the retained day, read-only: 3 days old reads 2, a mark set in the run reads 0", () => {
  const end = Date.UTC(2026, 11, 18, 12, 0, 0);
  const old = database("old", new Date(end - 3 * 86_400_000).toISOString());
  const before = sha(old);
  assert.deepEqual(markOf(old, end), { value: 2, reason: null, detail: { mark_updated_at: new Date(end - 3 * 86_400_000).toISOString(), end_at: new Date(end).toISOString() } });
  assert.equal(sha(old), before, "the database is read, never written");
  assert.equal(markOf(database("fresh", new Date(end - 60_000).toISOString()), end).value, 0);
});

test("no prune mark (or no metadata table): null with no_event_prune", () => {
  const end = Date.UTC(2026, 11, 18, 12, 0, 0);
  assert.deepEqual(markOf(database("nomark", null), end), { value: null, reason: "no_event_prune", detail: { mark_updated_at: null, end_at: new Date(end).toISOString() } });
  const empty = join(root, "empty.sqlite");
  spawnSync("python3", ["-I", "-c", "import sqlite3,sys; sqlite3.connect(sys.argv[1]).close()", empty]);
  assert.equal(markOf(empty, end).reason, "no_event_prune");
});

/** prune-mark.py --set-age-days: the mark re-dated in place, as the runner does on the attempt's fixture copy. */
const setMark = (db, days, nowMs) => {
  const r = spawnSync("python3", ["-I", join(here, "prune-mark.py"), "--db", db, "--set-age-days", String(days), "--now-ms", String(nowMs)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("the runner's pre-try step dates the prune mark N days before the try starts, and the post step then reads N - 1", () => {
  const now = Date.UTC(2026, 11, 18, 12, 0, 0);
  const stale = database("stale", new Date(now - 30 * 86_400_000).toISOString());
  const want = new Date(now - 3 * 86_400_000).toISOString();
  assert.deepEqual(setMark(stale, 3, now), { set: true, inserted: false, reason: null, mark_updated_at: want });
  assert.deepEqual(markOf(stale, now + 300_000).detail.mark_updated_at, want);
  assert.equal(markOf(stale, now + 300_000).value, 2);
});

test("re-dating a database in WAL mode leaves its write-ahead log checkpointed into the database file", () => {
  const now = Date.UTC(2026, 11, 18, 12, 0, 0);
  const db = database("wal", new Date(now - 30 * 86_400_000).toISOString());
  const wal = spawnSync("python3", ["-I", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('PRAGMA journal_mode=WAL').fetchone()[0]); c.close()", db], { encoding: "utf8" });
  assert.equal(wal.stdout.trim(), "wal");
  setMark(db, 3, now);
  const walFile = `${db}-wal`;
  assert.ok(!existsSync(walFile) || readFileSync(walFile).length === 0, "nothing left in the WAL");
  // A copy of the database file alone (as a restore copies it) holds the new mark.
  const copy = join(root, "wal-copy.sqlite");
  writeFileSync(copy, readFileSync(db));
  assert.equal(markOf(copy, now).detail.mark_updated_at, new Date(now - 3 * 86_400_000).toISOString());
});

/** A database as an era fixture has it: projection metadata (thread-projections), events, and no prune mark. */
function fixtureDb(name, { metadata = true } = {}) {
  const db = join(root, `${name}.sqlite`);
  const sql = metadata
    ? [
        "CREATE TABLE orchestration_v2_projection_metadata (projection_name TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, last_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL)",
        "INSERT INTO orchestration_v2_projection_metadata VALUES ('thread-projections', 7, 151, '2026-10-17T00:00:00.000Z')",
        "CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, payload TEXT)",
        "INSERT INTO orchestration_events (sequence, payload) VALUES (149, 'a'), (150, 'b'), (151, 'c')",
      ]
    : ["CREATE TABLE something_else (x INTEGER)"];
  const made = spawnSync("python3", ["-I", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); [c.execute(s) for s in sys.argv[2:]]; c.commit(); c.close()", db, ...sql], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  return db;
}
const rowsOf = (db) =>
  JSON.parse(spawnSync("python3", ["-I", "-c", "import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute('SELECT projection_name, schema_version, last_sequence, updated_at FROM orchestration_v2_projection_metadata ORDER BY projection_name').fetchall()))", db], { encoding: "utf8" }).stdout);

test("a fixture with no prune mark gets one: the projections' schema version, the event head, N days before the try", () => {
  const now = Date.UTC(2026, 11, 18, 12, 0, 0);
  const db = fixtureDb("nomark-set");
  const want = new Date(now - 3 * 86_400_000).toISOString();
  assert.deepEqual(setMark(db, 3, now), { set: true, inserted: true, reason: null, mark_updated_at: want });
  assert.deepEqual(rowsOf(db), [
    ["event-log-prune-mark", 7, 151, want],
    ["thread-projections", 7, 151, "2026-10-17T00:00:00.000Z"],
  ]);
  // Re-dated on the next try: the time moves, the sequence the mark covers does not.
  const later = now + 3_600_000;
  assert.equal(setMark(db, 3, later).inserted, false);
  assert.deepEqual(rowsOf(db)[0], ["event-log-prune-mark", 7, 151, new Date(later - 3 * 86_400_000).toISOString()]);
  assert.equal(markOf(db, later + 300_000).value, 2);
});

test("a database without projection metadata is left as it is: no_event_prune", () => {
  const now = Date.UTC(2026, 11, 18, 12, 0, 0);
  const db = fixtureDb("nometa", { metadata: false });
  const before = sha(db);
  assert.deepEqual(setMark(db, 3, now), { set: false, inserted: false, reason: "no_event_prune", mark_updated_at: null });
  assert.equal(sha(db), before);
});

test("a try with no valid run measures nothing: every metric of the step is null with no_run_window", () => {
  // A raw attempt whose only run.ts run is invalid, though it has a window and a full set of turn starts.
  const raw = join(root, "invalid-raw");
  const run = join(raw, "work", "runs", "release", "attempt-1");
  mkdirSync(join(run, "base", "userdata", "logs"), { recursive: true });
  writeFileSync(join(run, "run.json"), JSON.stringify({ valid: false, window: { start: new Date(T0).toISOString(), end: new Date(T0 + 600_000).toISOString() } }));
  const spans = Array.from({ length: 10 }, (_, i) => JSON.stringify({ name: "ProviderTurnStartService.start", startTimeUnixNano: ns(T0 + 10_000 + i * 30_000), endTimeUnixNano: ns(T0 + 11_000 + i * 30_000), durationMs: 1_000 }));
  writeFileSync(join(run, "base", "userdata", "logs", "server.trace.ndjson"), `${spans.join("\n")}\n`);
  writeFileSync(join(run, "loop-1hz.ndjson"), `${JSON.stringify({ t: T0 + 11_000, dt_ms: 1_000, delay: { max_ms: 40 } })}\n`);
  const out = scenarioRaw("turn-start-gap", raw, { id: "x", version: 1 });
  assert.equal(out.window.valid, false);
  assert.deepEqual(out.metrics, {
    turn_start_history_gap_ms: { value: null, reason: "no_run_window" },
    turn_start_long_thread_ms: { value: null, reason: "no_run_window" },
  });
});

test("the prune-mark post step writes prune_mark_age_days, the metric event-log-compaction@2 publishes", () => {
  assert.deepEqual(POST_METRICS["prune-mark"], ["prune_mark_age_days"]);
  // A valid try: the mark's age in the kept run's database, under that key.
  const raw = join(root, "prune-valid-raw");
  const run = join(raw, "work", "runs", "release", "attempt-1");
  mkdirSync(join(run, "base", "userdata"), { recursive: true });
  const end = T0 + 600_000;
  writeFileSync(join(run, "run.json"), JSON.stringify({ valid: true, window: { start: new Date(T0).toISOString(), end: new Date(end).toISOString() } }));
  writeFileSync(join(run, "base", "userdata", "statev2.sqlite"), readFileSync(database("prune-post", new Date(end - 3 * 86_400_000).toISOString())));
  const out = scenarioRaw("prune-mark", raw, { id: "event-log-compaction", version: 2 });
  assert.equal(out.window.valid, true);
  assert.deepEqual(out.metrics, { prune_mark_age_days: { value: 2, reason: null } });
  // A try with no valid run: the step's metric, null with no_run_window.
  const invalid = join(root, "prune-invalid-raw");
  const bad = join(invalid, "work", "runs", "release", "attempt-1");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "run.json"), JSON.stringify({ valid: false, window: { start: new Date(T0).toISOString(), end: new Date(end).toISOString() } }));
  assert.deepEqual(scenarioRaw("prune-mark", invalid, { id: "event-log-compaction", version: 2 }).metrics, { prune_mark_age_days: { value: null, reason: "no_run_window" } });
});

// A scenario cell's post step turns its run directory into the raw scenario file: the long thread's turn-start block
// (the server trace's turn-start spans against the preload's per-second loop samples) and the event log's prune mark
// (read-only from the kept run's database). A value that cannot be measured is null with its reason, never 0.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { turnStartGap } from "./scenario-post.mjs";

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

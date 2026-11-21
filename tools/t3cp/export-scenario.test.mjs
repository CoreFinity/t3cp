// The exporter on a scenario cell's raw directory (<cell>-<n>): the row of scenarios.json decides the cell, its load
// and the metrics; scenario.json gives the post step's values, release.result.json the shell-read span. An internal
// reason (the step could not measure) makes the attempt invalid; a public reason publishes null with that reason.
// Every input is hand-made synthetic data.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { exportAttempt, INTERNAL_SCENARIO_REASONS } from "./export.mjs";
import { fakeScenarioSpec, writeRawScenarioAttempt } from "./lib/fake-raw.mjs";
import { loadSchema } from "./lib/repo.mjs";
import { SCENARIO_REASONS, SCENARIO_REASON_WORDS } from "./lib/schemas.mjs";
import { validate } from "./lib/validate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-export-scenario-"));
  temps.push(d);
  return d;
};

const COMPACTION = {
  id: "event-log-compaction",
  version: 1,
  suite: "event-log-compaction@1",
  status: "active",
  added: "2026-11-21",
  harness: "t3cp-harness/2.0.2",
  platforms: ["linux-x64", "darwin-arm64"],
  fixture: "large-76",
  attempts: 3,
  metrics: ["event_log_unpruned_days"],
  cells: [{ name: "cmp", mode: "history", sessions: 1, subscribers: 1, pollers: 0, turn_gap: "5s", warmup_s: 60, window_s: 300, seed_compacted_at: false, post: "prune-mark", mark_age_days: 3 }],
};
const LONG_THREAD = {
  id: "long-thread-turn-start",
  version: 1,
  suite: "long-thread-turn-start@1",
  status: "active",
  added: "2026-11-21",
  harness: "t3cp-harness/2.0.2",
  platforms: ["linux-x64", "darwin-arm64"],
  fixture: "long-thread-1",
  attempts: 3,
  metrics: ["turn_start_history_gap_ms", "turn_start_long_thread_ms", "get_thread_shell_long_thread_ms"],
  cells: [{ name: "lt", mode: "history", sessions: 1, subscribers: 0, pollers: 0, turn_gap: "20s", warmup_s: 30, window_s: 600, seed_compacted_at: true, post: "turn-start-gap" }],
};
const SCENARIOS = { schema: "t3cp/scenarios/1", rows: [COMPACTION, LONG_THREAD] };
const opts = { privatePatterns: [], scenarios: SCENARIOS };
const ok = (value) => ({ value, reason: null });
const na = (reason) => ({ value: null, reason });

function compaction({ metrics = { event_log_unpruned_days: ok(2) }, spec, edit, n = 1 } = {}) {
  const root = tmp();
  const dir = writeRawScenarioAttempt(root, { row: COMPACTION, cell: "cmp", n, metrics, spec, edit });
  return { dir, spec: spec ?? fakeScenarioSpec(COMPACTION) };
}

const LT_OK = { turn_start_history_gap_ms: ok(812.5), turn_start_long_thread_ms: ok(240.125) };
function longThread({ metrics = LT_OK, shell, date = "2026-11-15", edit } = {}) {
  const root = tmp();
  const tag = `v0.1.10-nightly.${date.replaceAll("-", "")}.4749`;
  const spec = fakeScenarioSpec(LONG_THREAD, { record_id: `${date}.linux-x64.nightly`, release: { tag, version: tag.slice(1), date } });
  const dir = writeRawScenarioAttempt(root, { row: LONG_THREAD, cell: "lt", metrics, shell, spec, edit });
  return { dir, spec };
}

test("red first: a scenario cell's raw directory exports a t3cp/scenario-attempt/1 attempt with its row's metrics", () => {
  const { dir, spec } = compaction();
  const a = exportAttempt(dir, spec, opts);
  assert.equal(a.schema, "t3cp/scenario-attempt/1");
  assert.deepEqual(validate(loadSchema("scenario-attempt-1.json"), a), []);
  assert.equal(a.cell, "cmp");
  assert.equal(a.n, 1);
  assert.deepEqual(a.workload.scenario, { id: "event-log-compaction", version: 1 });
  assert.equal(a.workload.suite, "event-log-compaction@1");
  assert.equal(a.workload.attempts_per_cell, 3);
  assert.deepEqual(a.load, { sessions: 1, subscribers: 1, pollers: 0, mode: "history", turn_gap_s: 5, switch_interval_s: null, poll_interval_s: null, fixture: "era", warmup_s: 60, window_s: 300, seed_compacted_at: false, post: "prune-mark", mark_age_days: 3 });
  assert.equal(a.attempt.valid, true, a.attempt.problems.join(","));
  assert.deepEqual(a.metrics, { event_log_unpruned_days: 2 });
  assert.deepEqual(a.attempt.metric_reasons, {});
  assert.equal(a.fixture.id, "large-76");
});

test("a public reason publishes null with it; an internal reason makes the attempt invalid (scenario_unmeasured)", () => {
  let { dir, spec } = compaction({ metrics: { event_log_unpruned_days: na("no_event_prune") } });
  let a = exportAttempt(dir, spec, opts);
  assert.equal(a.attempt.valid, true);
  assert.deepEqual(a.metrics, { event_log_unpruned_days: null });
  assert.deepEqual(a.attempt.metric_reasons, { event_log_unpruned_days: "no_event_prune" });
  for (const reason of INTERNAL_SCENARIO_REASONS) {
    ({ dir, spec } = compaction({ metrics: { event_log_unpruned_days: na(reason) } }));
    a = exportAttempt(dir, spec, opts);
    assert.equal(a.attempt.valid, false, reason);
    assert.ok(a.attempt.problems.includes("scenario_unmeasured"), reason);
    assert.deepEqual(a.metrics, { event_log_unpruned_days: null }, reason);
    assert.deepEqual(a.attempt.metric_reasons, {}, `${reason} is never published`);
    assert.doesNotMatch(JSON.stringify(a), new RegExp(reason), `${reason} is never published`);
  }
  // A code neither list knows is never published either: the attempt is invalid.
  ({ dir, spec } = compaction({ metrics: { event_log_unpruned_days: na("something_new") } }));
  a = exportAttempt(dir, spec, opts);
  assert.equal(a.attempt.valid, false);
  assert.doesNotMatch(JSON.stringify(a), /something_new/);
  // No scenario.json at all: nothing was measured.
  ({ dir, spec } = compaction());
  fs.rmSync(path.join(dir, "scenario.json"));
  a = exportAttempt(dir, spec, opts);
  assert.equal(a.attempt.valid, false);
  assert.ok(a.attempt.problems.includes("scenario_unmeasured"));
});

test("the long-thread row: the shell-read p95 from release.result.json, null under 20 reads, and the eras' reasons", () => {
  let { dir, spec } = longThread({ shell: { count: 120, p95_ms: 4.25 } });
  let a = exportAttempt(dir, spec, opts);
  assert.equal(a.attempt.valid, true, a.attempt.problems.join(","));
  // Rounded as every published value is (report.ts: 3 decimals under 100, 1 above).
  assert.deepEqual(a.metrics, { turn_start_history_gap_ms: 812.5, turn_start_long_thread_ms: 240.1, get_thread_shell_long_thread_ms: 4.25 });
  ({ dir, spec } = longThread({ shell: { count: 19, p95_ms: 4.25 } }));
  a = exportAttempt(dir, spec, opts);
  assert.equal(a.metrics.get_thread_shell_long_thread_ms, null);
  assert.equal(a.attempt.metric_reasons.get_thread_shell_long_thread_ms, "shell_reads_missing");
  // Before the shell span's era (2026-10-26) the release has no such span: no_shell_span, whatever the count.
  ({ dir, spec } = longThread({ shell: null, date: "2026-10-22" }));
  a = exportAttempt(dir, spec, opts);
  assert.equal(a.metrics.get_thread_shell_long_thread_ms, null);
  assert.equal(a.attempt.metric_reasons.get_thread_shell_long_thread_ms, "no_shell_span");
  assert.equal(a.metrics.turn_start_history_gap_ms, 812.5, "the turn-start era began 10-20");
  // Before the turn-start span's era (2026-10-20) no start can be timed: the step's turn_start_incomplete reads
  // no_turn_start_span.
  ({ dir, spec } = longThread({ shell: null, date: "2026-10-18", metrics: { turn_start_history_gap_ms: na("turn_start_incomplete"), turn_start_long_thread_ms: na("turn_start_incomplete") } }));
  a = exportAttempt(dir, spec, opts);
  assert.equal(a.attempt.valid, true);
  assert.deepEqual(a.attempt.metric_reasons, { turn_start_history_gap_ms: "no_turn_start_span", turn_start_long_thread_ms: "no_turn_start_span", get_thread_shell_long_thread_ms: "no_shell_span" });
  // In the era, fewer than 10 starts is turn_start_incomplete; a valid attempt then carries no shell value either.
  ({ dir, spec } = longThread({ metrics: { turn_start_history_gap_ms: na("turn_start_incomplete"), turn_start_long_thread_ms: na("turn_start_incomplete") } }));
  a = exportAttempt(dir, spec, opts);
  assert.equal(a.attempt.metric_reasons.turn_start_history_gap_ms, "turn_start_incomplete");
  assert.equal(a.attempt.metric_reasons.get_thread_shell_long_thread_ms, "turn_start_incomplete");
  assert.equal(a.metrics.get_thread_shell_long_thread_ms, null);
});

test("the row decides: an unknown or retired row, a cell it lacks, other load arguments or another metric are refused", () => {
  const { dir, spec } = compaction();
  assert.throws(() => exportAttempt(dir, { ...spec, suite: { id: "nope@1", scenario: { id: "nope", version: 1 } } }, opts), /not in scenarios\.json/);
  const retired = { ...SCENARIOS, rows: [{ ...COMPACTION, status: "retired" }] };
  assert.throws(() => exportAttempt(dir, spec, { ...opts, scenarios: retired }), /retired/);
  assert.throws(() => exportAttempt(dir, { ...spec, suite: { ...spec.suite, id: "event-log-compaction@2" } }, opts), /suite/);
  const harness = compaction({ edit: (f) => (f.meta.harness.version = "t3cp-harness/1.9.9") });
  assert.throws(() => exportAttempt(harness.dir, harness.spec, opts), /harness t3cp-harness\/1\.9\.9 is not the row's/);
  const other = compaction({ edit: (f) => (f.meta.profile.subscribers = 3) });
  assert.throws(() => exportAttempt(other.dir, other.spec, opts), /load .*row's cell cmp/);
  const extra = compaction({ metrics: { event_log_unpruned_days: ok(2), turn_start_long_thread_ms: ok(1) } });
  assert.throws(() => exportAttempt(extra.dir, extra.spec, opts), /turn_start_long_thread_ms.*not one of the row's metrics/);
  const missing = compaction({ metrics: {} });
  assert.throws(() => exportAttempt(missing.dir, missing.spec, opts), /event_log_unpruned_days.*missing/);
  const negative = compaction({ metrics: { event_log_unpruned_days: ok(-1) } });
  assert.throws(() => exportAttempt(negative.dir, negative.spec, opts), /negative/);
  const root = tmp();
  const wrongCell = writeRawScenarioAttempt(root, { row: { ...COMPACTION, cells: [{ ...COMPACTION.cells[0], name: "xyz" }] }, cell: "xyz", metrics: { event_log_unpruned_days: ok(2) } });
  assert.throws(() => exportAttempt(wrongCell, spec, opts), /cell xyz/);
});

test("maintenance in the window is what an unseeded cell measures: it stays valid there, and invalidates elsewhere", () => {
  let { dir, spec } = compaction({ edit: (f) => (f.meta.maintenance_in_window = 2) });
  let a = exportAttempt(dir, spec, opts);
  assert.equal(a.attempt.valid, true);
  assert.equal(a.attempt.maintenance_in_window, 2);
  ({ dir, spec } = longThread({ edit: (f) => (f.meta.maintenance_in_window = 2) }));
  a = exportAttempt(dir, spec, opts);
  assert.equal(a.attempt.valid, false);
  assert.ok(a.attempt.problems.includes("maintenance_in_window"));
  // maintenance_expected on a seeded cell is the runner contradicting the row: refused.
  ({ dir, spec } = longThread({ edit: (f) => (f.meta.maintenance_expected = true) }));
  assert.throws(() => exportAttempt(dir, spec, opts), /maintenance_expected/);
});

test("the CLI exports a scenario cell with the repository's scenarios.json", () => {
  const { dir, spec } = compaction();
  const out = tmp();
  const specFile = path.join(out, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const r = spawnSync(process.execPath, [path.join(here, "export.mjs"), dir, "--out", path.join(out, "o"), "--spec", specFile, "--no-private-patterns"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const a = JSON.parse(fs.readFileSync(path.join(out, "o", "attempt.json"), "utf8"));
  assert.equal(a.schema, "t3cp/scenario-attempt/1");
  assert.deepEqual(a.metrics, { event_log_unpruned_days: 2 });
});

test("the public scenario reasons each have plain words; the internal ones are never public", () => {
  assert.deepEqual(SCENARIO_REASONS, ["no_turn_start_span", "turn_start_incomplete", "no_shell_span", "shell_reads_missing", "no_event_prune"]);
  for (const r of SCENARIO_REASONS) assert.ok(typeof SCENARIO_REASON_WORDS[r] === "string" && SCENARIO_REASON_WORDS[r].length > 20, r);
  assert.deepEqual(INTERNAL_SCENARIO_REASONS, ["no_run_window", "no_loop_samples", "db_unreadable", "mark_unreadable"]);
  for (const r of INTERNAL_SCENARIO_REASONS) assert.ok(!SCENARIO_REASONS.includes(r));
  const attemptSchema = JSON.stringify(loadSchema("scenario-attempt-1.json"));
  const recordSchema = JSON.stringify(loadSchema("scenario-record-1.json"));
  for (const r of INTERNAL_SCENARIO_REASONS) {
    assert.ok(!attemptSchema.includes(`"${r}"`) && !recordSchema.includes(`"${r}"`), `${r} is in no public schema`);
  }
});

test("review: a ladder attempt's era block names only the ladder's feature eras, as before the scenario metrics", async () => {
  const { writeRawAttempt, fakeSpec } = await import("./lib/fake-raw.mjs");
  const { loadCatalogue } = await import("./lib/repo.mjs");
  const catalogue = loadCatalogue();
  const scenarioOnly = new Set(catalogue.metrics.filter((m) => m.lane === "scenario").map((m) => m.era));
  for (const m of catalogue.metrics) if (m.lane !== "scenario") scenarioOnly.delete(m.era);
  assert.ok(scenarioOnly.size > 0);
  const dir = writeRawAttempt(tmp(), { cell: "100", n: 1 });
  const a = exportAttempt(dir, fakeSpec(), { privatePatterns: [] });
  for (const id of [...a.era.has, ...a.era.missing]) assert.ok(!scenarioOnly.has(id), `${id} is a scenario-only era`);
  const before = catalogue.feature_eras.filter((e) => !scenarioOnly.has(e.id)).map((e) => e.id);
  assert.deepEqual([...a.era.has, ...a.era.missing].sort(), before.sort());
});

test("review: the cell's warm-up and window are checked as the runner and run.ts ran them, and the measured window", () => {
  // No suite block in attempt-meta.json: the cell's timings are unproven, refused.
  let { dir, spec } = compaction({ edit: (f) => delete f.meta.suite });
  assert.throws(() => exportAttempt(dir, spec, opts), /suite/);
  ({ dir, spec } = compaction({ edit: (f) => (f.meta.suite.warmup_s = 0) }));
  assert.throws(() => exportAttempt(dir, spec, opts), /warm-up or window/);
  ({ dir, spec } = compaction({ edit: (f) => (f.result.knobs.workload.window_s = 10) }));
  assert.throws(() => exportAttempt(dir, spec, opts), /run\.ts ran another warm-up or window/);
  // A measured window well short of the cell's is no measurement of it.
  ({ dir, spec } = compaction({ edit: (f) => (f.run.window.end = new Date(Date.parse(f.run.window.start) + 10_000).toISOString()) }));
  const a = exportAttempt(dir, spec, opts);
  assert.equal(a.attempt.valid, false);
  assert.ok(a.attempt.problems.includes("window_too_short"));
});

test("review: the post step's window must be the valid run the exporter chose; another window is no measurement", () => {
  const cases = [
    { start_ms: 1, end_ms: 2, run: 1, valid: true },
    { run: 99 },
    { valid: false },
  ];
  for (const change of cases) {
    const root = tmp();
    const base = { start_ms: Date.parse("2026-11-15T10:01:00Z"), end_ms: Date.parse("2026-11-15T10:06:00Z"), run: 1, valid: true };
    const dir = writeRawScenarioAttempt(root, { row: COMPACTION, cell: "cmp", metrics: { event_log_unpruned_days: ok(2) }, window: { ...base, ...change } });
    const a = exportAttempt(dir, fakeScenarioSpec(COMPACTION), opts);
    assert.equal(a.attempt.valid, false, JSON.stringify(change));
    assert.ok(a.attempt.problems.includes("scenario_unmeasured"), JSON.stringify(change));
    assert.deepEqual(a.metrics, { event_log_unpruned_days: null });
  }
});

test("review: any internal or unknown reason, or a value with a public reason, is no measurement", () => {
  for (const entry of [{ value: 2, reason: "db_unreadable" }, { value: 2, reason: "something_new" }, { value: 2, reason: "no_event_prune" }]) {
    const { dir, spec } = compaction({ metrics: { event_log_unpruned_days: entry } });
    const a = exportAttempt(dir, spec, opts);
    assert.equal(a.attempt.valid, false, JSON.stringify(entry));
    assert.ok(a.attempt.problems.includes("scenario_unmeasured"), JSON.stringify(entry));
    assert.deepEqual(a.metrics, { event_log_unpruned_days: null });
    assert.doesNotMatch(JSON.stringify(a.attempt.metric_reasons), /db_unreadable|something_new/);
  }
});

test("review: scenario.json carries the post step's metrics only; another metric's entry is refused", () => {
  const { dir, spec } = longThread({ metrics: { ...LT_OK, get_thread_shell_long_thread_ms: { value: 2, reason: "db_unreadable" } } });
  assert.throws(() => exportAttempt(dir, spec, opts), /get_thread_shell_long_thread_ms is not a post-step metric/);
});

test("review: the run the exporter chose must have run the cell: its driver's mode, sessions and fixture threads", () => {
  let { dir, spec } = compaction({ edit: (f) => Object.assign(f.run.driver.workload, { mode: "fresh", fixture_thread_sessions: 0, new_thread_sessions: 1 }) });
  assert.throws(() => exportAttempt(dir, spec, opts), /driver ran mode fresh/);
  ({ dir, spec } = compaction({ edit: (f) => Object.assign(f.run.driver.workload, { sessions: 50 }) }));
  assert.throws(() => exportAttempt(dir, spec, opts), /50 sessions/);
  ({ dir, spec } = compaction({ edit: (f) => Object.assign(f.run.driver.workload, { fixture_thread_sessions: 0, new_thread_sessions: 1 }) }));
  assert.throws(() => exportAttempt(dir, spec, opts), /fixture threads/);
});

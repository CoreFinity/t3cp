// The aggregator per suite: records of every scenarios.json row are accepted under
// data/v1/scenarios/<id>/<version>/{records,fork,base}/ and kept in their own series; a record of no row, or under the
// wrong path, is refused; each harness is checked against its own pin; a scenario's eras never reach another's
// series, and the ladder's outputs are the same with or without scenario records. Inputs are hand-made synthetic
// records (tools/t3cp/lib/fake.mjs, fake-scenario.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BUDGETS, buildOutputs, BuildError, checkBudgets } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { FAKE_PUBLIC_REFS, HARNESS, HARNESS_B, fakeAttempts, fakeExtras, fakeIdentity } from "../../tools/t3cp/lib/fake.mjs";
import { fakeScenarioRecord, scenarioRecordPath } from "../../tools/t3cp/lib/fake-scenario.mjs";
import { loadCatalogue, loadScenarios, loadSchema } from "../../tools/t3cp/lib/repo.mjs";
import { validate } from "../../tools/t3cp/lib/validate.mjs";

const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const LADDER_ROW = loadScenarios().rows.find((r) => r.id === "ladder" && r.version === 1);
const cell = (name, over = {}) => ({ name, mode: "history", sessions: 1, subscribers: 1, pollers: 0, turn_gap: "5s", warmup_s: 60, window_s: 300, seed_compacted_at: true, post: "turn-start-gap", ...over });
const COMPACTION = {
  id: "event-log-compaction", version: 1, suite: "event-log-compaction@1", status: "active", added: "2026-11-21", harness: HARNESS.version,
  platforms: ["linux-x64", "darwin-arm64"], fixture: "large-76", attempts: 3, metrics: ["event_log_unpruned_days"],
  cells: [cell("cmp", { seed_compacted_at: false, post: "prune-mark", mark_age_days: 3 })],
};
const SECOND = {
  id: "second-row", version: 1, suite: "second-row@1", status: "active", added: "2026-11-21", harness: HARNESS.version,
  platforms: ["linux-x64", "darwin-arm64"], fixture: "large-76", attempts: 3, metrics: ["turn_start_history_gap_ms", "turn_start_long_thread_ms"],
  cells: [cell("a"), cell("b", { subscribers: 0 })],
};
const SECOND_V2 = { ...SECOND, version: 2, suite: "second-row@2", harness: HARNESS_B.version };
const SCENARIOS = { schema: "t3cp/scenarios/1", rows: [LADDER_ROW, COMPACTION, SECOND, SECOND_V2] };

function nightly(date) {
  const identity = fakeIdentity({ date });
  const attempts = fakeAttempts(catalogue, identity, { jitter: 0 });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
}
const HEADLINE_BANDS = Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }]));
const BANDS = { schema: "t3cp/bands/1", method: "test bands", platforms: { "linux-x64": { measured: { from: "2026-11-01", to: "2026-11-02", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" }, metrics: HEADLINE_BANDS } } };
const LADDER = [0, 1, 2].map((i) => nightly(addDays("2026-11-10", i)));

function writeTree(ladder, scenarioRecords = [], raw = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-scenarios-"));
  temps.push(dir);
  const put = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  for (const r of ladder) put(`records/${r.platform.id}/${r.release.date}.${r.release.tag}.json`, r);
  for (const r of scenarioRecords) put(scenarioRecordPath(r), r);
  put("bands.json", BANDS);
  for (const [rel, v] of Object.entries(raw)) put(rel, v);
  return dir;
}
const build = (dir, extra = {}) => buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS, scenarios: SCENARIOS, warn: () => {}, ...extra });
const compaction = (date, value = (_id, _c, n) => 1 + n / 10, extra = {}) => fakeScenarioRecord({ row: COMPACTION, date, value, ...extra });
const second = (date, extra = {}) => fakeScenarioRecord({ row: SECOND, date, value: (id, c, n) => (id === "turn_start_history_gap_ms" ? 800 + n : 200 + n) + (c === "b" ? 50 : 0), ...extra });
const shard = (files, row, platform, metric) => {
  const rel = `scenarios/${row.id}/${row.version}/series/${platform}/${metric}.json`;
  assert.ok(files.has(rel), `${rel} is built`);
  return JSON.parse(files.get(rel).toString("utf8"));
};

test("red first: a second suite's records are accepted and kept in their own series", () => {
  const dates = ["2026-11-10", "2026-11-11", "2026-11-12"];
  const files = build(writeTree(LADDER, dates.map((d) => compaction(d))));
  const s = shard(files, COMPACTION, "linux-x64", "event_log_unpruned_days");
  assert.equal(s.schema, "t3cp/scenario-series/1");
  assert.deepEqual(validate(loadSchema("scenario-series-1.json"), s), []);
  assert.equal(s.suite, "event-log-compaction@1");
  assert.deepEqual(s.nightly.dates, dates);
  assert.deepEqual(Object.keys(s.nightly.cells), ["cmp"]);
  assert.deepEqual(s.nightly.cells.cmp.median, [1.2, 1.2, 1.2]);
  assert.ok(s.nightly.cells.cmp.segment.every((id) => Number.isInteger(id)));
  // The record itself is published beside the series, re-serialised.
  const rel = scenarioRecordPath(compaction(dates[0]));
  assert.deepEqual(JSON.parse(files.get(rel).toString("utf8")), compaction(dates[0]));
  const index = JSON.parse(files.get("scenarios/index.json").toString("utf8"));
  assert.deepEqual(validate(loadSchema("scenarios-index-1.json"), index), []);
  assert.deepEqual(index.rows.map((r) => r.suite), ["event-log-compaction@1"]);
  assert.equal(index.rows[0].platforms["linux-x64"].records, 3);
  // The ladder's outputs are the same with or without the scenario records.
  const ladderOnly = build(writeTree(LADDER));
  const ladderFiles = (m) => [...m.keys()].filter((k) => !k.startsWith("scenarios/")).sort();
  assert.deepEqual(ladderFiles(files), ladderFiles(ladderOnly));
  for (const rel of ladderFiles(ladderOnly)) assert.ok(files.get(rel).equals(ladderOnly.get(rel)), `${rel} moved`);
  assert.deepEqual([...ladderOnly.keys()].filter((k) => k.startsWith("scenarios/")), [], "no scenario output without scenario records");
});

test("a scenario's eras and segments are its own: adding another scenario's records changes none of its files", () => {
  const dates = ["2026-11-10", "2026-11-11"];
  const alone = build(writeTree(LADDER, dates.map((d) => compaction(d))));
  // The second row's records start at another fixture sha (a rebuilt fixture): an era and a segment of its own.
  const others = [second(dates[0]), second(dates[1])];
  others[1].fixture.sha256 = "e".repeat(64);
  const both = build(writeTree(LADDER, [...dates.map((d) => compaction(d)), ...others]));
  for (const [rel, bytes] of alone) {
    if (rel.startsWith(`scenarios/${COMPACTION.id}/`)) assert.ok(both.get(rel)?.equals(bytes), `${rel} moved`);
  }
  const s = shard(both, SECOND, "linux-x64", "turn_start_history_gap_ms");
  assert.deepEqual(Object.keys(s.nightly.cells), ["a", "b"]);
  assert.notEqual(s.nightly.cells.a.segment[0], s.nightly.cells.a.segment[1], "a rebuilt fixture starts a new segment");
  assert.ok(s.eras.some((e) => e.kind === "fixture" && e.date === dates[1]));
  assert.deepEqual(shard(both, COMPACTION, "linux-x64", "event_log_unpruned_days").eras, []);
  // Cells of one row with other loads never share a segment.
  assert.notEqual(s.nightly.cells.a.segment[0], s.nightly.cells.b.segment[0]);
});

test("a metric's era starts within its own scenario's series only", () => {
  // event_prune starts 2026-11-04: records before it carry the era's reason, and the series marks the start.
  const dates = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
  const records = dates.map((d) => (d < "2026-11-04" ? compaction(d, () => null, { reason: () => "no_event_prune" }) : compaction(d)));
  const files = build(writeTree(LADDER, records));
  const s = shard(files, COMPACTION, "linux-x64", "event_log_unpruned_days");
  assert.deepEqual(s.nightly.cells.cmp.median, [null, null, 1.2, 1.2]);
  assert.deepEqual(s.nightly.cells.cmp.reason, ["no_event_prune", "no_event_prune", null, null]);
  assert.deepEqual(s.eras, [{ date: "2026-11-04", kind: "metric", label: catalogue.feature_eras.find((e) => e.id === "event_prune").what }]);
  const index = JSON.parse(files.get("index.json").toString("utf8"));
  assert.ok(!index.eras.feature.some((e) => e.id === "event_prune"), "the ladder's index names no scenario era");
});

test("refused: a record of no row, a record under another row's path or another file name, and a ladder suite under scenarios/", () => {
  const good = compaction("2026-11-10");
  const stray = { ...good, workload: { ...good.workload, suite: "nope@1", scenario: { id: "nope", version: 1 } } };
  assert.throws(() => build(writeTree(LADDER, [], { [scenarioRecordPath(stray)]: stray })), (e) => e instanceof BuildError && /not a row of scenarios\.json/.test(e.message));
  const rel = scenarioRecordPath(good);
  assert.throws(() => build(writeTree(LADDER, [], { [rel.replace("/1/", "/2/")]: good })), (e) => e instanceof BuildError && /path/.test(e.message));
  assert.throws(() => build(writeTree(LADDER, [], { [rel.replace("2026-11-10.", "2026-11-11.")]: good })), (e) => e instanceof BuildError && /file name/.test(e.message));
  // A scenario record under the ladder's paths is refused, and a ladder record under scenarios/.
  assert.throws(() => build(writeTree(LADDER, [], { [`records/linux-x64/2026-11-13.${good.release.tag}.json`]: good })), (e) => e instanceof BuildError && /suite/.test(e.message));
  const ladder = LADDER[0];
  assert.throws(() => build(writeTree(LADDER, [], { [`scenarios/event-log-compaction/1/records/linux-x64/${ladder.release.date}.${ladder.release.tag}.json`]: ladder })), BuildError);
  // A record that runs another harness than its row pins is refused.
  const otherHarness = fakeScenarioRecord({ row: { ...COMPACTION, harness: HARNESS_B.version }, date: "2026-11-10", harness: HARNESS_B });
  assert.throws(() => build(writeTree(LADDER, [otherHarness])), (e) => e instanceof BuildError && /harness/.test(e.message));
});

test("several harness pins: each record is checked against its own version's pin; hashes that differ are refused", () => {
  const v1 = second("2026-11-10");
  const v2 = fakeScenarioRecord({ row: SECOND_V2, date: "2026-11-10", harness: HARNESS_B, value: () => 5 });
  const files = build(writeTree(LADDER, [v1, v2]));
  assert.ok(files.has("scenarios/second-row/1/series/linux-x64/turn_start_long_thread_ms.json"));
  assert.ok(files.has("scenarios/second-row/2/series/linux-x64/turn_start_long_thread_ms.json"));
  const refs = structuredClone(FAKE_PUBLIC_REFS);
  refs.harness[HARNESS_B.version].files_sha256 = "0".repeat(64);
  assert.throws(() => build(writeTree(LADDER, [v1, v2]), { publicRefs: refs }), (e) => e instanceof BuildError && /second-row\/2\/.*files_sha256 is not the pinned public tree's/.test(e.message));
});

test("the size budgets hold with one added scenario of two cells on 45 records", () => {
  const records = Array.from({ length: 45 }, (_, i) => second(addDays("2026-10-02", i)));
  const files = build(writeTree(LADDER, records));
  const sizes = checkBudgets(files, BUDGETS);
  const scenarioSizes = [...sizes].filter(([rel]) => rel.startsWith("scenarios/"));
  assert.ok(scenarioSizes.length > 45, "every scenario file is under a budget");
  const shardBudget = BUDGETS.find((b) => b.prefix === "scenarios/").limit;
  for (const [rel, size] of scenarioSizes) assert.ok(size <= shardBudget, `${rel}: ${size}`);
});

test("review: a scenario record must implement its row: scenario, attempts, fixture, platform, each cell's load and the row's metrics", () => {
  const good = compaction("2026-11-10");
  const variants = {
    scenario: (r) => (r.workload.scenario = { id: "second-row", version: 1 }),
    attempts: (r) => (r.workload.attempts_per_cell = 2),
    fixture: (r) => (r.fixture = { ...r.fixture, id: "large-63" }),
    platform: (r) => {
      r.platform = { ...r.platform, id: "darwin-arm64" };
      r.record_id = r.record_id.replace("linux-x64", "darwin-arm64");
    },
    load: (r) => (r.workload.cells.cmp = { ...r.workload.cells.cmp, sessions: 50, window_s: 10 }),
    "load missing": (r) => delete r.workload.cells.cmp,
    "metric missing": (r) => delete r.cells.cmp.metrics.event_log_unpruned_days,
  };
  const narrowRow = { ...COMPACTION, platforms: ["linux-x64"] };
  for (const [what, edit] of Object.entries(variants)) {
    const r = structuredClone(good);
    edit(r);
    const rel = what === "platform" ? scenarioRecordPath(r) : scenarioRecordPath(good);
    const scenarios = what === "platform" ? { ...SCENARIOS, rows: [LADDER_ROW, narrowRow, SECOND, SECOND_V2] } : SCENARIOS;
    assert.throws(() => build(writeTree(LADDER, [], { [rel]: r }), { scenarios }), (e) => e instanceof BuildError && /its row|row's|workload\.cells/.test(e.message), what);
  }
  // A partial record (a cell with no attempts) is still published.
  const partial = structuredClone(good);
  delete partial.cells.cmp;
  delete partial.workload.cells.cmp;
  partial.status = "partial";
  partial.status_reason = "attempts_invalid";
  assert.doesNotThrow(() => build(writeTree(LADDER, [partial])));
});

test("review: each scenario's series keeps its own time: a newer record of another scenario moves none of its files", () => {
  const alone = build(writeTree(LADDER, [compaction("2026-11-10")]));
  const later = second("2026-11-12");
  later.pipeline.generated_at = "2026-11-20T18:00:00Z";
  const both = build(writeTree(LADDER, [compaction("2026-11-10"), later]));
  for (const [rel, bytes] of alone) {
    if (rel.startsWith(`scenarios/${COMPACTION.id}/`)) assert.ok(both.get(rel)?.equals(bytes), `${rel} moved`);
  }
});

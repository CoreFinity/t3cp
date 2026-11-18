// Aggregator findings of the independent review: strict parsing and re-serialised copies (M2), counters and zero
// references (M5), mandatory bands (M6), validation fixtures and file names (m7), status.json (m8) and the
// reference-window mutants (m9). Inputs are hand-made synthetic records.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildOutputs, BuildError } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from "../../tools/t3cp/lib/fake.mjs";
import { loadCatalogue } from "../../tools/t3cp/lib/repo.mjs";

const catalogue = loadCatalogue();
const j = (...parts) => parts.join("");
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function nightly(date, values = () => undefined, extra = {}) {
  const identity = fakeIdentity({ date, ...extra });
  const attempts = fakeAttempts(catalogue, identity, { value: (id, cell) => values(id, cell, date), jitter: 0 });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
}

/** Bands for every headline metric (a measured platform needs them) plus the ones a test names. */
const HEADLINE_BANDS = Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }]));
const BANDS = (metrics = { ...HEADLINE_BANDS, turns_completed: { band: 4.6, n: 6 }, stall_share_500ms: { band: 10, n: 6 } }) => ({
  schema: "t3cp/bands/1",
  method: "test bands",
  platforms: { "linux-x64": { measured: { from: "2026-11-01", to: "2026-11-02", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" }, metrics } },
});

function writeTree(records, { bands = BANDS(), raw = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-review-"));
  temps.push(dir);
  for (const r of records) {
    const file = path.join(dir, "records", r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  if (bands) fs.writeFileSync(path.join(dir, "bands.json"), `${JSON.stringify(bands, null, 2)}\n`);
  for (const [rel, text] of Object.entries(raw)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const series = (files, metric) => JSON.parse(files.get(`series/linux-x64/${metric}.latest.json`).toString("utf8"));
const ladder = (n, values) => Array.from({ length: n }, (_, i) => nightly(addDays("2026-11-01", i), (id, cell, date) => values(id, cell, i, date)));

// M2 ------------------------------------------------------------------------------------------------------
test("M2: a duplicate key in a record fails the build; copied inputs are published re-serialised", () => {
  const records = ladder(4, () => undefined);
  const dir = writeTree(records);
  const file = path.join(dir, "records", "linux-x64", `${records[1].release.date}.${records[1].release.tag}.json`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"status": "complete"', '"status": "partial", "status": "complete"'));
  assert.throws(() => buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && /duplicate key/.test(e.message));
  const clean = writeTree(records);
  const rel = `records/linux-x64/${records[0].release.date}.${records[0].release.tag}.json`;
  const files = buildOutputs(clean, { publicRefs: FAKE_PUBLIC_REFS });
  assert.equal(files.get(rel).toString("utf8"), `${JSON.stringify(JSON.parse(fs.readFileSync(path.join(clean, rel), "utf8")))}\n`);
});

// M5 ------------------------------------------------------------------------------------------------------
test("M5: counters flag any value above zero absolutely, with no percentage and no band needed", () => {
  const records = ladder(10, (id, cell, i) => (cell === "100" && id === "server_warn_lines" ? (i === 9 ? 1 : 0) : cell === "100" && id === "buffer_full_warnings" ? 3 : undefined));
  const files = buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS });
  const warn = series(files, "server_warn_lines");
  assert.equal(warn.levels["100"].verdict[9], "regressed");
  assert.equal(warn.levels["100"].delta[9], null, "no percentage for a counter");
  assert.equal(warn.levels["100"].verdict[8], "within");
  // Since decision D2 a log-line counter flags only a rise: a steady 3 is within noise.
  const full = series(files, "buffer_full_warnings");
  assert.equal(full.levels["100"].verdict[9], "within");
  assert.ok(catalogue.metrics.find((m) => m.id === "client_errors").counter);
});

test("M5: a non-counter with a zero reference: zero is within noise, anything else is noted zero_reference", () => {
  const records = ladder(10, (id, cell, i) => (cell === "100" && id === "stall_share_500ms" ? (i === 9 ? 2.5 : 0) : undefined));
  const s = series(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "stall_share_500ms");
  assert.equal(s.levels["100"].verdict[8], "within");
  assert.equal(s.levels["100"].verdict[9], null);
  assert.equal(s.levels["100"].note[9], "zero_reference");
  assert.equal(s.levels["100"].delta[9], null);
});

// M6 ------------------------------------------------------------------------------------------------------
test("M6: a platform with records and no bands fails the build unless bands.json marks it pending", () => {
  const records = ladder(4, () => undefined);
  assert.throws(() => buildOutputs(writeTree(records, { bands: null }), { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && /bands/.test(e.message));
  const noPlatform = { schema: "t3cp/bands/1", method: "test bands", platforms: {} };
  assert.throws(() => buildOutputs(writeTree(records, { bands: noPlatform }), { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && /linux-x64/.test(e.message));
  const pending = { schema: "t3cp/bands/1", method: "noise-band run pending", platforms: { "linux-x64": { pending: true } } };
  const s = series(buildOutputs(writeTree(records, { bands: pending }), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  assert.equal(s.levels["100"].note[3], "no_band");
  assert.equal(s.threshold, null);
});

// m7 ------------------------------------------------------------------------------------------------------
test("m7: a base record on a validation fixture, and a record whose id disagrees with its file name, fail", () => {
  const records = ladder(3, () => undefined);
  const base = nightly("2026-11-01", () => undefined, { kind: "base", sha: "c".repeat(40), tag: "v0.1.9" });
  base.fixture.id = "large-76-s2";
  const dir = writeTree(records, { raw: { [`base/${"c".repeat(12)}.linux-x64.json`]: `${JSON.stringify(base)}\n` } });
  assert.throws(() => buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && /validation record/.test(e.message));
  const odd = ladder(3, () => undefined);
  odd[1].record_id = "2026-11-09.linux-x64.nightly";
  assert.throws(() => buildOutputs(writeTree(odd), { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && /record_id/.test(e.message));
});

// m8 ------------------------------------------------------------------------------------------------------
test("m8: status.json is parsed strictly and published re-serialised", () => {
  const records = ladder(3, () => undefined);
  const home = j("/ho", "me/x");
  assert.throws(() => buildOutputs(writeTree(records, { raw: { "status.json": `{"a":"ok","a":"${home}"}\n` } }), { publicRefs: FAKE_PUBLIC_REFS }), /duplicate key/);
  assert.throws(() => buildOutputs(writeTree(records, { raw: { "status.json": "[1,2]\n" } }), { publicRefs: FAKE_PUBLIC_REFS }), /status\.json/);
  const doc = '{ "schema" : "t3cp/status/1",\n  "generated_at": "2026-11-03T06:00:00Z", "platforms": {} }\n';
  const files = buildOutputs(writeTree(records, { raw: { "status.json": doc } }), { publicRefs: FAKE_PUBLIC_REFS });
  assert.equal(files.get("status.json").toString("utf8"), '{"schema":"t3cp/status/1","generated_at":"2026-11-03T06:00:00Z","platforms":{}}\n');
});

// m9 ------------------------------------------------------------------------------------------------------
test("m9: the reference is the median of exactly the previous seven complete records", () => {
  // Prior values, oldest first: 300, then four at 100, then three at 300. The last seven give 100; eight would give 200.
  const prior = [300, 100, 100, 100, 100, 300, 300, 300];
  const records = ladder(9, (id, cell, i) => (cell === "100" && id === "turns_completed" ? (i < 8 ? prior[i] : 100) : undefined));
  const s = series(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  assert.equal(s.levels["100"].ref[8], 100);
});

test("m9: partial records never enter the reference window", () => {
  // Three complete records at 300, then three partial ones at 900, then the judged record.
  const records = ladder(7, (id, cell, i) => (cell === "100" && id === "turns_completed" ? (i < 3 ? 300 : i < 6 ? 900 : 300) : undefined));
  for (const r of records.slice(3, 6)) r.status = "partial";
  const s = series(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  assert.equal(s.levels["100"].ref[6], 300);
  assert.equal(s.levels["100"].thin[6], false);
});

test("m9: a change of the profile name alone starts a new reference window", () => {
  const records = ladder(8, (id, cell, i) => (cell === "100" && id === "turns_completed" ? (i < 5 ? 300 : 150) : undefined));
  for (const r of records.slice(5)) r.workload.profile = "primary-scaled";
  const s = series(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  assert.equal(s.levels["100"].note[5], "no_reference");
});

test("distribution tolerance: a cell's recorded tolerance is carried, and a change of it starts a new reference window", () => {
  const records = ladder(8, (id, cell, i) => (cell === "100" && id === "turns_completed" ? (i < 5 ? 300 : 150) : undefined));
  for (const r of records) r.workload.cells["100"].distribution_tolerance = 2.5;
  for (const r of records.slice(5)) r.workload.cells["100"].distribution_tolerance = 3;
  const files = buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS });
  const s = series(files, "turns_completed");
  assert.equal(s.levels["100"].note[5], "no_reference");
  assert.ok(s.eras.some((e) => e.kind === "profile" && e.date === records[5].release.date));
  const index = JSON.parse(files.get("index.json").toString("utf8"));
  assert.deepEqual(index.headline_levels, [1, 50, 100, 250]);
  assert.equal(index.default_headline_level, 50);
});

// D1, D2 --------------------------------------------------------------------------------------------------
test("D1: absolute counters flag on any record, the first one and the first after an era boundary included", () => {
  const records = Array.from({ length: 4 }, (_, i) => nightly(addDays("2026-10-29", i), (id, cell) => (cell === "100" && id === "client_errors" ? 2 : undefined)));
  const s = series(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "client_errors");
  assert.equal(s.levels["100"].verdict[0], "regressed", "the first record");
  assert.equal(s.levels["100"].verdict[s.dates.indexOf("2026-10-31")], "regressed", "the first record of the new fixture era");
});

test("D2: log-line counters flag only a rise above the reference; a steady non-zero count is within noise", () => {
  const values = [5, 5, 5, 5, 5, 5, 5, 5, 6];
  const records = ladder(9, (id, cell, i) => (cell === "100" && id === "server_warn_lines" ? values[i] : undefined));
  const s = series(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "server_warn_lines");
  assert.equal(s.levels["100"].verdict[0], null);
  assert.equal(s.levels["100"].note[0], "no_reference");
  assert.equal(s.levels["100"].verdict[7], "within", "steady at 5");
  assert.equal(s.levels["100"].verdict[8], "regressed", "a rise to 6 above the reference of 5");
  assert.equal(s.levels["100"].delta[8], null, "no percentage for a counter");
});

// minors --------------------------------------------------------------------------------------------------
test("3: only the published suite is accepted under records/, fork/ and base/", () => {
  const records = ladder(3, () => undefined);
  records[1].workload.suite = "val-smoke";
  assert.throws(() => buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && /suite/.test(e.message));
  const bands = ladder(3, () => undefined);
  bands[2].workload.suite = "bands-1";
  assert.throws(() => buildOutputs(writeTree(bands), { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && /suite/.test(e.message));
});

test("4: status.json follows its strict schema: enumerated reason codes, no free text", () => {
  const records = ladder(3, () => undefined);
  const good = {
    schema: "t3cp/status/1",
    generated_at: "2026-11-16T06:00:00Z",
    platforms: {
      "linux-x64": {
        latest_record_id: records[2].record_id,
        latest_date: records[2].release.date,
        latest_status: "complete",
        queue: { pending: 1, active: 1 },
        last_failure: { record_id: records[1].record_id, at: "2026-11-15T02:00:00Z", reason: "preempted" },
        heartbeat_at: "2026-11-16T05:59:00Z",
      },
    },
  };
  assert.doesNotThrow(() => buildOutputs(writeTree(records, { raw: { "status.json": JSON.stringify(good) } }), { publicRefs: FAKE_PUBLIC_REFS }));
  const free = structuredClone(good);
  free.platforms["linux-x64"].last_failure.reason = "the VM was preempted in zone b";
  assert.throws(() => buildOutputs(writeTree(records, { raw: { "status.json": JSON.stringify(free) } }), { publicRefs: FAKE_PUBLIC_REFS }), /status\.json/);
  const extra = structuredClone(good);
  extra.platforms["linux-x64"].note = "x";
  assert.throws(() => buildOutputs(writeTree(records, { raw: { "status.json": JSON.stringify(extra) } }), { publicRefs: FAKE_PUBLIC_REFS }), /status\.json/);
});

test("6: a measured platform's bands must be non-empty and cover the eight headline metrics", () => {
  const records = ladder(3, () => undefined);
  const missing = BANDS({ turns_completed: { band: 4.6, n: 6 } });
  assert.throws(() => buildOutputs(writeTree(records, { bands: missing }), { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && /headline/.test(e.message));
  const empty = BANDS({});
  assert.throws(() => buildOutputs(writeTree(records, { bands: empty }), { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && /bands/.test(e.message));
});

// The ladder decision (a) ----------------------------------------------------------------------------------
const saturate = (record, level, served) => {
  const cell = record.cells[level];
  cell.saturated = true;
  cell.metrics.agents_served = { median: served, min: served, max: served, n: 3, values: [served, served, served] };
};

test("saturated: at a saturated level latency and the other metrics are context (note saturated); turns and agents served keep verdicts", () => {
  const bands = BANDS({ ...HEADLINE_BANDS, turns_completed: { band: 4.6, n: 6 }, turn_p95_ms: { band: 10, n: 6 }, agents_served: { band: 2, n: 6 } });
  const records = ladder(9, (id, cell, i) => (cell === "250" && id === "turns_completed" ? (i === 8 ? 200 : 300) : cell === "250" && id === "turn_p95_ms" ? (i === 8 ? 900 : 300) : undefined));
  for (const r of records) r.cells["250"].metrics.agents_served = { median: 250, min: 250, max: 250, n: 3, values: [250, 250, 250] };
  saturate(records[8], "250", 180);
  const files = buildOutputs(writeTree(records, { bands }), { publicRefs: FAKE_PUBLIC_REFS });
  const latency = series(files, "turn_p95_ms");
  assert.equal(latency.levels["250"].verdict[8], null);
  assert.equal(latency.levels["250"].note[8], "saturated");
  assert.equal(latency.levels["250"].saturated[8], true);
  assert.equal(latency.levels["250"].saturated[7], false);
  assert.equal(series(files, "turns_completed").levels["250"].verdict[8], "regressed");
  assert.equal(series(files, "agents_served").levels["250"].verdict[8], "regressed");
  const changes = JSON.parse(files.get("changes.json").toString("utf8"));
  assert.ok(!changes.items.some((c) => c.metric === "turn_p95_ms" && c.level === "250"), "no saturated latency in the feed");
});

test("saturated: saturated records never enter a latency reference", () => {
  const bands = BANDS({ ...HEADLINE_BANDS, turn_p95_ms: { band: 10, n: 6 } });
  const records = ladder(9, (id, cell, i) => (cell === "250" && id === "turn_p95_ms" ? (i === 7 ? 5000 : 300) : undefined));
  saturate(records[7], "250", 100);
  const s = series(buildOutputs(writeTree(records, { bands }), { publicRefs: FAKE_PUBLIC_REFS }), "turn_p95_ms");
  assert.equal(s.levels["250"].ref[8], 300);
  assert.equal(s.levels["250"].verdict[8], "within");
});

// The compaction decision (b) ------------------------------------------------------------------------------
test("compaction schedule era: its own era; no reference or band crosses the boundary; the first record after it starts a new window", () => {
  const records = Array.from({ length: 8 }, (_, i) => nightly(addDays("2026-10-17", i), (id, cell) => (cell === "100" && id === "turns_completed" ? 300 : undefined)));
  for (const r of records.slice(0, 3)) r.compaction_schedule = "unscheduled";
  for (const r of records.slice(3)) r.compaction_schedule = "scheduled";
  const s = series(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  assert.equal(s.levels["100"].note[2], "no_band", "bands are measured in the scheduled era");
  assert.equal(s.levels["100"].note[3], "no_reference", "10-20 opens a new window");
  assert.ok(s.eras.some((e) => e.kind === "compaction" && e.date === "2026-10-20" && e.label === "compaction schedule era"));
});

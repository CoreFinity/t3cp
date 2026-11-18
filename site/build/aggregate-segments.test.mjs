// records-index.json publishes the aggregator's own comparability, so the browser's compare never re-implements it:
// per record and platform, `segment` maps each level to an opaque integer (equal exactly when the aggregator would
// compare two records at that level: fixture era, harness, suite, profile, the cell's load arguments and the
// compaction era, with an unknown era unique to its record) and `banded` says whether a noise band applies (the
// scheduled compaction era only). Inputs are hand-made synthetic records.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildOutputs } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS, HARNESS_B, publicHarness } from "../../tools/t3cp/lib/fake.mjs";
import { loadCatalogue, loadSchema } from "../../tools/t3cp/lib/repo.mjs";
import { validate } from "../../tools/t3cp/lib/validate.mjs";

const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function nightly(date) {
  const identity = fakeIdentity({ date });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0 }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
}
const HEADLINE_BANDS = Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }]));
const BANDS = {
  schema: "t3cp/bands/1",
  method: "test bands",
  platforms: { "linux-x64": { measured: { from: "2026-11-01", to: "2026-11-02", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" }, metrics: HEADLINE_BANDS } },
};
function writeTree(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-seg-"));
  temps.push(dir);
  for (const r of records) {
    const file = path.join(dir, "records", r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(dir, "bands.json"), `${JSON.stringify(BANDS, null, 2)}\n`);
  return dir;
}

test("segment: equal exactly where the aggregator compares; an unknown compaction era is unique; banded only in the scheduled era", () => {
  const records = Array.from({ length: 9 }, (_, i) => nightly(addDays("2026-11-01", i)));
  for (const r of records) r.compaction_schedule = "scheduled";
  records[2].harness = publicHarness(HARNESS_B); // another (pinned) harness
  records[3].workload.cells["100"] = { ...records[3].workload.cells["100"], subscribers: 4 }; // other load at 100 only
  records[4].compaction_schedule = null; // unknown era
  records[5].compaction_schedule = null; // another unknown record
  records[6].compaction_schedule = "unscheduled";
  const files = buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS });
  const ri = JSON.parse(files.get("records-index.json").toString("utf8"));
  assert.deepEqual(validate(loadSchema("records-index-1.json"), ri), []);
  const at = (i) => ri.records[i].platforms["linux-x64"];
  const levels = ["1", "50", "100", "150", "200", "250", "1e", "once"];
  for (let i = 0; i < 9; i++) {
    assert.deepEqual(Object.keys(at(i).segment), levels, `record ${i}: every level the record has`);
    for (const L of levels) assert.ok(Number.isInteger(at(i).segment[L]) && at(i).segment[L] >= 0, `${i} ${L}: an opaque index`);
  }
  const same = (i, j, L) => at(i).segment[L] === at(j).segment[L];
  for (const L of levels) {
    assert.ok(same(0, 1, L) && same(0, 7, L) && same(1, 8, L), `${L}: records alike compare`);
    assert.ok(!same(0, 2, L), `${L}: another harness never compares`);
    assert.ok(!same(0, 4, L) && !same(4, 5, L), `${L}: an unknown era compares with nothing, not even another unknown`);
    assert.ok(!same(0, 6, L), `${L}: the unscheduled era does not compare with the scheduled one`);
  }
  assert.ok(!same(0, 3, "100") && same(0, 3, "50") && same(0, 3, "once"), "other load arguments at 100 change only 100");
  assert.deepEqual(ri.records.map((r) => r.platforms["linux-x64"].banded), [true, true, true, true, false, false, false, true, true]);
  // Opaque: small integers, never names, hashes or era words.
  for (const r of ri.records) assert.ok(Object.values(r.platforms["linux-x64"].segment).every((v) => typeof v === "number"), "only integers");
});

test("segment ids are stable: a record inserted mid-series with a segment of its own renumbers no other record", () => {
  // The backfill commits records out of date order. Records 0-2 share a segment, record 3 starts another (a new
  // harness) and keeps it; an unknown-era record later inserted between 2 and 3 must leave every other id alone.
  const dates = [0, 1, 2, 4, 5, 6].map((d) => addDays("2026-11-01", d));
  const records = dates.map((d) => nightly(d));
  for (const r of records.slice(3)) r.harness = publicHarness(HARNESS_B);
  const inserted = nightly(addDays("2026-11-01", 3));
  inserted.compaction_schedule = null;
  const ids = (files) => {
    const ri = JSON.parse(files.get("records-index.json").toString("utf8"));
    return new Map(ri.records.map((r) => [r.date, r.platforms["linux-x64"].segment]));
  };
  const before = ids(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }));
  const after = ids(buildOutputs(writeTree([...records, inserted]), { publicRefs: FAKE_PUBLIC_REFS }));
  for (const d of dates) assert.deepEqual(after.get(d), before.get(d), `${d} keeps its ids`);
  assert.notDeepEqual(before.get(dates[3]), before.get(dates[2]), "the test covers a second segment after the insertion point");
  const own = Object.values(after.get(addDays("2026-11-01", 3)));
  for (const d of dates) assert.ok(Object.values(after.get(d)).every((id) => !own.includes(id)), `${d} shares no id with the unknown-era record`);
});

test("compare files: where no band applies (unscheduled or unknown era), a row's band and threshold are null, never the metric's", () => {
  const records = Array.from({ length: 4 }, (_, i) => nightly(addDays("2026-11-01", i)));
  for (const r of records) r.compaction_schedule = "scheduled";
  records[1].compaction_schedule = "unscheduled";
  records[2].compaction_schedule = "unscheduled";
  const files = buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS });
  const rowsOf = (a, b) => JSON.parse(files.get(`compare/${records[a].release.tag}__${records[b].release.tag}.linux-x64.json`).toString("utf8")).rows;
  assert.ok(rowsOf(1, 2).some((r) => r.note === "no_band"), "the unscheduled pair has rows without a band");
  for (const [a, b] of [[0, 1], [1, 2], [2, 3]]) {
    for (const r of rowsOf(a, b).filter((x) => x.note === "no_band")) assert.deepEqual([r.band, r.threshold], [null, null], `${a}-${b} ${r.metric} ${r.level}`);
  }
  // A banded pair still shows its band.
  const banded = rowsOf(2, 3);
  assert.ok(banded.length > 0);
});

// The reference window is the contiguous run of the record's segment at that level, so it never
// reaches back across another segment, even to records of the same segment before it (a harness that returns).
const shard = (files, id) => JSON.parse(files.get(`series/linux-x64/${id}.latest.json`).toString("utf8"));

test("a reference window never crosses another segment: a returning harness (A, B, A) starts over with no reference and no verdict", () => {
  const records = Array.from({ length: 9 }, (_, i) => nightly(addDays("2026-11-01", i)));
  for (const r of records) r.compaction_schedule = "scheduled";
  records[4].harness = publicHarness(HARNESS_B); // B between two runs of A
  const s = shard(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed").levels["100"];
  assert.equal(s.verdict[3], "within", "inside the first run of A: a reference and a verdict");
  assert.equal(s.ref[4], null, "the first record of B");
  assert.equal(s.verdict[4], null);
  assert.equal(s.ref[5], null, "A again: the first record after a boundary, no reference from the first run");
  assert.equal(s.verdict[5], null);
  assert.equal(s.note[5], "no_reference");
  assert.equal(s.dod_verdict[5], null, "nor a day-over-day verdict");
  assert.equal(s.thin[6], true, "the run starts over: one record of reference");
  assert.equal(s.verdict[6], "within");
});

test("a reference window never crosses another segment at its level: other load at one level and back restarts only that level", () => {
  const records = Array.from({ length: 6 }, (_, i) => nightly(addDays("2026-11-01", i)));
  for (const r of records) r.compaction_schedule = "scheduled";
  records[2].workload.cells["100"] = { ...records[2].workload.cells["100"], subscribers: 4 }; // other load at 100 on one day
  const s = shard(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  assert.equal(s.levels["100"].ref[3], null, "100: the load came back, the run starts over");
  assert.equal(s.levels["100"].verdict[3], null);
  assert.notEqual(s.levels["50"].ref[3], null, "50: one unbroken run, its reference stays");
  assert.equal(s.levels["50"].verdict[3], "within");
});

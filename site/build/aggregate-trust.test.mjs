// The aggregator re-derives what a record states instead of trusting it (the delta re-review): a cell's saturated flag
// must be the merge's rule over its attempts and agents served, and a record that cannot say its compaction schedule
// era (null) is an era of its own: no band, no reference across it. Inputs are hand-made synthetic records.
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
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function nightly(date, values = () => undefined) {
  const identity = fakeIdentity({ date });
  const attempts = fakeAttempts(catalogue, identity, { value: (id, cell) => values(id, cell), jitter: 0 });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
}
const HEADLINE_BANDS = Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }]));
const BANDS = {
  schema: "t3cp/bands/1",
  method: "test bands",
  platforms: { "linux-x64": { measured: { from: "2026-11-01", to: "2026-11-02", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" }, metrics: { ...HEADLINE_BANDS, turns_completed: { band: 4.6, n: 6 } } } },
};
function writeTree(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-trust-"));
  temps.push(dir);
  for (const r of records) {
    const file = path.join(dir, "records", r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(dir, "bands.json"), `${JSON.stringify(BANDS, null, 2)}\n`);
  return dir;
}
const series = (files, metric) => JSON.parse(files.get(`series/linux-x64/${metric}.latest.json`).toString("utf8"));

test("cell.saturated: a record whose cell flag disagrees with its attempts and agents served is refused, either way", () => {
  const records = Array.from({ length: 3 }, (_, i) => nightly(addDays("2026-11-01", i)));
  assert.ok(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }).size > 0, "consistent records build");
  // Attempts saturated (and the median agents served below the cell's agents), the cell says not.
  const hidden = structuredClone(records);
  const cell = hidden[2].cells["250"];
  for (const a of cell.attempts) {
    a.saturated = true;
    a.saturated_by = ["sessions_starved"];
  }
  cell.metrics.agents_served = { median: 210, min: 205, max: 215, n: 3, values: [205, 210, 215] };
  cell.saturated = false;
  assert.throws(() => buildOutputs(writeTree(hidden), { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && /saturated/.test(e.message));
  // The cell says saturated, nothing under it does.
  const claimed = structuredClone(records);
  claimed[2].cells["100"].saturated = true;
  assert.throws(() => buildOutputs(writeTree(claimed), { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && /saturated/.test(e.message));
});

test("compaction schedule null: its own era, with no band and no reference from either neighbouring era", () => {
  const records = Array.from({ length: 6 }, (_, i) => nightly(addDays("2026-10-17", i), (id, cell) => (cell === "100" && id === "turns_completed" ? 300 : undefined)));
  records[0].compaction_schedule = "unscheduled";
  records[1].compaction_schedule = null;
  records[2].compaction_schedule = "unscheduled";
  for (const r of records.slice(3)) r.compaction_schedule = "scheduled";
  records[4].compaction_schedule = null;
  const s = series(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed").levels["100"];
  assert.equal(s.note[1], "no_band", "an unknown era gets no band");
  assert.equal(s.ref[1], null, "and no reference from the unscheduled era before it");
  assert.equal(s.ref[2], null, "nor does the unscheduled record after it reach back across it");
  assert.equal(s.note[4], "no_band");
  assert.equal(s.ref[4], null, "no reference from the scheduled era either");
  assert.equal(s.ref[5], null, "and the scheduled record after it starts a new window");
});

test("compaction schedule null between scheduled records: the later reference never reaches back across it, and the mark says the era is unknown", () => {
  // The reviewer's case: scheduled 10-24, unknown 10-25 and 10-26, scheduled 10-27.
  const values = (i) => (i < 8 ? 300 : 150);
  const records = Array.from({ length: 11 }, (_, i) => nightly(addDays("2026-10-17", i), (id, cell) => (cell === "100" && id === "turns_completed" ? values(i) : undefined)));
  for (const r of records) r.compaction_schedule = "scheduled";
  records[8].compaction_schedule = null;
  records[9].compaction_schedule = null;
  const s = series(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  const L = s.levels["100"];
  assert.equal(L.ref[10], null, "10-27 takes no reference from 10-24 or earlier");
  assert.equal(L.note[10], "no_reference");
  const marks = s.eras.filter((e) => e.kind === "compaction");
  assert.deepEqual(marks.map((e) => [e.date, e.label]), [["2026-10-25", "compaction schedule unknown"], ["2026-10-27", "compaction schedule era"]]);
});

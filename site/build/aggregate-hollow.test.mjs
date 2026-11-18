// A level the record ran with no valid attempt is "hollow", like a level with too few valid attempts: the record exists
// there, so it never reads as "no_data" (a level not run, or a metric outside its era). The value stays null, so a chart
// draws a gap, never a zero, and no verdict comes from it, in the series and in the compare files alike. Inputs are
// hand-made synthetic records built by tools/t3cp/lib/fake.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildOutputs } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from "../../tools/t3cp/lib/fake.mjs";
import { loadCatalogue, loadSchema } from "../../tools/t3cp/lib/repo.mjs";
import { validate } from "../../tools/t3cp/lib/validate.mjs";

const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * One nightly. `invalid(cell, n)` marks an attempt invalid (driver_failed; a failed driver's numbers are planted as 0,
 * which must never be published); `absent` leaves those cells out of the record.
 */
function nightly(date, { invalid = () => false, absent = [] } = {}) {
  const identity = fakeIdentity({ date });
  const attempts = fakeAttempts(catalogue, identity, { jitter: 0, attempt: (cell, n) => (invalid(cell, n) ? { valid: false, problems: ["driver_failed"] } : {}) }).filter(
    (a) => !absent.includes(a.cell),
  );
  for (const a of attempts) if (!a.attempt.valid) for (const id of Object.keys(a.metrics)) if (typeof a.metrics[id] === "number") a.metrics[id] = 0;
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
}

const HEADLINE_BANDS = Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }]));
const BANDS = {
  schema: "t3cp/bands/1",
  method: "test bands",
  platforms: { "linux-x64": { measured: { from: "2026-10-17", to: "2026-10-17", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" }, metrics: HEADLINE_BANDS } },
};
function build(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-hollow-"));
  temps.push(dir);
  const put = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
  };
  for (const r of records) put(`records/${r.platform.id}/${r.release.date}.${r.release.tag}.json`, r);
  put("bands.json", BANDS);
  return buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS });
}
const read = (files, rel) => JSON.parse(files.get(rel).toString("utf8"));

// 10-17..10-22; 10-19 ran 250 with no valid attempt, 100 with one, and has no 200 cell; 10-21 ran 250 with no valid
// attempt. elu starts 2026-10-20 (the gauges era): on 10-19 it is outside its era.
const DATES = Array.from({ length: 6 }, (_, i) => addDays("2026-10-17", i));
const records = DATES.map((date) =>
  date === "2026-10-19"
    ? nightly(date, { invalid: (cell, n) => cell === "250" || (cell === "100" && n > 1), absent: ["200"] })
    : date === "2026-10-21"
      ? nightly(date, { invalid: (cell) => cell === "250" })
      : nightly(date),
);
const files = build(records);
const at = (s, L, date) => {
  const i = s.dates.indexOf(date);
  const lv = s.levels[L];
  return { value: lv.median[i], note: lv.note[i], verdict: lv.verdict[i], dod: lv.dod_verdict[i] };
};

test("the inputs: 10-19 and 10-21 are partial records, their invalid cells exist with 0 valid attempts", () => {
  assert.equal(records[2].status, "partial");
  assert.equal(records[2].cells["250"].valid, 0);
  assert.equal(records[2].cells["100"].valid, 1);
  assert.equal(records[2].cells["200"], undefined);
  assert.equal(records[4].cells["250"].valid, 0);
  assert.equal(catalogue.metrics.find((m) => m.id === "elu").era_start, "2026-10-20");
});

test("series: a level run with no valid attempt is hollow, its value null and never judged", () => {
  for (const metric of ["turn_p50_ms", "turns_completed", "main_busy_pct"]) {
    for (const shard of ["latest", "all"]) {
      const s = read(files, `series/linux-x64/${metric}.${shard}.json`);
      assert.deepEqual(at(s, "250", "2026-10-19"), { value: null, note: "hollow", verdict: null, dod: null }, `${metric} ${shard}`);
      assert.deepEqual(at(s, "250", "2026-10-21"), { value: null, note: "hollow", verdict: null, dod: null }, `${metric} ${shard}`);
      assert.deepEqual(validate(loadSchema("series-1.json"), s), [], `${metric} ${shard}`);
    }
  }
  // A gauge inside its era from 10-20: hollow on 10-21 too.
  assert.deepEqual(at(read(files, "series/linux-x64/elu.latest.json"), "250", "2026-10-21"), { value: null, note: "hollow", verdict: null, dod: null });
});

test("series: an absent cell, or a metric outside its era, stays no_data", () => {
  const s = read(files, "series/linux-x64/turn_p50_ms.latest.json");
  assert.deepEqual(at(s, "200", "2026-10-19"), { value: null, note: "no_data", verdict: null, dod: null });
  // elu before its era (10-20), at a level the record ran with no valid attempt: no_data, not hollow.
  const elu = read(files, "series/linux-x64/elu.latest.json");
  assert.deepEqual(at(elu, "250", "2026-10-19"), { value: null, note: "no_data", verdict: null, dod: null });
  assert.deepEqual(at(elu, "50", "2026-10-19"), { value: null, note: "no_data", verdict: null, dod: null });
});

test("series: a level with one valid attempt is still hollow, its value shown and never judged", () => {
  const s = read(files, "series/linux-x64/turn_p50_ms.latest.json");
  const p = at(s, "100", "2026-10-19");
  assert.equal(p.note, "hollow");
  assert.equal(p.verdict, null);
  assert.equal(p.dod, null);
  assert.equal(typeof p.value, "number");
  assert.ok(p.value > 0, "the valid attempt's value, never a failed attempt's 0");
});

test("series: no zero is published for a level without a valid attempt", () => {
  for (const [rel, bytes] of files) {
    if (!/^series\/linux-x64\/.+\.latest\.json$/.test(rel)) continue;
    const s = JSON.parse(bytes.toString("utf8"));
    const m = catalogue.metrics.find((x) => x.id === s.id);
    if (m.source.file === "merge" || !s.levels["250"]) continue; // attempt counts: 0 valid attempts is the count
    for (const date of ["2026-10-19", "2026-10-21"]) assert.equal(at(s, "250", date).value, null, `${s.id} ${date}`);
  }
});

test("compare: the same rule on either side; no verdict from a hollow or absent level", () => {
  const tag = (date) => records[DATES.indexOf(date)].release.tag;
  const cmp = (a, b) => read(files, `compare/${tag(a)}__${tag(b)}.linux-x64.json`);
  const row = (c, metric, level) => c.rows.find((r) => r.metric === metric && r.level === level) ?? null;
  // b ran 250 with no valid attempt: hollow (it was no_data).
  const into = cmp("2026-10-18", "2026-10-19");
  assert.deepEqual(validate(loadSchema("compare-1.json"), into), []);
  assert.deepEqual(pick(row(into, "turn_p50_ms", "250")), { b: null, verdict: null, note: "hollow" });
  // b has no 200 cell: no_data.
  assert.deepEqual(pick(row(into, "turn_p50_ms", "200")), { b: null, verdict: null, note: "no_data" });
  // b has one valid attempt at 100: hollow, as before.
  assert.equal(row(into, "turn_p50_ms", "100").note, "hollow");
  assert.equal(row(into, "turn_p50_ms", "100").verdict, null);
  // a ran 250 with no valid attempt, b has a value: hollow (it was no_reference).
  const out = cmp("2026-10-19", "2026-10-20");
  assert.equal(row(out, "turn_p50_ms", "250").a, null);
  assert.equal(row(out, "turn_p50_ms", "250").note, "hollow");
  assert.equal(row(out, "turn_p50_ms", "250").verdict, null);
  // a has no 200 cell, b has a value: no_reference, as before.
  assert.equal(row(out, "turn_p50_ms", "200").note, "no_reference");
  // elu: outside its era on 10-19 (a), inside on 10-20 (b): no_reference, not hollow.
  assert.equal(row(out, "elu", "250").note, "no_reference");
});

function pick(r) {
  return r === null ? null : { b: r.b, verdict: r.verdict, note: r.note };
}

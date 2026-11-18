// Series name why a value is missing where a public reason exists: levels.<L>.reason, parallel to note, is
// extra_timeout or no_setup_span (the record's stat reason) or timeout (the record did not finish in time: its
// status_reason, for a level or extra it never measured), and null everywhere else. It is set only where the note is
// no_data; the note itself is unchanged. A timed-out record is partial and never enters a reference window. Inputs
// are hand-made synthetic records built by tools/t3cp/lib/fake.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildOutputs } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from "../../tools/t3cp/lib/fake.mjs";
import { loadCatalogue, loadSchema, median } from "../../tools/t3cp/lib/repo.mjs";
import { validate } from "../../tools/t3cp/lib/validate.mjs";

const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const NULL_STAT = (reason, values = [null, null, null]) => ({ median: null, min: null, max: null, n: 0, values, ...(reason ? { reason } : {}) });

function nightly(date, factor = () => 1) {
  const identity = fakeIdentity({ date });
  const attempts = fakeAttempts(catalogue, identity, { jitter: 0, value: (id, cell, v) => (typeof v === "number" && id === "turn_p50_ms" ? Math.round(v * factor(cell) * 1000) / 1000 : undefined) });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
}
const BANDS = {
  schema: "t3cp/bands/1",
  method: "test bands",
  platforms: {
    "linux-x64": {
      measured: { from: "2026-11-01", to: "2026-11-01", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" },
      metrics: Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }])),
    },
  },
};
function build(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-reasons-"));
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

// 11-02..11-08. 11-03: db_ready_first_ms has no setup span. 11-04: the snapshot extra and the empty part's
// db_ready_warm_ms timed out. 11-06: the record reached its deadline: partial, timeout, cells 200 and 250 never ran,
// the first-turn extra never ran, and turn_p50_ms at 1 agent is planted three times as high (it must not reach the
// reference of 11-07). 11-05: a plain no_data (first_turn missing, no reason) and a hollow level (no reason).
const DATES = Array.from({ length: 7 }, (_, i) => addDays("2026-11-02", i));
const records = DATES.map((d) => nightly(d, (cell) => (d === "2026-11-06" && cell === "1" ? 3 : 1)));
const at = (d) => records[DATES.indexOf(d)];
at("2026-11-03").extras.fixture.metrics.db_ready_first_ms = NULL_STAT("no_setup_span");
at("2026-11-04").extras.fixture.metrics.snapshot_full_get_ms = NULL_STAT("extra_timeout", [null]);
at("2026-11-04").extras.empty.metrics.db_ready_warm_ms = NULL_STAT("extra_timeout", []);
delete at("2026-11-05").extras.fixture.metrics.first_turn_after_start_ms;
{
  const r = at("2026-11-05");
  r.cells["150"].attempts.forEach((a) => {
    a.valid = false;
    a.problems = ["driver_failed"];
  });
  r.cells["150"].valid = 0;
  for (const [id, s] of Object.entries(r.cells["150"].metrics)) if (s && typeof s === "object" && "values" in s) r.cells["150"].metrics[id] = NULL_STAT(null);
  r.status = "partial";
  r.status_reason = "attempts_invalid";
}
{
  const r = at("2026-11-06");
  delete r.cells["200"];
  delete r.cells["250"];
  delete r.workload.cells["200"];
  delete r.workload.cells["250"];
  delete r.extras.fixture.metrics.first_turn_after_start_ms;
  r.status = "partial";
  r.status_reason = "timeout";
}
const files = build(records);
const series = (id, shard = "latest") => read(files, `series/linux-x64/${id}.${shard}.json`);
const reasonAt = (s, L, d) => s.levels[L].reason[s.dates.indexOf(d)];
const noteAt = (s, L, d) => s.levels[L].note[s.dates.indexOf(d)];

test("series: every level has a reason array parallel to note, and every shard validates", () => {
  for (const [rel, bytes] of files) {
    if (!/^series\/linux-x64\/.+\.json$/.test(rel)) continue;
    const s = JSON.parse(bytes.toString("utf8"));
    assert.deepEqual(validate(loadSchema("series-1.json"), s), [], rel);
    for (const [L, lv] of Object.entries(s.levels)) {
      assert.ok(Array.isArray(lv.reason), `${rel} ${L}`);
      assert.equal(lv.reason.length, s.dates.length, `${rel} ${L}`);
      lv.reason.forEach((r, j) => {
        if (r !== null) assert.equal(lv.note[j], "no_data", `${rel} ${L} ${s.dates[j]}: a reason only beside no_data`);
      });
    }
  }
});

test("series: the record's stat reason (no_setup_span, extra_timeout), at once and on the empty part", () => {
  assert.equal(reasonAt(series("db_ready_first_ms"), "once", "2026-11-03"), "no_setup_span");
  assert.equal(noteAt(series("db_ready_first_ms"), "once", "2026-11-03"), "no_data");
  assert.equal(reasonAt(series("snapshot_full_get_ms"), "once", "2026-11-04"), "extra_timeout");
  assert.equal(reasonAt(series("db_ready_warm_ms"), "1e", "2026-11-04"), "extra_timeout");
  // The same metrics on other days: values, no reason.
  assert.equal(reasonAt(series("db_ready_first_ms"), "once", "2026-11-04"), null);
  assert.equal(reasonAt(series("snapshot_full_get_ms"), "once", "2026-11-03"), null);
});

test("series: a timed-out record gives timeout where it never measured, and nothing where it did", () => {
  const s = series("turn_p50_ms");
  for (const L of ["200", "250"]) {
    assert.equal(noteAt(s, L, "2026-11-06"), "no_data", L);
    assert.equal(reasonAt(s, L, "2026-11-06"), "timeout", L);
  }
  for (const L of ["1", "50", "100", "150"]) assert.equal(reasonAt(s, L, "2026-11-06"), null, L);
  assert.equal(reasonAt(series("first_turn_after_start_ms"), "once", "2026-11-06"), "timeout");
});

test("series: no reason for a plain no_data, a hollow level, or a metric outside its era", () => {
  assert.equal(noteAt(series("first_turn_after_start_ms"), "once", "2026-11-05"), "no_data");
  assert.equal(reasonAt(series("first_turn_after_start_ms"), "once", "2026-11-05"), null);
  const s = series("turn_p50_ms");
  assert.equal(noteAt(s, "150", "2026-11-05"), "hollow");
  assert.equal(reasonAt(s, "150", "2026-11-05"), null);
  // A fork-only metric on a nightly is outside its era: no_data and no reason, also on the timed-out record.
  const forkOnly = catalogue.metrics.find((m) => m.era_start === null && m.upstream === "fork" && m.lane === "daily" && m.scope === "level");
  const f = series(forkOnly.id);
  assert.equal(noteAt(f, "250", "2026-11-06"), "no_data");
  assert.equal(reasonAt(f, "250", "2026-11-06"), null);
});

test("a timed-out record never enters a reference window", () => {
  const s = series("turn_p50_ms", "all");
  const i = s.dates.indexOf("2026-11-07");
  // Complete records before 11-07: 11-02, 11-03, 11-04 (11-05 and 11-06 are partial).
  const complete = ["2026-11-02", "2026-11-03", "2026-11-04"].map((d) => at(d).cells["1"].metrics.turn_p50_ms.median);
  assert.equal(s.levels["1"].ref[i], Math.round(median(complete) * 1000) / 1000);
  const planted = at("2026-11-06").cells["1"].metrics.turn_p50_ms.median;
  assert.ok(planted > 2 * s.levels["1"].ref[i], "the planted value is far from the reference: it was not used");
});

// Series name a saturated level's symptoms: levels.<L>.saturated_by (aligned with dates) and fork.levels.<L>.saturated_by
// (aligned with fork.tags) hold, per entry, the union of the cell's attempts' saturated_by codes, or null when that
// record is not saturated there. Inputs are hand-made synthetic records built by tools/t3cp/lib/fake.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildOutputs, BuildError } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from "../../tools/t3cp/lib/fake.mjs";
import { loadCatalogue, loadSchema } from "../../tools/t3cp/lib/repo.mjs";
import { validate } from "../../tools/t3cp/lib/validate.mjs";

const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function record(identity) {
  const attempts = fakeAttempts(catalogue, identity, { jitter: 0 });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${identity.release.date}T18:00:00Z` });
}
const nightly = (date) => record(fakeIdentity({ date }));
function fork(date, perf, base) {
  return record(fakeIdentity({ date, kind: "fork", tag: `v0.1.9-perf.${perf}`, base: { tag: base.release.tag, date: base.release.date, sha: base.release.sha } }));
}
/** Marks a level saturated, each attempt with its own saturation codes; agents served fall below the level's agents. */
function saturate(r, level, codesPerAttempt) {
  const cell = r.cells[level];
  cell.saturated = true;
  const served = cell.agents_total - 40;
  cell.metrics.agents_served = { median: served, min: served, max: served, n: 3, values: [served, served, served] };
  cell.attempts.forEach((a, i) => {
    a.saturated = codesPerAttempt[i].length > 0;
    a.saturated_by = codesPerAttempt[i];
  });
}

const HEADLINE_BANDS = Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }]));
const BANDS = {
  schema: "t3cp/bands/1",
  method: "test bands",
  platforms: { "linux-x64": { measured: { from: "2026-11-01", to: "2026-11-02", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" }, metrics: { ...HEADLINE_BANDS, turns_completed: { band: 4.6, n: 6 } } } },
};
function writeTree(records, forks = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-satby-"));
  temps.push(dir);
  const put = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
  };
  for (const r of records) put(`records/${r.platform.id}/${r.release.date}.${r.release.tag}.json`, r);
  for (const r of forks) put(`fork/${r.release.tag}.${r.platform.id}.json`, r);
  put("bands.json", BANDS);
  return dir;
}
const seriesOf = (files, metric) => JSON.parse(files.get(`series/linux-x64/${metric}.latest.json`).toString("utf8"));

test("series: levels.<L>.saturated_by aligns with dates, the union of the attempts' codes (sorted), or null when not saturated", () => {
  const records = Array.from({ length: 4 }, (_, i) => nightly(addDays("2026-11-01", i)));
  saturate(records[2], "250", [["sessions_starved"], ["call_timeouts", "sessions_starved"], []]);
  saturate(records[3], "200", [["session_mcp_missing"], ["session_mcp_missing"], ["session_mcp_missing"]]);
  const files = buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS });
  for (const metric of ["turn_p95_ms", "turns_completed"]) {
    const s = seriesOf(files, metric);
    assert.deepEqual(s.levels["250"].saturated_by, [null, null, ["call_timeouts", "sessions_starved"], null], metric);
    assert.deepEqual(s.levels["200"].saturated_by, [null, null, null, ["session_mcp_missing"]], metric);
    assert.deepEqual(s.levels["100"].saturated_by, [null, null, null, null], metric);
    assert.equal(s.levels["250"].saturated_by.length, s.dates.length);
    assert.deepEqual(validate(loadSchema("series-1.json"), s), [], metric);
  }
  // Every shard carries it, cut like the other arrays.
  const all = JSON.parse(files.get("series/linux-x64/turn_p95_ms.all.json").toString("utf8"));
  assert.deepEqual(all.levels["250"].saturated_by, [null, null, ["call_timeouts", "sessions_starved"], null]);
});

test("series: fork.levels.<L>.saturated_by aligns with the fork releases", () => {
  const nightlies = Array.from({ length: 3 }, (_, i) => nightly(addDays("2026-11-01", i)));
  const forks = [fork("2026-11-01", 1, nightlies[0]), fork("2026-11-03", 2, nightlies[2])];
  saturate(forks[1], "250", [["call_timeouts"], [], []]);
  const s = seriesOf(buildOutputs(writeTree(nightlies, forks), { publicRefs: FAKE_PUBLIC_REFS }), "turn_p95_ms");
  assert.deepEqual(s.fork.levels["250"].saturated_by, [null, ["call_timeouts"]]);
  assert.deepEqual(s.fork.levels["100"].saturated_by, [null, null]);
  assert.equal(s.fork.levels["250"].saturated_by.length, s.fork.tags.length);
  assert.deepEqual(validate(loadSchema("series-1.json"), s), []);
});

test("series: a saturated_by code outside the problem codes is refused, at the input and in series-1", () => {
  const records = Array.from({ length: 2 }, (_, i) => nightly(addDays("2026-11-01", i)));
  saturate(records[1], "250", [["sessions_starved"], ["sessions_starved"], ["sessions_starved"]]);
  records[1].cells["250"].attempts[0].saturated_by = ["mystery_code"];
  assert.throws(() => buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError);
  const good = Array.from({ length: 2 }, (_, i) => nightly(addDays("2026-11-01", i)));
  saturate(good[1], "250", [["sessions_starved"], [], []]);
  const s = seriesOf(buildOutputs(writeTree(good), { publicRefs: FAKE_PUBLIC_REFS }), "turn_p95_ms");
  s.levels["250"].saturated_by[1] = ["mystery_code"];
  assert.ok(validate(loadSchema("series-1.json"), s).length > 0, "series-1 names the codes");
});

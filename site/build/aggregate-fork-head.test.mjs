// Red first: the nightly fork-head records (fork-nightly/<platform>/<D>.<tag>.json) become the fork's second line.
// - The series' fork step carries the measured value on each night that has a fork-head record, instead of the held
//   release value; fork.head_tags names the release measured that night; fork.levels.<L>.head_note says why a measured
//   night has no value (hollow: no valid attempt; saturated; no_data). Nights without one keep the held step.
// - With fork-head records and no fork release record at all, the series still has its fork line.
// - records-index.json lists them in fork_heads with their paired nightly; each night gets a fork-head-vs-nightly
//   comparison file, listed in index.json.
// - With no fork-head record, none of these keys or files exist: every output is as before.
// - status.json's latest_record_id stays an upstream nightly's.
// Inputs are hand-made synthetic records built by tools/t3cp/lib/fake.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildOutputs, BuildError } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS, PLATFORM } from "../../tools/t3cp/lib/fake.mjs";
import { loadCatalogue, loadSchema } from "../../tools/t3cp/lib/repo.mjs";
import { validate } from "../../tools/t3cp/lib/validate.mjs";

const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const TAG = "v0.1.9-perf.9";

// A record whose turn_p50_ms is scaled by `factor`, with the given cells' attempts all invalid.
const merged = (identity, { factor = 1, invalid = [] } = {}) =>
  mergeRecord({
    publicRefs: FAKE_PUBLIC_REFS,
    attempts: fakeAttempts(catalogue, identity, {
      jitter: 0,
      value: (id, cell, v) => (typeof v === "number" && id === "turn_p50_ms" ? Math.round(v * factor * 1000) / 1000 : undefined),
      attempt: (cell) => (invalid.includes(cell) ? { valid: false, problems: ["driver_failed"] } : {}),
    }),
    extras: [fakeExtras(catalogue, identity)],
    catalogue,
    generatedAt: `${identity.release.date}T18:00:00Z`,
  });
const BASE = (n) => ({ tag: n.release.tag, date: n.release.date, sha: n.release.sha });
const DATES = Array.from({ length: 4 }, (_, i) => addDays("2026-11-14", i));
const nightlies = DATES.map((d) => merged(fakeIdentity({ date: d })));
const release = merged(fakeIdentity({ date: "2026-11-14", kind: "fork", tag: TAG, base: BASE(nightlies[0]) }), { factor: 0.9 });
function head(D, opts) {
  const identity = fakeIdentity({ date: "2026-11-14", kind: "fork", tag: TAG, base: BASE(nightlies[0]) });
  identity.record_id = `${D}.linux-x64.fork`;
  identity.paired_nightly = { tag: nightlies[DATES.indexOf(D)].release.tag, date: D };
  return merged(identity, opts);
}
// 16 Nov: measured, turn_p50_ms at half the nightly's. 17 Nov: no valid attempt at 100 agents.
const heads = [head("2026-11-16", { factor: 0.5 }), head("2026-11-17", { factor: 0.5, invalid: ["100"] })];
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
function tree({ releases = [], fh = [], status = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-forkhead-"));
  temps.push(dir);
  const put = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
  };
  for (const r of nightlies) put(`records/${r.platform.id}/${r.release.date}.${r.release.tag}.json`, r);
  for (const r of releases) put(`fork/${r.release.tag}.${r.platform.id}.json`, r);
  for (const r of fh) put(`fork-nightly/${r.platform.id}/${r.paired_nightly.date}.${r.release.tag}.json`, r);
  put("bands.json", BANDS);
  if (status) put("status.json", status);
  return dir;
}
const build = (dir) => buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS, warn: () => {} });
const read = (files, rel) => JSON.parse(files.get(rel).toString("utf8"));
const statOf = (r, L) => r.cells[L].metrics.turn_p50_ms.median;

test("the fork step is measured on each night with a fork-head record, held elsewhere", () => {
  const files = build(tree({ releases: [release], fh: heads }));
  const s = read(files, "series/linux-x64/turn_p50_ms.all.json");
  assert.deepEqual(s.fork.head_tags, [null, null, TAG, TAG]);
  const at50 = s.fork.levels["50"], at100 = s.fork.levels["100"];
  assert.deepEqual(at50.step, [statOf(release, "50"), statOf(release, "50"), statOf(heads[0], "50"), statOf(heads[1], "50")]);
  assert.notEqual(statOf(heads[0], "50"), statOf(release, "50"), "the fixture tells measured from held");
  assert.deepEqual(at50.head_note, [null, null, null, null]);
  assert.deepEqual(at100.step, [statOf(release, "100"), statOf(release, "100"), statOf(heads[0], "100"), null], "a measured night without a value is a gap, not the held value");
  assert.deepEqual(at100.head_note, [null, null, null, "hollow"]);
  assert.equal(validate(loadSchema("series-1.json"), s).length, 0, "the series validates");
});

test("fork-head records alone (no fork release record) still give the series its fork line", () => {
  const s = read(build(tree({ fh: heads })), "series/linux-x64/turn_p50_ms.all.json");
  assert.ok(s.fork, "a fork object");
  assert.deepEqual(s.fork.tags, []);
  assert.deepEqual(s.fork.head_tags, [null, null, TAG, TAG]);
  assert.deepEqual(s.fork.levels["50"].step, [null, null, statOf(heads[0], "50"), statOf(heads[1], "50")]);
  assert.equal(validate(loadSchema("series-1.json"), s).length, 0);
});

test("records-index lists the fork-head records with their paired nightly; each night has its comparison", () => {
  const files = build(tree({ releases: [release], fh: heads }));
  const ri = read(files, "records-index.json");
  assert.deepEqual(ri.fork_heads, heads.map((h) => ({
    date: h.paired_nightly.date,
    tag: TAG,
    sha: h.release.sha,
    paired_tag: h.paired_nightly.tag,
    platforms: { "linux-x64": { record_id: h.record_id, status: h.status, path: `fork-nightly/linux-x64/${h.paired_nightly.date}.${TAG}.json` } },
  })));
  assert.equal(validate(loadSchema("records-index-1.json"), ri).length, 0, "records-index validates, fork-nightly paths included");
  const index = read(files, "index.json");
  for (const h of heads) {
    const rel = `compare/${h.paired_nightly.tag}__head-${h.paired_nightly.date}.linux-x64.json`;
    assert.ok(index.compare.includes(rel), rel);
    const c = read(files, rel);
    assert.equal(c.kind, "fork-head-vs-nightly");
    assert.deepEqual([c.a.record_id, c.b.record_id], [`${h.paired_nightly.date}.linux-x64.nightly`, h.record_id]);
    assert.equal(validate(loadSchema("compare-1.json"), c).length, 0, "the comparison validates");
  }
  assert.equal(validate(loadSchema("index-1.json"), index).length, 0);
});

test("with no fork-head record nothing changes: no head keys, no fork_heads, no head comparison", () => {
  const files = build(tree({ releases: [release] }));
  for (const [rel, bytes] of files) {
    if (!rel.startsWith("series/")) continue;
    const s = JSON.parse(bytes.toString("utf8"));
    assert.ok(!("head_tags" in s.fork), rel);
    for (const lv of Object.values(s.fork.levels)) assert.ok(!("head_note" in lv), rel);
  }
  assert.ok(!("fork_heads" in read(files, "records-index.json")));
  assert.ok(!read(files, "index.json").compare.some((p) => p.includes("__head-")));
  assert.ok(![...files.keys()].some((p) => p.startsWith("compare/") && p.includes("__head-")));
});

test("status.json's latest record stays an upstream nightly: a fork-head id there is refused", () => {
  const status = {
    schema: "t3cp/status/1",
    generated_at: "2026-11-17T20:00:00Z",
    platforms: { "linux-x64": { latest_record_id: "2026-11-17.linux-x64.fork", latest_date: "2026-11-17", latest_status: "complete", queue: { pending: 0, active: 0 }, last_failure: null, heartbeat_at: "2026-11-17T20:00:00Z" } },
  };
  assert.throws(() => build(tree({ fh: heads, status })), (e) => e instanceof BuildError && /status\.json/.test(e.message));
  status.platforms["linux-x64"].latest_record_id = "2026-11-17.linux-x64.nightly";
  assert.doesNotThrow(() => build(tree({ fh: heads, status })), "the upstream nightly's id is accepted");
});

// From the review of the fork-head line.
test("a fork-head record paired with another build of its night than the published nightly is refused", () => {
  const h = head("2026-11-16", { factor: 0.5 });
  h.paired_nightly.tag = h.paired_nightly.tag.replace(/\.\d+$/, ".1");
  assert.notEqual(h.paired_nightly.tag, nightlies[2].release.tag);
  assert.throws(() => build(tree({ releases: [release], fh: [h] })), (e) => e instanceof BuildError && /fork-nightly\/linux-x64\/2026-11-16/.test(e.message) && /paired_nightly/.test(e.message));
});

test("fork_heads keeps each platform's release: two platforms measuring different releases on one night", () => {
  const P = { ...PLATFORM, id: "darwin-arm64" };
  const identity = fakeIdentity({ date: "2026-11-14", kind: "fork", tag: "v0.1.9-perf.8", base: BASE(nightlies[0]), platform: P });
  identity.record_id = "2026-11-16.darwin-arm64.fork";
  identity.paired_nightly = { tag: nightlies[2].release.tag, date: "2026-11-16" };
  const mac = merged(identity);
  const ri = read(build(tree({ releases: [release], fh: [heads[0], mac] })), "records-index.json");
  const night = ri.fork_heads.filter((e) => e.date === "2026-11-16");
  assert.deepEqual(night.map((e) => [e.tag, Object.keys(e.platforms)]).sort(), [["v0.1.9-perf.8", ["darwin-arm64"]], [TAG, ["linux-x64"]]]);
  for (const e of night) for (const [p, x] of Object.entries(e.platforms)) assert.ok(x.path.endsWith(`.${e.tag}.json`) && x.path.includes(p), `${p}: ${x.path} is ${e.tag}'s`);
  assert.equal(validate(loadSchema("records-index-1.json"), ri).length, 0);
});

test("a fork-head night whose count was not measured on a saturated attempt says saturated", () => {
  const identity = fakeIdentity({ date: "2026-11-14", kind: "fork", tag: TAG, base: BASE(nightlies[0]) });
  identity.record_id = "2026-11-16.linux-x64.fork";
  identity.paired_nightly = { tag: nightlies[2].release.tag, date: "2026-11-16" };
  const attempts = fakeAttempts(catalogue, identity, { jitter: 0 });
  const a = attempts.find((x) => x.cell === "100" && x.n === 1);
  a.attempt.saturated = true; a.attempt.saturated_by = ["driver_failed"]; a.attempt.metric_reasons = { ...(a.attempt.metric_reasons ?? {}), turns_completed: "not_measured_saturated" }; a.metrics.turns_completed = null;
  const h = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: "2026-11-14T18:00:00Z" });
  assert.equal(h.cells["100"].saturated, false, "the cell itself is not saturated");
  const s = read(build(tree({ releases: [release], fh: [h] })), "series/linux-x64/turns_completed.all.json");
  assert.equal(s.fork.levels["100"].head_note[2], "saturated");
  assert.equal(s.fork.levels["100"].step[2], null);
});

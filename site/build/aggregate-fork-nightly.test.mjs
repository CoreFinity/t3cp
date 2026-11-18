// The nightly fork-head records (data/v1/fork-nightly/<platform>/<D>.<tag>.json, written by the pipeline) are read,
// checked and passed through by the aggregator before the site renders them: each validates against record-1, passes
// the scan, names a release pinned at its public commit, and agrees with its file name (record_id <D>.<platform>.fork,
// paired_nightly of night D, the release tag), one per platform and night. It is copied to the output as published; it
// is no nightly and no fork release (its series, records-index and comparison entries are aggregate-fork-head's). Any
// other record carrying paired_nightly is refused. Inputs are hand-made synthetic records built by tools/t3cp/lib/fake.mjs.
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

const merged = (identity) => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0 }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${identity.release.date}T18:00:00Z` });
const BASE = (n) => ({ tag: n.release.tag, date: n.release.date, sha: n.release.sha });
function head(D, nightlyOfD, base, tag = "v0.1.9-perf.9") {
  const identity = fakeIdentity({ date: "2026-11-14", kind: "fork", tag, base });
  identity.record_id = `${D}.linux-x64.fork`;
  identity.paired_nightly = { tag: nightlyOfD.release.tag, date: D };
  return merged(identity);
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
function tree(nightlies, heads, { name } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-forknightly-"));
  temps.push(dir);
  const put = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
  };
  for (const r of nightlies) put(`records/${r.platform.id}/${r.release.date}.${r.release.tag}.json`, r);
  heads.forEach((r, i) => put(name?.(r, i) ?? `fork-nightly/${r.platform.id}/${r.paired_nightly.date}.${r.release.tag}.json`, r));
  put("bands.json", BANDS);
  return dir;
}
const build = (dir) => buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS });

const DATES = Array.from({ length: 4 }, (_, i) => addDays("2026-11-14", i));
const nightlies = DATES.map((d) => merged(fakeIdentity({ date: d })));
const heads = [head("2026-11-16", nightlies[2], BASE(nightlies[0])), head("2026-11-17", nightlies[3], BASE(nightlies[0]))];

test("fork-head records are accepted and passed through as published, counted as no nightly and no fork release", () => {
  const files = build(tree(nightlies, heads));
  for (const r of heads) {
    const rel = `fork-nightly/linux-x64/${r.paired_nightly.date}.${r.release.tag}.json`;
    assert.ok(files.has(rel), rel);
    assert.deepEqual(JSON.parse(files.get(rel).toString("utf8")), r);
  }
  const index = JSON.parse(files.get("index.json").toString("utf8"));
  assert.equal(index.platforms.find((p) => p.id === "linux-x64").records, 4, "only the nightlies count as records");
  assert.deepEqual(index.fork, [], "no fork release entry from a fork-head record");
  const ri = JSON.parse(files.get("records-index.json").toString("utf8"));
  assert.deepEqual(ri.records.map((r) => r.date), DATES);
});

test("a fork-head record that disagrees with its file name, is unpinned or is doubled is refused, naming the file", () => {
  const refuse = (dir, re) => assert.throws(() => build(dir), (e) => e instanceof BuildError && /fork-nightly\//.test(e.message) && re.test(e.message));
  // The night in the file name differs from the record's.
  refuse(tree(nightlies, [heads[0]], { name: (r) => `fork-nightly/linux-x64/2026-11-15.${r.release.tag}.json` }), /file name/);
  // The tag in the file name differs from the release's.
  refuse(tree(nightlies, [heads[0]], { name: (r) => `fork-nightly/linux-x64/${r.paired_nightly.date}.v0.1.9-perf.8.json` }), /file name/);
  // paired_nightly of another night than the record id's.
  const shifted = structuredClone(heads[0]);
  shifted.paired_nightly.date = "2026-11-15";
  refuse(tree(nightlies, [shifted], { name: (r) => `fork-nightly/linux-x64/2026-11-16.${r.release.tag}.json` }), /paired_nightly/);
  // A release not pinned at its public commit.
  const unpinned = structuredClone(heads[0]);
  unpinned.release.sha = "e".repeat(40);
  refuse(tree(nightlies, [unpinned]), /pinned/);
  // Two for one night.
  const second = head("2026-11-16", nightlies[2], BASE(nightlies[0]), "v0.1.9-perf.8");
  refuse(tree(nightlies, [heads[0], second]), /second/);
});

test("paired_nightly belongs to fork-head records only: a nightly or a fork release record carrying it is refused", () => {
  const nightly = structuredClone(nightlies[1]);
  nightly.paired_nightly = { tag: nightlies[1].release.tag, date: nightlies[1].release.date };
  assert.throws(() => build(tree([nightlies[0], nightly, nightlies[2], nightlies[3]], [])), (e) => e instanceof BuildError && /paired_nightly/.test(e.message));
  // A fork-head record placed under fork/ (a release's path) is refused there.
  const dir = tree(nightlies, [heads[0]], { name: (r) => `fork/${r.release.tag}.${r.platform.id}.json` });
  assert.throws(() => build(dir), (e) => e instanceof BuildError && /fork\//.test(e.message));
});

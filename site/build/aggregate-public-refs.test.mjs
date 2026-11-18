// Defence in depth beside the VM's merge: the aggregator re-checks every committed record against the pinned public
// references (tools/t3cp/public-refs.json). A record's harness must be a pinned version at its public commit with the
// pinned content hashes, and a fork record's release.sha must be the commit pinned for its tag; otherwise the build
// fails. A dev build (synthetic data, never published) skips the check. Inputs are hand-made synthetic records.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildOutputs, BuildError } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { FAKE_PUBLIC_REFS, HARNESS_B, fakeAttempts, fakeExtras, fakeIdentity, hex, publicHarness } from "../../tools/t3cp/lib/fake.mjs";
import { loadCatalogue } from "../../tools/t3cp/lib/repo.mjs";

const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const merged = (identity) =>
  mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0 }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${identity.release.date}T18:00:00Z` });
const BANDS = {
  schema: "t3cp/bands/1",
  method: "test bands",
  platforms: { "linux-x64": { measured: { from: "2026-11-01", to: "2026-11-02", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" }, metrics: Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }])) } },
};
function writeTree(records, forks = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-refs-"));
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
const nightlies = () => Array.from({ length: 3 }, (_, i) => merged(fakeIdentity({ date: addDays("2026-11-01", i) })));
const refused = (dir, pattern, what) => assert.throws(() => buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && pattern.test(e.message), what);

test("harness: a record must name a pinned harness at its public commit with the pinned hashes", () => {
  assert.ok(buildOutputs(writeTree(nightlies()), { publicRefs: FAKE_PUBLIC_REFS }).size > 0, "pinned records build");
  const b = nightlies();
  b[2].harness = publicHarness(HARNESS_B);
  assert.ok(buildOutputs(writeTree(b), { publicRefs: FAKE_PUBLIC_REFS }).size > 0, "another pinned harness builds");
  for (const [what, change] of [
    ["an internal commit", (h) => (h.sha = hex("internal-snapshot", 40))],
    ["an unpinned version", (h) => (h.version = "t3cp-harness/9.9.9")],
    ["another files hash", (h) => (h.files_sha256 = "e".repeat(64))],
    ["another preload hash", (h) => (h.preload_sha256 = "e".repeat(64))],
  ]) {
    const records = nightlies();
    change(records[1].harness);
    refused(writeTree(records), /harness/, what);
  }
});

test("fork records: release.sha must be the commit pinned for the tag; an unpinned tag is fork_tag_unpinned", () => {
  const records = nightlies();
  const base = { tag: records[0].release.tag, date: records[0].release.date, sha: records[0].release.sha };
  const fork = merged(fakeIdentity({ date: "2026-11-02", kind: "fork", tag: "v0.1.9-perf.7", base }));
  assert.ok(buildOutputs(writeTree(records, [fork]), { publicRefs: FAKE_PUBLIC_REFS }).size > 0);
  const wrong = structuredClone(fork);
  wrong.release.sha = hex("internal-fork", 40);
  refused(writeTree(records, [wrong]), /public commit/, "an internal fork commit");
  assert.throws(
    () => buildOutputs(writeTree(records, [fork]), { publicRefs: { ...FAKE_PUBLIC_REFS, fork: {} } }),
    (e) => e instanceof BuildError && /fork_tag_unpinned/.test(e.message),
  );
});

test("the pinned file is the default; a dev build (synthetic data, never published) skips the check", () => {
  // The fakes' harness is not in tools/t3cp/public-refs.json.
  assert.throws(() => buildOutputs(writeTree(nightlies())), (e) => e instanceof BuildError && /harness/.test(e.message));
  const synthetic = nightlies().map((r) => ({ schema: r.schema, synthetic: true, ...r }));
  assert.ok(buildOutputs(writeTree(synthetic), { dev: true }).size > 0);
});

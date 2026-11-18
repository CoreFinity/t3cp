// A published record names only what a reader can resolve in public: the harness by its public tag commit and the
// content hashes of its public tree, a fork release by its public tag commit, and no private workflow run. merge maps
// the attempts' harness identity through the pinned public references (tools/t3cp/public-refs.json) and refuses what
// they do not cover. Inputs are hand-made synthetic attempts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MergeError, mergeRecord } from "./merge.mjs";
import { FAKE_PUBLIC_REFS, HARNESS, fakeAttempts, fakeIdentity, hex } from "./lib/fake.mjs";
import { loadCatalogue, loadSchema } from "./lib/repo.mjs";
import { validate } from "./lib/validate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogue = loadCatalogue();
const GEN = "2026-11-16T18:00:00Z";
const merge = (attempts, options = {}) => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN, ...options });

// The attempts name the harness by the commit they ran (a snapshot, unreachable in public) with the hashes of a tree
// whose public tag has the same content.
const SNAPSHOT = { ...HARNESS, sha: hex("internal-snapshot", 40) };
const PUBLIC = FAKE_PUBLIC_REFS.harness[HARNESS.version];

test("harness: the record carries the public tag commit; the attempts' hashes equal the public tree's", () => {
  const record = merge(fakeAttempts(catalogue, fakeIdentity({ date: "2026-11-15", harness: SNAPSHOT })));
  assert.equal(record.harness.sha, PUBLIC.sha);
  for (const k of ["files_sha256", "driver_sha256", "fakes_sha256", "preload_sha256"]) assert.equal(record.harness[k], PUBLIC[k], k);
  assert.ok(!JSON.stringify(record).includes(SNAPSHOT.sha), "never the snapshot commit");
  assert.deepEqual(validate(loadSchema("record-1.json"), record), []);
});

test("harness: an attempt whose content hashes differ from the pinned public tree's, or whose version is not pinned, is refused", () => {
  for (const k of ["files_sha256", "driver_sha256", "fakes_sha256", "preload_sha256"]) {
    const attempts = fakeAttempts(catalogue, fakeIdentity({ date: "2026-11-15", harness: { ...SNAPSHOT, [k]: hex(`other-${k}`) } }));
    assert.throws(() => merge(attempts), (e) => e instanceof MergeError && /harness/.test(e.message), k);
  }
  const unknown = fakeAttempts(catalogue, fakeIdentity({ date: "2026-11-15", harness: { ...SNAPSHOT, version: "t3cp-harness/9.9.9" } }));
  assert.throws(() => merge(unknown), (e) => e instanceof MergeError && /public/.test(e.message));
});

test("fork records: release.sha must be the public commit pinned for the release's tag", () => {
  const base = { tag: "v0.1.9-nightly.20261101.5000", date: "2026-11-01", sha: hex("base", 40) };
  const ok = merge(fakeAttempts(catalogue, fakeIdentity({ date: "2026-11-10", kind: "fork", tag: "v0.1.9-perf.7", base })));
  assert.equal(ok.release.sha, FAKE_PUBLIC_REFS.fork["v0.1.9-perf.7"]);
  const internal = fakeAttempts(catalogue, fakeIdentity({ date: "2026-11-10", kind: "fork", tag: "v0.1.9-perf.7", sha: hex("internal-fork", 40), base }));
  assert.throws(() => merge(internal), (e) => e instanceof MergeError && /public/.test(e.message));
  const unlisted = fakeAttempts(catalogue, fakeIdentity({ date: "2026-11-10", kind: "fork", tag: "v0.1.99-perf.1", base }));
  assert.throws(() => merge(unlisted), (e) => e instanceof MergeError && /fork_tag_unpinned/.test(e.message));
  // An empty fork map refuses every fork record, and still merges nightlies.
  const noForks = { ...FAKE_PUBLIC_REFS, fork: {} };
  assert.throws(() => merge(fakeAttempts(catalogue, fakeIdentity({ date: "2026-11-10", kind: "fork", tag: "v0.1.9-perf.7", base })), { publicRefs: noForks }), (e) => e instanceof MergeError && /fork_tag_unpinned/.test(e.message));
  assert.ok(merge(fakeAttempts(catalogue, fakeIdentity({ date: "2026-11-15" })), { publicRefs: noForks }));
});

test("pipeline.run_id is published as null: a private workflow run gives a reader nothing", () => {
  const record = merge(fakeAttempts(catalogue, fakeIdentity({ date: "2026-11-15" })), { runId: 43958797064 });
  assert.equal(record.pipeline.run_id, null);
  assert.ok(!JSON.stringify(record).includes("43958797064"));
});

test("public-refs.json: the pinned file is public values only, in its schema shape", () => {
  const refs = JSON.parse(fs.readFileSync(path.join(here, "public-refs.json"), "utf8"));
  assert.equal(refs.schema, "t3cp/public-refs/1");
  for (const [version, h] of Object.entries(refs.harness)) {
    assert.match(version, /^t3cp-harness\/\d+\.\d+\.\d+$/);
    assert.match(h.sha, /^[0-9a-f]{40}$/);
    for (const k of ["files_sha256", "driver_sha256", "fakes_sha256", "preload_sha256"]) assert.match(h[k] ?? "", /^[0-9a-f]{64}$/, `${version} ${k}`);
  }
  for (const [tag, sha] of Object.entries(refs.fork)) {
    assert.match(tag, /^v\d+\.\d+\.\d+-perf\.\d+$/);
    assert.match(sha, /^[0-9a-f]{40}$/);
  }
  // The launch image needs harness 2.0.2; fork releases are pinned when their final public commits exist (the map may
  // be empty or partial until then, and merge refuses an unpinned fork tag).
  assert.ok(Object.hasOwn(refs.harness, "t3cp-harness/2.0.2"), "harness 2.0.2 is pinned");
});

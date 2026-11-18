// The pinned public references (tools/t3cp/public-refs.json) name the public commit of every fork release the launch
// publishes, so the VM's merge accepts a fork record at exactly that commit (and refuses any other, or an unpinned
// tag). The commits are the launch push's exact objects. Inputs are hand-made synthetic attempts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPublicRefs, mergeRecord, MergeError } from "./merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity } from "./lib/fake.mjs";
import { loadCatalogue } from "./lib/repo.mjs";

const catalogue = loadCatalogue();
const LAUNCH_FORKS = ["v0.1.6-perf.1", "v0.1.6-perf.2", "v0.1.6-perf.3", "v0.1.6-perf.4", "v0.1.6-perf.5", "v0.1.7-perf.6", "v0.1.9-perf.7", "v0.1.9-perf.8", "v0.1.9-perf.9"];
const refs = loadPublicRefs();

test("public-refs.json pins exactly the launch's nine fork releases, each a distinct 40-hex commit", () => {
  assert.deepEqual(Object.keys(refs.fork).sort(), [...LAUNCH_FORKS].sort());
  for (const [tag, sha] of Object.entries(refs.fork)) assert.match(sha, /^[0-9a-f]{40}$/, tag);
  assert.equal(new Set(Object.values(refs.fork)).size, LAUNCH_FORKS.length, "no two tags share a commit");
});

test("merge accepts each pinned fork release at its public commit and refuses another commit", () => {
  const [version, pinned] = Object.entries(refs.harness)[0];
  const harness = { version, sha: "c".repeat(40), files_sha256: pinned.files_sha256, driver_sha256: pinned.driver_sha256, fakes_sha256: pinned.fakes_sha256, preload_sha256: pinned.preload_sha256 };
  const base = { tag: "v0.1.10-nightly.20261115.4749", date: "2026-11-15", sha: "a".repeat(40) };
  for (const tag of LAUNCH_FORKS) {
    const merge = (sha) => {
      const identity = fakeIdentity({ date: "2026-11-16", kind: "fork", tag, sha, base, harness });
      return mergeRecord({ publicRefs: refs, attempts: fakeAttempts(catalogue, identity), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: "2026-11-16T20:00:00Z" });
    };
    assert.equal(merge(refs.fork[tag]).release.sha, refs.fork[tag], tag);
    assert.throws(() => merge("d".repeat(40)), (e) => e instanceof MergeError && /not the public commit pinned/.test(e.message), `${tag}: another commit`);
  }
});

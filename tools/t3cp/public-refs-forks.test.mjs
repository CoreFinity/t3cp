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
// The releases pushed after the launch, each pinned to the commit fork-publish pushed (its dry run's tag commit).
const AFTER_LAUNCH = {
  "v0.1.9-perf.10": "602f6349275bc7d1c12447456ce125645820ca0c",
  "v0.1.9-perf.11": "803d74c244e13bdbdb24368da19100fbd5f342ed",
  "v0.1.9-perf.12": "7e83bdf9c8583575b519bc8a96756015a08e8858",
  "v0.1.9-perf.13": "a453e92775c4e77e527cd9ac43f462a309daf279",
  "v0.1.9-perf.14": "17954106587be13c5766d80c249bbba2a69241b6",
  "v0.1.11-perf.16": "1732334087c250e20852625f062f3723f8689d59",
};
const PINNED = [...LAUNCH_FORKS, ...Object.keys(AFTER_LAUNCH)];
const refs = loadPublicRefs();

test("public-refs.json pins exactly the published fork releases (the launch's nine, perf.10 to perf.14 and perf.16), each a distinct 40-hex commit", () => {
  assert.deepEqual(Object.keys(refs.fork).sort(), [...PINNED].sort());
  for (const [tag, sha] of Object.entries(AFTER_LAUNCH)) assert.equal(refs.fork[tag], sha, `${tag}: the commit fork-publish pushed`);
  for (const [tag, sha] of Object.entries(refs.fork)) assert.match(sha, /^[0-9a-f]{40}$/, tag);
  assert.equal(new Set(Object.values(refs.fork)).size, PINNED.length, "no two tags share a commit");
});

test("merge accepts each pinned fork release at its public commit and refuses another commit", () => {
  const [version, pinned] = Object.entries(refs.harness)[0];
  const harness = { version, sha: "c".repeat(40), files_sha256: pinned.files_sha256, driver_sha256: pinned.driver_sha256, fakes_sha256: pinned.fakes_sha256, preload_sha256: pinned.preload_sha256 };
  const base = { tag: "v0.1.10-nightly.20261115.4749", date: "2026-11-15", sha: "a".repeat(40) };
  for (const tag of PINNED) {
    const merge = (sha) => {
      const identity = fakeIdentity({ date: "2026-11-16", kind: "fork", tag, sha, base, harness });
      return mergeRecord({ publicRefs: refs, attempts: fakeAttempts(catalogue, identity), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: "2026-11-16T20:00:00Z" });
    };
    assert.equal(merge(refs.fork[tag]).release.sha, refs.fork[tag], tag);
    assert.throws(() => merge("d".repeat(40)), (e) => e instanceof MergeError && /not the public commit pinned/.test(e.message), `${tag}: another commit`);
  }
});

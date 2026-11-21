// The merge of a scenario record (t3cp/scenario-record/1): the row's cells keyed by name, each metric the median of its
// valid attempts, a public reason kept where no value is, complete when every cell has two valid attempts. Inputs are
// the exporter's output on hand-made synthetic raw directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { exportAttempt } from "./export.mjs";
import { MergeError, mergeDirectory, mergeScenarioRecord } from "./merge.mjs";
import { fakeScenarioSpec, writeRawAttempt, writeRawScenarioAttempt } from "./lib/fake-raw.mjs";
import { hex } from "./lib/fake.mjs";
import { loadScenarios, loadSchema } from "./lib/repo.mjs";
import { validate } from "./lib/validate.mjs";

const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-merge-scenario-"));
  temps.push(d);
  return d;
};

const ROW = loadScenarios().rows.find((r) => r.id === "event-log-compaction" && r.version === 1);
const SPEC = fakeScenarioSpec(ROW);
const ok = (value) => ({ value, reason: null });
const na = (reason) => ({ value: null, reason });

/** The exported attempt of cmp-<n> with the step's value (a number, a public reason, or an internal one). */
function attempt(n, entry, { edit } = {}) {
  const root = tmp();
  const dir = writeRawScenarioAttempt(root, { row: ROW, cell: "cmp", n, metrics: { event_log_unpruned_days: entry }, edit });
  return exportAttempt(dir, SPEC, { privatePatterns: [] });
}

/** Public references pinning the attempts' harness as published. */
const refsFor = (a) => ({
  schema: "t3cp/public-refs/1",
  harness: { [a.harness.version]: { sha: hex("harness-public", 40), files_sha256: a.harness.files_sha256, driver_sha256: a.harness.driver_sha256, fakes_sha256: a.harness.fakes_sha256, preload_sha256: a.harness.preload_sha256 } },
  fork: {},
});
const merge = (attempts, extra = {}) => mergeScenarioRecord({ attempts, publicRefs: refsFor(attempts[0]), generatedAt: "2026-11-15T18:00:00Z", ...extra });

test("red first: a scenario record keys its row's cells by name, each metric the median of the valid attempts", () => {
  const attempts = [attempt(1, ok(2)), attempt(2, ok(3)), attempt(3, na("db_unreadable"))];
  const r = merge(attempts);
  assert.equal(r.schema, "t3cp/scenario-record/1");
  assert.deepEqual(validate(loadSchema("scenario-record-1.json"), r), []);
  assert.deepEqual(Object.keys(r.cells), ["cmp"]);
  const cmp = r.cells.cmp;
  assert.equal(cmp.valid, 2);
  assert.equal(cmp.total, 3);
  assert.deepEqual(cmp.metrics.event_log_unpruned_days, { median: 2.5, min: 2, max: 3, n: 2, values: [2, 3] });
  assert.deepEqual(cmp.attempts.map((a) => [a.n, a.valid]), [[1, true], [2, true], [3, false]]);
  assert.deepEqual(r.workload.cells.cmp, attempts[0].load);
  assert.equal(r.workload.suite, "event-log-compaction@1");
  assert.equal(r.status, "complete");
  assert.equal(r.status_reason, null);
  assert.equal(r.harness.sha, hex("harness-public", 40), "the harness is published by its public tag commit");
});

test("a public reason is kept where no valid attempt has a value; fewer than two valid attempts is partial", () => {
  let r = merge([attempt(1, na("no_event_prune")), attempt(2, na("no_event_prune")), attempt(3, na("no_event_prune"))]);
  assert.deepEqual(r.cells.cmp.metrics.event_log_unpruned_days, { median: null, min: null, max: null, n: 0, values: [null, null, null], reason: "no_event_prune" });
  assert.equal(r.status, "complete");
  r = merge([attempt(1, ok(2)), attempt(2, na("mark_unreadable")), attempt(3, na("mark_unreadable"))]);
  assert.equal(r.cells.cmp.valid, 1);
  assert.equal(r.status, "partial");
  assert.equal(r.status_reason, "attempts_invalid");
  r = merge([attempt(1, ok(2)), attempt(2, ok(2))], { timedOut: true });
  assert.equal(r.status, "partial");
  assert.equal(r.status_reason, "timeout");
});

test("the merge refuses attempts of another record, another cell or load than the row's, a duplicate, and an unpinned harness", () => {
  const a1 = attempt(1, ok(2));
  const a2 = attempt(2, ok(3));
  assert.throws(() => merge([a1, { ...a2, record_id: "2026-11-14.linux-x64.nightly" }]), /record_id differs/);
  assert.throws(() => merge([a1, { ...a2, cell: "zzz" }]), /cell zzz/);
  assert.throws(() => merge([a1, { ...a2, load: { ...a2.load, subscribers: 3 } }]), /load .*row's cell cmp/);
  assert.throws(() => merge([a1, a1]), /duplicate attempt cmp-1/);
  const refs = refsFor(a1);
  refs.harness[a1.harness.version].files_sha256 = "0".repeat(64);
  assert.throws(() => mergeScenarioRecord({ attempts: [a1, a2], publicRefs: refs }), /files_sha256 is not the pinned public tree's/);
  assert.throws(() => mergeScenarioRecord({ attempts: [a1, a2], publicRefs: { ...refs, harness: {} } }), /no public tag pinned/);
  assert.throws(() => mergeScenarioRecord({ attempts: [], publicRefs: refsFor(a1) }), /no attempts/);
});

test("mergeDirectory merges a scenario record's attempts, and refuses ladder and scenario attempts together", () => {
  const out = tmp();
  for (const n of [1, 2, 3]) {
    const a = attempt(n, ok(n));
    fs.mkdirSync(path.join(out, "attempts", `cmp-${n}`), { recursive: true });
    fs.writeFileSync(path.join(out, "attempts", `cmp-${n}`, "attempt.json"), JSON.stringify(a));
  }
  const first = JSON.parse(fs.readFileSync(path.join(out, "attempts", "cmp-1", "attempt.json"), "utf8"));
  const r = mergeDirectory(out, { publicRefs: refsFor(first), generatedAt: "2026-11-15T18:00:00Z" });
  assert.equal(r.schema, "t3cp/scenario-record/1");
  assert.equal(r.cells.cmp.metrics.event_log_unpruned_days.median, 2);
  // A ladder attempt in a scenario record's directory is refused.
  const raw = tmp();
  writeRawAttempt(raw, { cell: "100", n: 1 });
  fs.mkdirSync(path.join(out, "attempts", "100-1"), { recursive: true });
  fs.writeFileSync(path.join(out, "attempts", "100-1", "attempt.json"), JSON.stringify({ schema: "t3cp/attempt/1" }));
  assert.throws(() => mergeDirectory(out, { publicRefs: refsFor(first) }), MergeError);
  // So is an extras document: a scenario record measures no record extras.
  fs.rmSync(path.join(out, "attempts", "100-1"), { recursive: true });
  fs.mkdirSync(path.join(out, "extras"), { recursive: true });
  fs.writeFileSync(path.join(out, "extras", "fixture.json"), JSON.stringify({ schema: "t3cp/extras/1" }));
  assert.throws(() => mergeDirectory(out, { publicRefs: refsFor(first) }), /extras/);
});

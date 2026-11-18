// A record that reached its deadline (the runner's failure record_timeout, exit 5) is merged from what it exported in
// time and published as partial with the public status_reason "timeout", even when its cells are complete: the record
// did not finish. merge.mjs reads it from <O>/failures/*.json, the directory the VM merges, so its command line is
// unchanged. A deadline can leave a finished but unmoved export in a dot-directory (attempts/.<cell>.tmp/,
// extras/.tmp/): merge ignores dot-entries and still refuses any other unexpected name. Extras stats keep their
// public reasons. Inputs are hand-made synthetic attempts and extras (tools/t3cp/lib/fake.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MergeError, mergeDirectory } from "./merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from "./lib/fake.mjs";
import { loadCatalogue, loadSchema } from "./lib/repo.mjs";
import { validate } from "./lib/validate.mjs";

const catalogue = loadCatalogue();
const identity = fakeIdentity({ date: "2026-11-10" });
const GEN = "2026-11-10T18:00:00Z";
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const failure = (over = {}) => ({
  schema: "t3cp/failure/1",
  record_id: identity.record_id,
  lease: 1,
  reason: "record_timeout",
  retryable: false,
  at: "2026-11-10T17:59:00Z",
  detail: "the record's deadline was reached after 21000 s of this run; its work is stopped",
  deadline_epoch_s: 1_794_340_740,
  elapsed_s: 21_000,
  ...over,
});
/** An output directory as the runner leaves it: attempts (all, or those `keep` passes), extras, failures. */
function outDir({ keep = () => true, failures = [], extras = [fakeExtras(catalogue, identity)], edit } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-merge-timeout-"));
  temps.push(dir);
  for (const a of fakeAttempts(catalogue, identity).filter(keep)) {
    fs.mkdirSync(path.join(dir, "attempts", `${a.cell}-${a.n}`), { recursive: true });
    fs.writeFileSync(path.join(dir, "attempts", `${a.cell}-${a.n}`, "attempt.json"), JSON.stringify(a));
  }
  fs.mkdirSync(path.join(dir, "extras"), { recursive: true });
  extras.forEach((e, i) => fs.writeFileSync(path.join(dir, "extras", `part-${i}.json`), JSON.stringify(e)));
  if (failures.length) fs.mkdirSync(path.join(dir, "failures"), { recursive: true });
  failures.forEach((f, i) => fs.writeFileSync(path.join(dir, "failures", `20261110T17590${i}000Z.json`), typeof f === "string" ? f : JSON.stringify(f)));
  edit?.(dir);
  return dir;
}
const merge = (dir) => mergeDirectory(dir, { publicRefs: FAKE_PUBLIC_REFS, generatedAt: GEN });
const recordSchema = loadSchema("record-1.json");

test("no failure: the record is merged as before (complete, no reason)", () => {
  const r = merge(outDir());
  assert.equal(r.status, "complete");
  assert.equal(r.status_reason, null);
});

test("record_timeout: partial with status_reason timeout, even when every cell is complete", () => {
  const r = merge(outDir({ failures: [failure()] }));
  assert.deepEqual(validate(recordSchema, r), []);
  assert.equal(r.status, "partial");
  assert.equal(r.status_reason, "timeout");
  assert.equal(r.cells["250"].valid, 3, "the cells measured in time are kept");
});

test("record_timeout with cells cut: partial, timeout (not attempts_invalid), the missing cells absent", () => {
  const r = merge(outDir({ keep: (a) => ["1", "50", "100"].includes(a.cell), failures: [failure()] }));
  assert.deepEqual(validate(recordSchema, r), []);
  assert.equal(r.status, "partial");
  assert.equal(r.status_reason, "timeout");
  assert.deepEqual(Object.keys(r.cells), ["1", "50", "100"]);
});

test("other failure reasons do not change the record; a record_timeout for another record, or an unreadable failure, is refused", () => {
  const other = merge(outDir({ failures: [failure({ reason: "hook_failed", retryable: true, deadline_epoch_s: undefined, elapsed_s: undefined })] }));
  assert.equal(other.status, "complete");
  assert.equal(other.status_reason, null);
  assert.throws(() => merge(outDir({ failures: [failure({ record_id: "2026-11-11.linux-x64.nightly" })] })), (e) => e instanceof MergeError && /failures\/.*record/.test(e.message));
  assert.throws(() => merge(outDir({ failures: ["{"] })), (e) => e instanceof MergeError && /failures\//.test(e.message));
  assert.throws(() => merge(outDir({ failures: [{ schema: "t3cp/heartbeat/1", reason: "record_timeout" }] })), (e) => e instanceof MergeError && /failures\//.test(e.message));
});

test("dot-entries a deadline can leave are ignored; any other unexpected name is still refused", () => {
  const dir = outDir({
    failures: [failure()],
    edit: (d) => {
      // A finished export the deadline left unmoved, and the extras' staging directory.
      fs.mkdirSync(path.join(d, "attempts", ".250.tmp"), { recursive: true });
      fs.writeFileSync(path.join(d, "attempts", ".250.tmp", "attempt.json"), "{}");
      fs.mkdirSync(path.join(d, "extras", ".tmp"), { recursive: true });
      fs.writeFileSync(path.join(d, "extras", ".tmp", "startup.json"), "{}");
      fs.writeFileSync(path.join(d, "failures", ".20261110T175901000Z.json.tmp"), "{");
    },
  });
  const r = merge(dir);
  assert.equal(r.status_reason, "timeout");
  const bad = outDir({ edit: (d) => fs.mkdirSync(path.join(d, "attempts", "250-x"), { recursive: true }) });
  assert.throws(() => merge(bad), (e) => e instanceof MergeError && /unexpected/.test(e.message));
});

test("extras stats keep their public reasons into the record", () => {
  const extras = fakeExtras(catalogue, identity);
  extras.fixture.metrics.db_ready_first_ms = { median: null, min: null, max: null, n: 0, values: [null, null, null], reason: "no_setup_span" };
  extras.empty.metrics.db_ready_warm_ms = { median: null, min: null, max: null, n: 0, values: [], reason: "extra_timeout" };
  extras.fixture.metrics.snapshot_full_get_ms = { median: null, min: null, max: null, n: 0, values: [null], reason: "extra_timeout" };
  const r = merge(outDir({ extras: [extras] }));
  assert.deepEqual(validate(recordSchema, r), []);
  assert.equal(r.extras.fixture.metrics.db_ready_first_ms.reason, "no_setup_span");
  assert.equal(r.extras.empty.metrics.db_ready_warm_ms.reason, "extra_timeout");
  assert.equal(r.extras.fixture.metrics.snapshot_full_get_ms.reason, "extra_timeout");
});

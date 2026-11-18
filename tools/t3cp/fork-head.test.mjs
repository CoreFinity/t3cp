// The nightly fork-head record: each night the public fork's main (the latest published release, at its tag commit) is
// measured beside that night's upstream nightly. It is a fork record (kind "fork": a release build, its release and its
// merge-base nightly as for a release record) keyed by the night it ran: record_id <D>.<platform>.fork, with
// paired_nightly {tag, date} naming the upstream nightly of night D. The coupling is enforced in code (the schema
// walker refuses if/then): a date-keyed fork id needs paired_nightly of that date and a -perf release tag; any other
// record carries no paired_nightly. Inputs are hand-made synthetic data (tools/t3cp/lib/fake*.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeSpec, writeRawAttempt } from "./lib/fake-raw.mjs";
import { FAKE_PUBLIC_REFS, fakeAttempts, fakeExtras, fakeIdentity } from "./lib/fake.mjs";
import { MergeError, mergeRecord } from "./merge.mjs";
import { loadCatalogue, loadSchema } from "./lib/repo.mjs";
import { validate } from "./lib/validate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const D = "2026-11-17";
const PAIRED = { tag: "v0.1.10-nightly.20261117.4800", date: D };
const BASE = { tag: "v0.1.10-nightly.20261115.4749", date: "2026-11-15", sha: "a".repeat(40) };
const headSpec = (over = {}) =>
  fakeSpec({
    record_id: `${D}.linux-x64.fork`,
    kind: "fork",
    release: { tag: "v0.1.9-perf.9", version: "0.1.9-perf.9", archive_name: "t3-0.1.9-perf.9-linux-x64.tar.gz", date: "2026-11-16" },
    base: BASE,
    paired_nightly: PAIRED,
    now: "2026-11-18T00:00:00Z",
    ...over,
  });

/** Runs the exporter CLI on one synthetic raw attempt: {status, stderr, attempt}. */
function exportWith(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-fork-head-"));
  temps.push(root);
  spec = structuredClone(spec);
  spec.fixture.path = path.join(root, "fixture.sqlite");
  spec.release.archive_path = path.join(root, "archive.tar.gz");
  fs.writeFileSync(spec.fixture.path, Buffer.alloc(4096));
  fs.writeFileSync(spec.release.archive_path, Buffer.alloc(2048));
  const raw = writeRawAttempt(path.join(root, "raw"), { cell: "100", n: 1, spec });
  fs.writeFileSync(path.join(root, "spec.json"), JSON.stringify(spec));
  const out = path.join(root, "out");
  const r = spawnSync(process.execPath, [path.join(here, "export.mjs"), raw, "--out", out, "--spec", path.join(root, "spec.json"), "--no-private-patterns"], {
    encoding: "utf8",
    env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" },
  });
  const file = path.join(out, "attempt.json");
  return { status: r.status, stderr: r.stderr, attempt: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null };
}

test("schemas: a date-keyed fork id is a record id everywhere (spec, attempt, extras, record); paired_nightly is defined", () => {
  const id = `${D}.linux-x64.fork`;
  const spec = loadSchema("record-spec-1.json");
  assert.match(id, new RegExp(spec.properties.record_id.pattern));
  assert.doesNotMatch(`${D}.linux-x64.forks`, new RegExp(spec.properties.record_id.pattern));
  assert.ok(spec.properties.paired_nightly, "the runner's input contract names paired_nightly");
  // As run-record.sh validates its spec on the VM (runner/lib.mjs validate).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-fork-head-spec-"));
  temps.push(root);
  fs.writeFileSync(path.join(root, "spec.json"), JSON.stringify(headSpec()));
  const r = spawnSync(process.execPath, [path.join(here, "runner/lib.mjs"), "validate", path.join(root, "spec.json"), path.join(here, "../../schema/record-spec-1.json")], { encoding: "utf8" });
  assert.equal(r.status, 0, `a fork-head spec is a valid record spec: ${r.stderr}`);
  for (const name of ["attempt-1.json", "extras-1.json", "record-1.json"]) {
    const s = loadSchema(name);
    assert.match(id, new RegExp(s.$defs.record_id.pattern), name);
  }
  for (const name of ["attempt-1.json", "record-1.json"]) assert.ok(loadSchema(name).properties.paired_nightly, `${name} defines paired_nightly`);
  for (const name of ["attempt-1.json", "record-1.json"]) assert.ok(!loadSchema(name).required.includes("paired_nightly"), `${name}: optional, every published record lacks it`);
});

test("export: a fork-head attempt carries paired_nightly, its date-keyed id, the release and its base; the era is the release's code", () => {
  const { status, stderr, attempt } = exportWith(headSpec());
  assert.equal(status, 0, stderr);
  assert.deepEqual(validate(loadSchema("attempt-1.json"), attempt), []);
  assert.equal(attempt.record_id, `${D}.linux-x64.fork`);
  assert.equal(attempt.kind, "fork");
  assert.deepEqual(attempt.paired_nightly, PAIRED);
  assert.equal(attempt.release.tag, "v0.1.9-perf.9");
  assert.equal(attempt.release.date, "2026-11-16");
  assert.deepEqual(attempt.base, BASE);
  assert.equal(attempt.workload.now, "2026-11-18T00:00:00Z");
  assert.equal(attempt.platform.id, "linux-x64");
});

test("export: the coupling is refused when broken, before anything is written", () => {
  const cases = [
    ["no paired_nightly", headSpec({ paired_nightly: undefined })],
    ["another night", headSpec({ paired_nightly: { ...PAIRED, date: "2026-11-16" } })],
    ["a tag of another night", headSpec({ paired_nightly: { ...PAIRED, tag: "v0.1.10-nightly.20261116.4790" } })],
    ["not a nightly tag", headSpec({ paired_nightly: { ...PAIRED, tag: "v0.1.9-perf.8" } })],
    ["a nightly release", headSpec({ release: { tag: "v0.1.10-nightly.20261116.4790", version: "0.1.10-nightly.20261116.4790", date: "2026-11-16" } })],
    ["paired_nightly on a release record", fakeSpec({ record_id: "0.1.9-perf.9.linux-x64.fork", kind: "fork", release: { tag: "v0.1.9-perf.9", version: "0.1.9-perf.9", date: "2026-11-16" }, base: BASE, paired_nightly: PAIRED })],
    ["paired_nightly on a nightly", fakeSpec({ paired_nightly: { tag: "v0.1.10-nightly.20261115.4749", date: "2026-11-15" } })],
    ["a date-keyed fork id of kind nightly", fakeSpec({ record_id: `${D}.linux-x64.fork`, paired_nightly: PAIRED })],
  ];
  for (const [what, spec] of cases) {
    const r = exportWith(spec);
    assert.notEqual(r.status, 0, what);
    assert.equal(r.attempt, null, `${what}: nothing written`);
    assert.match(r.stderr, /paired_nightly|fork-head|record_id|kind/, what);
  }
});

/** A fork-head record's attempts and extras, from the synthetic kit. */
function headIdentity() {
  const identity = fakeIdentity({ date: "2026-11-16", kind: "fork", tag: "v0.1.9-perf.9", base: BASE });
  identity.record_id = `${D}.linux-x64.fork`;
  identity.paired_nightly = { ...PAIRED };
  return identity;
}
const mergeIt = (attempts, identity) =>
  mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: "2026-11-17T20:00:00Z" });

test("merge: a fork-head record keeps paired_nightly and its pinned release; it validates as record-1", () => {
  const identity = headIdentity();
  const record = mergeIt(fakeAttempts(catalogue, identity), identity);
  assert.deepEqual(validate(loadSchema("record-1.json"), record), []);
  assert.equal(record.record_id, `${D}.linux-x64.fork`);
  assert.deepEqual(record.paired_nightly, PAIRED);
  assert.equal(record.release.sha, FAKE_PUBLIC_REFS.fork["v0.1.9-perf.9"], "the release's public commit, pinned");
  // A release record and a nightly carry none (the key is absent, not null).
  const release = fakeIdentity({ date: "2026-11-16", kind: "fork", tag: "v0.1.9-perf.9", base: BASE });
  assert.equal("paired_nightly" in mergeIt(fakeAttempts(catalogue, release), release), false);
  const nightly = fakeIdentity({ date: "2026-11-15" });
  assert.equal("paired_nightly" in mergeIt(fakeAttempts(catalogue, nightly), nightly), false);
});

test("merge: a broken coupling or attempts that disagree on paired_nightly are refused", () => {
  const identity = headIdentity();
  const mixed = fakeAttempts(catalogue, identity);
  delete mixed[3].paired_nightly;
  assert.throws(() => mergeIt(mixed, identity), (e) => e instanceof MergeError && /paired_nightly/.test(e.message));
  const missing = headIdentity();
  delete missing.paired_nightly;
  assert.throws(() => mergeIt(fakeAttempts(catalogue, missing), missing), (e) => e instanceof MergeError && /paired_nightly/.test(e.message));
  const other = headIdentity();
  other.paired_nightly.date = "2026-11-16";
  assert.throws(() => mergeIt(fakeAttempts(catalogue, other), other), (e) => e instanceof MergeError && /paired_nightly/.test(e.message));
  const onRelease = fakeIdentity({ date: "2026-11-16", kind: "fork", tag: "v0.1.9-perf.9", base: BASE });
  onRelease.paired_nightly = { ...PAIRED };
  assert.throws(() => mergeIt(fakeAttempts(catalogue, onRelease), onRelease), (e) => e instanceof MergeError && /paired_nightly/.test(e.message));
  // The publish rule is unchanged: the release must be pinned at its public commit.
  const unpinned = headIdentity();
  unpinned.release.sha = "e".repeat(40);
  assert.throws(() => mergeIt(fakeAttempts(catalogue, unpinned), unpinned), (e) => e instanceof MergeError && /not the public commit pinned/.test(e.message));
});

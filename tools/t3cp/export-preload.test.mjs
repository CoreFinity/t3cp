// The four harness hashes a record carries each come from one documented source, run.ts's result.json, so a reader
// recomputes each from the public tag by run.ts's own method: files_sha256 is identity.harness_files_sha256,
// driver_sha256 and fakes_sha256 are knobs.workload's, and preload_sha256 is identity.preload.sha256 (sha256 over the
// lines "<basename>\0<sha256 of the file>\n" for bench-preload.cjs, then bench-preload.mjs). The runner's own values in
// attempt-meta.json are never a fallback: its preload hash (another method) never reaches a record, and its files
// hash must agree with run.ts's. Inputs are hand-made synthetic raw attempts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeSpec, writeRawAttempt } from "./lib/fake-raw.mjs";
import { loadSchema } from "./lib/repo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const sha = (text) => createHash("sha256").update(text).digest("hex");
/** The harness block's properties in a schema file (the block is a $defs entry the identity refers to). */
function harnessOf(name) {
  const schema = loadSchema(name);
  const ref = schema.properties.harness.$ref;
  return (ref ? schema.$defs[ref.split("/").pop()] : schema.properties.harness).properties;
}

/** run.ts's method over two invented preload file bodies. */
const RUN_TS = sha(`bench-preload.cjs\0${sha("cjs body")}\nbench-preload.mjs\0${sha("mjs body")}\n`);
const RUNNER = sha("cjs body"); // the runner's plain hash of the .cjs alone: another method

function exportWith(edit, { expect = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-preload-"));
  temps.push(root);
  const spec = structuredClone(fakeSpec());
  spec.fixture.path = path.join(root, "fixture.sqlite");
  spec.release.archive_path = path.join(root, "archive.tar.gz");
  fs.writeFileSync(spec.fixture.path, Buffer.alloc(4096));
  fs.writeFileSync(spec.release.archive_path, Buffer.alloc(2048));
  const raw = writeRawAttempt(path.join(root, "raw"), { cell: "100", n: 1, edit, spec });
  fs.writeFileSync(path.join(root, "spec.json"), JSON.stringify(spec));
  const out = path.join(root, "out");
  const r = spawnSync(process.execPath, [path.join(here, "export.mjs"), raw, "--out", out, "--spec", path.join(root, "spec.json"), "--no-private-patterns"], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" } });
  assert.equal(r.status, expect, r.stderr);
  return expect === 0 ? JSON.parse(fs.readFileSync(path.join(out, "attempt.json"), "utf8")) : r;
}

test("preload_sha256 is run.ts's identity.preload.sha256, never the runner's hash in attempt-meta.json", () => {
  const a = exportWith((f) => {
    f.meta.harness.preload_sha256 = RUNNER;
    f.result.identity.preload = { file: "bench-preload.cjs", sha256: RUN_TS };
  });
  assert.equal(a.harness.preload_sha256, RUN_TS);
  assert.ok(!JSON.stringify(a).includes(RUNNER), "the runner's hash is in no field");
});

test("preload_sha256: a run without a preload (identity.preload null) records null, whatever attempt-meta.json says", () => {
  const a = exportWith((f) => {
    f.meta.harness.preload_sha256 = RUNNER;
    f.result.identity.preload = null;
  });
  assert.equal(a.harness.preload_sha256, null);
});

test("files_sha256 is run.ts's identity.harness_files_sha256; with none there, the runner's copy is no fallback (refused)", () => {
  const X = sha("files by run.ts");
  const a = exportWith((f) => {
    f.meta.harness.files_sha256 = X;
    f.result.identity.harness_files_sha256 = X;
  });
  assert.equal(a.harness.files_sha256, X);
  exportWith(
    (f) => {
      f.meta.harness.files_sha256 = X;
      delete f.result.identity.harness_files_sha256;
    },
    { expect: 2 },
  );
  const r = exportWith(
    (f) => {
      f.meta.harness.files_sha256 = sha("runner copy");
      f.result.identity.harness_files_sha256 = X;
    },
    { expect: 2 },
  );
  assert.match(r.stderr, /files_sha256 differs/);
});

test("driver_sha256 and fakes_sha256 are run.ts's knobs.workload values", () => {
  const D = sha("driver by run.ts");
  const F = sha("fakes by run.ts");
  const a = exportWith((f) => {
    f.result.knobs.workload.driver_sha256 = D;
    f.result.knobs.workload.fakes_sha256 = F;
  });
  assert.equal(a.harness.driver_sha256, D);
  assert.equal(a.harness.fakes_sha256, F);
});

test("the schemas name each harness hash's source and method, so a reader can recompute them from the public tag", () => {
  for (const name of ["attempt-1.json", "record-1.json"]) {
    const h = harnessOf(name);
    assert.match(h.files_sha256.description ?? "", /identity\.harness_files_sha256/, `${name} files_sha256`);
    assert.match(h.files_sha256.description ?? "", /harnessFilesSha256/, `${name} files_sha256 method`);
    assert.match(h.driver_sha256.description ?? "", /knobs\.workload\.driver_sha256/, `${name} driver_sha256`);
    assert.match(h.driver_sha256.description ?? "", /driverHash/, `${name} driver_sha256 method`);
    assert.match(h.fakes_sha256.description ?? "", /knobs\.workload\.fakes_sha256/, `${name} fakes_sha256`);
    assert.match(h.fakes_sha256.description ?? "", /fakesHash/, `${name} fakes_sha256 method`);
  }
});

test("preload_sha256: the schemas name the method, so a reader can recompute it from the public tag", () => {
  for (const name of ["attempt-1.json", "record-1.json"]) {
    const d = harnessOf(name).preload_sha256.description ?? "";
    assert.match(d, /identity\.preload\.sha256/, `${name} names run.ts's field`);
    assert.match(d, /bench-preload\.cjs/, `${name} names the first file`);
    assert.match(d, /bench-preload\.mjs/, `${name} names the second file`);
  }
});

test("harness.sha is described: in a record, the public commit the version's tag points at; in an attempt, the run's own, which merge replaces", () => {
  for (const name of ["attempt-1.json", "record-1.json"]) {
    const d = harnessOf(name).sha.description ?? "";
    assert.match(d, /public commit/, `${name}: the public commit`);
    assert.match(d, /tag points at/, `${name}: the version's tag`);
    assert.match(d, /public-refs\.json/, `${name}: where it is pinned`);
    assert.match(d, /merge/, `${name}: who replaces an attempt's`);
  }
});

test("preload_sha256's method holds for any preload path: the loaded file, then bench-preload.mjs in that file's directory", () => {
  for (const name of ["attempt-1.json", "record-1.json"]) {
    const d = harnessOf(name).preload_sha256.description ?? "";
    assert.match(d, /--preload/, `${name}: a non-default preload`);
    assert.match(d, /in that file's directory/, `${name}: the second file sits beside the loaded one`);
    assert.match(d, /by default/, `${name}: the default path is named as the default`);
  }
});

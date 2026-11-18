// The exporter against the run.json of t3cp-harness/2.0.0: problems as {code, kind} only, the saturation block, served
// and total agents that may be null, server.stop, driver_failure, and the driver's post-window distribution check (an
// exact binomial test; the record publishes its p50 and p95 ratios and its verdict, never its counts). Inputs are
// hand-made synthetic raw directories (lib/fake-raw.mjs writes the 2.0.0 shape by default).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeDistributionMatch, fakeSpec, harnessRun, writeRawAttempt } from "./lib/fake-raw.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const exporter = path.join(here, "export.mjs");
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function setup({ cell = "100", n = 1, edit } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-export-h2-"));
  temps.push(root);
  const spec = structuredClone(fakeSpec());
  spec.fixture.path = path.join(root, "fixture.sqlite");
  spec.release.archive_path = path.join(root, "archive.tar.gz");
  fs.writeFileSync(spec.fixture.path, Buffer.alloc(4096));
  fs.writeFileSync(spec.release.archive_path, Buffer.alloc(2048));
  const raw = writeRawAttempt(path.join(root, "raw"), { cell, n, edit, spec });
  const specFile = path.join(root, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec));
  return { root, raw, specFile, out: path.join(root, "out", `${cell}-${n}`) };
}
const run = (s) => spawnSync(process.execPath, [exporter, s.raw, "--out", s.out, "--spec", s.specFile, "--no-private-patterns"], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" } });
const read = (s) => JSON.parse(fs.readFileSync(path.join(s.out, "attempt.json"), "utf8"));
function exported(s, what) {
  const r = run(s);
  assert.equal(r.status, 0, `${what}: exit ${r.status}\n${r.stderr}`);
  return read(s);
}
function refused(s, what, pattern) {
  const r = run(s);
  assert.equal(r.status, 2, `${what}: exit ${r.status}\n${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(s.out, "attempt.json")), `${what}: nothing written`);
  if (pattern) assert.match(r.stderr, pattern, what);
  return r;
}
/** A 2.0.0 run the harness judged invalid with these {code, kind} problems. */
const invalid = (problems) => (f) => {
  f.run.valid = false;
  f.run.saturated = false;
  f.run.problems = problems;
  f.result.runs.valid = 0;
  f.result.run_details[0].valid = false;
};
const match = (f) => f.run.driver.workload.distribution_match;

test("2.0.0: the synthetic default attempt is the 2.0.0 run.json shape, and it exports", () => {
  const s = setup();
  const runJson = JSON.parse(fs.readFileSync(path.join(s.raw, "work", "runs", "release", "attempt-1", "run.json"), "utf8"));
  assert.equal(typeof runJson.saturated, "boolean");
  assert.deepEqual(Object.keys(runJson.saturation), ["elu", "elu_source", "threshold"]);
  assert.deepEqual(Object.keys(runJson.server.stop), ["forced", "signal_to_exit_ms", "exited_before_stop"]);
  assert.equal(runJson.driver_failure, null);
  assert.equal(typeof runJson.driver.workload.distribution_match.test.passed, "boolean");
  const a = exported(s, "the default attempt");
  assert.equal(a.attempt.valid, true);
  assert.equal(a.harness.version, "t3cp-harness/2.0.0");
});

test("2.0.0: served and total agents are null on a run whose window was not measured; the attempt exports as invalid, without the failure's text", () => {
  const reason = ["the driver exited", "with code 1"].join(" ");
  const s = setup({
    edit: (f) => {
      invalid([{ code: "driver_failed", kind: "defect" }])(f);
      f.run.sessions_served = null;
      f.run.sessions_total = null;
      f.run.window = null;
      f.run.driver_failure = { phase: "setup", code: "fixture_unreadable", reason, exit_code: 1, signal: null, result_file: "present" };
      f.run.driver.workload.distribution_match = null;
    },
  });
  const a = exported(s, "an unmeasured 2.0.0 run");
  assert.equal(a.attempt.valid, false);
  assert.deepEqual(a.attempt.problems, ["driver_failed"]);
  assert.equal(a.attempt.agents_total, 100, "from the cell's profile when run.json has none");
  assert.ok(!JSON.stringify(a).includes(reason), "driver_failure's text is never copied");
});

test("2.0.0: preload_not_loaded as a {code, kind} problem leaves the preload metrics n/a, as the bare code did", () => {
  const s = setup({ edit: (f) => (f.run.problems = [{ code: "preload_not_loaded", kind: "defect" }]) });
  const a = exported(s, "a 2.0.0 run without its preload");
  assert.equal(a.attempt.valid, true);
  assert.deepEqual(a.attempt.problems, ["preload_not_loaded"]);
  for (const id of ["eld_p50_ms", "eld_p99_ms", "eld_max_ms", "gc_ms_per_s", "stall_share_40ms"]) assert.equal(a.metrics[id], null, id);
  assert.notEqual(a.metrics.server_eld_max_ms, null, "the server's own gauge stays");
});

test("distribution: each attempt publishes the check's p50 and p95 ratios and its verdict, never its counts, bands or p-values", () => {
  const a = exported(setup(), "a passing check");
  assert.deepEqual(a.attempt.distribution, { test: "binomial", p50_ratio: 1.02, p95_ratio: 0.97, passed: true });
  const text = JSON.stringify(a);
  for (const key of ["below_p50", "above_p95", "band_below", "p_value_below", "expected_above", "alpha"]) assert.ok(!text.includes(key), key);

  const failing = exported(
    setup({
      edit: (f) => {
        invalid([{ code: "distribution_mismatch", kind: "defect" }])(f);
        Object.assign(match(f), { p50Ratio: 1.41, p95Ratio: 1.9, withinTolerance: false });
        Object.assign(match(f).test, { below_p50: 96, p_value_below: 0.0000123, passed: false });
      },
    }),
    "a failing check",
  );
  assert.equal(failing.attempt.valid, false);
  assert.deepEqual(failing.attempt.problems, ["distribution_mismatch"]);
  assert.deepEqual(failing.attempt.distribution, { test: "binomial", p50_ratio: 1.41, p95_ratio: 1.9, passed: false });

  // An older harness's ratio check (no binomial test): the ratios and its tolerance verdict.
  const older = exported(setup({ edit: (f) => delete match(f).test }), "a ratio-only check");
  assert.deepEqual(older.attempt.distribution, { test: "ratio_tolerance", p50_ratio: 1.02, p95_ratio: 0.97, passed: true });
  // No check (the empty-database cell, or a run.json without one): null.
  assert.equal(exported(setup({ cell: "1e" }), "the empty-database cell").attempt.distribution, null);
  assert.equal(exported(setup({ edit: (f) => delete f.run.driver }), "no driver block").attempt.distribution, null);
});

test("distribution: an unknown key or an out-of-range value in the check is refused", () => {
  const cases = [
    ["an unknown key in the match", (m) => (m.note = "x")],
    ["an unknown key in the test", (m) => (m.test.z_score = 1.2)],
    ["a missing ratio", (m) => delete m.p95Ratio],
    ["a negative ratio", (m) => (m.p50Ratio = -1)],
    ["a string verdict", (m) => (m.withinTolerance = "yes")],
    ["a fractional count", (m) => (m.test.below_p50 = 148.5)],
    ["a p-value above 1", (m) => (m.test.p_value_above = 1.5)],
    ["a band of three", (m) => (m.test.band_below = [1, 2, 3])],
    ["a share above 1", (m) => (m.test.expected_below = 2)],
  ];
  for (const [what, plant] of cases) refused(setup({ edit: (f) => plant(match(f)) }), what);
  assert.deepEqual(Object.keys(fakeDistributionMatch().test).length, 11, "the 2.0.0 test has eleven fields");
});

test("distribution: a verdict that contradicts itself, its bands or the run's problems is refused", () => {
  const cases = [
    ["withinTolerance differs from the test's verdict", (f) => (match(f).withinTolerance = false)],
    ["passed with a count outside its band", (f) => (match(f).test.below_p50 = 200)],
    ["failed with every count inside its bands", (f) => { match(f).test.passed = false; match(f).withinTolerance = false; invalid([{ code: "distribution_mismatch", kind: "defect" }])(f); }],
    ["a count above n", (f) => { match(f).test.above_p95 = 301; match(f).test.band_above = [4, 301]; }],
    ["a band that runs backwards", (f) => (match(f).test.band_above = [28, 4])],
    ["failed without distribution_mismatch", (f) => { Object.assign(match(f), { withinTolerance: false }); Object.assign(match(f).test, { below_p50: 96, passed: false }); }],
    ["distribution_mismatch with a passing check", (f) => invalid([{ code: "distribution_mismatch", kind: "defect" }])(f)],
  ];
  for (const [what, plant] of cases) refused(setup({ edit: plant }), what, /distribution/);
});

test("server.stop: a forced stop (SIGKILL after the grace) or a server gone before the stop leaves shutdown_s n/a; an unknown key is refused", () => {
  assert.equal(exported(setup(), "a clean stop").metrics.shutdown_s, 3, "SIGTERM to gone on a clean stop");
  const forced = exported(setup({ edit: (f) => (f.run.server.stop = { forced: true, signal_to_exit_ms: 120004, exited_before_stop: false }) }), "a forced stop");
  assert.equal(forced.metrics.shutdown_s, null, "a forced stop's time is the grace, not the server's shutdown");
  assert.equal(forced.attempt.valid, true, "the window itself stands");
  const gone = exported(setup({ edit: (f) => (f.run.server.stop = { forced: false, signal_to_exit_ms: null, exited_before_stop: true }) }), "gone before the stop");
  assert.equal(gone.metrics.shutdown_s, null);
  refused(setup({ edit: (f) => (f.run.server.stop.signal = "SIGTERM") }), "an unknown key in server.stop");
  refused(setup({ edit: (f) => (f.run.server.stop.forced = "no") }), "a string forced");
  assert.equal(exported(setup({ edit: (f) => delete f.run.server }), "an older run.json without server.stop").metrics.shutdown_s, 3);
});

test("saturation: the block's shape is checked, and a saturated run must have its ELU at or above the threshold", () => {
  const ok = exported(setup({ cell: "250", edit: harnessRun({ codes: ["sessions_starved"], elu: 0.999, source: "preload", served: 21, total: 250 }) }), "a saturated run");
  assert.equal(ok.attempt.saturated, true);
  assert.deepEqual(ok.attempt.saturated_by, ["sessions_starved"]);
  assert.equal(ok.metrics.agents_served, 21);
  const below = (f) => {
    harnessRun({ codes: ["sessions_starved"], elu: 0.999, source: "preload", served: 21, total: 250 })(f);
    f.run.metrics.loop.elu = 0.5;
    f.run.saturation.elu = 0.5;
  };
  refused(setup({ cell: "250", edit: below }), "saturated below the threshold", /saturat|ELU/);
  refused(setup({ edit: (f) => (f.run.saturation.elu_source = "mystery") }), "an unknown ELU source");
  refused(setup({ edit: (f) => (f.run.saturation.extra = 1) }), "an unknown key");
  refused(setup({ edit: (f) => (f.run.saturation.elu = 1.5) }), "an ELU above 1");
  refused(setup({ edit: (f) => (f.run.saturation = { elu: 0.5, elu_source: null, threshold: 0.95 }) }), "an ELU without its source");
  assert.equal(exported(setup({ edit: harnessRun({ elu: null }) }), "no ELU in the run's metrics").attempt.valid, true);
});

test("harness edge cases are accepted: a stored p-value equal to alpha on a passed test, tied fixture shares, an ELU of exactly 1", () => {
  // The harness decides passed on unrounded p-values and stores them at 4 significant figures, so a passed test can
  // show p = alpha; the exporter never re-derives passed from the stored p-values.
  const atAlpha = exported(setup({ edit: (f) => Object.assign(match(f).test, { p_value_below: 0.001 }) }), "a stored p-value at alpha");
  assert.equal(atAlpha.attempt.distribution.passed, true);
  // With ties the fixture's own shares below its p50 and above its p95 are not 0.5 and 0.05.
  assert.equal(exported(setup({ edit: (f) => Object.assign(match(f).test, { expected_below: 0.471204, expected_above: 0.038 }) }), "tied shares").attempt.valid, true);
  // A saturated server can record an ELU of exactly 1.
  const full = exported(setup({ cell: "250", edit: harnessRun({ codes: ["sessions_starved"], elu: 1, source: "preload", served: 25, total: 250 }) }), "an ELU of 1");
  assert.equal(full.attempt.saturated, true);
});

test("driver.json's own block (the VM's host name, an installed harness's null sha) and git's stderr never reach the attempt", () => {
  const host = ["t3", "perf", "runner", "d", "7"].join("-");
  const gitError = ["fatal: not a git repository", "(or any of the parent directories): .git"].join(" ");
  const s = setup({
    edit: (f) => {
      f.driver.driver = { sha: null, dirty: null, node: "v26.1.0", platform: "Linux-x86_64", host, pid: 5151 };
      f.driver.knobs = { mode: "mixed", tokenFile: `/${["home", "runner"].join("/")}/token` };
    },
  });
  const runDir = path.join(s.raw, "work", "runs", "release", "attempt-1");
  fs.writeFileSync(path.join(s.raw, "run.log"), `run.ts output\n${gitError}\n`);
  fs.writeFileSync(path.join(runDir, "driver", "driver.stderr"), `${gitError}\n${host}\n`);
  const a = exported(s, "a driver.json naming its host");
  const text = JSON.stringify(a);
  assert.ok(!text.includes(host), "no host name");
  assert.ok(!text.includes("not a git repository"), "no git stderr");
  assert.ok(!text.includes("token"), "no token file path");
  assert.equal(a.attempt.valid, true);
});

test("2.0.1: decidedBy beside withinTolerance is accepted as \"binomial\" with its test; any other value, or binomial without a test, is refused", () => {
  const a = exported(setup({ edit: (f) => (match(f).decidedBy = "binomial") }), "a 2.0.1 check");
  assert.deepEqual(a.attempt.distribution, { test: "binomial", p50_ratio: 1.02, p95_ratio: 0.97, passed: true });
  assert.ok(!JSON.stringify(a).includes("decidedBy"));
  refused(setup({ edit: (f) => (match(f).decidedBy = "ratio") }), "an unknown decidedBy");
  refused(setup({ edit: (f) => (match(f).decidedBy = null) }), "a null decidedBy");
  refused(setup({ edit: (f) => { match(f).decidedBy = "binomial"; delete match(f).test; } }), "binomial without its test", /distribution/);
});

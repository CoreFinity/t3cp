// The exporter re-checks what run.json and attempt-meta.json say instead of trusting them (the delta re-review's
// reproductions): the harness's classification (run.ts classifyProblems: the window ELU from the run's own metrics,
// the 0.95 threshold, which codes may be saturation, which defects are fatal), the served agents against the cell's
// profile, and the runner's host guard and maintenance keys, which must be present. Inputs are hand-made synthetic raw
// directories; harnessRun builds a run.json as the harness classifies it, and each case then breaks one part.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeDistributionMatch, fakeSpec, harnessRun, legacyRun, writeRawAttempt } from "./lib/fake-raw.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const exporter = path.join(here, "export.mjs");
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function setup({ cell = "100", edit } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-export-trust-"));
  temps.push(root);
  const spec = structuredClone(fakeSpec());
  spec.fixture.path = path.join(root, "fixture.sqlite");
  spec.release.archive_path = path.join(root, "archive.tar.gz");
  fs.writeFileSync(spec.fixture.path, Buffer.alloc(4096));
  fs.writeFileSync(spec.release.archive_path, Buffer.alloc(2048));
  const raw = writeRawAttempt(path.join(root, "raw"), { cell, n: 1, edit, spec });
  const specFile = path.join(root, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec));
  return { raw, specFile, out: path.join(root, "out", `${cell}-1`) };
}
const run = (s) => spawnSync(process.execPath, [exporter, s.raw, "--out", s.out, "--spec", s.specFile, "--no-private-patterns"], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" } });
function exported(s, what) {
  const r = run(s);
  assert.equal(r.status, 0, `${what}: exit ${r.status}\n${r.stderr}`);
  return JSON.parse(fs.readFileSync(path.join(s.out, "attempt.json"), "utf8"));
}
function refused(s, what) {
  const r = run(s);
  assert.equal(r.status, 2, `${what}: exit ${r.status} (expected a refusal)\n${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(s.out, "attempt.json")), `${what}: nothing written`);
}
/** harnessRun, then one part of run.json changed. */
const then = (options, change) => (f) => {
  harnessRun(options)(f);
  change(f.run, f);
};
const starved = { codes: ["sessions_starved"], elu: 0.97, served: 200, total: 250 };

test("saturation block: it must be present and equal the ELU the run's own metrics give, with the threshold 0.95 (F2b-F2f, F2n, F2o)", () => {
  const ok = exported(setup({ cell: "250", edit: harnessRun(starved) }), "a saturated run as the harness writes it");
  assert.equal(ok.attempt.saturated, true);
  refused(setup({ cell: "250", edit: then(starved, (r) => (r.saturation.threshold = 0.5)) }), "F2b: a threshold other than 0.95");
  refused(setup({ cell: "250", edit: then({ ...starved, elu: 0.6 }, (r) => { r.saturation.threshold = 0.5; r.saturated = true; r.problems[0].kind = "saturation"; r.valid = true; }) }), "F2b: ELU 0.6 under a lowered threshold");
  refused(setup({ cell: "250", edit: then(starved, (r) => delete r.saturation) }), "F2c: no saturation block");
  refused(setup({ cell: "250", edit: then(starved, (r) => (r.saturation = null)) }), "F2d: a null saturation block");
  refused(setup({ cell: "250", edit: then(starved, (r) => (r.saturation = { elu: null, elu_source: null, threshold: 0.95 })) }), "F2e: saturated without an ELU");
  // F2f: every agent served, saturated by call timeouts: valid only if the run's metrics carry that ELU.
  assert.equal(exported(setup({ cell: "250", edit: harnessRun({ codes: ["call_timeouts"], elu: 0.97, served: 250, total: 250 }) }), "F2f consistent").attempt.saturated, true);
  refused(setup({ cell: "250", edit: then({ codes: ["call_timeouts"], elu: 0.97, served: 250, total: 250 }, (r) => delete r.metrics.otlp.elu_mean) }), "F2f: the block's ELU is in no metric");
  refused(setup({ cell: "250", edit: then(starved, (r) => { r.saturation.elu_source = "server_gauge"; r.saturation.elu = 0.96; delete r.metrics.otlp.elu_mean; }) }), "F2n: a server-gauge ELU with no gauge");
  refused(setup({ cell: "250", edit: then(starved, (r) => (r.metrics.loop = { elu: 0.5, eld_p50_ms: 10, eld_p99_ms: 20, eld_max_ms: 30 })) }), "F2o: the block's ELU differs from metrics.loop.elu");
});

test("kinds: saturation only for sessions_starved, session_mcp_missing and call_timeouts at an ELU of 0.95 or more; everything else is a defect (F2k, F2m)", () => {
  refused(setup({ cell: "250", edit: then({ ...starved, codes: ["sessions_starved", "server_exited"] }, (r) => { r.problems[1].kind = "saturation"; r.valid = true; r.saturated = true; }) }), "F2k: a fatal code of kind saturation");
  refused(setup({ cell: "250", edit: then({ codes: ["call_timeouts"], elu: 0.6, served: 250, total: 250 }, (r) => { r.problems[0].kind = "saturation"; r.valid = true; }) }), "F2m: kind saturation at ELU 0.6");
  refused(setup({ cell: "250", edit: then(starved, (r) => (r.problems[0].kind = "defect")) }), "a saturation code at ELU 0.97 reported as a defect");
  refused(setup({ edit: then({ codes: ["otlp_no_samples"] }, (r) => r.problems.push({ ...r.problems[0] })) }), "a code listed twice");
  refused(setup({ edit: then({ codes: [] }, (r) => (r.problems = ["otlp_no_samples"])) }), "a bare code in a 2.0 run.json");
});

test("validity: run.valid must be what the harness's rule gives; a fatal or window defect on a valid run is refused (F2l, F6i)", () => {
  refused(setup({ edit: then({ codes: ["server_exited"] }, (r) => (r.valid = true)) }), "F2l: server_exited on a valid run");
  refused(
    setup({
      edit: (f) => {
        harnessRun({ codes: ["distribution_mismatch"] })(f);
        Object.assign(f.run.driver.workload.distribution_match, { withinTolerance: false });
        Object.assign(f.run.driver.workload.distribution_match.test, { below_p50: 100, passed: false });
        f.run.valid = true;
      },
    }),
    "F6i: a failed distribution check on a valid run",
  );
  refused(setup({ edit: then({ codes: ["otlp_no_samples"] }, (r) => (r.valid = false)) }), "invalid with only a non-fatal defect");
  assert.equal(exported(setup({ edit: harnessRun({ codes: ["otlp_no_samples"] }) }), "a non-fatal defect").attempt.valid, true);
  // Trace problems are fatal only when the server writes timed spans (result.json's sampling says so).
  refused(setup({ edit: then({ codes: ["trace_coverage"] }, (r) => (r.valid = true)) }), "a trace problem on a valid run that needed its trace");
  const untimed = (f) => {
    harnessRun({ codes: ["trace_coverage"] })(f);
    f.result.sampling.trace_min_level = "Warn";
    f.run.valid = true;
    f.result.runs.valid = 1;
    f.result.run_details[0].valid = true;
  };
  assert.equal(exported(setup({ edit: untimed }), "a trace problem when spans are untimed").attempt.valid, true);
  refused(setup({ cell: "250", edit: then(starved, (r) => (r.saturated = false)) }), "saturated must be valid and a saturation-kind problem");
  refused(setup({ edit: then({ codes: ["otlp_no_samples"] }, (r) => (r.saturated = true)) }), "saturated with no saturation-kind problem");
});

test("served agents: sessions_total is the cell's agents (F2j); a valid run that left agents unserved names sessions_starved, and the reverse", () => {
  refused(setup({ edit: harnessRun({ served: 100, total: 400 }) }), "F2j: 400 agents at the 100-agent cell");
  refused(setup({ edit: harnessRun({ codes: [], served: 90, total: 100 }) }), "a valid run with unserved agents and no sessions_starved");
  refused(setup({ edit: harnessRun({ codes: ["sessions_starved"], elu: 0.97, served: 100, total: 100 }) }), "sessions_starved with every agent served");
  refused(setup({ edit: harnessRun({ served: null, total: 100 }) }), "served without total, or the reverse");
  const unmeasured = exported(setup({ edit: harnessRun({ codes: ["driver_failed"], served: null, total: null }) }), "an unmeasured run");
  assert.equal(unmeasured.attempt.valid, false);
  assert.equal(unmeasured.attempt.agents_total, 100);
});

test("older harnesses: a run.json without saturated, the saturation block and {code, kind} problems is refused (F2g, F2h)", () => {
  refused(setup({ cell: "250", edit: (f) => { harnessRun({ ...starved, codes: ["sessions_starved", "server_exited"] })(f); legacyRun(f); } }), "F2g");
  refused(setup({ cell: "250", edit: (f) => { harnessRun({ ...starved, codes: ["sessions_starved", "otlp_no_samples"] })(f); legacyRun(f); f.run.valid = false; } }), "F2h");
});

test("runner keys: maintenance_in_window, contaminated, contamination_reasons and host_guard are required (F3e, F4c)", () => {
  for (const key of ["maintenance_in_window", "contaminated", "contamination_reasons", "host_guard"]) {
    refused(setup({ edit: (f) => delete f.meta[key] }), `${key} absent`);
  }
});

test("host guard: a null, empty or sampleless guard is unavailable; a boolean verdict must agree with its reasons (F4b, F5b)", () => {
  for (const [what, guard] of [["null", null], ["empty", {}], ["no samples", { method: "none", samples: 0 }]]) {
    const a = exported(setup({ edit: (f) => (f.meta.host_guard = guard) }), `F4b: a ${what} guard`);
    assert.equal(a.attempt.valid, false, what);
    assert.deepEqual(a.attempt.problems, ["host_guard_unavailable"], what);
    assert.equal(a.attempt.contaminated, null, `${what}: unknown, not clean`);
  }
  refused(setup({ edit: (f) => (f.meta.contamination_reasons = ["steal"]) }), "F5b: contaminated false with reasons");
  refused(setup({ edit: (f) => (f.meta.contaminated = true) }), "contaminated true without reasons");
  refused(setup({ edit: (f) => { f.meta.host_guard = null; f.meta.contaminated = true; f.meta.contamination_reasons = ["steal"]; } }), "contaminated with no guard to say so");
  const dirty = exported(setup({ edit: (f) => { f.meta.contaminated = true; f.meta.contamination_reasons = ["foreign_cpu"]; } }), "a contaminated attempt");
  assert.equal(dirty.attempt.contaminated, true);
  assert.equal(dirty.attempt.valid, false);
});

test("loop source: metrics.loop or loop-window.json, chosen once per attempt for every preload histogram field, never mixed", () => {
  const partial = exported(setup({ edit: (f) => (f.result.metrics.loop = { eld_p50_ms: 50 }) }), "metrics.loop with one field");
  assert.equal(partial.metrics.eld_p50_ms, 50);
  assert.equal(partial.metrics.eld_p99_ms, null, "not loop-window.json's 45.25");
  assert.equal(partial.metrics.eld_max_ms, null, "not loop-window.json's 120");
  const windowOnly = exported(setup(), "no metrics.loop");
  assert.deepEqual([windowOnly.metrics.eld_p50_ms, windowOnly.metrics.eld_p99_ms, windowOnly.metrics.eld_max_ms], [10.5, 45.25, 120]);
  assert.equal(fakeDistributionMatch().test.passed, true);
});

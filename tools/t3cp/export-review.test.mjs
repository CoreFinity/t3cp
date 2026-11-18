// Exporter findings of the independent review: problem codes (M1), duplicate keys (M2), typed 1 Hz series
// (M3), zero-sample statistics (M4), negative values (m4), a fully checked attempt-meta.json (m5) and the
// exporter's content hash (m6). Inputs are hand-made synthetic raw directories; planted strings are fragments.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeSpec, harnessRun, legacyRun, writeRawAttempt } from "./lib/fake-raw.mjs";
import { exportAttempt, EXPORTER_FILES } from "./export.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const exporter = path.join(here, "export.mjs");
const j = (...parts) => parts.join("");
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function setup({ cell = "100", n = 1, edit, spec = fakeSpec(), rawEdit } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-export-review-"));
  temps.push(root);
  spec = structuredClone(spec);
  spec.fixture.path = path.join(root, "fixture.sqlite");
  spec.release.archive_path = path.join(root, "archive.tar.gz");
  fs.writeFileSync(spec.fixture.path, Buffer.alloc(4096));
  fs.writeFileSync(spec.release.archive_path, Buffer.alloc(2048));
  const raw = writeRawAttempt(path.join(root, "raw"), { cell, n, edit, spec });
  rawEdit?.(raw);
  const specFile = path.join(root, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec));
  return { root, raw, spec, specFile, out: path.join(root, "out", `${cell}-${n}`) };
}
const run = (s) => spawnSync(process.execPath, [exporter, s.raw, "--out", s.out, "--spec", s.specFile, "--no-private-patterns"], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" } });
const read = (s) => JSON.parse(fs.readFileSync(path.join(s.out, "attempt.json"), "utf8"));
function refused(s, what) {
  const r = run(s);
  assert.equal(r.status, 2, `${what}: exit ${r.status}\n${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(s.out, "attempt.json")), `${what}: nothing written`);
  return r;
}
const runDir = (s) => path.join(s.raw, "work", "runs", "release", "attempt-1");
/** A run whose problems are these codes, classified as harness 2.0.x does (kinds, valid, saturated). */
const withProblems = (codes) => harnessRun({ codes });

// M1 ------------------------------------------------------------------------------------------------------
test("M1: harness problem codes pass through; any other code becomes other_problem and is never copied", () => {
  const known = setup({ edit: withProblems(["server_exited", "trace_coverage"]) });
  assert.equal(run(known).status, 0);
  assert.deepEqual(read(known).attempt.problems, ["server_exited", "trace_coverage"]);
  for (const planted of [j("host_w", "s4_down"), j("preempted_europe", "_west2"), "a".repeat(47)]) {
    const s = setup({ edit: withProblems([planted]) });
    assert.equal(run(s).status, 0, planted);
    const attempt = read(s);
    assert.deepEqual(attempt.attempt.problems, ["other_problem"]);
    assert.ok(!JSON.stringify(attempt).includes(planted));
  }
  // An unknown code on a run the harness kept valid makes the attempt invalid.
  const odd = setup({ edit: withProblems(["something_new"]) });
  assert.equal(run(odd).status, 0);
  assert.equal(read(odd).attempt.valid, false);
  assert.deepEqual(read(odd).attempt.problems, ["other_problem"]);
});

// M2 ------------------------------------------------------------------------------------------------------
test("M2: a duplicate key in result.json (a second server reference) or attempt-meta.json is refused", () => {
  const ref = ["server", "ref"].join("_");
  const s = setup({
    edit: (f) => {
      f.resultText = JSON.stringify(f.result).replace(`"${ref}":"sea:release"`, `"${ref}":"sea:release","${ref}":"sea:${j("/mn", "t/bench")}/x"`);
    },
  });
  const r = refused(s, "duplicate server reference");
  assert.match(r.stderr, /duplicate key/);
  const meta = setup({
    rawEdit: (raw) => {
      const file = path.join(raw, "attempt-meta.json");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"contaminated": false', '"contaminated": true, "contaminated": false'));
    },
  });
  refused(meta, "duplicate contaminated");
});

// M3 ------------------------------------------------------------------------------------------------------
test("M3: a string or a missing number in a consumed proc-1hz field refuses the export", () => {
  const procFile = (s) => path.join(runDir(s), "proc-1hz.ndjson");
  const s = setup({ rawEdit: () => {} });
  const lines = fs.readFileSync(procFile(s), "utf8").trim().split("\n");
  const row = JSON.parse(lines[100]);
  row.proc.cutime = "203435037172";
  lines[100] = JSON.stringify(row);
  fs.writeFileSync(procFile(s), `${lines.join("\n")}\n`);
  assert.match(refused(s, "string cutime").stderr, /proc-1hz/);
  const t = setup();
  const tl = fs.readFileSync(procFile(t), "utf8").trim().split("\n");
  // lines: the meta line, then one per second from 5 s before the window to 5 s after; index 306 is the window end.
  const end = JSON.parse(tl[306]);
  delete end.host.cpu.idle;
  tl[306] = JSON.stringify(end);
  fs.writeFileSync(procFile(t), `${tl.join("\n")}\n`);
  refused(t, "host cpu idle missing at the window end");
});

test("M3: an unparseable line is refused unless it is the final line (a torn write)", () => {
  const procFile = (s) => path.join(runDir(s), "proc-1hz.ndjson");
  const mid = setup();
  const lines = fs.readFileSync(procFile(mid), "utf8").trim().split("\n");
  lines[50] = '{"t": NaN}';
  fs.writeFileSync(procFile(mid), `${lines.join("\n")}\n`);
  refused(mid, "unparseable middle line");
  const torn = setup();
  fs.appendFileSync(procFile(torn), '{"t":17631');
  assert.equal(run(torn).status, 0);
  const loopTorn = setup();
  fs.appendFileSync(path.join(runDir(loopTorn), "loop-1hz.ndjson"), '{"t":1');
  assert.equal(run(loopTorn).status, 0);
  const loopMid = setup();
  const ll = fs.readFileSync(path.join(runDir(loopMid), "loop-1hz.ndjson"), "utf8").trim().split("\n");
  const bad = JSON.parse(ll[10]);
  bad.delay.max_ms = "120";
  ll[10] = JSON.stringify(bad);
  fs.writeFileSync(path.join(runDir(loopMid), "loop-1hz.ndjson"), `${ll.join("\n")}\n`);
  refused(loopMid, "string delay max");
});

// M4 ------------------------------------------------------------------------------------------------------
test("M4: a span, call or SQL entry with no samples gives null statistics, never 0; counts stay", () => {
  const s = setup({
    edit: (f) => {
      f.result.metrics.spans["OrchestratorV2.getThreadShell"] = { count: 0, errors: 0, total_ms: 0, avg_ms: 0, p50_ms: 0, p95_ms: 0, max_ms: 0 };
      f.result.metrics.driver.calls["session.turn"] = { count: 0, errors: 0, unfinished: 0, per_s: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0, max_ms: 0 };
      f.result.metrics.sql["sql.transaction|reader"] = { ...f.result.metrics.sql["sql.transaction|reader"], lock_wait_n: 0, avg_lock_wait_ms: 0, p95_lock_wait_ms: 0 };
      f.result.metrics.sql["sqlite|reader"] = { count: 0, errors: 0, total_ms: 0, avg_ms: 0, p50_ms: 0, p95_ms: 0, max_ms: 0 };
    },
  });
  assert.equal(run(s).status, 0);
  const m = read(s).metrics;
  assert.equal(m.get_thread_shell_p95_ms, null);
  assert.equal(m.turn_p50_ms, null);
  assert.equal(m.turn_p95_ms, null);
  assert.equal(m.turns_completed, 0, "a count of zero is a measurement");
  assert.equal(m.reader_tx_wait_avg_ms, null);
  assert.equal(m.reader_tx_wait_p95_ms, null);
  assert.ok(m.reader_tx_avg_ms > 0, "the transactions themselves had samples");
  assert.equal(m.reader_stmt_p95_ms, null);
});

// m4 ------------------------------------------------------------------------------------------------------
test("m4: a negative value where the unit cannot be negative is refused; negative zero is written as zero", () => {
  const s = setup({ edit: (f) => (f.result.metrics.cpu.main.busy_pct = -5) });
  assert.match(refused(s, "negative cpu").stderr, /main_busy_pct/);
  const z = setup({ edit: (f) => (f.resultText = JSON.stringify(f.result).replace('"sys_pct":12.4', '"sys_pct":-0')) });
  const attempt = exportAttempt(z.raw, z.spec, { privatePatterns: [] });
  assert.ok(Object.is(attempt.metrics.main_sys_pct, 0));
});

// m5 ------------------------------------------------------------------------------------------------------
test("m5: attempt-meta.json and the run results are schema-checked in full", () => {
  refused(setup({ edit: (f) => (f.meta.cycle_s = "478") }), "cycle_s string");
  refused(setup({ edit: (f) => (f.meta.host_guard.busy_pct_mean = "high") }), "host guard string");
  refused(setup({ edit: (f) => (f.meta.surprise = 1) }), "unknown top-level key");
  refused(setup({ edit: (f) => (f.meta.contaminated = "false") }), "contaminated string");
  refused(setup({ edit: (f) => (f.meta.release.sha = "b".repeat(40)) }), "meta release differs from the spec");
  refused(setup({ edit: (f) => (f.result.run_details[0].valid = "true") }), "run_details valid string");
  refused(setup({ edit: (f) => (f.result.runs.valid = "1") }), "runs.valid string");
  refused(setup({ edit: (f) => (f.run.valid = 1) }), "run.json valid number");
});

// m6 ------------------------------------------------------------------------------------------------------
test("m6: the exporter's content hash covers the merge and the record schema", () => {
  for (const rel of ["tools/t3cp/merge.mjs", "schema/record-1.json", "tools/t3cp/lib/json.mjs"]) assert.ok(EXPORTER_FILES.includes(rel), rel);
});

test("distribution tolerance: the runner's per-cell tolerance reaches attempt.json; null for fresh cells", () => {
  const s = setup({ edit: (f) => (f.meta.profile.distribution_tolerance = 2.5) });
  assert.equal(run(s).status, 0);
  assert.equal(read(s).profile.distribution_tolerance, 2.5);
  const fresh = setup({ cell: "1", edit: (f) => (f.meta.profile.distribution_tolerance = null) });
  assert.equal(run(fresh).status, 0);
  assert.equal(read(fresh).profile.distribution_tolerance, null);
  const bad = setup({ edit: (f) => (f.meta.profile.distribution_tolerance = "2.5") });
  refused(bad, "a string tolerance");
});

// minors of the re-review --------------------------------------------------------------------------------
test("7: counts must be integers, values stay under a sane bound per unit, and a call entry must be an object", () => {
  refused(setup({ edit: (f) => (f.result.metrics.driver.calls["session.turn"].count = 318.5) }), "a fractional count");
  refused(setup({ edit: (f) => (f.result.metrics.mem.rss_peak_mib = 1e308) }), "an absurd memory value");
  refused(setup({ edit: (f) => (f.result.metrics.otlp.elu_mean = 7) }), "a utilisation above 1");
  refused(setup({ edit: (f) => (f.result.metrics.driver.calls["poll.mcp.t3_project_list"] = 5) }), "a call entry that is a number");
});

test("2: the distribution tolerance stays within 0..5", () => {
  refused(setup({ edit: (f) => (f.meta.profile.distribution_tolerance = 6) }), "tolerance 6");
  refused(setup({ edit: (f) => (f.meta.profile.distribution_tolerance = -1) }), "tolerance -1");
});

test("8: an empty private list is refused with its real reason", () => {
  const s = setup();
  const list = path.join(s.root, "private.txt");
  fs.writeFileSync(list, "# nothing\n");
  const r = spawnSync(process.execPath, [exporter, s.raw, "--out", s.out, "--spec", s.specFile], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: list } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no patterns/);
});

test("sessions_starved is a harness code: it passes through; served/total counts are accepted in run.json", () => {
  // Since the ladder decision a starved run on a clean host, with the server's ELU at 0.95 or more, is saturated and
  // valid (tests below).
  const s = setup({ edit: harnessRun({ codes: ["sessions_starved"], elu: 0.97, served: 80, total: 100 }) });
  assert.equal(run(s).status, 0);
  const attempt = read(s);
  assert.deepEqual(attempt.attempt.problems, ["sessions_starved"]);
  assert.equal(attempt.attempt.saturated, true);
});

test("maintenance_in_window: attempt-meta.json accepts a count of 0 or more, the two runner codes and null; anything else is refused", () => {
  for (const value of [0, 2, "unscheduled_pre_marker", "unobserved_no_span", null]) {
    const s = setup({ edit: (f) => (f.meta.maintenance_in_window = value) });
    assert.equal(run(s).status, 0, JSON.stringify(value));
  }
  refused(setup({ edit: (f) => delete f.meta.maintenance_in_window }), "absent: the runner always writes it");
  for (const value of [-1, 1.5, "other"]) refused(setup({ edit: (f) => (f.meta.maintenance_in_window = value) }), JSON.stringify(value));
});

test("maintenance_in_window display: a count above 0 invalidates the attempt with its own code; 0 and the two runner codes are published as they are", () => {
  const busy = setup({ edit: (f) => (f.meta.maintenance_in_window = 2) });
  assert.equal(run(busy).status, 0);
  assert.equal(read(busy).attempt.maintenance_in_window, 2);
  assert.equal(read(busy).attempt.valid, false);
  assert.deepEqual(read(busy).attempt.problems, ["maintenance_in_window"]);
  for (const value of [0, "unobserved_no_span", "unscheduled_pre_marker"]) {
    const s = setup({ edit: (f) => (f.meta.maintenance_in_window = value) });
    assert.equal(run(s).status, 0, JSON.stringify(value));
    assert.equal(read(s).attempt.maintenance_in_window, value);
    assert.equal(read(s).attempt.valid, true, `${value} leaves validity alone`);
    assert.deepEqual(read(s).attempt.problems, []);
  }
});

test("harness review: absolute host paths in run.json (preload node options, resource monitor path) never reach an exported file", () => {
  // These fields are outside the allow-list, so this test proves the drop rather than changing behaviour.
  const home = ["", "ho" + "me", "someone", "bench"].join("/");
  const s = setup({
    edit: (f) => {
      f.run.preload = { node_options: `--max-old-space` + `-size=4321 --req` + `uire=${home}/bench-preload.cjs`, loaded: true };
      f.run.resource_monitor = { path: `${home}/release/resource-monitor/t3-resource-monitor` };
    },
  });
  assert.equal(run(s).status, 0);
  const text = fs.readFileSync(path.join(s.out, "attempt.json"), "utf8");
  assert.ok(!text.includes(home), "no host path");
  assert.ok(!text.includes("bench-preload"), "no preload file name");
  assert.ok(!/\/(home|Users|mnt|var|tmp|private|root|Volumes)\//.test(text), "no absolute path at all");
});

test("harness review: with preload_not_loaded the preload metrics (event loop delay, GC, stall shares) are n/a even if old preload files are present", () => {
  const s = setup({ edit: withProblems(["preload_not_loaded"]) });
  assert.equal(run(s).status, 0);
  const attempt = read(s);
  assert.equal(attempt.attempt.valid, true, "the run itself is valid");
  assert.deepEqual(attempt.attempt.problems, ["preload_not_loaded"]);
  for (const id of ["eld_p50_ms", "eld_p99_ms", "gc_ms_per_s", "stall_share_40ms", "stall_share_100ms", "stall_share_500ms"]) {
    assert.equal(attempt.metrics[id], null, id);
  }
  assert.equal(attempt.metrics.eld_max_ms, null, "the preload histogram's maximum too");
  assert.ok(attempt.metrics.elu !== null && attempt.metrics.server_eld_max_ms !== null, "the server's own gauges stay");
});

// The ladder decision (a): a clean-host attempt whose server could not serve every agent is SATURATED: published,
// valid, flagged, with agents_served n of N. Turn statistics come from the served agents only.
// The harness calls a starved window saturated when the server's window ELU is 0.95 or more.
const starve = (served, total, more = []) => harnessRun({ codes: ["sessions_starved", ...more], elu: 0.97, served, total });

test("saturated: a starved run on a clean host is valid and saturated, with agents_served n of N and its own statistics", () => {
  const s = setup({ cell: "250", edit: starve(180, 250) });
  assert.equal(run(s).status, 0);
  const a = read(s);
  assert.equal(a.attempt.valid, true);
  assert.equal(a.attempt.saturated, true);
  assert.equal(a.attempt.agents_total, 250);
  assert.equal(a.metrics.agents_served, 180);
  assert.deepEqual(a.attempt.problems, ["sessions_starved"]);
  assert.equal(a.metrics.turns_completed, null, "turns are counted by start time and outlast the window at saturation: not measured");
  assert.deepEqual(a.attempt.metric_reasons, { turns_completed: "not_measured_saturated" });
  assert.ok(a.metrics.poll_project_list_p95_ms > 0);
});

test("saturated: a starved window with no turn row: turns not measured (null, with the reason), latencies null, never 0; pollers stay", () => {
  const s = setup({
    cell: "250",
    edit: (f) => {
      starve(40, 250)(f);
      delete f.run.metrics.driver.calls["session.turn"];
      delete f.result.metrics.driver.calls["session.turn"];
    },
  });
  assert.equal(run(s).status, 0);
  const m = read(s).metrics;
  assert.equal(m.turns_completed, null, "not measured at saturation");
  assert.equal(m.turn_p50_ms, null);
  assert.equal(m.agents_served, 40);
  assert.ok(m.poll_http_bounded_p95_ms > 0);
});

test("turns completed: an unsaturated window's two shapes with no completed turn, a row of count 0 and no row, both give 0; no measured window gives null", () => {
  // The harness lists a call type when any session started such a call in the window: a row of count 0 when the calls
  // that started did not finish, no row when none started. On an unsaturated attempt both are a measured 0.
  const emptyRow = setup({
    cell: "100",
    edit: (f) => {
      const empty = { count: 0, errors: 0, unfinished: 12, per_s: 0.04, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null };
      Object.assign(f.run.metrics.driver.calls["session.turn"], empty);
      Object.assign(f.result.metrics.driver.calls["session.turn"], empty);
    },
  });
  const noRow = setup({
    cell: "200",
    edit: (f) => {
      delete f.run.metrics.driver.calls["session.turn"];
      delete f.result.metrics.driver.calls["session.turn"];
    },
  });
  for (const [what, s] of [["a row of count 0", emptyRow], ["no row", noRow]]) {
    assert.equal(run(s).status, 0, what);
    const m = read(s).metrics;
    assert.equal(m.turns_completed, 0, what);
    assert.equal(m.turn_p50_ms, null, what);
  }
  const unmeasured = setup({
    cell: "200",
    edit: (f) => {
      delete f.run.metrics.driver.calls["session.turn"];
      delete f.result.metrics.driver.calls["session.turn"];
      f.run.window = null;
    },
  });
  assert.equal(run(unmeasured).status, 0);
  assert.equal(read(unmeasured).metrics.turns_completed, null, "without a measured window nothing is known");
});

test("saturated: starvation with a fatal problem, on a contaminated host, or with a maintenance pass stays invalid", () => {
  const fatal = setup({ cell: "250", edit: starve(180, 250, ["server_exited"]) });
  assert.equal(run(fatal).status, 0);
  assert.equal(read(fatal).attempt.valid, false);
  assert.equal(read(fatal).attempt.saturated, false);
  const dirty = setup({ cell: "250", edit: (f) => { starve(180, 250)(f); f.meta.contaminated = true; f.meta.contamination_reasons = ["foreign_cpu"]; } });
  assert.equal(run(dirty).status, 0);
  assert.equal(read(dirty).attempt.valid, false);
  const busy = setup({ cell: "250", edit: (f) => { starve(180, 250)(f); f.meta.maintenance_in_window = 1; } });
  assert.equal(run(busy).status, 0);
  assert.equal(read(busy).attempt.valid, false);
});

test("saturated: a run that served everyone is not saturated and reports agents_served N", () => {
  const s = setup({ cell: "100", edit: (f) => { f.run.sessions_served = 100; f.run.sessions_total = 100; } });
  assert.equal(run(s).status, 0);
  assert.equal(read(s).attempt.saturated, false);
  assert.equal(read(s).metrics.agents_served, 100);
  refused(setup({ cell: "100", edit: (f) => { f.run.sessions_served = 120; f.run.sessions_total = 100; } }), "more served than started");
});

test("maintenance_in_window null on a valid run means unverified: the attempt is refused validity with maintenance_unverified", () => {
  const s = setup({ edit: (f) => (f.meta.maintenance_in_window = null) });
  assert.equal(run(s).status, 0);
  assert.equal(read(s).attempt.valid, false);
  assert.deepEqual(read(s).attempt.problems, ["maintenance_unverified"]);
  const dead = setup({ edit: (f) => { withProblems(["server_exited"])(f); f.meta.maintenance_in_window = null; } });
  assert.equal(run(dead).status, 0);
  assert.deepEqual(read(dead).attempt.problems, ["server_exited"], "an invalid run's null says nothing");
});

test("consistency: statistics from one source must be ordered (p50 <= p95 <= p99 <= max); different sources are not compared", () => {
  refused(setup({ edit: (f) => (f.result.metrics.driver.calls["session.dispatch"].p95_ms = 400) }), "a call whose p95 exceeds its max");
  refused(setup({ edit: (f) => (f.result.metrics.spans["OrchestratorV2.getThreadShell"].p50_ms = 70) }), "a span whose p50 exceeds its p95");
  const loop = setup();
  const lw = path.join(runDir(loop), "loop-window.json");
  const doc = JSON.parse(fs.readFileSync(lw, "utf8"));
  doc.delay.max_ms = 30; // below its own p99 (45.25)
  fs.writeFileSync(lw, JSON.stringify(doc));
  assert.match(refused(loop, "a preload histogram whose max is below its p99").stderr, /loop-window/);
  // The server gauge's maximum (eld_max_ms) and the preload histogram's percentiles are different sources.
  const mixed = setup({ edit: (f) => (f.result.metrics.otlp.event_loop_delay_max_ms = 6) });
  assert.equal(run(mixed).status, 0);
  assert.ok(read(mixed).metrics.server_eld_max_ms < read(mixed).metrics.eld_p99_ms);
});

// The loop source (harness review) and the problem kinds ----------------------------------------------------
test("loop source: eld_* come from the preload (run.json metrics.loop, else loop-window.json); the server gauge is server_eld_max_ms", () => {
  const s = setup({ edit: (f) => (f.result.metrics.loop = { elu: 0.6, eld_p50_ms: 10.2, eld_p90_ms: 11, eld_p99_ms: 13.5, eld_p999_ms: 20, eld_max_ms: 44, eld_mean_ms: 10.5, gc_ms_per_s: 6.5, gc_max_pause_ms: 80 }) });
  assert.equal(run(s).status, 0);
  const m = read(s).metrics;
  assert.equal(m.eld_p50_ms, 10.2);
  assert.equal(m.eld_p99_ms, 13.5);
  assert.equal(m.eld_max_ms, 44);
  assert.equal(m.gc_ms_per_s, 6.5);
  assert.equal(m.server_eld_max_ms, 412, "the server's own gauge, separately");
  const fallback = setup();
  assert.equal(run(fallback).status, 0);
  assert.equal(read(fallback).metrics.eld_max_ms, 120, "loop-window.json's own maximum when metrics.loop is absent");
  refused(setup({ edit: (f) => (f.result.metrics.loop = { eld_p50_ms: 10, eld_p99_ms: 13.5, eld_max_ms: 12 }) }), "a preload max below its own p99");
});

test("problem kinds: the exporter publishes the harness's classification and refuses an unknown kind, an extra key or an inconsistent verdict", () => {
  // Built as harness 2.0.x classifies (kinds, fatality and the ELU >= 0.95 test); the exporter re-checks every part.
  const busy = (codes) => harnessRun({ codes, elu: 0.97 });
  const tamper = (codes, change) => (f) => {
    busy(codes)(f);
    change(f.run);
  };
  const sat = setup({ edit: busy(["call_timeouts", "session_mcp_missing"]) });
  assert.equal(run(sat).status, 0);
  const a = read(sat).attempt;
  assert.equal(a.valid, true);
  assert.equal(a.saturated, true);
  assert.deepEqual(a.saturated_by, ["call_timeouts", "session_mcp_missing"]);
  assert.deepEqual(a.problems, ["call_timeouts", "session_mcp_missing"]);
  const defect = setup({ edit: busy(["error_rate"]) });
  assert.equal(run(defect).status, 0);
  assert.equal(read(defect).attempt.valid, false);
  assert.equal(read(defect).attempt.saturated, false);
  const nonFatal = setup({ edit: busy(["otlp_no_samples"]) });
  assert.equal(run(nonFatal).status, 0);
  assert.equal(read(nonFatal).attempt.valid, true, "a non-fatal defect the harness kept valid stays valid");
  const dirty = setup({ edit: (f) => { busy(["call_timeouts"])(f); f.meta.contaminated = true; f.meta.contamination_reasons = ["foreign_cpu"]; } });
  assert.equal(run(dirty).status, 0);
  assert.equal(read(dirty).attempt.valid, false, "the host guard still applies");
  refused(setup({ edit: tamper(["call_timeouts"], (r) => (r.problems[0].kind = "mystery")) }), "an unknown kind");
  refused(setup({ edit: tamper(["call_timeouts"], (r) => (r.problems[0].note = "x")) }), "an extra key on a problem");
  refused(setup({ edit: tamper(["call_timeouts"], (r) => (r.valid = false)) }), "saturated without valid");
  refused(setup({ edit: tamper(["otlp_no_samples"], (r) => (r.saturated = true)) }), "saturated with no saturation-kind problem");
  // A run.json from before harness 2.0.0 (bare codes, no saturated flag or saturation block) is refused: the runner
  // runs 2.0.0 or later, and the exporter never decides validity or saturation in its place.
  refused(setup({ cell: "250", edit: (f) => { starve(200, 250)(f); legacyRun(f); } }), "an older harness's run.json");
});

// The host guard fails closed: when it cannot judge a try (no samples, none in the window, no foreign-CPU or
// steal values), the runner writes contaminated: null with no reasons.
test("host guard unavailable: contaminated null invalidates the attempt with host_guard_unavailable and publishes null, valid or saturated alike", () => {
  const unknown = (f) => {
    f.meta.contaminated = null;
    f.meta.contamination_reasons = [];
  };
  const plain = setup({ edit: unknown });
  assert.equal(run(plain).status, 0, run(plain).stderr);
  const a = read(plain);
  assert.equal(a.attempt.valid, false);
  assert.deepEqual(a.attempt.problems, ["host_guard_unavailable"]);
  assert.equal(a.attempt.contaminated, null, "unknown, never a false 'clean'");
  assert.equal(a.metrics.turns_completed, null, "an invalid attempt carries no values");

  const saturated = setup({
    cell: "250",
    edit: (f) => {
      unknown(f);
      harnessRun({ codes: ["sessions_starved"], elu: 0.99, source: "preload", served: 200, total: 250 })(f);
    },
  });
  assert.equal(run(saturated).status, 0, run(saturated).stderr);
  const s = read(saturated);
  assert.equal(s.attempt.valid, false);
  assert.equal(s.attempt.saturated, false);
  assert.deepEqual(s.attempt.problems, ["sessions_starved", "host_guard_unavailable"]);

  refused(setup({ edit: (f) => { f.meta.contaminated = null; f.meta.contamination_reasons = ["steal"]; } }), "null with reasons");
  refused(setup({ edit: (f) => { delete f.meta.contaminated; delete f.meta.contamination_reasons; } }), "absent: the runner always writes them");
  const clean = setup();
  assert.equal(run(clean).status, 0);
  assert.equal(read(clean).attempt.contaminated, false, "checked and clean");
});

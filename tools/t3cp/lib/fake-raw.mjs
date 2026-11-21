// Hand-made SYNTHETIC raw inputs for the exporter's tests: a minimal raw attempt directory in the layout of
// schema/record-spec-1.json $defs.attempt_dir, a raw extras directory ($defs.extras_dir) and a record spec.
// Nothing here comes from a real run; every value is invented and every path is a temporary directory.
import * as fs from "node:fs";
import * as path from "node:path";
import { fakeProfile, hex } from "./fake.mjs";

/** attempt-meta.json's profile of the cell: the runner's real3 entry (fakeProfile without the record's fixture). */
const rawProfile = (cell) => {
  const { fixture, ...profile } = fakeProfile(cell);
  return profile;
};

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};

export const WINDOW_START = Date.parse("2026-11-15T10:01:00Z");
export const WINDOW_END = WINDOW_START + 300_000;

export function fakeSpec(overrides = {}) {
  const spec = {
    schema: "t3cp/record-spec/1",
    record_id: "2026-11-15.linux-x64.nightly",
    kind: "nightly",
    release: {
      tag: "v0.1.10-nightly.20261115.4749",
      sha: hex("release", 40),
      version: "0.1.10-nightly.20261115.4749",
      archive_name: "t3-0.1.10-nightly.20261115.4749-linux-x64.tar.gz",
      archive_sha256: hex("archive"),
      archive_path: "/nonexistent/archive.tar.gz",
      date: "2026-11-15",
    },
    fixture: { id: "large-76", path: "/nonexistent/fixture.sqlite", sha256: hex("fixture"), migration: 76 },
    suite: { id: "ladder-1", levels: [1, 50, 100, 150, 200, 250], attempts_per_level: 3, empty_cell: true, warmup_s: 60, window_s: 300 },
    now: "2026-11-16T00:00:00Z",
    seed: "1",
  };
  return merge(spec, overrides);
}

function merge(a, b) {
  if (b === undefined) return a;
  if (b === null || typeof b !== "object" || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v === undefined ? undefined : merge(a?.[k], v);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

const calls = () => ({
  "session.turn": { count: 318, errors: 0, unfinished: 0, per_s: 1.06, p50_ms: 9257, p95_ms: 15012, p99_ms: 18000, max_ms: 21000 },
  "session.dispatch": { count: 318, errors: 0, unfinished: 0, per_s: 1.06, p50_ms: 41.5, p95_ms: 120.25, p99_ms: 200, max_ms: 300 },
  "session.firstItem": { count: 318, errors: 0, unfinished: 0, per_s: 1.06, p50_ms: 812, p95_ms: 1500, p99_ms: 2000, max_ms: 2500 },
  "push.threadEvent": { count: 9000, errors: 0, unfinished: 0, per_s: 30, p50_ms: 12, p95_ms: 88, p99_ms: 120, max_ms: 400 },
  "subscribe.httpThreadBounded": { count: 50, errors: 0, unfinished: 0, per_s: 0.2, p50_ms: 210, p95_ms: 500, p99_ms: 600, max_ms: 700 },
  "subscribe.threadSync": { count: 50, errors: 0, unfinished: 0, per_s: 0.2, p50_ms: 300, p95_ms: 900, p99_ms: 1000, max_ms: 1100 },
  "subscribe.shellSync": { count: 50, errors: 0, unfinished: 0, per_s: 0.2, p50_ms: 100, p95_ms: 400, p99_ms: 500, max_ms: 600 },
  "poll.mcp.t3_thread_read": { count: 600, errors: 0, unfinished: 0, per_s: 2, p50_ms: 30, p95_ms: 95, p99_ms: 120, max_ms: 200 },
  "poll.mcp.t3_project_list": { count: 600, errors: 0, unfinished: 0, per_s: 2, p50_ms: 20, p95_ms: 70, p99_ms: 100, max_ms: 150 },
  "poll.http.threadBounded": { count: 600, errors: 0, unfinished: 0, per_s: 2, p50_ms: 40, p95_ms: 110, p99_ms: 150, max_ms: 220 },
  "session.mcp.t3_thread_read": { count: 12, errors: 0, unfinished: 0, per_s: 0.04, p50_ms: 50, p95_ms: 140, p99_ms: 150, max_ms: 160 },
  "session.mcp.t3_project_list": { count: 12, errors: 0, unfinished: 0, per_s: 0.04, p50_ms: 40, p95_ms: 160, p99_ms: 170, max_ms: 180 },
});

const span = (p50, p95) => ({ count: 100, errors: 0, total_ms: p50 * 100, avg_ms: p50, p50_ms: p50, p95_ms: p95, max_ms: p95 * 2 });
const r3 = (v) => Math.round(v * 1000) / 1000;
const sql = (avg, p95, wait) => ({ ...span(avg, p95), lock_wait_n: 100, avg_lock_wait_ms: wait, p50_lock_wait_ms: wait, p95_lock_wait_ms: r3(wait * 3), max_lock_wait_ms: r3(wait * 6) });

/** The run.ts metric tree of one valid run (result.json metrics / run.json metrics). */
export function fakeMetricTree() {
  return {
    cpu: {
      main: { user_pct: 61.2, sys_pct: 12.4, busy_pct: 73.6 },
      process: { user_pct: 150, sys_pct: 40, busy_pct: 190.5 },
      worker_threads: { user_pct: 20, sys_pct: 5, busy_pct: 25.3, threads: 4 },
      main_busy_1s: { p50_pct: 70, p95_pct: 96.5, max_pct: 100 },
    },
    io: {
      main: { syscr_per_s: 1200.5, syscw_per_s: 300.25 },
      threads_sum: { syscr_per_s: 2000, syscw_per_s: 500 },
      process: { syscr_per_s: 2500.5, syscw_per_s: 600 },
      worker_threads: { syscr_per_s: 700, syscw_per_s: 100 },
    },
    mem: { rss_peak_mib: 2048.5, hwm_mib: 2050 },
    otlp: { exports: 60, samples: 300, samples_in_window: 300, intervals_in_window: 299, elu_mean: 0.62, elu_max: 0.97, event_loop_delay_max_ms: 412, cpu_utilization_mean: 1.9, rss_peak_mib: 2040, heap_used_peak_mib: 1210.4 },
    trace: { spans: 51234, errors: 0 },
    spans: {
      "OrchestratorV2.getThreadShell": span(20, 61.5),
      "OrchestratorV2.getThreadSnapshotWindow": span(30, 95),
      "McpHttpServer.authenticateRequest": span(2, 7.5),
      "ProviderTurnStartService.start": span(45.6, 80),
      "Orchestrator.handleRunUpdate": span(5, 18),
    },
    sql: {
      "sql.transaction|reader": sql(4.5, 15, 0.8),
      "sql.transaction|writer": sql(2.5, 9, 0.3),
      "sqlite|reader": sql(1.5, 6, 0.2),
      "sqlite|writer": sql(1, 4, 0.1),
    },
    driver: { thread_events_per_s: 31.5, shell_events_per_s: 4.25, calls: calls() },
  };
}

/** proc-1hz.ndjson in procmon.py's line format: a meta line, then cumulative counters every second. */
function procLines(pid) {
  const lines = [JSON.stringify({ meta: { pid, clk_tck: 100, page_size: 4096, nproc: 16, attrib: false } })];
  for (let s = -5; s <= 305; s++) {
    const t = WINDOW_START + s * 1000;
    const k = s + 5;
    lines.push(
      JSON.stringify({
        t,
        proc: { minflt: 1000 + k * 50, majflt: 0, cutime: k * 2, cstime: k },
        threads: [
          { tid: pid, comm: "t3", minflt: 500 + k * 20, majflt: 0, vcs: 100 + k * 30, nvcs: 10 + k * 3, run_ns: k * 7.0e8, wait_ns: k * 5.0e6 },
          { tid: pid + 1, comm: "WorkerThread", minflt: 10, majflt: 0, vcs: 5, nvcs: 1, run_ns: k * 1e8, wait_ns: k * 1e5 },
        ],
        children: { n: 12, by_comm: { git: { n: 2, u: k * 3, s: k, cu: 0, cs: 0, rss_pages: 100, threads: 1 }, node: { n: 10, u: k * 10, s: k * 2, cu: 0, cs: 0, rss_pages: 1000, threads: 10 } } },
        host: { cpu: { user: k * 400, nice: 0, system: k * 100, idle: k * 1000, iowait: k * 5, irq: 0, softirq: 0, steal: k * 2 }, disk: { rd_ios: 0, rd_sect: k * 10, wr_ios: 0, wr_sect: k * 100, io_ms: 0 } },
        wal_bytes: (4 + (k % 10)) * 1048576,
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

function loopLines() {
  const lines = [];
  for (let s = 0; s < 300; s++) {
    lines.push(JSON.stringify({ t: WINDOW_START + s * 1000 + 500, dt_ms: 1000, elu: 0.6, delay: { p50_ms: 10.2, p90_ms: 20, p99_ms: 40, max_ms: s % 10 === 0 ? 120 : s % 5 === 0 ? 60 : 15, mean_ms: 12 }, gc: {} }));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The driver's post-window distribution check as t3cp-harness/2.0.0 writes it (driver.json distribution.match, copied
 * to run.json driver.workload.distribution_match): the p50 and p95 turn-item ratios of the exercised threads to the
 * fixture's, and the exact binomial test that decides withinTolerance. Invented values, consistent with each other.
 */
export function fakeDistributionMatch() {
  return {
    p50Ratio: 1.02,
    p95Ratio: 0.97,
    tolerance: 0.2,
    withinTolerance: true,
    test: { n: 300, below_p50: 148, expected_below: 0.5, band_below: [121, 179], p_value_below: 0.8642, above_p95: 14, expected_above: 0.05, band_above: [4, 28], p_value_above: 0.9087, alpha: 0.001, passed: true },
  };
}

/** An `edit` step: the run.json of a harness before 2.0.0 (no saturated flag or saturation block, bare codes). */
export function legacyRun(files) {
  delete files.run.saturated;
  delete files.run.saturation;
  files.run.problems = files.run.problems.map((p) => (typeof p === "string" ? p : p.code));
}

// harness 2.0.x's classification (run.ts classifyProblems), modelled for the fakes: at a server window ELU of 0.95 or
// more the three saturation codes are kind "saturation"; every other problem is a "defect", and a fatal defect voids
// the run. The fake's result.json samples traces at Info with timing on, so trace problems are fatal too.
const SATURATION_ELU = 0.95;
const SATURATION_CODES = new Set(["sessions_starved", "session_mcp_missing", "call_timeouts"]);
const FATAL_CODES = new Set([
  "server_start_failed", "server_auth_failed", "server_exited", "driver_failed", "driver_timeout", "pid_gone", "window_too_short",
  "main_thread_missing", "node_flags_mismatch", "node_flags_unverified", "db_setup_failed", "db_ready_timeout",
  "driver_saturated", "error_rate", "distribution_mismatch",
  "trace_missing", "trace_coverage", "trace_stale", "trace_rotated_during_read",
]);

/**
 * An `edit` step: run.json as harness 2.0.x writes it for these problem codes at this server window ELU. The ELU goes
 * into the run's metric tree (the server gauge's elu_mean, or the preload's loop.elu), the saturation block repeats it,
 * each problem's kind, valid and saturated follow the harness's rule, and result.json's valid count agrees. `served`
 * and `total` set the served agents (the cell's agents by default).
 */
export function harnessRun({ codes = [], elu, source = "server_gauge", served, total } = {}) {
  return (files) => {
    const { run, result } = files;
    if (elu !== undefined) {
      run.metrics.otlp = { ...run.metrics.otlp };
      delete run.metrics.otlp.elu_mean;
      delete run.metrics.loop;
      if (source === "server_gauge" && elu !== null) run.metrics.otlp.elu_mean = elu;
      if (source === "preload" && elu !== null) run.metrics.loop = { elu };
    }
    const preload = run.metrics?.loop?.elu;
    const gauge = run.metrics?.otlp?.elu_mean;
    const block = Number.isFinite(preload) ? { elu: preload, elu_source: "preload" } : Number.isFinite(gauge) ? { elu: gauge, elu_source: "server_gauge" } : { elu: null, elu_source: null };
    run.saturation = { ...block, threshold: SATURATION_ELU };
    const busy = block.elu !== null && block.elu >= SATURATION_ELU;
    let valid = true;
    let anySaturation = false;
    run.problems = [...new Set(codes)].map((code) => {
      const kind = busy && SATURATION_CODES.has(code) ? "saturation" : "defect";
      if (kind === "saturation") anySaturation = true;
      if (kind === "defect" && (FATAL_CODES.has(code) || SATURATION_CODES.has(code))) valid = false;
      return { code, kind };
    });
    run.valid = valid;
    run.saturated = valid && anySaturation;
    if (served !== undefined) run.sessions_served = served;
    if (total !== undefined) run.sessions_total = total;
    result.runs.valid = valid ? 1 : 0;
    result.run_details[0].valid = valid;
  };
}

/**
 * Writes W/raw/<cell>-<n>/ under `root`. `edit` receives {meta, result, run, driver} before they are written
 * so a test can plant a failure.
 */
export function writeRawAttempt(root, { cell = "100", n = 1, edit, spec = fakeSpec() } = {}) {
  const dir = path.join(root, `${cell}-${n}`);
  const pid = 4242;
  const level = cell === "1e" ? 1 : Number(cell);
  const meta = {
    schema: "t3cp/attempt-meta/1",
    record_id: spec.record_id,
    cell,
    n,
    level,
    label: "release",
    profile: rawProfile(cell),
    suite: { id: spec.suite.id, warmup_s: spec.suite.warmup_s, window_s: spec.suite.window_s },
    now: spec.now,
    seed: spec.seed,
    release: { tag: spec.release.tag, sha: spec.release.sha, version: spec.release.version },
    cpus: { server: "0-5,8-13", driver: "6,7,14,15", pinned: true },
    window_start_ms: WINDOW_START,
    window_end_ms: WINDOW_END,
    valid_run: 1,
    tries: [{ started_at: "2026-11-15T10:00:00Z", ended_at: "2026-11-15T10:07:58Z", cycle_s: 478, run_ts_exit: 0, contaminated: false }],
    host_guard_max_busy_pct: 31.2,
    fixture: cell === "1e" ? "none" : spec.fixture.id,
    started_at: "2026-11-15T10:00:00Z",
    ended_at: "2026-11-15T10:07:58Z",
    cycle_s: 478,
    run_ts_exit: 0,
    contaminated: false,
    contamination_reasons: [],
    maintenance_in_window: 0,
    host_guard: { method: "proc-stat", samples: 478, busy_pct_mean: 20.5, busy_pct_max: 31.2, foreign_pct_mean: 0.4, foreign_pct_max: 2.1, steal_pct_mean: 0.1, steal_pct_max: 0.5, iowait_pct_mean: 0.2, iowait_pct_max: 1 },
    host: { machine: "n2d-standard-16", provisioning: "spot", runtime_node: "26.1.0", cpu_model: "AMD EPYC 7B13", cores: 16, memory_gib: 64, kernel: "6.12.48+deb13-cloud-amd64", os: "Debian 13" },
    harness: { version: "t3cp-harness/2.0.0", sha: hex("harness", 40), files_sha256: hex("harness-files"), preload_sha256: hex("preload") },
    runner: { version: "t3cp-runner/1.0.0", files_sha256: hex("runner-files") },
    ...(spec.kind === "nightly" ? {} : { build: { source_repo: spec.kind === "fork" ? "github.com/navidnadali/t3code" : "github.com/pingdotgg/t3code", script_sha256: hex("build-script") } }),
  };
  const metrics = fakeMetricTree();
  const result = {
    schema: "t3-server-bench/result/1",
    label: "release",
    created_at: "2026-11-15T10:07:50Z",
    identity: {
      server_sha: spec.release.sha,
      [["server", "ref"].join("_")]: "sea:release",
      server_dirty: false,
      server_version: spec.release.version,
      server_archive_sha256: spec.release.archive_sha256,
      server_binary_sha256: hex("binary"),
      base_sha: spec.release.sha,
      base_ref: null,
      harness_sha: meta.harness.sha,
      harness_files_sha256: meta.harness.files_sha256,
      fixture: { kind: "file", sha256: spec.fixture.sha256, bytes: 26_260_000_000 },
      preload: { file: "bench-preload.cjs", sha256: hex("preload") },
    },
    sampling: { trace_min_level: "Info", trace_sql_min_duration_ms: "0", otlp_export_interval_ms: 1000, collect_interval_ms: 1000 },
    knobs: { server: {}, workload: { driver: "driver.ts", driver_sha256: hex("driver"), fakes_sha256: hex("fakes"), warmup_s: 60, window_s: 300 }, run: { runs: 1, retries: 2, server_entry: "sea" } },
    host: { cpu_model: "AMD EPYC 7B13", node: "v26.1.0" },
    runs: { requested: 1, attempted: 1, valid: 1, order: ["release#1"] },
    metrics,
    spread: { min: metrics, max: metrics },
    run_details: [{ schema: "t3-server-bench/run/1", label: "release", attempt: 1, valid: true, problems: [] }],
  };
  // The empty-database cell has no fixture threads to match; every other cell's exercised threads face the test.
  const distributionMatch = cell === "1e" ? null : fakeDistributionMatch();
  const mode = meta.profile.mode;
  // run.json in the t3cp-harness/2.0.0 shape (legacyRun strips what an older harness did not write).
  const run = {
    schema: "t3-server-bench/run/1",
    label: "release",
    attempt: 1,
    valid: true,
    problems: [],
    saturated: false,
    // The run's metric tree has no preload loop block, so the server gauge's elu_mean is the window ELU.
    saturation: { elu: 0.62, elu_source: "server_gauge", threshold: 0.95 },
    started_at: "2026-11-15T10:00:05Z",
    now: spec.now,
    window: { start: new Date(WINDOW_START).toISOString(), end: new Date(WINDOW_END).toISOString() },
    server: { pid, exit_before_stop: { code: null, signal: null }, stop: { forced: false, signal_to_exit_ms: 3000, exited_before_stop: false } },
    // The current harness reports the served agents on every measured run (null when the window was not measured).
    sessions_served: level,
    sessions_total: level,
    driver_failure: null,
    driver: {
      ok: true,
      error: null,
      failure_code: null,
      knobs: { mode },
      workload: { mode, sessions: level, fixture_thread_sessions: mode === "fresh" ? 0 : level, new_thread_sessions: mode === "fresh" ? level : 0, session_candidates: 4000, distribution_match: distributionMatch },
    },
    metrics: fakeMetricTree(),
  };
  const driver = {
    status: "ok",
    windowSeconds: 300,
    timeline: { window: new Date(WINDOW_START).toISOString(), teardown: new Date(WINDOW_END + 20_000).toISOString() },
    calls: Object.fromEntries(Object.entries(calls()).map(([k, v]) => [k, { count: v.count, errors: v.errors, unfinished: k === "session.turn" ? 2 : 0, p50: v.p50_ms, p95: v.p95_ms }])),
    distribution: { match: distributionMatch === null ? null : structuredClone(distributionMatch) },
  };
  const files = { meta, result, run, driver, serverLog: "[10:00:01] INFO started\n[10:02:00] WARN live event buffer is full\n[10:03:00] WARN slow\n[10:04:00] ERROR failed once\n" };
  edit?.(files);
  const runDir = path.join(dir, "work", "runs", "release", `attempt-${files.run.attempt}`);
  write(path.join(dir, "attempt-meta.json"), files.meta);
  write(path.join(dir, "release.result.json"), files.resultText ?? files.result);
  write(path.join(dir, "run.log"), "run.ts output\n");
  write(path.join(runDir, "run.json"), files.runText ?? files.run);
  write(path.join(runDir, "driver", "driver.json"), files.driver);
  write(path.join(runDir, "server.log"), files.serverLog);
  write(path.join(runDir, "loop-window.json"), { schema: "t3-server-bench/loop-window/1", start: WINDOW_START, end: WINDOW_END, resolution_ms: 10, delay: { p50_ms: 10.5, p90_ms: 20, p99_ms: 45.25, max_ms: 120, mean_ms: 12 }, elu: 0.61, elu_active_ms: 183000, gc: { minor: { n: 3000, ms: 1500, max_ms: 5 }, major: { n: 10, ms: 600, max_ms: 80 } } });
  write(path.join(runDir, "loop-1hz.ndjson"), loopLines());
  write(path.join(runDir, "proc-1hz.ndjson"), procLines(pid));
  write(path.join(runDir, "server-exit.json"), { gone_ms: WINDOW_END + 23_000, resolution_ms: 1000 });
  return dir;
}

/** W/raw-extras/ with startup, migration, snapshot and first-turn files. */
export function writeRawExtras(root, edit) {
  const starts = [];
  for (const fixture of ["era", "empty"]) {
    for (const phase of ["cold", "warm"]) {
      for (let n = 1; n <= 3; n++) {
        const base = (fixture === "era" ? 4000 : 900) * (phase === "cold" ? 1.5 : 1);
        starts.push({ fixture, phase, n, listening_ms: base + n, accept_ms: base + 10 + n, db_ready_ms: base + 50 + n, killed: false, page_cache_dropped: phase === "cold", reasons: {} });
      }
    }
  }
  const files = {
    startup: { schema: "t3cp/extras-startup/1", starts },
    migration: { schema: "t3cp/extras-migration/1", fixture_id: "large-76", from_migration: 76, to_migration: 79, migrations: [{ id: 77, name: "AddIndex", seconds: 1.5 }, { id: 78, name: "Backfill", seconds: 12.25 }, { id: 79, name: "Drop", seconds: 0.5 }], chain_s: 14.25, run_migrations_span_ms: 14300, start_to_ready_ms: 16000, peak_extra_disk_bytes: 512 * 1048576, peak_wal_bytes: 64 * 1048576, db_initial_bytes: 1, db_final_bytes: 2, rss_peak_bytes: 3, reasons: {} },
    snapshot: { schema: "t3cp/extras-snapshot/1", thread_turn_items: 100000, ms: 5123.5, wire_bytes: 48_000_000, body_bytes: 280_000_000, status: 200, started_at: "2026-11-15T12:00:00Z", ended_at: "2026-11-15T12:00:05Z", window_end: "2026-11-15T11:59:00Z", reasons: {} },
    first_turn: { schema: "t3cp/extras-first-turn/1", ms: null, started_at: null, ended_at: null, reasons: { ms: "driver_has_no_first_turn" } },
  };
  edit?.(files);
  for (const [name, value] of Object.entries(files)) if (value !== undefined) write(path.join(root, `${name}.json`), value);
  write(path.join(root, "migration-sampler.tsv"), "t\tdb\twal\n");
  return root;
}

/**
 * A scenario spec: the ladder fake's release, fixture and identity, running one row of scenarios.json (suite.id is
 * <id>@<version>, suite.scenario the row).
 */
export function fakeScenarioSpec(row, overrides = {}) {
  const spec = { ...fakeSpec(overrides), suite: { id: `${row.id}@${row.version}`, scenario: { id: row.id, version: row.version } } };
  if (row.fixture === "none") spec.fixture = { id: "none" };
  else spec.fixture = { ...spec.fixture, id: row.fixture };
  return spec;
}

/**
 * <root>/<cell>-<n>/ as the runner writes a scenario cell's attempt: the ladder attempt's files with the cell's
 * attempt-meta.json (cell, level = sessions, the cell's suite warm-up and window, scenario, the row's fixture,
 * maintenance_expected on an unseeded cell), scenario-cell.json, scenario.json (the post step's metrics, each
 * {value, reason}) and, in release.result.json, the getThreadShell span (`shell`: {count, p95_ms}; null drops it).
 */
export function writeRawScenarioAttempt(root, { row, cell, n = 1, spec = fakeScenarioSpec(row), metrics = {}, window, shell = { count: 120, p95_ms: 3.5 }, edit } = {}) {
  const c = row.cells.find((x) => x.name === cell);
  if (!c) throw new Error(`fake: row ${row.id}@${row.version} has no cell ${cell}`);
  const staging = fs.mkdtempSync(path.join(root, ".staging-"));
  const ladderSpec = { ...spec, suite: { id: spec.suite.id, warmup_s: c.warmup_s, window_s: c.window_s } };
  const seconds = (d) => {
    const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(d);
    return Number(m[1]) * (m[2] === "ms" ? 0.001 : m[2] === "m" ? 60 : 1);
  };
  const profile = {
    sessions: c.sessions,
    subscribers: c.subscribers,
    pollers: c.pollers,
    mode: c.mode,
    turn_gap_s: seconds(c.turn_gap),
    switch_interval_s: c.switch_interval === undefined ? null : seconds(c.switch_interval),
    poll_interval_s: c.poll_rate === undefined ? null : Math.round((1 / Number(c.poll_rate)) * 1000) / 1000,
  };
  const built = writeRawAttempt(staging, {
    cell: "1",
    n,
    spec: ladderSpec,
    edit: (files) => {
      files.meta.cell = cell;
      files.meta.level = c.sessions;
      files.meta.profile = profile;
      files.meta.scenario = { id: row.id, version: row.version };
      files.meta.fixture = c.fixture === "none" || row.fixture === "none" ? "none" : spec.fixture.id;
      if (c.seed_compacted_at === false) files.meta.maintenance_expected = true;
      if (shell === null) delete files.result.metrics.spans?.["OrchestratorV2.getThreadShell"];
      else {
        files.result.metrics.spans ??= {};
        files.result.metrics.spans["OrchestratorV2.getThreadShell"] = { count: shell.count, errors: 0, total_ms: shell.p95_ms * shell.count, avg_ms: shell.p95_ms / 2, p50_ms: shell.p95_ms / 2, p95_ms: shell.p95_ms, max_ms: shell.p95_ms * 2 };
      }
      edit?.(files);
    },
  });
  const dir = path.join(root, `${cell}-${n}`);
  fs.renameSync(built, dir);
  fs.rmSync(staging, { recursive: true, force: true });
  write(path.join(dir, "scenario-cell.json"), {
    scenario: { id: row.id, version: row.version },
    cell,
    warmup_s: c.warmup_s,
    window_s: c.window_s,
    seed_compacted_at: c.seed_compacted_at,
    post: c.post,
    mark_age_days: c.mark_age_days ?? null,
    profile,
  });
  if (c.post !== "none") {
    write(path.join(dir, "scenario.json"), {
      schema: "t3cp/scenario-raw/1",
      scenario: { id: row.id, version: row.version },
      post: c.post,
      window: window ?? { start_ms: WINDOW_START, end_ms: WINDOW_END, run: 1, valid: true },
      metrics,
      detail: {},
    });
  }
  return dir;
}

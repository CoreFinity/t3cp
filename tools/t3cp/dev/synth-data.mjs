#!/usr/bin/env node
// Writes a complete SYNTHETIC data/v1-shaped tree for development, so the site and the release posts can render
// real shapes before real records exist. Every number is invented; every file carries "synthetic": true at the top
// level, and the aggregator and the deploy gate refuse such files under data/.
//
//   node tools/t3cp/dev/synth-data.mjs [--out site/.dev-data]
//
// Writes <out>/input/v1/ (records, fork records, bands: the shape of data/v1 as the pipeline writes it) and
// <out>/v1/ (the aggregated public tree: index, series, changes, compare, status, downloads, inputs copied).
// <out> is git-ignored. Contents:
//   - 30 Linux nightlies, 2026-10-17 to 2026-11-15; fixture large-63 to 10-30, large-76 from 10-31;
//   - metric era gaps: the server gauges (elu, heap, eld_max) start 10-20 (lock wait starts 10-14, before the window);
//   - 8 fork releases v0.1.6-perf.1 .. v0.1.9-perf.8, each with a base record (kind "base", the upstream tree
//     built at its merge-base SHA) and the nightly of that day as context;
//   - planted changes: turns_completed falls 25 % from 11-08 (regressed, stays low); turn_p50_ms falls 35 % from
//     11-12 (improved); dispatch_p95_ms rises 60 % on 11-03 only (one day); perf.8 improves turn_p50_ms by 30 %
//     and turns_completed by 20 % against both its base and perf.7;
//   - one partial record (10-25: one valid attempt at 250 agents);
//   - the unscheduled compaction schedule era 10-17..10-19 (its own era: no reference or band crosses it);
//   - a saturated level: 250 agents on 11-10 and 11-11 serve 210 of 250 (latencies there are context only);
//   - synthetic bands (the design's illustrative values; NOT measured).
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { fakeAttempts, fakeExtras, fakeIdentity, hex, prng, FAKE_PUBLIC_REFS } from "../lib/fake.mjs";
import { mergeRecord } from "../merge.mjs";
import { REPO_ROOT, isMain, loadCatalogue } from "../lib/repo.mjs";
import { aggregate, overviewPayload } from "../../../site/build/aggregate.mjs";

const catalogue = loadCatalogue();
const COUNTS = new Set(catalogue.metrics.filter((m) => m.unit === "n").map((m) => m.id));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const round = (v) => (Math.abs(v) < 100 ? Math.round(v * 1000) / 1000 : Math.round(v * 10) / 10);

export const NIGHTLY_FROM = "2026-10-17";
export const NIGHTLY_DAYS = 30;
export const FORKS = [
  { perf: 1, version: "0.1.6", date: "2026-11-01", base: "2026-11-01" },
  { perf: 2, version: "0.1.6", date: "2026-11-03", base: "2026-11-02" },
  { perf: 3, version: "0.1.6", date: "2026-11-04", base: "2026-11-03" },
  { perf: 4, version: "0.1.6", date: "2026-11-04", base: "2026-11-03" },
  { perf: 5, version: "0.1.6", date: "2026-11-05", base: "2026-11-03" },
  { perf: 6, version: "0.1.7", date: "2026-11-09", base: "2026-11-08" },
  { perf: 7, version: "0.1.9", date: "2026-11-14", base: "2026-11-13" },
  { perf: 8, version: "0.1.9", date: "2026-11-15", base: "2026-11-14" },
];

/** The planted upstream shape of a metric on a date (a multiplier on the fake base value). */
function upstreamFactor(id, cell, date) {
  if (cell === "1e") return 1;
  if (id === "turns_completed" && date >= "2026-11-08") return 0.75;
  if (id === "turn_p50_ms" && date >= "2026-11-12") return 0.65;
  if (id === "dispatch_p95_ms" && date === "2026-11-03") return 1.6;
  return 1;
}

/** What each fork release changes against its base (a multiplier). perf.8 also beats perf.7. */
function forkFactor(id, perf) {
  if (id === "turn_p50_ms") return perf === 8 ? 0.85 * 0.7 : 1 - 0.02 * perf;
  if (id === "turns_completed") return perf === 8 ? 1.2 * 1.04 : 1 + 0.005 * perf;
  if (id === "rss_peak_mib") return 1 - 0.03 * Math.min(perf, 5);
  if (id === "proc_cpu_pct" || id === "main_busy_pct") return 1 - 0.015 * perf;
  return 1;
}

const noise = (seed, size) => {
  const r = prng(seed);
  return () => 1 + (r() * 2 - 1) * size;
};

/** Dates whose release starts a maintenance pass after every start (the unscheduled compaction schedule era). */
export const UNSCHEDULED = new Set(["2026-10-17", "2026-10-18", "2026-10-19"]);
/** Dates on which the server could not serve every agent at 250 agents (saturated: 210 of 250 served). */
export const SATURATED_250 = new Set(["2026-11-10", "2026-11-11"]);

function synthRecord({ identity, factor, partial = false }) {
  const n = noise(identity.record_id, 0.015);
  const attempts = fakeAttempts(catalogue, identity, {
    jitter: 0.02,
    value: (id, cell, v) => {
      if (v === null || v === undefined) return undefined;
      const f = factor(id, cell);
      if (id === "client_errors" || id === "client_unfinished") return 0;
      if (id === "agents_served") return undefined; // every agent served unless a date is planted as saturated
      if (COUNTS.has(id)) return Math.max(0, Math.round(v * f * n()));
      return round(v * f);
    },
    attempt: (cell, k) => (partial && cell === "250" && k > 1 ? { valid: false, problems: ["server_exited"] } : {}),
  });
  for (const a of attempts) {
    a.synthetic = true;
    if (identity.kind === "nightly" && UNSCHEDULED.has(identity.release.date)) a.attempt.maintenance_in_window = "unscheduled_pre_marker";
    if (identity.kind === "nightly" && SATURATED_250.has(identity.release.date) && a.cell === "250" && a.attempt.valid) {
      a.attempt.saturated = true;
      a.attempt.saturated_by = ["sessions_starved"];
      a.attempt.problems = ["sessions_starved"];
      a.metrics.agents_served = 210;
      // As the exporter writes a saturated attempt: turns completed is not measured there.
      a.metrics.turns_completed = null;
      a.attempt.metric_reasons = { turns_completed: "not_measured_saturated" };
      for (const id of ["turn_p50_ms", "turn_p95_ms", "dispatch_p95_ms"]) if (typeof a.metrics[id] === "number") a.metrics[id] = round(a.metrics[id] * 2.5);
    }
  }
  const en = noise(`${identity.record_id}-extras`, 0.03);
  const extras = fakeExtras(catalogue, identity, { value: (id, level, v) => (v === null ? null : round(v * factor(id, level) * en())) });
  extras.synthetic = true;
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [extras], catalogue, generatedAt: `${identity.release.date}T${identity.kind === "fork" ? "20" : "18"}:00:00Z`, runId: 1000 + Number(identity.release.date.slice(8)), lease: 1 });
}

const BAND_VALUES = {
  turns_completed: 4.6, agents_served: 2, server_eld_max_ms: 3.6, turn_p50_ms: 17.5, dispatch_p50_ms: 35, dispatch_p95_ms: 18.7, push_p95_ms: 98, switch_sync_p95_ms: 144,
  poll_thread_read_p95_ms: 107, poll_project_list_p95_ms: 62, poll_http_bounded_p95_ms: 42, session_mcp_p95_ms: 122,
  thread_events_per_s: 19.9, main_busy_pct: 7.2, main_user_pct: 3.7, main_sys_pct: 11.7, proc_cpu_pct: 5.8, workers_cpu_pct: 3.9,
  children_cpu_pct: 16.5, elu: 9.8, eld_p50_ms: 23.8, eld_p99_ms: 17.5, eld_max_ms: 3.6, gc_ms_per_s: 11.9, main_runq_wait_ms_per_s: 11.5,
  main_minflt_per_s: 3.9, main_syscr_per_s: 6.4, main_syscw_per_s: 4.3, rss_peak_mib: 12.5, heap_peak_mib: 21.8, wal_max_mib: 6.4,
  reader_tx_avg_ms: 32, reader_tx_wait_avg_ms: 34.7, reader_tx_wait_p95_ms: 17.7, reader_stmt_p95_ms: 56, writer_tx_avg_ms: 15.6,
  writer_tx_p95_ms: 3.6, writer_tx_wait_p95_ms: 15.8, reader_tx_per_s: 5.5, writer_tx_per_s: 3.2, get_thread_shell_p95_ms: 18.4,
  mcp_auth_p95_ms: 39, shutdown_s: 26, db_ready_warm_ms: 10, db_ready_first_ms: 12, listening_warm_ms: 10, first_turn_after_start_ms: 20,
};

export function synthInputs(dir) {
  const write = (rel, value) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  const nightlies = new Map();
  for (let i = 0; i < NIGHTLY_DAYS; i++) {
    const date = addDays(NIGHTLY_FROM, i);
    const identity = fakeIdentity({ date });
    const record = synthRecord({ identity, factor: (id, cell) => upstreamFactor(id, cell, date), partial: date === "2026-10-25" });
    nightlies.set(date, record);
    write(`records/${record.platform.id}/${date}.${record.release.tag}.json`, record);
  }
  const bases = new Map();
  for (const f of FORKS) {
    if (bases.has(f.base)) continue;
    const sha = hex(`merge-base-${f.base}`, 40);
    const identity = fakeIdentity({ date: f.base, kind: "base", sha, tag: `v${f.version}` });
    const record = synthRecord({ identity, factor: (id, cell) => upstreamFactor(id, cell, f.base) });
    bases.set(f.base, record);
    write(`base/${sha.slice(0, 12)}.${record.platform.id}.json`, record);
  }
  for (const f of FORKS) {
    const nightly = nightlies.get(f.base);
    const tag = `v${f.version}-perf.${f.perf}`;
    const identity = fakeIdentity({ date: f.date, kind: "fork", tag, base: { tag: nightly.release.tag, date: f.base, sha: bases.get(f.base).release.sha } });
    const record = synthRecord({ identity, factor: (id, cell) => upstreamFactor(id, cell, f.base) * (cell === "1e" ? 1 : forkFactor(id, f.perf)) });
    write(`fork/${tag}.${record.platform.id}.json`, record);
  }
  write("bands.json", {
    schema: "t3cp/bands/1",
    synthetic: true,
    method: "synthetic development bands, not measured: (max - min) / median in percent",
    platforms: {
      "linux-x64": {
        measured: { from: "2026-11-01", to: "2026-11-01", attempts: 42, machines: 3, tag: nightlies.get("2026-11-01").release.tag },
        metrics: Object.fromEntries(Object.entries(BAND_VALUES).map(([id, band]) => [id, { band, n: 6 }])),
      },
    },
  });
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { out: { type: "string" } } });
  const root = path.resolve(values.out ?? path.join(REPO_ROOT, "site", ".dev-data"));
  const dataDir = path.resolve(REPO_ROOT, "data");
  if (root === dataDir || root.startsWith(`${dataDir}${path.sep}`)) {
    process.stderr.write("synth-data: refusing to write synthetic data under data/\n");
    return 2;
  }
  const input = path.join(root, "input", "v1");
  fs.rmSync(input, { recursive: true, force: true });
  synthInputs(input);
  const files = aggregate({ inDir: input, outDir: path.join(root, "v1"), dev: true });
  const payload = overviewPayload(files, "linux-x64", catalogue);
  process.stderr.write(`synth-data: ${files.size} files in ${path.join(root, "v1")}; overview payload ${payload.total} bytes gzipped (measured)\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));

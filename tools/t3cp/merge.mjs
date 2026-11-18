#!/usr/bin/env node
// Folds the attempts of one record (O/attempts/<cell>-<n>/attempt.json, 18 ladder + 3 empty-database) and its
// extras (O/extras/*.json) into one t3cp/record/1 file. Fail closed: any attempt or extras file that does not
// validate, any identity mismatch between attempts, or a record that does not validate exits 2 and writes nothing.
//
//   node tools/t3cp/merge.mjs <O> --out <record.json> [--run-id N] [--lease N] [--generated-at <ISO>] [--public-refs <file>]
//   (--run-id is accepted and never published: a private workflow run gives a reader nothing)
//
// Per cell and metric: values[] = the valid attempts' values in attempt order (null kept: a missing span is
// null, never 0), n = the non-null count, median / min / max over those (null when n = 0). status = complete
// when every expected cell (workload levels, plus 1e with the empty cell) has at least two valid attempts,
// partial otherwise (status_reason attempts_invalid). A record whose O/failures holds the runner's record_timeout (it
// reached its deadline, exit 5) is merged from what it exported in time: partial, status_reason timeout, even when its
// cells are complete. Dot-entries under O (a runner's unfinished staging) are never read.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { validate } from "./lib/validate.mjs";
import { EXPORTER_VERSION, isMain, loadCatalogue, loadSchema, median, roundValue } from "./lib/repo.mjs";
import { NOT_MEASURED_SATURATED, levelMetricIds } from "./lib/schemas.mjs";
import { ScanConfigError, scanValue } from "./lib/scan.mjs";
import { JsonError, parseStrict } from "./lib/json.mjs";
import { cellProfile, loadProfiles, metaProfile } from "./runner/profiles.mjs";

const IDENTITY_KEYS = ["record_id", "kind", "release", "base", "platform", "harness", "fixture", "workload", "era"];
const canonical = (value) =>
  JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

export class MergeError extends Error {}

/** The load profiles the runner runs (tools/t3cp/runner/profiles.json). */
const PROFILES = loadProfiles();

/** The content hashes a harness is published by; each must be the pinned public tree's. */
const HARNESS_HASHES = ["files_sha256", "driver_sha256", "fakes_sha256", "preload_sha256"];
const PUBLIC_REFS_FILE = new URL("./public-refs.json", import.meta.url);

/**
 * The public references a record may name (tools/t3cp/public-refs.json, pinned from the public repository's tags):
 * per harness version its public tag commit and the content hashes of that tree, and per fork release tag its public
 * commit. Refuses a file that is missing or malformed.
 */
export function loadPublicRefs(file = PUBLIC_REFS_FILE) {
  let refs;
  try {
    refs = parseStrict(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new MergeError(`public-refs.json: ${error.message}`);
  }
  const hex = (v, n) => typeof v === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
  if (refs?.schema !== "t3cp/public-refs/1" || typeof refs.harness !== "object" || typeof refs.fork !== "object") throw new MergeError("public-refs.json: not t3cp/public-refs/1");
  for (const [version, h] of Object.entries(refs.harness)) {
    if (!/^t3cp-harness\/\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version) || !hex(h?.sha, 40) || !HARNESS_HASHES.every((k) => hex(h[k], 64))) throw new MergeError(`public-refs.json: harness ${version} is malformed`);
  }
  for (const [tag, sha] of Object.entries(refs.fork)) {
    if (!/^v\d{1,3}\.\d{1,3}\.\d{1,4}-perf\.\d{1,3}$/.test(tag) || !hex(sha, 40)) throw new MergeError(`public-refs.json: fork ${tag} is malformed`);
  }
  return refs;
}

/**
 * The harness as a record publishes it: the attempts' content hashes must be the pinned public tree's, and the commit is
 * the public tag's (the attempts name the snapshot they ran, which a reader cannot resolve).
 */
function publicHarness(harness, refs) {
  const pinned = refs.harness[harness.version];
  if (!pinned) throw new MergeError(`harness ${harness.version}: no public tag pinned in public-refs.json`);
  for (const k of HARNESS_HASHES) {
    if (harness[k] !== pinned[k]) throw new MergeError(`harness ${harness.version}: ${k} is not the pinned public tree's`);
  }
  return { ...harness, sha: pinned.sha };
}

/**
 * Whether a cell is saturated (the ladder decision): most of its valid attempts are, or the median agents served is
 * below the cell's agents. The aggregator re-derives it with this same rule.
 */
export function cellSaturated({ attempts, agentsServedMedian, agentsTotal }) {
  const valid = attempts.filter((a) => a.valid);
  return valid.filter((a) => a.saturated === true).length * 2 > valid.length || (agentsServedMedian !== null && agentsTotal !== null && agentsServedMedian < agentsTotal);
}

const stat = (values) => {
  const numbers = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  return {
    median: roundValue(median(numbers)),
    min: numbers.length === 0 ? null : Math.min(...numbers),
    max: numbers.length === 0 ? null : Math.max(...numbers),
    n: numbers.length,
    values,
  };
};

/** Metric ids a cell carries: the empty-database cell keeps its own list plus the validity gates. */
export function cellMetricIds(catalogue, cell, kind) {
  const gates = new Set(["client_errors", "client_unfinished", "host_busy_pct", "host_steal_pct", "host_iowait_pct"]);
  const byId = new Map(catalogue.metrics.map((m) => [m.id, m]));
  return levelMetricIds(catalogue).filter((id) => {
    const m = byId.get(id);
    if (m.upstream === "fork" && kind !== "fork") return false;
    return cell === "1e" ? m.empty_cell || gates.has(id) : true;
  });
}

/**
 * The record's compaction schedule era from its attempts' maintenance_in_window: "unscheduled" when the release
 * starts a pass after every start (unscheduled_pre_marker), "scheduled" for a count or unobserved_no_span, null
 * when no attempt could tell. Attempts that disagree are refused.
 */
function compactionSchedule(attempts) {
  const eras = new Set();
  for (const a of attempts) {
    const m = a.attempt.maintenance_in_window ?? null;
    if (m === null) continue;
    eras.add(m === "unscheduled_pre_marker" ? "unscheduled" : "scheduled");
  }
  if (eras.size > 1) throw new MergeError("attempts disagree on the compaction schedule era");
  return eras.size === 0 ? null : [...eras][0];
}

/** Least-squares slope of y on x; null with fewer than two points. */
function slope(points) {
  if (points.length < 2) return null;
  const mx = points.reduce((s, [x]) => s + x, 0) / points.length;
  const my = points.reduce((s, [, y]) => s + y, 0) / points.length;
  const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  if (sxx === 0) return null;
  return points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx;
}

/**
 * Builds one t3cp/record/1 object from validated attempt objects (t3cp/attempt/1) and extras documents
 * (t3cp/extras/1, any number, each carrying some parts). Throws MergeError on any inconsistency.
 */
export function mergeRecord({ attempts, extras = [], catalogue = loadCatalogue(), generatedAt, runId = null, lease = null, publicRefs = loadPublicRefs(), timedOut = false }) {
  if (attempts.length === 0) throw new MergeError("no attempts");
  const first = attempts[0];
  // runId names a private workflow run: accepted from the caller, never published.
  void runId;
  for (const attempt of attempts) {
    for (const key of IDENTITY_KEYS) {
      if (canonical(attempt[key]) !== canonical(first[key])) {
        throw new MergeError(`attempt ${attempt.cell}-${attempt.n}: ${key === "record_id" ? "record_id" : key} differs from attempt ${first.cell}-${first.n}`);
      }
    }
  }
  for (const part of extras) {
    if (part.record_id !== first.record_id) throw new MergeError("extras record_id differs from the attempts");
    // The extras come from the same exporter as the attempts (the runner identity is the attempts' alone).
    for (const key of ["exporter_version", "exporter_files_sha256"]) {
      if ((part.pipeline?.[key] ?? null) !== (first.pipeline?.[key] ?? null)) throw new MergeError(`extras: pipeline differs (${key}) from the attempts`);
    }
  }
  const CODE = ["exporter_version", "exporter_files_sha256", "runner_version", "runner_files_sha256"];
  for (const a of attempts) {
    for (const key of CODE) {
      if ((a.pipeline?.[key] ?? null) !== (first.pipeline?.[key] ?? null)) throw new MergeError(`attempt ${a.cell}-${a.n}: pipeline differs (${key}) from attempt ${first.cell}-${first.n}`);
    }
  }
  const seen = new Set();
  for (const a of attempts) {
    const key = `${a.cell}-${a.n}`;
    if (seen.has(key)) throw new MergeError(`duplicate attempt ${key}`);
    seen.add(key);
  }

  // The exporter gives every valid unsaturated attempt's measured window a turns count (0 when no turn completed), and a
  // saturated attempt none, with the reason not_measured_saturated (turns are counted by start time and outlast the
  // window there). Anything else is an exporter regression, never published; the empty-database cell carries no count.
  for (const a of attempts) {
    if (!a.attempt.valid || a.cell === "1e") continue;
    const turns = a.metrics.turns_completed;
    const notMeasured = a.attempt.metric_reasons?.turns_completed === "not_measured_saturated";
    if (a.attempt.saturated) {
      if (turns !== null || !notMeasured) throw new MergeError(`attempt ${a.cell}-${a.n}: a saturated attempt carries turns_completed null with not_measured_saturated`);
    } else if (turns === null || turns === undefined || notMeasured) {
      throw new MergeError(`attempt ${a.cell}-${a.n}: valid without turns_completed`);
    }
  }
  // Only public commits are published: the harness by its pinned public tag, a fork release by its pinned tag commit.
  const harness = publicHarness(first.harness, publicRefs);
  if (first.kind === "fork") {
    const pinned = publicRefs.fork[first.release.tag];
    if (pinned === undefined) throw new MergeError(`fork ${first.release.tag}: fork_tag_unpinned (no public commit pinned for the tag in public-refs.json)`);
    if (pinned !== first.release.sha) throw new MergeError(`fork ${first.release.tag}: release.sha is not the public commit pinned for the tag in public-refs.json`);
  }
  const workload = first.workload;
  const expected = [...workload.levels.map(String), ...(workload.empty_cell ? ["1e"] : [])];
  const cells = {};
  const profiles = {};
  let complete = true;
  for (const cell of ["1", "50", "100", "150", "200", "250", "1e"]) {
    const inCell = attempts.filter((a) => a.cell === cell).sort((a, b) => a.n - b.n);
    if (inCell.length === 0) {
      if (expected.includes(cell)) complete = false;
      continue;
    }
    for (const a of inCell) {
      if (canonical(a.profile) !== canonical(inCell[0].profile)) throw new MergeError(`attempt ${a.cell}-${a.n}: load profile differs from attempt ${inCell[0].cell}-${inCell[0].n}`);
    }
    // The cell ran what profiles.json says for the record's profile at this cell, nothing else.
    let planned;
    try {
      const entry = cellProfile(PROFILES, workload.profile, cell, first.fixture.id);
      planned = { ...metaProfile(entry), fixture: entry.fixture };
    } catch (error) {
      throw new MergeError(`cell ${cell}: no profiles.json entry for profile ${workload.profile} (${error.message})`);
    }
    if (canonical(inCell[0].profile) !== canonical(planned)) throw new MergeError(`cell ${cell}: the attempts' load profile is not profiles.json's ${workload.profile} entry for this cell`);
    profiles[cell] = structuredClone(inCell[0].profile);
    const valid = inCell.filter((a) => a.attempt.valid);
    if (valid.length < 2) complete = false;
    const metrics = {};
    for (const id of cellMetricIds(catalogue, cell, first.kind)) metrics[id] = stat(valid.map((a) => a.metrics[id] ?? null));
    // A count not measured on a saturated attempt is not measured for the cell either, when any of its attempts is.
    if (valid.some((a) => a.attempt.saturated === true)) {
      for (const id of NOT_MEASURED_SATURATED) {
        if (metrics[id] !== undefined) metrics[id] = { median: null, min: null, max: null, n: 0, values: [], reason: "not_measured_saturated" };
      }
    }
    // Saturated (the ladder decision): the median agents served is below the cell's agents.
    const agentsTotal = inCell[0].attempt.agents_total ?? inCell[0].profile?.sessions ?? null;
    const servedMedian = metrics.agents_served?.median ?? null;
    cells[cell] = {
      attempts: inCell.map((a) => ({ n: a.n, ...a.attempt })),
      valid: valid.length,
      total: inCell.length,
      saturated: cellSaturated({ attempts: inCell.map((a) => a.attempt), agentsServedMedian: servedMedian, agentsTotal }),
      agents_total: agentsTotal,
      metrics,
    };
  }
  for (const cell of expected) if (cells[cell] === undefined) complete = false;

  // Extras: every part's metrics, later files filling what earlier ones left out.
  const fixtureMetrics = {};
  const emptyMetrics = {};
  let migration = null;
  for (const part of extras) {
    Object.assign(fixtureMetrics, part.fixture?.metrics ?? {});
    Object.assign(emptyMetrics, part.empty?.metrics ?? {});
    if (part.migration) migration = part.migration;
  }
  // Process CPU per served agent: the slope of each standard-profile level's median process CPU (50 agents and up;
  // the 1-agent cell runs a different profile) against its median agents served, not the agents it offered (a
  // saturated level serves fewer). One fitted value; null, with its reason, under two distinct served levels.
  const points = workload.levels
    .filter((level) => level >= 50)
    .map((level) => [cells[String(level)]?.metrics.agents_served?.median ?? null, cells[String(level)]?.metrics.proc_cpu_pct?.median ?? null])
    .filter(([x, y]) => x !== null && y !== null);
  const cpuSlope = new Set(points.map(([x]) => x)).size < 2 ? null : slope(points);
  if (catalogue.metrics.some((m) => m.id === "cpu_per_session_pct")) {
    fixtureMetrics.cpu_per_session_pct =
      cpuSlope === null
        ? { median: null, min: null, max: null, n: 0, values: [], reason: "fewer_than_two_served_levels" }
        : { median: roundValue(cpuSlope), min: roundValue(cpuSlope), max: roundValue(cpuSlope), n: 1, values: [roundValue(cpuSlope)] };
  }

  const maxOf = (values) => {
    const numbers = values.filter((v) => typeof v === "number");
    return numbers.length === 0 ? null : Math.max(...numbers);
  };
  const guard = (key) => maxOf(attempts.map((a) => a.host_guard?.[key]));
  const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    schema: "t3cp/record/1",
    ...(first.synthetic === true ? { synthetic: true } : {}),
    ...Object.fromEntries(IDENTITY_KEYS.map((key) => [key, structuredClone(first[key])])),
    harness: harness,
    workload: { ...structuredClone(first.workload), cells: profiles },
    cells,
    extras: {
      fixture: Object.keys(fixtureMetrics).length === 0 ? null : { metrics: sortKeys(fixtureMetrics) },
      empty: Object.keys(emptyMetrics).length === 0 ? null : { metrics: sortKeys(emptyMetrics) },
      migration,
      weekly: null,
    },
    host_guard: {
      contaminated: attempts.some((a) => a.attempt.contaminated),
      host_busy_pct_max: guard("busy_pct_max") ?? maxOf(attempts.map((a) => a.metrics.host_busy_pct)),
      host_steal_pct_max: guard("steal_pct_max") ?? maxOf(attempts.map((a) => a.metrics.host_steal_pct)),
      host_iowait_pct_max: guard("iowait_pct_max") ?? maxOf(attempts.map((a) => a.metrics.host_iowait_pct)),
      foreign_pct_mean_max: guard("foreign_pct_mean"),
      thermal_limit_min: null,
    },
    // A record that reached its deadline did not finish, whatever its cells say: partial, timeout.
    status: complete && !timedOut ? "complete" : "partial",
    status_reason: timedOut ? "timeout" : complete ? null : "attempts_invalid",
    compaction_schedule: compactionSchedule(attempts),
    pipeline: {
      generated_at: generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      run_id: null,
      lease,
      exporter_version: first.pipeline?.exporter_version ?? EXPORTER_VERSION,
      exporter_files_sha256: first.pipeline?.exporter_files_sha256 ?? null,
      runner_version: first.pipeline?.runner_version ?? null,
      runner_files_sha256: first.pipeline?.runner_files_sha256 ?? null,
    },
  };
}

function readValidated(file, schemaName) {
  let value;
  try {
    value = parseStrict(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new MergeError(`${path.basename(path.dirname(file))}/${path.basename(file)}: ${error instanceof JsonError ? error.message : "not readable JSON"}`);
  }
  const errors = validate(loadSchema(schemaName), value);
  if (errors.length > 0) {
    throw new MergeError(`${path.basename(path.dirname(file))}/${path.basename(file)}: ${errors.slice(0, 5).map((e) => `${e.path} ${e.message}`).join("; ")}`);
  }
  return value;
}

/**
 * Whether O/failures holds the runner's record_timeout (the record reached its deadline: exit 5). Every failure file
 * must be a t3cp/failure/1 of this record; any other reason leaves the record as its attempts say.
 */
function readTimedOut(dir, recordId) {
  const failuresDir = path.join(dir, "failures");
  if (!fs.existsSync(failuresDir)) return false;
  let timedOut = false;
  for (const name of fs.readdirSync(failuresDir).sort()) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    let f;
    try {
      f = parseStrict(fs.readFileSync(path.join(failuresDir, name), "utf8"));
    } catch (error) {
      throw new MergeError(`failures/${name}: ${error instanceof JsonError ? error.message : "not readable JSON"}`);
    }
    if (f === null || typeof f !== "object" || Array.isArray(f) || f.schema !== "t3cp/failure/1" || typeof f.reason !== "string") {
      throw new MergeError(`failures/${name}: not a t3cp/failure/1 file`);
    }
    if (f.record_id !== recordId) throw new MergeError(`failures/${name}: names another record than the attempts`);
    if (f.reason === "record_timeout") timedOut = true;
  }
  return timedOut;
}

/**
 * Reads O/attempts, O/extras and O/failures, merges, validates and scans; returns the record. Dot-entries are a
 * runner's unfinished staging (a deadline can leave a finished but unmoved export there) and are never read.
 */
export function mergeDirectory(dir, options = {}) {
  const attemptsDir = path.join(dir, "attempts");
  const attempts = [];
  if (fs.existsSync(attemptsDir)) {
    for (const name of fs.readdirSync(attemptsDir).sort()) {
      if (name.startsWith(".")) continue;
      if (!/^(1|50|100|150|200|250|1e)-[1-9]$/.test(name)) throw new MergeError(`attempts/${name}: unexpected directory name`);
      const file = path.join(attemptsDir, name, "attempt.json");
      if (!fs.existsSync(file)) continue; // an attempt that never exported counts as missing
      const attempt = readValidated(file, "attempt-1.json");
      if (`${attempt.cell}-${attempt.n}` !== name) throw new MergeError(`attempts/${name}: cell and n do not match the directory`);
      attempts.push(attempt);
    }
  }
  const extras = [];
  const extrasDir = path.join(dir, "extras");
  if (fs.existsSync(extrasDir)) {
    for (const name of fs.readdirSync(extrasDir).sort()) {
      if (name.startsWith(".") || !name.endsWith(".json")) continue;
      extras.push(readValidated(path.join(extrasDir, name), "extras-1.json"));
    }
  }
  const timedOut = attempts.length > 0 && readTimedOut(dir, attempts[0].record_id);
  const record = mergeRecord({ attempts, extras, ...options, timedOut });
  const errors = validate(loadSchema("record-1.json"), record);
  if (errors.length > 0) throw new MergeError(`record: ${errors.slice(0, 5).map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const hits = scanValue(record);
  if (hits.length > 0) throw new MergeError(`record: forbidden pattern(s) ${[...new Set(hits.map((h) => h.pattern))].join(", ")}`);
  return record;
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: "string" }, "run-id": { type: "string" }, lease: { type: "string" }, "generated-at": { type: "string" }, "public-refs": { type: "string" } },
  });
  if (positionals.length !== 1 || values.out === undefined) {
    process.stderr.write("usage: merge.mjs <output dir> --out <record.json> [--run-id N] [--lease N] [--generated-at ISO] [--public-refs <file>]\n");
    return 2;
  }
  try {
    const record = mergeDirectory(positionals[0], {
      // The pinned tools/t3cp/public-refs.json unless a test names another file.
      publicRefs: loadPublicRefs(values["public-refs"] ?? PUBLIC_REFS_FILE),
      runId: values["run-id"] === undefined ? null : Number.parseInt(values["run-id"], 10),
      lease: values.lease === undefined ? null : Number.parseInt(values.lease, 10),
      generatedAt: values["generated-at"],
    });
    const tmp = `${values.out}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(tmp, values.out);
    process.stderr.write(`merge: ${record.record_id} ${record.status}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`merge: refused: ${error instanceof MergeError || error instanceof ScanConfigError ? error.message : "internal error"}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

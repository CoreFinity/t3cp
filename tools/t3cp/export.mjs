#!/usr/bin/env node
// The allow-list exporter: the only program whose output leaves a runner.
//
//   node tools/t3cp/export.mjs <W/raw/<cell>-<n>> --out <O/attempts/<cell>-<n>> --spec <spec.json>
//   node tools/t3cp/export.mjs --extras <W/raw-extras> --out <O/extras> --spec <spec.json>
//   [--no-private-patterns]   (only where no private list exists: tests, local development)
//
// It reads one raw attempt directory (schema/record-spec-1.json $defs.attempt_dir) and writes attempt.json
// (schema/attempt-1.json): the identity fields of design §5.5 and the catalogue's metric ids, nothing else.
// With --extras it writes one t3cp/extras/1 file per raw extras file (startup, migration, snapshot, first_turn).
//
// Fail closed: a schema error, a forbidden pattern (public list + the private list named by
// T3CP_PRIVATE_PATTERNS + any secret found under a creds directory), a value that is not a finite number, an
// identity mismatch, or an input that resolves into a creds directory or outside the raw directory: exit 2,
// nothing written.
// Messages name JSON paths, metric ids and pattern ids, never the offending value.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { validate } from "./lib/validate.mjs";
import { ScanConfigError, loadPrivatePatterns, scanText, scanValue } from "./lib/scan.mjs";
import { EXPORTER_VERSION, isMain, loadCatalogue, loadScenarios, loadSchema, median, roundValue } from "./lib/repo.mjs";
import { BUILD_REPOS, EXTRAS_REASONS, PROBLEMS, SCENARIO_REASONS, forkHeadProblem, levelMetricIds, NOT_MEASURED_SATURATED } from "./lib/schemas.mjs";
import { JsonError, parseNdjsonStrict, parseStrict } from "./lib/json.mjs";
import { durationS, ladderFeatureEras, scenarioLoad } from "./lib/scenarios.mjs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MAPPING, MappingError, procWindow } from "./lib/mapping.mjs";

export class ExportError extends Error {}
const fail = (message) => {
  throw new ExportError(message);
};

const CELLS = ["1", "50", "100", "150", "200", "250", "1e"];

/**
 * sha256 over "<path>\0<sha256 of the file>\n" of the exporter's own code and the catalogue and schemas it applies,
 * sorted by path: the content identity written into every record (no t3cp commit SHA is ever recorded).
 */
// Exactly what the runner VM runs during export and merge (exporter-closure.test.mjs recomputes it): the static import
// closure of export.mjs and merge.mjs and the data files that code reads. tools/t3cp/image-pin.json pins its hash.
export const EXPORTER_FILES = [
  "tools/t3cp/export.mjs", "tools/t3cp/merge.mjs", "tools/t3cp/lib/json.mjs", "tools/t3cp/lib/mapping.mjs", "tools/t3cp/lib/repo.mjs",
  "tools/t3cp/lib/scan.mjs", "tools/t3cp/lib/schemas.mjs", "tools/t3cp/lib/validate.mjs", "tools/t3cp/runner/profiles.mjs",
  "tools/t3cp/runner/is-main.mjs", "tools/t3cp/runner/profiles.json", "tools/t3cp/public-refs.json",
  "tools/t3cp/lib/scenarios.mjs", "catalogue/catalogue.json", "scenarios.json", "schema/attempt-1.json", "schema/extras-1.json", "schema/record-1.json",
  "schema/scenario-attempt-1.json", "schema/scenario-record-1.json",
  // run-record.sh validates its spec against this on the VM; the runner identity (run-record.sh, runner/*) omits it.
  "schema/record-spec-1.json",
];
let exporterFilesSha;
export function exporterFilesSha256() {
  if (exporterFilesSha === undefined) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const hash = createHash("sha256");
    for (const rel of [...EXPORTER_FILES].sort()) hash.update(`${rel}\0${createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex")}\n`);
    exporterFilesSha = hash.digest("hex");
  }
  return exporterFilesSha;
}

/** The runner's code identity from attempt-meta.json: {version, files_sha256}, both or nothing; never a commit. */
function runnerIdentity(meta) {
  if (meta.runner === undefined || meta.runner === null) return { runner_version: null, runner_files_sha256: null };
  const errors = validate(
    { type: "object", additionalProperties: false, required: ["version", "files_sha256"], properties: { version: { type: "string", pattern: "^t3cp-runner/\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$" }, files_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } } },
    meta.runner,
  );
  if (errors.length > 0) fail(`attempt-meta.json: ${errors.map((e) => `runner${e.path.slice(1)} ${e.message}`).join("; ")}`);
  return { runner_version: meta.runner.version, runner_files_sha256: meta.runner.files_sha256 };
}

/** Fork and base records: the public source repository and the build script's hash; nightlies have no build. */
function buildIdentity(spec, meta) {
  if (spec.kind === "nightly") return null;
  const build = meta.build ?? spec.release.build;
  if (build === undefined || build === null) fail(`attempt-meta.json: build_missing (a ${spec.kind} record needs build {source_repo, script_sha256})`);
  const errors = validate(
    { type: "object", additionalProperties: false, required: ["source_repo", "script_sha256"], properties: { source_repo: { type: "string", enum: BUILD_REPOS }, script_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } } },
    build,
  );
  if (errors.length > 0) fail(`attempt-meta.json: ${errors.map((e) => `build${e.path.slice(1)} ${e.message}`).join("; ")}`);
  return { source_repo: build.source_repo, script_sha256: build.script_sha256 };
}
const TAG = /^v\d{1,3}\.\d{1,3}\.\d{1,4}(-nightly\.20\d{6}\.\d{1,6}|-perf\.\d{1,3})?$/;
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// ---------------------------------------------------------------------------------------------------------
// guarded reads

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Reads files under one root only; refuses anything that resolves outside it, into a creds directory, or to a settings file. */
class Reader {
  constructor(root) {
    this.root = fs.realpathSync(root);
  }
  resolve(rel) {
    const full = path.join(this.root, rel);
    if (!fs.existsSync(full)) return null;
    const real = fs.realpathSync(full);
    if (!inside(real, this.root)) fail(`${rel}: input resolves outside the raw directory`);
    const parts = path.relative(this.root, real).split(path.sep);
    if (parts.includes("creds") || parts.at(-1) === "settings.json") fail(`${rel}: input resolves into a creds directory or a settings file`);
    return real;
  }
  text(rel) {
    const file = this.resolve(rel);
    return file === null ? null : fs.readFileSync(file, "utf8");
  }
  json(rel, { required = false } = {}) {
    const text = this.text(rel);
    if (text === null) return required ? fail(`${rel}: missing`) : null;
    try {
      return parseStrict(text);
    } catch (error) {
      return fail(`${rel}: ${error instanceof JsonError ? error.message : "not valid JSON"}`);
    }
  }
  /** Newline-delimited JSON, strictly: only an unparseable final line (a torn write) is dropped. */
  ndjson(rel) {
    const text = this.text(rel);
    if (text === null) return [];
    try {
      return parseNdjsonStrict(text, rel);
    } catch (error) {
      return fail(error instanceof JsonError ? error.message : `${rel}: not valid JSON`);
    }
  }
}

/**
 * Secret strings under any creds directory of the raw tree: the values of token, secret, password and key
 * fields in JSON files, and whole single-line files. They are forbidden in the output; never printed.
 */
function credsSecrets(root) {
  const secrets = new Set();
  const take = (value) => {
    if (typeof value === "string" && value.length >= 12) secrets.add(value);
  };
  const fromJson = (node, key = "") => {
    if (Array.isArray(node)) node.forEach((n) => fromJson(n, key));
    else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) fromJson(v, k);
    else if (/token|secret|password|passwd|key|bootstrap|credential|cookie|auth/i.test(key)) take(node);
  };
  const walk = (dir, underCreds) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, underCreds || entry.name === "creds");
      else if (underCreds && entry.isFile() && fs.statSync(full).size <= 1_000_000) {
        const text = fs.readFileSync(full, "utf8");
        try {
          fromJson(parseStrict(text));
        } catch {
          const line = text.trim();
          if (!line.includes("\n")) take(line);
        }
      }
    }
  };
  walk(root, false);
  return [...secrets];
}

const stringsOf = (node, out = []) => {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => stringsOf(n, out));
  else if (node && typeof node === "object") Object.values(node).forEach((n) => stringsOf(n, out));
  return out;
};

/**
 * Public + private + creds scan of a value; throws naming pattern ids only. `valuesOnly` scans the string
 * values and not the keys (for harness input blocks whose own key names, such as the server reference field, are on the list).
 */
function scanOrFail(what, value, context, { valuesOnly = false } = {}) {
  const hits = valuesOnly
    ? stringsOf(value).flatMap((text) => scanText(text, { privatePatterns: context.privatePatterns }))
    : scanValue(value, { privatePatterns: context.privatePatterns });
  const text = JSON.stringify(value);
  const ids = new Set(hits.map((h) => h.pattern));
  if (context.secrets.some((secret) => text.includes(secret))) ids.add("creds_secret");
  if (ids.size > 0) fail(`${what}: forbidden pattern(s) ${[...ids].sort().join(", ")}`);
}

function schemaOrFail(what, schemaName, value) {
  const errors = validate(loadSchema(schemaName), value);
  if (errors.length > 0) fail(`${what}: ${errors.slice(0, 8).map((e) => `${e.path} ${e.message}`).join("; ")}`);
}

// ---------------------------------------------------------------------------------------------------------
// identity

/** The runner's default load profile when a spec names none (tools/t3cp/runner/profiles.json "default"). */
const DEFAULT_PROFILE = "real3";
const numOrNull = { type: ["number", "null"] };
const GUARD_KEYS = ["busy_pct_mean", "busy_pct_max", "foreign_pct_mean", "foreign_pct_max", "steal_pct_mean", "steal_pct_max", "iowait_pct_mean", "iowait_pct_max", "window_start_ms", "window_end_ms"];

/** attempt-meta.json as the runner writes it (tools/t3cp/runner/lib.mjs merge-tries), checked in full. */
const META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // The runner writes its host guard and maintenance keys on every attempt: an absent one is refused, never read as clean.
  required: ["schema", "record_id", "cell", "n", "profile", "host", "harness", "contaminated", "contamination_reasons", "host_guard", "maintenance_in_window"],
  properties: {
    schema: { const: "t3cp/attempt-meta/1" },
    record_id: { type: "string" },
    cell: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,30}$" },
    n: { type: "integer", minimum: 1, maximum: 9 },
    level: { type: "integer", minimum: 1, maximum: 1000 },
    label: { type: "string", pattern: "^[a-z0-9][a-z0-9.-]{0,47}$" },
    profile: { type: "object" },
    fixture: { type: "string", pattern: "^(large-\\d{2,3}(-s\\d{1,3})?|none|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$" },
    suite: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, warmup_s: { type: "integer" }, window_s: { type: "integer" } } },
    // A scenario cell's row, and whether its window is expected to hold maintenance passes (an unseeded cell).
    scenario: { type: "object", additionalProperties: false, required: ["id", "version"], properties: { id: { type: "string" }, version: { type: "integer", minimum: 1 } } },
    maintenance_expected: { const: true },
    now: { type: "string" },
    seed: { type: "string" },
    release: { type: "object", additionalProperties: false, properties: { tag: { type: "string" }, sha: { type: "string" }, version: { type: "string" } } },
    cpus: { type: "object", additionalProperties: false, properties: { server: { type: ["string", "null"], pattern: "^[0-9,-]*$" }, driver: { type: ["string", "null"], pattern: "^[0-9,-]*$" }, pinned: { type: "boolean" } } },
    host: { type: "object" },
    harness: { type: "object" },
    runner: { type: ["object", "null"] },
    build: { type: ["object", "null"] },
    started_at: { type: ["string", "null"] },
    ended_at: { type: ["string", "null"] },
    cycle_s: { type: ["number", "null"], minimum: 0 },
    run_ts_exit: { type: ["integer", "null"] },
    window_start_ms: numOrNull,
    window_end_ms: numOrNull,
    valid_run: { type: ["integer", "null"], minimum: 1 },
    host_guard: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        method: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" },
        samples: { type: "integer", minimum: 0 },
        ...Object.fromEntries(GUARD_KEYS.map((k) => [k, numOrNull])),
        thresholds: { type: "object", additionalProperties: numOrNull },
      },
    },
    contaminated: { type: ["boolean", "null"] },
    contamination_reasons: { type: "array", items: { type: "string", enum: ["foreign_cpu", "steal"] } },
    host_guard_max_busy_pct: numOrNull,
    // How many maintenance passes (event-store compaction or prune spans) overlapped the window, or why that is
    // not counted: the release starts an unscheduled pass after every start, or its pass emits no named span.
    maintenance_in_window: { type: ["integer", "string", "null"], minimum: 0, pattern: "^(unscheduled_pre_marker|unobserved_no_span)$" },
    tries: { type: "array", items: { type: "object" } },
  },
};

/** The parts of result.json the exporter relies on, by type (the rest is never read). */
const RESULT_SHAPE = {
  type: "object",
  required: ["runs", "run_details", "metrics", "identity"],
  properties: {
    runs: { type: "object", required: ["valid"], properties: { requested: { type: "integer" }, attempted: { type: "integer" }, valid: { type: "integer", minimum: 0 } } },
    run_details: { type: "array", items: { type: "object", required: ["attempt", "valid"], properties: { attempt: { type: "integer", minimum: 1 }, valid: { type: "boolean" } } } },
    metrics: { type: "object" },
    identity: { type: "object" },
    sampling: { type: "object", properties: { trace_min_level: { type: "string" }, trace_timing_enabled: { type: "string" } } },
  },
};
/**
 * The driver's post-window distribution check (t3cp-harness/2.0.0: driver.json distribution.match, copied to run.json
 * driver.workload.distribution_match): the exercised threads' p50 and p95 turn-item ratios to the fixture's, and the
 * exact two-sided binomial test of how many fall below the fixture's p50 and above its p95, which decides
 * withinTolerance (2.0.1 names it: decidedBy "binomial"). An older harness wrote the ratios and a tolerance verdict
 * without the test. Every key is known.
 */
const COUNT = { type: "integer", minimum: 0, maximum: 1000000 };
const SHARE = { type: "number", minimum: 0, maximum: 1 };
const BAND = { type: "array", minItems: 2, maxItems: 2, items: COUNT };
const QUANTILE_TEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["n", "below_p50", "expected_below", "band_below", "p_value_below", "above_p95", "expected_above", "band_above", "p_value_above", "alpha", "passed"],
  properties: {
    n: COUNT,
    below_p50: COUNT,
    expected_below: SHARE,
    band_below: BAND,
    p_value_below: SHARE,
    above_p95: COUNT,
    expected_above: SHARE,
    band_above: BAND,
    p_value_above: SHARE,
    alpha: SHARE,
    passed: { type: "boolean" },
  },
};
const RATIO = { type: ["number", "null"], minimum: 0, maximum: 10000 };
const DISTRIBUTION_MATCH_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["p50Ratio", "p95Ratio", "tolerance", "withinTolerance"],
  properties: {
    p50Ratio: RATIO,
    p95Ratio: RATIO,
    tolerance: { type: "number", minimum: 0, maximum: 5 },
    withinTolerance: { type: "boolean" },
    // t3cp-harness/2.0.1: what decided withinTolerance; the binomial test after the window is the only one.
    decidedBy: { type: "string", enum: ["binomial"] },
    test: QUANTILE_TEST_SCHEMA,
  },
};

/** One problem as harness 2.0.x writes it. */
const PROBLEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["code", "kind"],
  properties: { code: { type: "string" }, kind: { type: "string", enum: ["saturation", "defect"] } },
};

/**
 * The parts of run.json the exporter relies on, in the shape of t3cp-harness 2.0.0 and later (the runner refuses an
 * older harness): {code, kind} problems, saturated and the saturation block always; the blocks it reads key by key.
 */
const RUN_SHAPE = {
  type: "object",
  required: ["valid", "problems", "saturated", "saturation", "sessions_served", "sessions_total"],
  properties: {
    valid: { type: "boolean" },
    problems: { type: "array", items: PROBLEM_SCHEMA },
    saturated: { type: "boolean" },
    // The server's window ELU that decides the problem kinds: the preload's, else the server gauge's, else none.
    saturation: {
      type: "object",
      additionalProperties: false,
      required: ["elu", "elu_source", "threshold"],
      properties: {
        elu: { type: ["number", "null"], minimum: 0, maximum: 1 },
        elu_source: { enum: ["preload", "server_gauge", null] },
        threshold: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    window: { type: ["object", "null"], properties: { start: { type: "string" }, end: { type: "string" } } },
    // Null when the window was not measured.
    sessions_served: { type: ["integer", "null"], minimum: 0, maximum: 1000 },
    sessions_total: { type: ["integer", "null"], minimum: 1, maximum: 1000 },
    server: {
      type: ["object", "null"],
      properties: {
        // How the server stopped: SIGTERM, then SIGKILL after the grace (forced); or it was gone before the stop.
        stop: {
          type: "object",
          additionalProperties: false,
          required: ["forced", "signal_to_exit_ms", "exited_before_stop"],
          properties: {
            forced: { type: "boolean" },
            signal_to_exit_ms: { type: ["integer", "null"], minimum: 0 },
            exited_before_stop: { type: "boolean" },
          },
        },
      },
    },
    driver: {
      type: ["object", "null"],
      properties: { workload: { type: ["object", "null"], properties: { distribution_match: DISTRIBUTION_MATCH_SCHEMA } } },
    },
    metrics: { type: ["object", "null"] },
  },
};

// harness 2.0.x's classification (run.ts classifyProblems, SATURATION_ELU, serverElu, traceRequired), which the
// exporter re-checks rather than trusts: at a server window ELU of 0.95 or more the three saturation codes are kind
// "saturation" (the run stays valid and is saturated); every other problem is a "defect", and a fatal defect voids
// the run whatever the load.
const SATURATION_ELU = 0.95;
const SATURATION_CODES = new Set(["sessions_starved", "session_mcp_missing", "call_timeouts"]);
const FATAL_CODES = new Set([
  "server_start_failed", "server_auth_failed", "server_exited", "driver_failed", "driver_timeout", "pid_gone", "window_too_short",
  "main_thread_missing", "node_flags_mismatch", "node_flags_unverified", "db_setup_failed", "db_ready_timeout",
  // a judged window's other findings
  "driver_saturated", "error_rate", "distribution_mismatch",
]);
/** Fatal only when the server writes timed spans (result.json sampling: Info or finer, timing on). */
const TRACE_CODES = new Set(["trace_missing", "trace_coverage", "trace_stale", "trace_rotated_during_read"]);
const TIMING_OFF = new Set(["false", "no", "off", "0", "n"]);
const UNTIMED_LEVELS = new Set(["warn", "error", "fatal", "none"]);

/** The server's window ELU and its source from the run's own metric tree: the preload's, else the server gauge's. */
function serverElu(metrics) {
  const preload = metrics?.loop?.elu;
  if (typeof preload === "number" && Number.isFinite(preload)) return { elu: preload, elu_source: "preload" };
  const gauge = metrics?.otlp?.elu_mean;
  if (typeof gauge === "number" && Number.isFinite(gauge)) return { elu: gauge, elu_source: "server_gauge" };
  return { elu: null, elu_source: null };
}

/**
 * Re-checks run.json's classification against the harness's rule: the saturation block is the ELU the run's own
 * metrics give with the threshold 0.95; each problem's kind, valid and saturated are what the rule gives; the served
 * agents are the cell's. Returns the saturation-kind codes. A code outside the known list never decides validity
 * here (the exporter makes that attempt invalid as other_problem).
 */
function checkHarnessVerdict(run, sampling, cellAgents) {
  const elu = serverElu(run.metrics);
  const block = run.saturation;
  if (block.threshold !== SATURATION_ELU) fail("run.json: saturation.threshold is not the harness's 0.95");
  if (block.elu !== elu.elu || block.elu_source !== elu.elu_source) fail("run.json: the saturation block's ELU is not the one the run's own metrics give");
  const busy = elu.elu !== null && elu.elu >= SATURATION_ELU;
  const timedSpans = !TIMING_OFF.has(sampling?.trace_timing_enabled ?? "true") && !UNTIMED_LEVELS.has(String(sampling?.trace_min_level ?? "Info").trim().toLowerCase());
  const seen = new Set();
  const saturationCodes = [];
  let fatal = false;
  let unknown = false;
  run.problems.forEach(({ code, kind }, i) => {
    if (seen.has(code)) fail(`run.json: problems[${i}] repeats an earlier code`);
    seen.add(code);
    const expected = busy && SATURATION_CODES.has(code) ? "saturation" : "defect";
    if (kind !== expected) fail(`run.json: problems[${i}] is of kind ${kind}; the harness's rule gives ${expected}`);
    if (kind === "saturation") saturationCodes.push(code);
    else if (FATAL_CODES.has(code) || SATURATION_CODES.has(code) || (timedSpans && TRACE_CODES.has(code))) fatal = true;
    if (!PROBLEMS.includes(code) || code === "other_problem") unknown = true;
  });
  if (run.valid && fatal) fail("run.json: valid with a fatal defect");
  if (!run.valid && !fatal && !unknown) fail("run.json: invalid with no fatal defect");
  if (run.saturated !== (run.valid && saturationCodes.length > 0)) fail("run.json: saturated is not 'valid with a saturation-kind problem'");
  const served = run.sessions_served;
  const total = run.sessions_total;
  if ((served === null) !== (total === null)) fail("run.json: sessions_served and sessions_total must both be counts or both null");
  if (total !== null) {
    if (total !== cellAgents) fail("run.json: sessions_total is not the cell's agents");
    if (served > total) fail("run.json: sessions_served exceeds sessions_total");
    if (run.valid && served < total && !seen.has("sessions_starved")) fail("run.json: a valid run left agents unserved without sessions_starved");
    if (seen.has("sessions_starved") && served === total) fail("run.json: sessions_starved with every agent served");
  }
  return saturationCodes;
}

/**
 * The distribution check of one run as the record publishes it: its p50 and p95 ratios and its verdict, never the
 * counts, bands or p-values. A check that contradicts itself, its own acceptance bands or the run's problems is
 * refused. Null when the run has none (the empty-database cell, a window that was not measured, an older run.json).
 */
function distributionOf(run, codes) {
  const match = run.driver?.workload?.distribution_match ?? null;
  if (match === null) return null;
  const where = "run.json: driver.workload.distribution_match";
  const test = match.test;
  if (match.decidedBy === "binomial" && test === undefined) fail(`${where}: decided by the binomial test, but it has none`);
  if (test !== undefined) {
    const { n } = test;
    for (const [name, [low, high]] of [["band_below", test.band_below], ["band_above", test.band_above]]) {
      if (low > high || high > n) fail(`${where}.test.${name}: not an interval inside 0..n`);
    }
    if (test.below_p50 > n || test.above_p95 > n) fail(`${where}.test: a count above n`);
    const inBand = (count, [low, high]) => low <= count && count <= high;
    if (test.passed !== (inBand(test.below_p50, test.band_below) && inBand(test.above_p95, test.band_above))) {
      fail(`${where}.test: passed disagrees with its own acceptance bands`);
    }
    if (match.withinTolerance !== test.passed) fail(`${where}: withinTolerance disagrees with the binomial test`);
  }
  const passed = match.withinTolerance;
  if (passed === codes.includes("distribution_mismatch")) {
    fail(`${where}: the check ${passed ? "passed" : "failed"} but distribution_mismatch is ${passed ? "" : "not "}a problem`);
  }
  const ratio = (value) => (value === null ? null : Math.round(value * 1000) / 1000);
  return { test: test === undefined ? "ratio_tolerance" : "binomial", p50_ratio: ratio(match.p50Ratio), p95_ratio: ratio(match.p95Ratio), passed };
}


const PROFILE_KEYS = ["sessions", "subscribers", "pollers", "turn_gap_s", "switch_interval_s", "poll_interval_s", "mode", "distribution_tolerance"];
const PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sessions", "subscribers", "pollers"],
  properties: Object.fromEntries(PROFILE_KEYS.map((k) => [k, { type: k === "mode" ? ["string", "null"] : ["number", "null"] }])),
};

const HOST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["host", "harness"],
  properties: {
    host: {
      type: "object",
      additionalProperties: false,
      required: ["machine", "provisioning", "runtime_node", "cpu_model", "cores", "memory_gib", "kernel", "os"],
      properties: Object.fromEntries(["machine", "provisioning", "runtime_node", "cpu_model", "cores", "memory_gib", "kernel", "os"].map((k) => [k, { type: ["string", "number", "null"] }])),
    },
    harness: {
      type: "object",
      additionalProperties: false,
      required: ["version"],
      properties: Object.fromEntries(["version", "sha", "files_sha256", "preload_sha256"].map((k) => [k, { type: ["string", "null"] }])),
    },
  },
};

const normaliseOs = (os) => {
  const debian = /^Debian(?: GNU\/Linux)? (\d{1,2})\b/.exec(String(os));
  if (debian) return `Debian ${debian[1]}`;
  const mac = /^macOS (\d{2}(?:\.\d{1,2}){0,2})\b/.exec(String(os));
  return mac ? `macOS ${mac[1]}` : os;
};

/** The release date: the spec's, or the nightly tag's YYYYMMDD. Forks need the spec's date and base. */
function releaseDate(spec) {
  if (spec.release.date !== undefined) return spec.release.date;
  const m = /-nightly\.(\d{4})(\d{2})(\d{2})\.\d+$/.exec(spec.release.tag);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : fail("spec: release.date missing and the tag carries no nightly date");
}

function checkSpec(spec) {
  if (spec?.schema !== "t3cp/record-spec/1") fail("spec: schema is not t3cp/record-spec/1");
  if (typeof spec.release?.tag !== "string" || !TAG.test(spec.release.tag)) fail("spec: release.tag does not match the tag regex");
  if (!["nightly", "fork", "base"].includes(spec.kind)) fail("spec: kind");
  const headProblem = forkHeadProblem(spec);
  if (headProblem) fail(`spec: ${headProblem}`);
  if (spec.kind === "fork" && (spec.base === undefined || spec.base === null || spec.release.date === undefined)) fail("spec: fork_base_missing (a fork record needs release.date and base)");
  if (spec.kind === "base") {
    if (spec.release.date === undefined) fail("spec: a base record needs release.date (the merge-base commit's date)");
    if (!String(spec.record_id).startsWith(`${String(spec.release.sha).slice(0, 12)}.`)) fail("spec: a base record id starts with the first 12 hex of its merge-base SHA");
  }
}

function featureEra(eras, date) {
  return {
    has: eras.filter((e) => date >= e.from).map((e) => e.id),
    missing: eras.filter((e) => date < e.from).map((e) => e.id),
  };
}

const sizeOf = (file) => {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > 0 ? st.size : null;
  } catch {
    return null;
  }
};

/** The identity block shared by every attempt and extras file of one record. */
/**
 * The identity block of an attempt: release, platform, harness, fixture, workload and the feature eras the release has
 * (`eras`: the ladder's by default, so a scenario-only era never reaches a ladder record).
 */
function identityOf(spec, meta, result, catalogue, eras = ladderFeatureEras(catalogue)) {
  checkSpec(spec);
  const date = releaseDate(spec);
  const platformId = /\.(linux-x64|darwin-arm64)\.(nightly|fork|base)$/.exec(spec.record_id)?.[1] ?? fail("spec: record_id has no platform");
  const id = result?.identity ?? {};
  if (id.server_sha && id.server_sha !== spec.release.sha) fail("identity: release_sha_mismatch (the binary's commit differs from the spec)");
  const h = meta.harness;
  const harnessSha = h.sha ?? id.harness_sha ?? null;
  // Each harness hash has one source, run.ts's result.json, so a reader recomputes it from the public tag by run.ts's
  // own method; the runner's copies in attempt-meta.json are never a fallback (its files hash must agree, its preload
  // hash, another method, is not read).
  const filesSha = id.harness_files_sha256 ?? null;
  if (h.sha && id.harness_sha && h.sha !== id.harness_sha) fail("identity: harness sha differs between attempt-meta.json and result.json");
  if (h.files_sha256 && id.harness_files_sha256 && h.files_sha256 !== id.harness_files_sha256) fail("identity: harness files_sha256 differs between attempt-meta.json and result.json");
  const host = meta.host;
  return {
    record_id: spec.record_id,
    kind: spec.kind,
    release: {
      tag: spec.release.tag,
      sha: spec.release.sha,
      date,
      version: spec.release.version,
      archive: spec.release.archive_name ? { name: spec.release.archive_name, sha256: spec.release.archive_sha256, bytes: sizeOf(spec.release.archive_path) } : null,
      binary_sha256: id.server_binary_sha256 ?? null,
      build: buildIdentity(spec, meta),
    },
    base: spec.kind === "fork" ? { tag: spec.base.tag, date: spec.base.date, sha: spec.base.sha } : null,
    // The nightly fork-head record's night (checkSpec has checked the coupling).
    ...(spec.paired_nightly ? { paired_nightly: { tag: spec.paired_nightly.tag, date: spec.paired_nightly.date } } : {}),
    platform: {
      id: platformId,
      machine: host.machine,
      cpu_model: host.cpu_model,
      cores: host.cores,
      memory_gib: host.memory_gib,
      os: normaliseOs(host.os),
      kernel: host.kernel,
      provisioning: host.provisioning,
      runtime_node: typeof host.runtime_node === "string" ? host.runtime_node.replace(/^v/, "") : host.runtime_node,
    },
    harness: {
      version: h.version,
      sha: harnessSha,
      files_sha256: filesSha,
      driver_sha256: result?.knobs?.workload?.driver_sha256 ?? null,
      fakes_sha256: result?.knobs?.workload?.fakes_sha256 ?? null,
      preload_sha256: id.preload?.sha256 ?? null,
    },
    fixture:
      spec.fixture.id === "none"
        ? { id: "none", sha256: null, bytes: null, migration: null, recipe_sha256: null }
        : { id: spec.fixture.id, sha256: spec.fixture.sha256, bytes: sizeOf(spec.fixture.path), migration: spec.fixture.migration, recipe_sha256: null },
    workload: {
      profile: spec.suite.profile ?? DEFAULT_PROFILE,
      suite: spec.suite.id,
      warmup_s: spec.suite.warmup_s,
      window_s: spec.suite.window_s,
      levels: spec.suite.levels,
      empty_cell: spec.suite.empty_cell,
      attempts_per_level: spec.suite.attempts_per_level,
      seed: spec.seed,
      now: spec.now,
    },
    era: featureEra(eras, spec.kind === "fork" ? spec.base.date : date),
  };
}

// ---------------------------------------------------------------------------------------------------------
// one attempt

const isoMs = (text) => (typeof text === "string" ? Date.parse(text) : Number.NaN);

/**
 * Statistics from one source must be ordered: p50 <= p95 <= p99 <= max (and the same for lock waits and the 1 s
 * busy series). An entry with no samples is skipped. Different sources (the server's gauge maximum against the
 * preload histogram's percentiles) are never compared.
 */
function checkOrdered(src, loopWindow) {
  const ordered = (entry, keys, what) => {
    if (entry === null || typeof entry !== "object") return;
    if (typeof entry.count === "number" && entry.count === 0) return;
    const values = keys.map((k) => entry[k]).filter((v) => typeof v === "number");
    for (let i = 1; i < values.length; i++) if (values[i] < values[i - 1]) fail(`${what}: statistics out of order (${keys.join(" <= ")})`);
  };
  const LAT = ["p50_ms", "p95_ms", "p99_ms", "max_ms"];
  for (const [k, v] of Object.entries(src?.driver?.calls ?? {})) ordered(v, LAT, `calls["${k}"]`);
  for (const [k, v] of Object.entries(src?.spans ?? {})) ordered(v, LAT, `spans["${k}"]`);
  for (const [k, v] of Object.entries(src?.sql ?? {})) {
    ordered(v, LAT, `sql["${k}"]`);
    if (typeof v?.lock_wait_n !== "number" || v.lock_wait_n > 0) ordered({ ...v, count: undefined }, ["p50_lock_wait_ms", "p95_lock_wait_ms", "max_lock_wait_ms"], `sql["${k}"] lock wait`);
  }
  ordered(src?.cpu?.main_busy_1s, ["p50_pct", "p95_pct", "max_pct"], "cpu.main_busy_1s");
  ordered(loopWindow?.delay, ["p50_ms", "p90_ms", "p99_ms", "max_ms"], "loop-window.json delay");
  ordered(src?.loop, ["eld_p50_ms", "eld_p90_ms", "eld_p99_ms", "eld_p999_ms", "eld_max_ms"], "metrics.loop");
}

/** Builds the attempt.json object from a raw attempt directory. Throws ExportError on any refusal. */
/**
 * The runner's host guard (percent of the whole host): busy max over every try, the final try's steal and iowait max
 * and its foreign-load mean.
 */
function attemptGuard(meta) {
  const guardNum = (what, value) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`attempt-meta.json: ${what} is not a finite number`);
    return roundValue(value);
  };
  const guardValues = meta.host_guard ?? {};
  return {
    busy_pct_max: guardNum("host_guard_max_busy_pct", meta.host_guard_max_busy_pct ?? guardValues.busy_pct_max),
    steal_pct_max: guardNum("host_guard.steal_pct_max", guardValues.steal_pct_max),
    iowait_pct_max: guardNum("host_guard.iowait_pct_max", guardValues.iowait_pct_max),
    foreign_pct_mean: guardNum("host_guard.foreign_pct_mean", guardValues.foreign_pct_mean),
  };
}
const startedAtOf = (meta) => (typeof meta.started_at === "string" ? meta.started_at.replace(/\.\d+Z$/, "Z") : null);

/** <label>.result.json: run.ts's result, its shape checked and its identity block scanned. */
function readResult(reader, meta, context) {
  const label = meta.label ?? "release";
  const result = reader.json(`${label}.result.json`, { required: true });
  if (result.schema !== "t3-server-bench/result/1") fail(`${label}.result.json: schema is not t3-server-bench/result/1`);
  const resultErrors = validate(RESULT_SHAPE, result);
  if (resultErrors.length > 0) fail(`${label}.result.json: ${resultErrors.slice(0, 8).map((e) => `${e.path} ${e.message}`).join("; ")}`);
  // The identity block names what ran; a private path or name in it refuses the attempt.
  scanOrFail(`${label}.result.json identity`, result.identity ?? {}, context, { valuesOnly: true });

  return { label, result };
}

/**
 * The attempt's verdict: the chosen run (the last valid, else the last), the harness's classification re-checked, the
 * host guard, maintenance in the window, the problem codes and whether the attempt is valid or saturated.
 */
function judgeRun(reader, meta, result, label, { maintenanceExpected = false } = {}) {
  const details = Array.isArray(result.run_details) ? result.run_details : [];
  const validRun = [...details].reverse().find((d) => d?.valid === true);
  const chosen = validRun ?? details.at(-1) ?? null;
  const k = Number.isInteger(chosen?.attempt) ? chosen.attempt : 1;
  const runRel = path.join("work", "runs", label, `attempt-${k}`);
  const run = reader.json(path.join(runRel, "run.json"), { required: true });
  const runErrors = validate(RUN_SHAPE, run);
  if (runErrors.length > 0) fail(`run.json: ${runErrors.slice(0, 8).map((e) => `${e.path} ${e.message}`).join("; ")}`);
  // The runner's host guard fails closed: no guard (null, empty or without samples) or contaminated null means it could
  // not judge the try, published as contaminated null, never a clean false. A boolean verdict agrees with its reasons.
  const reasons = meta.contamination_reasons;
  const guard = meta.host_guard;
  // The runner's own rule for a guard that cannot judge: no method, no sample in the window, or no foreign-CPU or
  // steal figure.
  const guardMissing =
    guard === null || Object.keys(guard).length === 0 || guard.method === "none" || guard.samples === 0 || guard.foreign_pct_mean == null || guard.steal_pct_mean == null;
  if (meta.contaminated === null && reasons.length > 0) fail("attempt-meta.json: contaminated is null but contamination_reasons are given");
  if (typeof meta.contaminated === "boolean" && meta.contaminated !== reasons.length > 0) fail(`attempt-meta.json: contaminated is ${meta.contaminated} but contamination_reasons ${reasons.length > 0 ? "are given" : "are empty"}`);
  if (meta.contaminated === true && guardMissing) fail("attempt-meta.json: contaminated with no host guard to say so");
  const guardUnavailable = meta.contaminated === null || guardMissing;
  const contaminated = meta.contaminated === true;
  // The harness's classification, re-checked (never trusted): kinds, valid, saturated, the ELU and the served agents.
  const saturationCodes = checkHarnessVerdict(run, result.sampling, meta.profile.sessions);
  // Problem codes: the harness's fixed codes pass through; any other code becomes other_problem (its text is never
  // copied) and makes the attempt invalid.
  const codes = run.problems.map((p) => p.code);
  const problems = [];
  let unknownProblem = false;
  for (const code of codes) {
    if (PROBLEMS.includes(code) && code !== "other_problem") problems.push(code);
    else {
      problems.push("other_problem");
      unknownProblem = true;
    }
  }
  // Maintenance passes (event-store compaction or prune) inside the window distort every metric: a count above 0
  // invalidates the attempt. 0 and the runner's two codes are published as they are.
  const maintenance = meta.maintenance_in_window;
  // An unseeded scenario cell measures the compaction itself: its passes in the window are expected, never a problem.
  const maintenanceHit = !maintenanceExpected && typeof maintenance === "number" && maintenance > 0;
  if (maintenanceHit) problems.push("maintenance_in_window");
  const served = run.sessions_served;
  const total = run.sessions_total;
  const harnessValid = result.runs.valid >= 1 && validRun !== undefined && run.valid === true;
  const runValid = harnessValid && !unknownProblem && !maintenanceHit;
  // Saturated (the ladder decision): the server could not keep up, on a clean host, with no defect; the harness's
  // verdict as re-checked above.
  const saturated = run.saturated && runValid;
  const saturatedBy = saturated ? saturationCodes : [];
  // The runner writes null on a run it measured when it could not verify the window (a stop that may have lost
  // spans, or a missing trace): fail closed.
  const maintenanceUnverified = maintenance === null && (runValid || saturated);
  if (maintenanceUnverified) problems.push("maintenance_unverified");
  const valid = (runValid || saturated) && !contaminated && !maintenanceUnverified && !guardUnavailable;
  if (contaminated) problems.push("contaminated");
  if (guardUnavailable) problems.push("host_guard_unavailable");
  const distribution = distributionOf(run, codes);
  if (!runValid && !saturated && problems.length === 0) problems.push("attempt_invalid");
  return { run, runRel, k, codes, problems, runValid, saturated, saturatedBy, valid, contaminated, guardUnavailable, maintenance, served, total, distribution };
}

/**
 * attempt-meta.json, checked against the spec and the directory name (<cell>-<n>): its schema, record, release, suite,
 * seed and now, the host and harness facts, and the profile's keys.
 */
function readMeta(reader, spec, cell, n) {
  const meta = reader.json("attempt-meta.json", { required: true });
  const metaErrors = validate(META_SCHEMA, meta);
  if (metaErrors.length > 0) fail(`attempt-meta.json: ${metaErrors.slice(0, 8).map((e) => `${e.path} ${e.message}`).join("; ")}`);
  if (meta.record_id !== spec.record_id) fail("attempt-meta.json: record_id differs from the spec");
  if (meta.release && (meta.release.tag !== spec.release.tag || meta.release.sha !== spec.release.sha || meta.release.version !== spec.release.version)) {
    fail("attempt-meta.json: release differs from the spec");
  }
  if (meta.suite && meta.suite.id !== spec.suite.id) fail("attempt-meta.json: suite differs from the spec");
  if (meta.seed !== undefined && meta.seed !== spec.seed) fail("attempt-meta.json: seed differs from the spec");
  if (meta.now !== undefined && meta.now !== spec.now) fail("attempt-meta.json: now differs from the spec");
  if (String(meta.cell) !== cell || meta.n !== n) fail("attempt-meta.json: cell or n differs from the directory name");
  const facts = { host: meta.host, harness: meta.harness };
  const factErrors = validate(HOST_SCHEMA, facts);
  if (factErrors.length > 0) fail(`attempt-meta.json: ${factErrors.map((e) => `${e.path.replace(/^\$\./, "")} ${e.message}`).join("; ")}`);
  return meta;
}

const checkProfile = (meta) => {
  const profileErrors = validate(PROFILE_SCHEMA, meta.profile);
  if (profileErrors.length > 0) fail(`attempt-meta.json: ${profileErrors.map((e) => `profile${e.path.slice(1)} ${e.message}`).join("; ")}`);
};

export function exportAttempt(rawDir, spec, options = {}) {
  if (spec?.suite?.scenario !== undefined) return exportScenarioAttempt(rawDir, spec, options);
  const { privatePatterns = [], catalogue = loadCatalogue() } = options;
  const reader = new Reader(rawDir);
  const context = { privatePatterns, secrets: credsSecrets(reader.root) };
  const name = path.basename(reader.root);
  const dirMatch = /^(1|50|100|150|200|250|1e)-([1-9])$/.exec(name) ?? fail("raw directory name is not <cell>-<n>");
  const cell = dirMatch[1];
  const n = Number(dirMatch[2]);

  const meta = readMeta(reader, spec, cell, n);
  if (meta.scenario !== undefined || meta.maintenance_expected !== undefined) fail("attempt-meta.json: a ladder attempt names no scenario");
  if (cell !== "1e" && !spec.suite.levels.map(String).includes(cell)) fail("attempt-meta.json: cell is not a level of the suite");
  checkProfile(meta);
  const profile = {
    ...Object.fromEntries(PROFILE_KEYS.filter((k) => meta.profile[k] !== undefined).map((k) => [k, meta.profile[k]])),
    fixture: meta.fixture === "none" || cell === "1e" ? "none" : "era",
  };
  if (cell === "1e" && spec.suite.empty_cell !== true) fail("attempt-meta.json: the suite has no empty-database cell");

  const { result } = readResult(reader, meta, context);
  const identity = identityOf(spec, meta, result, catalogue);
  const { run, runRel, codes, problems, runValid, saturated, saturatedBy, valid, contaminated, guardUnavailable, maintenance, served, total, distribution } = judgeRun(reader, meta, result, meta.label ?? "release");

  const ids = levelMetricIds(catalogue);
  const metrics = Object.fromEntries(ids.map((id) => [id, null]));
  if (valid) {
    const startMs = isoMs(run.window?.start);
    const endMs = isoMs(run.window?.end);
    const window = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? { startMs, endMs } : null;
    const driverRaw = reader.json(path.join(runRel, "driver", "driver.json"));
    const exit = reader.json(path.join(runRel, "server-exit.json"));
    const teardown = isoMs(driverRaw?.timeline?.teardown);
    // A forced stop (SIGKILL after the grace) times the grace, not the server's shutdown; a server gone before the
    // stop had no shutdown to time. Either leaves shutdown_s n/a.
    const stop = run.server?.stop ?? null;
    const timedStop = stop === null || (!stop.forced && !stop.exited_before_stop);
    const shutdownMs = timedStop && typeof exit?.gone_ms === "number" && Number.isFinite(teardown) ? exit.gone_ms - teardown : null;
    const src = {
      // result.json's aggregate of the valid run; a saturated run is not in it, so its own run.json statistics.
      metrics: (runValid ? result.metrics : run.metrics) ?? {},
      sessionsServed: served,
      driverRaw,
      window,
      windowS: window ? (window.endMs - window.startMs) / 1000 : null,
      proc: (() => {
        try {
          return procWindow(reader.ndjson(path.join(runRel, "proc-1hz.ndjson")), window);
        } catch (error) {
          if (error instanceof MappingError) fail(error.message);
          throw error;
        }
      })(),
      loopWindow: reader.json(path.join(runRel, "loop-window.json")),
      loopLines: reader.ndjson(path.join(runRel, "loop-1hz.ndjson")),
      serverLog: reader.text(path.join(runRel, "server.log")),
      shutdownS: shutdownMs === null || shutdownMs < 0 ? null : roundValue(shutdownMs / 1000),
      kind: spec.kind,
    };
    checkOrdered(src.metrics, src.loopWindow);
    const preloadMissing = codes.includes("preload_not_loaded");
    const preloadIds = new Set(catalogue.metrics.filter((m) => m.upstream === "pre").map((m) => m.id));
    for (const id of ids) {
      const extract = MAPPING[id] ?? fail(`mapping: no extractor for catalogue metric ${id}`);
      let value;
      try {
        value = extract(src);
      } catch (error) {
        if (error instanceof MappingError) fail(`metric ${id}: ${error.message}`);
        throw error;
      }
      if (value === null || value === undefined) continue;
      // A preload that did not load leaves its metrics n/a, whatever older preload files the directory holds.
      if (preloadMissing && preloadIds.has(id)) continue;
      if (typeof value !== "number") fail(`metric ${id}: not a number`);
      if (!Number.isFinite(value)) fail(`metric ${id}: not a finite number`);
      if (value < 0) fail(`metric ${id}: negative, where its unit cannot be`);
      metrics[id] = value === 0 ? 0 : value; // never a negative zero
    }
  }
  for (const id of Object.keys(MAPPING)) if (!ids.includes(id)) fail(`mapping: ${id} is not a daily per-level catalogue metric`);
  // Counts taken by start time are not measured on a saturated attempt: a turn counts when it starts in the window and
  // ends by its close, and at saturation turns outlast the window, so the count would read near zero. Agents served is
  // the measure there.
  const metricReasons = {};
  // The commit lane in its era with no flush ending in the window (an idle level): null, with its public reason.
  const lane = catalogue.metrics.find((m) => m.id === "commit_lane_busy_share");
  const laneDate = spec.kind === "fork" ? spec.base.date : releaseDate(spec);
  if (valid && lane && metrics.commit_lane_busy_share === null && laneDate >= lane.era_start) metricReasons.commit_lane_busy_share = "no_flush_in_window";
  if (valid && saturated) {
    for (const id of NOT_MEASURED_SATURATED) {
      metrics[id] = null;
      metricReasons[id] = "not_measured_saturated";
    }
  }

  const hostGuard = attemptGuard(meta);
  const startedAt = startedAtOf(meta);
  const attempt = {
    schema: "t3cp/attempt/1",
    ...identity,
    cell,
    n,
    profile,
    host_guard: hostGuard,
    attempt: {
      valid,
      problems: [...new Set(problems)],
      started_at: startedAt,
      cycle_s: typeof meta.cycle_s === "number" ? roundValue(meta.cycle_s) : null,
      contaminated: guardUnavailable ? null : contaminated,
      maintenance_in_window: maintenance,
      saturated: valid && saturated,
      saturated_by: valid && saturated ? saturatedBy.filter((c) => PROBLEMS.includes(c)) : [],
      agents_total: total ?? (Number.isInteger(meta.profile.sessions) ? meta.profile.sessions : null),
      distribution,
      metric_reasons: metricReasons,
      // Whether the harness killed the server after the stop grace (the aggregator counts these per cell).
      stop_forced: typeof run.server?.stop?.forced === "boolean" ? run.server.stop.forced : null,
    },
    metrics,
    pipeline: { exported_at: now(), exporter_version: EXPORTER_VERSION, exporter_files_sha256: exporterFilesSha256(), ...runnerIdentity(meta) },
  };
  schemaOrFail("attempt.json", "attempt-1.json", attempt);
  scanOrFail("attempt.json", attempt, context);
  return attempt;
}

// ---------------------------------------------------------------------------------------------------------
// one attempt of a scenario cell

/** Codes a scenario post step writes when it could not measure: internal, never published; the attempt is invalid. */
export const INTERNAL_SCENARIO_REASONS = ["no_run_window", "no_loop_samples", "db_unreadable", "mark_unreadable"];
/** Where each scenario metric comes from: the post step's scenario.json, or run.ts's getThreadShell span. */
const SCENARIO_SOURCES = {
  turn_start_history_gap_ms: "post",
  turn_start_long_thread_ms: "post",
  event_log_unpruned_days: "post",
  get_thread_shell_long_thread_ms: "shell",
};
/** A feature era's public reason, for a release that predates it. */
const ERA_REASONS = { turn_start_span: "no_turn_start_span", thread_shell_span: "no_shell_span", event_prune: "no_event_prune" };
/** Fewer shell reads than this give no p95 (shell_reads_missing). */
const SHELL_MIN_READS = 20;
const SCENARIO_RAW = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "scenario", "post", "window", "metrics"],
  properties: {
    schema: { const: "t3cp/scenario-raw/1" },
    scenario: { type: "object", additionalProperties: false, required: ["id", "version"], properties: { id: { type: "string" }, version: { type: "integer" } } },
    post: { type: "string" },
    window: { type: "object" },
    metrics: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["value", "reason"],
        properties: { value: { type: ["number", "null"] }, reason: { type: ["string", "null"], pattern: "^[a-z][a-z0-9_]{0,63}$" } },
      },
    },
    detail: { type: "object" },
  },
};
/** The row of scenarios.json the spec names: active, and not the ladder. */
function scenarioRowOf(spec, scenarios) {
  const sc = spec.suite.scenario;
  if (typeof sc?.id !== "string" || !Number.isInteger(sc?.version) || spec.suite.id !== `${sc.id}@${sc.version}`) fail("spec: suite id is not the scenario's id@version");
  const row = scenarios?.rows?.find((r) => r.id === sc.id && r.version === sc.version) ?? fail(`spec: scenario ${spec.suite.id} is not in scenarios.json`);
  if (row.status !== "active") fail(`spec: scenario ${spec.suite.id} is retired`);
  if (row.suite !== spec.suite.id) fail(`spec: scenario ${spec.suite.id} is not a scenario row (the ladder publishes as its own suite)`);
  if ((spec.fixture?.id ?? "none") !== row.fixture) fail(`spec: fixture ${spec.fixture?.id} is not the row's (${row.fixture})`);
  return row;
}

/**
 * The driver's options as t3cp-harness 2.0.x's driver parses them (tools/server-bench/driver/options.ts: node:util
 * parseArgs, --flag value or --flag=value, the last of a repeated flag) and its defaults for the ones a cell sets.
 */
const DRIVER_STRING_OPTIONS = [
  "url", "out", "token-file", "mode", "sessions", "subscribers", "pollers", "projects", "warmup", "window", "seed", "provider", "model",
  "runtime-mode", "poll-rate", "poll-mix", "session-mcp-rate", "session-mcp-credentials", "switch-interval", "turn-gap", "message-chars",
  "read-pool", "fresh-subscriber-threads", "distribution-tolerance", "workspace-dir", "call-timeout", "grace", "sessions-per-socket",
  "max-driver-elu", "max-driver-delay", "stall-timeout", "setup-concurrency", "max-error-rate", "taskset", "server-pid",
];
const DRIVER_DEFAULTS = { mode: "history", sessions: "25", pollers: "10", "poll-rate": "1", "switch-interval": "30s", "turn-gap": "1s" };

/**
 * The driver arguments run.ts recorded (knobs.workload.driver_args: its own count flags, then each --driver-arg), read as
 * the driver reads them, must run the cell: its sessions, subscribers, pollers, mode and turn gap, and its switch
 * interval and poll rate (the driver's defaults where the cell names none).
 */
function checkDriverArgs(args, c, where) {
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) fail(`${where}: run.ts recorded no driver arguments`);
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      strict: false,
      allowPositionals: true,
      allowNegative: true,
      options: { ...Object.fromEntries(DRIVER_STRING_OPTIONS.map((name) => [name, { type: "string" }])), "stop-sessions": { type: "boolean" }, help: { type: "boolean" } },
    }));
  } catch {
    fail(`${where}: the driver arguments do not parse`);
  }
  const effective = (flag) => (typeof values[flag] === "string" ? values[flag] : DRIVER_DEFAULTS[flag]);
  const bad = (flag) => fail(`${where}: the driver arguments (--${flag}) are not the row's cell ${c.name}'s`);
  for (const [flag, want] of [["sessions", c.sessions], ["subscribers", c.subscribers], ["pollers", c.pollers]]) {
    const v = effective(flag);
    if (typeof v !== "string" || !/^\d+$/.test(v) || Number(v) !== want) bad(flag);
  }
  if (effective("mode") !== c.mode) bad("mode");
  const sameDuration = (flag, want) => {
    try {
      return durationS(effective(flag)) === durationS(want);
    } catch {
      return false;
    }
  };
  if (!sameDuration("turn-gap", c.turn_gap)) bad("turn-gap");
  if (!sameDuration("switch-interval", c.switch_interval ?? DRIVER_DEFAULTS["switch-interval"])) bad("switch-interval");
  if (Number(effective("poll-rate")) !== Number(c.poll_rate ?? DRIVER_DEFAULTS["poll-rate"])) bad("poll-rate");
}

const LOAD_KEYS = ["sessions", "subscribers", "pollers", "mode", "turn_gap_s", "switch_interval_s", "poll_interval_s"];

/**
 * One attempt of a scenario cell (t3cp/scenario-attempt/1): the row of scenarios.json decides the cell, its load and
 * its metrics; the verdict is the ladder's (the harness's classification re-checked, the host guard, maintenance),
 * except that an unseeded cell expects maintenance passes in its window. The post step's metrics come from
 * scenario.json and the shell read from run.ts's getThreadShell span. A public reason is published beside its null;
 * an internal one (the step could not measure) makes the attempt invalid (scenario_unmeasured).
 */
export function exportScenarioAttempt(rawDir, spec, { privatePatterns = [], catalogue = loadCatalogue(), scenarios = loadScenarios() } = {}) {
  const row = scenarioRowOf(spec, scenarios);
  const reader = new Reader(rawDir);
  const context = { privatePatterns, secrets: credsSecrets(reader.root) };
  const dirMatch = /^([a-z0-9][a-z0-9-]{0,30})-([1-5])$/.exec(path.basename(reader.root)) ?? fail("raw directory name is not <cell>-<n>");
  const cell = dirMatch[1];
  const n = Number(dirMatch[2]);
  const c = row.cells.find((x) => x.name === cell) ?? fail(`attempt-meta.json: the row has no cell ${cell}`);
  if (n > row.attempts) fail(`raw directory ${cell}-${n}: the row runs ${row.attempts} attempts per cell`);

  const meta = readMeta(reader, spec, cell, n);
  if (meta.scenario?.id !== row.id || meta.scenario?.version !== row.version) fail("attempt-meta.json: scenario differs from the spec");
  if (meta.harness?.version !== row.harness) fail(`attempt-meta.json: harness ${meta.harness?.version} is not the row's (${row.harness})`);
  const unseeded = c.seed_compacted_at === false;
  if ((meta.maintenance_expected === true) !== unseeded) fail("attempt-meta.json: maintenance_expected differs from the row's cell (only an unseeded cell expects maintenance)");
  checkProfile(meta);
  const load = scenarioLoad(row, c);
  for (const k of LOAD_KEYS) {
    if ((meta.profile[k] ?? null) !== load[k]) fail(`attempt-meta.json: the load (${k}) differs from the row's cell ${cell}`);
  }
  if (meta.level !== undefined && meta.level !== c.sessions) fail(`attempt-meta.json: level differs from the row's cell ${cell} sessions`);
  if (!meta.suite || typeof meta.suite.warmup_s !== "number" || typeof meta.suite.window_s !== "number") fail("attempt-meta.json: a scenario cell names its suite, warm-up and window");
  if (meta.suite.warmup_s !== c.warmup_s || meta.suite.window_s !== c.window_s) fail(`attempt-meta.json: warm-up or window differs from the row's cell ${cell}`);
  const fixtureId = load.fixture === "none" ? "none" : row.fixture;
  if (meta.fixture !== undefined && meta.fixture !== fixtureId) fail(`attempt-meta.json: fixture differs from the row's cell ${cell}`);

  const label = meta.label ?? "release";
  const { result } = readResult(reader, meta, context);
  // What run.ts ran: its knobs name the warm-up and window, which must be the cell's.
  const knobs = result.knobs?.workload;
  if (knobs?.warmup_s !== c.warmup_s || knobs?.window_s !== c.window_s) fail(`${label}.result.json: run.ts ran another warm-up or window than the row's cell ${cell}`);
  checkDriverArgs(knobs?.driver_args, c, `${label}.result.json`);
  if ((result.knobs?.run?.seed_compacted_at ?? false) !== c.seed_compacted_at) fail(`${label}.result.json: run.ts's compaction seeding is not the row's cell ${cell}'s`);
  // What run.ts started from: a fixture file exactly where the cell starts from the row's fixture.
  const observed = result.identity?.fixture ?? null;
  const onFile = observed !== null && observed.kind === "file";
  if (onFile !== (load.fixture === "era")) fail(`${label}.result.json: run.ts ran ${onFile ? "on a fixture file" : "without a fixture file"}, which the row's cell ${cell} ${load.fixture === "era" ? "starts from" : "has none of"}`);
  const base = identityOf(spec, meta, result, catalogue, catalogue.feature_eras);
  const identity = {
    ...base,
    fixture: base.fixture,
    workload: { suite: row.suite, scenario: { id: row.id, version: row.version }, attempts_per_cell: row.attempts, seed: spec.seed, now: spec.now },
  };
  const j = judgeRun(reader, meta, result, label, { maintenanceExpected: unseeded });
  const problems = [...j.problems];
  // A saturated try measured nothing a scenario publishes: only a run the harness itself calls valid counts.
  let valid = j.valid && j.runValid;
  // The run the exporter chose ran the cell: the driver's mode and sessions, and fixture threads exactly where the cell
  // starts from a fixture in history or mixed mode. Contradicting evidence is refused, never published as the row.
  if (j.runValid) {
    const dw = j.run.driver?.workload ?? fail("run.json: the driver's workload is missing");
    if (dw.mode !== c.mode || dw.sessions !== c.sessions) fail(`run.json: the driver ran mode ${dw.mode} with ${dw.sessions} sessions, not the row's cell ${cell}`);
    const onFixture = Number.isInteger(dw.fixture_thread_sessions) && dw.fixture_thread_sessions > 0;
    const needsFixture = load.fixture === "era" && c.mode !== "fresh";
    if (onFixture !== needsFixture) fail(`run.json: the driver ${onFixture ? "used" : "used no"} fixture threads, which the row's cell ${cell} ${needsFixture ? "runs on" : "has none of"}`);
  }
  // The measured window: as long as the cell's (5 % slack), or the attempt measured something else.
  const runStart = isoMs(j.run.window?.start);
  const runEnd = isoMs(j.run.window?.end);
  if (valid && !(Number.isFinite(runStart) && Number.isFinite(runEnd) && (runEnd - runStart) / 1000 >= c.window_s * 0.95)) {
    valid = false;
    problems.push("window_too_short");
  }
  if (!valid && problems.length === 0) problems.push("attempt_invalid");

  const date = spec.kind === "fork" ? spec.base.date : releaseDate(spec);
  const byId = new Map(catalogue.metrics.map((m) => [m.id, m]));
  const metrics = Object.fromEntries(row.metrics.map((id) => [id, null]));
  const reasons = {};
  let unmeasured = false;
  if (valid) {
    const sources = row.metrics.map((id) => SCENARIO_SOURCES[id] ?? fail(`mapping: no source for scenario metric ${id}`));
    const raw = sources.includes("post") ? reader.json("scenario.json") : null;
    if (raw !== null) {
      const rawErrors = validate(SCENARIO_RAW, raw);
      if (rawErrors.length > 0) fail(`scenario.json: ${rawErrors.slice(0, 8).map((e) => `${e.path} ${e.message}`).join("; ")}`);
      if (raw.scenario.id !== row.id || raw.scenario.version !== row.version || raw.post !== c.post) fail("scenario.json: scenario or post step differs from the row's cell");
      // The step measured the run the exporter chose: valid, that run, that window (1 s slack); else nothing is known.
      const w = raw.window;
      const near = (a, b) => typeof a === "number" && Number.isFinite(a) && Math.abs(a - b) <= 1000;
      if (w.valid !== true || w.run !== j.k || !near(w.start_ms, runStart) || !near(w.end_ms, runEnd)) unmeasured = true;
      for (const id of Object.keys(raw.metrics)) {
        if (!row.metrics.includes(id)) fail(`scenario.json: ${id} is not one of the row's metrics`);
        if (SCENARIO_SOURCES[id] !== "post") fail(`scenario.json: ${id} is not a post-step metric (its value comes from another source)`);
      }
    }
    if (sources.includes("post") && raw === null) unmeasured = true;
    const incomplete = raw !== null && Object.values(raw.metrics).some((e) => e.reason === "turn_start_incomplete");
    for (const id of row.metrics) {
      if (unmeasured) break;
      const m = byId.get(id) ?? fail(`scenarios.json: ${id} is not a catalogue metric`);
      const eraReason = m.era !== null && date < m.era_start ? (ERA_REASONS[m.era] ?? fail(`mapping: no public reason for the era ${m.era}`)) : null;
      let value = null;
      let reason = null;
      if (SCENARIO_SOURCES[id] === "post") {
        const entry = raw.metrics[id] ?? fail(`scenario.json: ${id} is missing`);
        // A value, or null with a public reason: anything else (an internal or unknown code, a value with a reason,
        // null with none) is no measurement.
        const publicReason = entry.reason !== null && SCENARIO_REASONS.includes(entry.reason);
        if (entry.value === null ? !publicReason : entry.reason !== null) {
          unmeasured = true;
          continue;
        }
        if (entry.value === null) reason = entry.reason;
        else value = entry.value;
      } else if (incomplete) {
        reason = "turn_start_incomplete";
      } else {
        const tree = (j.runValid ? result.metrics : j.run.metrics) ?? {};
        const span = tree.spans?.["OrchestratorV2.getThreadShell"];
        if (span === undefined || span === null || !Number.isInteger(span.count) || span.count < SHELL_MIN_READS) reason = "shell_reads_missing";
        else value = span.p95_ms;
      }
      // A release that predates the metric's feature era cannot give it: the era's reason, whatever the step read.
      if (eraReason !== null) {
        value = null;
        reason = eraReason;
      }
      if (value !== null) {
        if (typeof value !== "number" || !Number.isFinite(value)) fail(`metric ${id}: not a finite number`);
        if (value < 0) fail(`metric ${id}: negative, where its unit cannot be`);
        metrics[id] = value === 0 ? 0 : roundValue(value);
      } else reasons[id] = reason;
    }
  }
  if (unmeasured) {
    valid = false;
    problems.push("scenario_unmeasured");
    for (const id of row.metrics) metrics[id] = null;
    for (const id of Object.keys(reasons)) delete reasons[id];
  }
  const attempt = {
    schema: "t3cp/scenario-attempt/1",
    ...identity,
    cell,
    n,
    load,
    host_guard: attemptGuard(meta),
    attempt: {
      valid,
      problems: [...new Set(problems)],
      started_at: startedAtOf(meta),
      cycle_s: typeof meta.cycle_s === "number" ? roundValue(meta.cycle_s) : null,
      contaminated: j.guardUnavailable ? null : j.contaminated,
      maintenance_in_window: j.maintenance,
      metric_reasons: valid ? reasons : {},
    },
    metrics,
    pipeline: { exported_at: now(), exporter_version: EXPORTER_VERSION, exporter_files_sha256: exporterFilesSha256(), ...runnerIdentity(meta) },
  };
  schemaOrFail("attempt.json", "scenario-attempt-1.json", attempt);
  scanOrFail("attempt.json", attempt, context);
  return attempt;
}

// ---------------------------------------------------------------------------------------------------------
// extras

const num = (what, value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${what}: not a finite number`);
  return value;
};
const statOf = (values) => {
  const numbers = values.filter((v) => v !== null);
  return {
    median: roundValue(median(numbers)),
    min: numbers.length ? Math.min(...numbers) : null,
    max: numbers.length ? Math.max(...numbers) : null,
    n: numbers.length,
    values,
  };
};
const once = (value) => statOf([value === null ? null : roundValue(value)]);
const MIB = 1048576;
/** A raw extras file's reasons ({key: code}), checked: absent is none; the codes themselves are the runner's. */
const reasonsOf = (what, reasons) => {
  if (reasons === undefined) return {};
  if (reasons === null || typeof reasons !== "object" || Array.isArray(reasons) || !Object.values(reasons).every((v) => typeof v === "string")) {
    fail(`${what}.reasons: not an object of reason codes`);
  }
  return reasons;
};
/** A raw extras file's timed_out: true when the extra ran out of time, absent otherwise (never false). */
const timedOutOf = (what, raw) => {
  if (raw.timed_out === undefined) return false;
  if (raw.timed_out !== true) fail(`${what}.timed_out: true or absent`);
  return true;
};
/**
 * A stat with every value null carries the public reason among the runner's codes for it: no_setup_span first (the
 * release cannot give the value at all), then extra_timeout. Other codes are internal: no reason.
 */
const withReason = (stat, codes) => {
  if (stat.n !== 0) return stat;
  const reason = EXTRAS_REASONS.find((r) => codes.includes(r));
  return reason === undefined ? stat : { ...stat, reason };
};
/** A planned start pair the runner never got to (startup timed out before it): no value, extra_timeout. */
const TIMED_OUT = () => ({ median: null, min: null, max: null, n: 0, values: [], reason: "extra_timeout" });

const EXTRAS = {
  startup(raw, spec) {
    if (raw.schema !== "t3cp/extras-startup/1" || !Array.isArray(raw.starts)) fail("startup.json: schema");
    const timedOut = timedOutOf("startup.json", raw);
    raw.starts.forEach((s, i) => reasonsOf(`startup.json starts[${i}]`, s?.reasons));
    // The start pairs the runner plans: the era fixture's (when the record has one) and the empty database's.
    const planned = spec.fixture?.id === "none" ? ["empty"] : ["era", "empty"];
    const parts = { era: {}, empty: {} };
    for (const fixture of ["era", "empty"]) {
      for (const [phase, suffix] of [["cold", "first"], ["warm", "warm"]]) {
        const starts = raw.starts.filter((s) => s?.fixture === fixture && s?.phase === phase).sort((a, b) => a.n - b.n);
        if (starts.length === 0) {
          // Stopped before this pair began: published as timed out, never as metrics that do not exist.
          if (timedOut && planned.includes(fixture)) for (const what of ["listening", "accept", "db_ready"]) parts[fixture][`${what}_${suffix}_ms`] = TIMED_OUT();
          continue;
        }
        for (const what of ["listening", "accept", "db_ready"]) {
          const values = starts.map((s, i) => (s.killed === true ? null : num(`startup.json starts[${i}].${what}_ms`, s[`${what}_ms`])));
          const codes = starts.map((s) => s.reasons?.[`${what}_ms`]).filter((c) => c !== undefined);
          parts[fixture][`${what}_${suffix}_ms`] = withReason(statOf(values.map((v) => (v === null ? null : roundValue(v)))), codes);
        }
      }
    }
    return { fixture: parts.era, empty: parts.empty, migration: null };
  },
  migration(raw) {
    if (raw.schema !== "t3cp/extras-migration/1") fail("migration.json: schema");
    const chain = num("migration.json chain_s", raw.chain_s);
    const span = num("migration.json run_migrations_span_ms", raw.run_migrations_span_ms);
    const disk = num("migration.json peak_extra_disk_bytes", raw.peak_extra_disk_bytes);
    const per = (Array.isArray(raw.migrations) ? raw.migrations : []).map((m, i) => {
      if (!Number.isInteger(m?.id)) fail(`migration.json migrations[${i}].id: not an integer`);
      const s = num(`migration.json migrations[${i}].seconds`, m.seconds);
      return s === null ? null : { id: m.id, s: roundValue(s) };
    });
    return {
      fixture: { first_boot_migrations_ms: once(chain !== null ? chain * 1000 : span), migration_extra_disk_mib: once(disk === null ? null : disk / MIB) },
      empty: null,
      migration: { per_migration: per.filter((p) => p !== null) },
    };
  },
  snapshot(raw) {
    if (raw.schema !== "t3cp/extras-snapshot/1") fail("snapshot.json: schema");
    timedOutOf("snapshot.json", raw);
    // One reason for the run (reasons.ms): the bytes come from the same GET, so they share it.
    const reasons = reasonsOf("snapshot.json", raw.reasons);
    const codes = reasons.ms === undefined ? [] : [reasons.ms];
    const ms = num("snapshot.json ms", raw.ms);
    const bytes = num("snapshot.json body_bytes", raw.body_bytes) ?? num("snapshot.json wire_bytes", raw.wire_bytes);
    return { fixture: { snapshot_full_get_ms: withReason(once(ms), codes), snapshot_full_get_bytes: withReason(once(bytes), codes) }, empty: null, migration: null };
  },
  first_turn(raw) {
    if (raw.schema !== "t3cp/extras-first-turn/1") fail("first_turn.json: schema");
    timedOutOf("first_turn.json", raw);
    const reasons = reasonsOf("first_turn.json", raw.reasons);
    const codes = reasons.ms === undefined ? [] : [reasons.ms];
    return { fixture: { first_turn_after_start_ms: withReason(once(num("first_turn.json ms", raw.ms)), codes) }, empty: null, migration: null };
  },
};

/** Builds the extras documents ({name: t3cp/extras/1 object}) from a raw extras directory. */
export function exportExtras(rawDir, spec, { privatePatterns = [] } = {}) {
  checkSpec(spec);
  const reader = new Reader(rawDir);
  const context = { privatePatterns, secrets: credsSecrets(reader.root) };
  const docs = {};
  for (const [name, build] of Object.entries(EXTRAS)) {
    const raw = reader.json(`${name}.json`);
    if (raw === null) continue;
    const part = build(raw, spec);
    const wrap = (metrics) => (metrics === null || Object.keys(metrics).length === 0 ? null : { metrics });
    const doc = {
      schema: "t3cp/extras/1",
      record_id: spec.record_id,
      fixture: wrap(part.fixture),
      empty: wrap(part.empty),
      migration: part.migration,
      pipeline: { exported_at: now(), exporter_version: EXPORTER_VERSION, exporter_files_sha256: exporterFilesSha256(), runner_version: null, runner_files_sha256: null },
    };
    schemaOrFail(`extras/${name}.json`, "extras-1.json", doc);
    scanOrFail(`extras/${name}.json`, doc, context);
    docs[name] = doc;
  }
  return docs;
}

// ---------------------------------------------------------------------------------------------------------

/** Writes every file or none: temporaries first, then renames. */
function writeAll(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  const tmps = [];
  try {
    for (const [name, value] of Object.entries(files)) {
      const tmp = path.join(dir, `.${name}.tmp-${process.pid}`);
      fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
      tmps.push([tmp, path.join(dir, name)]);
    }
    for (const [tmp, final] of tmps) fs.renameSync(tmp, final);
  } finally {
    for (const [tmp] of tmps) fs.rmSync(tmp, { force: true });
  }
}

function main(argv) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { out: { type: "string" }, spec: { type: "string" }, extras: { type: "string" }, "no-private-patterns": { type: "boolean" } },
    }));
  } catch {
    process.stderr.write("export: refused: bad arguments\n");
    return 2;
  }
  const usage = "usage: export.mjs <raw attempt dir> --out <dir> --spec <spec.json> | --extras <raw extras dir> --out <dir> --spec <spec.json>";
  try {
    if (!values.out || !values.spec || (values.extras === undefined) === (positionals.length !== 1)) fail(usage);
    let privatePatterns = [];
    const file = process.env.T3CP_PRIVATE_PATTERNS;
    if (file) privatePatterns = loadPrivatePatterns(file);
    else if (values["no-private-patterns"] !== true) fail("private_patterns_unset: set T3CP_PRIVATE_PATTERNS to the private pattern file (or pass --no-private-patterns where none exists)");
    let spec;
    try {
      spec = parseStrict(fs.readFileSync(values.spec, "utf8"));
    } catch {
      fail("spec: not readable JSON");
    }
    if (values.extras !== undefined) {
      const docs = exportExtras(values.extras, spec, { privatePatterns });
      writeAll(values.out, Object.fromEntries(Object.entries(docs).map(([name, doc]) => [`${name}.json`, doc])));
      process.stderr.write(`export: extras ${Object.keys(docs).join(", ") || "(none)"}\n`);
    } else {
      const attempt = exportAttempt(positionals[0], spec, { privatePatterns });
      writeAll(values.out, { "attempt.json": attempt });
      process.stderr.write(`export: ${attempt.cell}-${attempt.n} ${attempt.attempt.valid ? "valid" : "invalid"}\n`);
    }
    return 0;
  } catch (error) {
    // ExportError messages carry paths and ids only; anything else is reported by type, never by content.
    process.stderr.write(`export: refused: ${error instanceof ExportError || error instanceof ScanConfigError ? error.message : `internal error (${error?.name ?? "unknown"})`}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));


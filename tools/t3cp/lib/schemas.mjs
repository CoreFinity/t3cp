// The t3cp JSON Schemas, built from one set of definitions and the metric catalogue, so the metric-id
// enumerations in every schema always match catalogue/catalogue.json. `tools/t3cp/dev/build-schemas.mjs`
// writes them to schema/*.json; schema/schemas.test.mjs checks the committed files equal this output.
//
// Every object has additionalProperties: false; every free string has a regex or an enumeration.

import * as fs from "node:fs";

export const PLATFORM_IDS = ["linux-x64", "darwin-arm64"];

/**
 * The problem codes an attempt may carry: run.ts's and collect.ts's own fixed codes, the host guard's
 * contaminated and host_guard_unavailable (it could not judge the try), attempt_invalid (an invalid run with no
 * code) and other_problem (any code outside this list: its text is never copied and the attempt is invalid).
 */
export const PROBLEMS = [
  "server_start_failed", "server_auth_failed", "server_exited", "driver_failed", "driver_timeout", "pid_gone",
  "window_too_short", "main_thread_missing", "trace_missing", "trace_coverage", "trace_rotated_during_read",
  "trace_stale", "otlp_no_samples", "db_ready_timeout", "db_setup_failed", "node_flags_mismatch",
  "node_flags_unverified", "preload_not_loaded", "per_thread_unavailable", "sessions_starved", "driver_saturated", "session_mcp_missing", "call_timeouts", "error_rate", "distribution_mismatch", "maintenance_in_window", "maintenance_unverified", "contaminated", "host_guard_unavailable", "attempt_invalid",
  "other_problem",
];

/**
 * Sane bounds per unit for every exported value (no 1e308), and integer counts. Values never go below zero
 * except the CPU-per-agent slope.
 */
const UNIT_BOUNDS = {
  n: { integer: true, min: 0, max: 1e9 },
  bytes: { integer: true, min: 0, max: 1e13 },
  ms: { min: 0, max: 1e8 },
  s: { min: 0, max: 1e6 },
  "/s": { min: 0, max: 1e9 },
  "ms/s": { min: 0, max: 1e6 },
  "%": { min: 0, max: 1e5 },
  "% of one core": { min: 0, max: 1e5 },
  "0–1": { min: 0, max: 1 },
  MiB: { min: 0, max: 1e7 },
  "% per agent": { min: -1e5, max: 1e5 },
  days: { min: 0, max: 1e4 },
};
export const boundsFor = (metric) => UNIT_BOUNDS[metric.unit] ?? { min: 0, max: 1e12 };
const boundKey = (b) => `${b.integer ? "int" : "num"}_${String(b.min).replace("-", "neg")}_${b.max}`;
const valueSchema = (b) => ({ type: [b.integer ? "integer" : "number", "null"], minimum: b.min, maximum: b.max });
/**
 * Why a statistic is null: fewer than two distinct served levels to fit CPU per served agent against, a count taken
 * by start time at a saturated level (not_measured_saturated), or, for a record extra with every value null, the
 * runner's public reason: the extra ran out of its time budget or was never started for lack of it (extra_timeout), or
 * the release writes no database setup span, so it cannot give db_ready (no_setup_span). The runner's other codes
 * (server_exited, not_reached_within_budget, no_fixture, ...) are internal and never published.
 */
export const STAT_REASONS = ["fewer_than_two_served_levels", "not_measured_saturated", "extra_timeout", "no_setup_span"];
/**
 * Why a scenario metric is null (public, published beside the null): the release predates the span or feature the
 * metric reads (no_turn_start_span, no_shell_span, no_event_prune), fewer than the row's 10 turn starts completed in
 * the attempt (turn_start_incomplete), or too few shell reads to give a p95 (shell_reads_missing). A post step that
 * could not measure at all (no valid run window, no loop samples, an unreadable database or mark) is internal: the
 * attempt is invalid (problem scenario_unmeasured) and no reason is published.
 */
export const SCENARIO_REASONS = ["no_turn_start_span", "turn_start_incomplete", "no_shell_span", "shell_reads_missing", "no_event_prune"];
/** What each public scenario reason means, in plain words. */
export const SCENARIO_REASON_WORDS = {
  no_turn_start_span: "the release predates the turn-start span in the server trace, so no turn start can be timed",
  turn_start_incomplete: "fewer than the row's 10 follow-up turn starts completed in the attempt",
  no_shell_span: "the release predates the thread shell read as a named span, so the read cannot be timed",
  shell_reads_missing: "fewer than 20 thread shell reads in the attempt, too few for a 95th percentile",
  no_event_prune: "the release keeps no event-log prune mark, so there is no compaction boundary to read",
};
/** An attempt's problems on a scenario cell: the ladder's, and a post step that could not measure. */
export const SCENARIO_PROBLEMS = [...PROBLEMS, "scenario_unmeasured"];
/** The scenario rows' metrics: the catalogue's scenario lane. */
export const scenarioMetricIds = (catalogue) => catalogue.metrics.filter((m) => m.lane === "scenario").map((m) => m.id);
/** A scenario row's suite: <id>@<version>. */
export const SCENARIO_SUITE_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*@[1-9][0-9]{0,5}$";
/** A scenario cell's name (scenarios.json). */
export const SCENARIO_CELL_PATTERN = "^[a-z0-9][a-z0-9-]{0,30}$";

/** The extras reasons the exporter publishes, in precedence order: a release that cannot give the value comes first. */
export const EXTRAS_REASONS = ["no_setup_span", "extra_timeout"];
/**
 * Why a series value is missing where the record says (levels.<L>.reason, beside the note no_data): an extras stat's
 * public reason, or timeout, the status_reason of a record that did not finish in time, for what it never measured.
 */
export const SERIES_REASONS = [...EXTRAS_REASONS, "timeout"];
/** Why an attempt's metric is null although the attempt is valid: a count taken by start time on a saturated attempt. */
export const METRIC_REASONS = ["not_measured_saturated"];
/**
 * Counts taken by start time in the window (a turn counts when it starts in the window and ends by its close): at
 * saturation they outlast the window and would read near zero, so they are not measured there.
 */
export const NOT_MEASURED_SATURATED = ["turns_completed"];
const boundedStat = (b) => ({
  type: "object",
  additionalProperties: false,
  required: ["median", "min", "max", "n", "values"],
  properties: {
    median: { type: ["number", "null"], minimum: b.min, maximum: b.max },
    min: valueSchema(b),
    max: valueSchema(b),
    n: { type: "integer", minimum: 0, maximum: 9 },
    values: { type: "array", items: valueSchema(b), maxItems: 9 },
    // Why the value is null (CPU per served agent; turns completed at a saturated level; an extra out of time or a
    // release without the setup span).
    reason: { type: "string", enum: STAT_REASONS },
  },
});
/** A scenario metric's statistic over a cell's valid attempts: the ladder's, with the public scenario reasons. */
const scenarioStat = (b) => {
  const stat = boundedStat(b);
  return { ...stat, properties: { ...stat.properties, n: { type: "integer", minimum: 0, maximum: 5 }, values: { type: "array", items: valueSchema(b), maxItems: 5 }, reason: { type: "string", enum: SCENARIO_REASONS, description: SCENARIO_REASONS.map((r) => `${r}: ${SCENARIO_REASON_WORDS[r]}`).join("; ") } } };
};

/** Suites: the published ladder, the noise-band run, and validation suites named val-<name>. */
export const SUITE_PATTERN = "^(ladder-1|bands-1|val-[a-z0-9-]{1,32})$";

/** The runner's load profiles and driver modes (tools/t3cp/runner/profiles.json). */
export function runnerProfiles() {
  const table = JSON.parse(fs.readFileSync(new URL("../runner/profiles.json", import.meta.url), "utf8"));
  const modes = new Set();
  for (const profile of Object.values(table.profiles)) {
    for (const part of [profile.single, profile.empty, profile.ladder, ...Object.values(profile.levels ?? {})]) if (part?.mode) modes.add(part.mode);
  }
  return { profiles: Object.keys(table.profiles).sort(), modes: [...modes].sort() };
}
/** The public repositories a fork or base build may come from (the fork, and upstream for the base trees). */
export const BUILD_REPOS = ["github.com/navidnadali/t3code", "github.com/pingdotgg/t3code"];
export const CELLS = ["1", "50", "100", "150", "200", "250", "1e"];
export const SERIES_LEVELS = [...CELLS, "once"];
export const VERDICTS = ["regressed", "improved", "within"];
export const NOTES = ["context", "no_band", "wide_band", "hollow", "gated", "no_reference", "no_data", "not_comparable", "no_base", "zero_reference", "saturated"];
const FORK_HEAD_NIGHTLY_TAG = /^v\d{1,3}\.\d{1,3}\.\d{1,4}-nightly\.(20\d{2})(\d{2})(\d{2})\.\d{1,6}$/;
/** The night of a nightly fork-head record id (<date>.<platform>.fork), or null for any other id. */
export const forkHeadNight = (recordId) => /^(20\d{2}-\d{2}-\d{2})\.(linux-x64|darwin-arm64)\.fork$/.exec(String(recordId))?.[1] ?? null;
/**
 * The nightly fork-head coupling, which the schemas cannot state: a <date>.<platform>.fork record is kind fork, measures
 * a fork release (a -perf tag), and names in paired_nightly the upstream nightly of that night (its tag's date and
 * its date are the id's); no other record carries paired_nightly. Returns the problem, or null.
 */
export function forkHeadProblem({ record_id: recordId, kind, release, paired_nightly: paired }) {
  const night = forkHeadNight(recordId);
  if (night === null) return paired === undefined ? null : "paired_nightly belongs to a nightly fork-head record (<date>.<platform>.fork) only";
  if (kind !== "fork") return "a fork-head record (<date>.<platform>.fork) is kind fork";
  if (typeof release?.tag !== "string" || !/-perf\.\d{1,3}$/.test(release.tag)) return "a fork-head record measures a fork release (a -perf tag)";
  const m = FORK_HEAD_NIGHTLY_TAG.exec(typeof paired?.tag === "string" ? paired.tag : "");
  if (paired === null || typeof paired !== "object" || !m) return "a fork-head record needs paired_nightly {tag, date}: the upstream nightly of its night";
  if (paired.date !== night || `${m[1]}-${m[2]}-${m[3]}` !== night) return `paired_nightly is not the nightly of ${night}, the record id's night`;
  return null;
}

export const STATUS_REASONS = [
  "preempted", "cpu_mismatch", "archive_missing", "export_failed", "contaminated", "runner_offline", "timeout",
  "attempts_invalid", "migration_failed", "build_failed",
];

/** What each public reason code means, in plain words (the status schema and the methodology page say it). */
export const STATUS_REASON_WORDS = {
  preempted: "the cloud VM was reclaimed while the record ran",
  cpu_mismatch: "the machine did not have the pinned CPU model",
  archive_missing: "the release archive could not be fetched or verified",
  export_failed: "an attempt's results could not be exported safely",
  contaminated: "other load on the machine disturbed the measurement",
  runner_offline: "the measurement infrastructure was unavailable",
  timeout: "the record did not finish in time",
  attempts_invalid: "too few attempts at a level were valid",
  migration_failed: "the nightly could not migrate the fixture",
  build_failed: "a fork release or base tree could not be built from source",
};

const DATE = "^20\\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$";
const DATETIME = "^20\\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d{1,3})?Z$";
const VERSION_CORE = "\\d{1,3}\\.\\d{1,3}\\.\\d{1,4}";
const SUFFIX = "(-nightly\\.20\\d{6}\\.\\d{1,6}|-perf\\.\\d{1,3})";

const obj = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const nullable = (schema) => {
  if (schema.$ref !== undefined) return { type: ["object", "null"], ...schema }; // never used: refs are wrapped below
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return { ...schema, type: [...types, "null"] };
};
const ref = (name) => ({ $ref: `#/$defs/${name}` });
const arrayOf = (items, extra = {}) => ({ type: "array", items, ...extra });
const num = { type: "number" };
const numOrNull = { type: ["number", "null"] };
/** An attempt's host guard verdict: true (other load disturbed it), false (checked and clean), null (it could not judge). */
const CONTAMINATED = { type: ["boolean", "null"], description: "true: other load on the machine disturbed the attempt; false: the host guard checked it and found it clean; null: the host guard could not judge it (problem host_guard_unavailable)" };
const int = (minimum = 0, maximum) => ({ type: "integer", minimum, ...(maximum === undefined ? {} : { maximum }) });

/** Daily per-level metric ids that attempts carry (everything but the merge-derived counts). */
export const levelMetricIds = (catalogue) =>
  catalogue.metrics.filter((m) => m.scope === "level" && m.lane === "daily" && m.source.file !== "merge").map((m) => m.id);

/** Record-scope metric ids (startup, migrations, snapshot, first turn, the derived CPU per agent). */
export const recordMetricIds = (catalogue) =>
  catalogue.metrics.filter((m) => m.scope === "record" && ["daily", "record"].includes(m.lane)).map((m) => m.id);

/** Shared definitions; each schema file gets the subset it references. */
function definitions(catalogue) {
  const runner = runnerProfiles();
  const metrics = catalogue.metrics;
  // Per-attempt values: daily, per-level metrics the exporter maps. Merge-derived counts (attempts_valid,
  // attempts_total, contaminated) live in each cell's valid/total and attempts[] instead.
  const levelIds = levelMetricIds(catalogue);
  const recordIds = recordMetricIds(catalogue);
  const featureEras = catalogue.feature_eras.map((e) => e.id);
  const stat = obj({
    median: numOrNull,
    min: numOrNull,
    max: numOrNull,
    n: int(0, 9),
    values: arrayOf(numOrNull, { maxItems: 9 }),
  });
  const byId = new Map(metrics.map((m) => [m.id, m]));
  return {
    date: { type: "string", pattern: DATE },
    datetime: { type: "string", pattern: DATETIME },
    sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    tag: { type: "string", pattern: `^v${VERSION_CORE}${SUFFIX}?$` },
    nightly_tag: { type: "string", pattern: `^v${VERSION_CORE}-nightly\\.20\\d{6}\\.\\d{1,6}$` },
    fork_tag: { type: "string", pattern: `^v${VERSION_CORE}-perf\\.\\d{1,3}$` },
    version: { type: "string", pattern: `^${VERSION_CORE}${SUFFIX}?$` },
    platform_id: { type: "string", enum: PLATFORM_IDS },
    record_id: {
      type: "string",
      pattern: `^(20\\d{2}-\\d{2}-\\d{2}\\.(linux-x64|darwin-arm64)\\.(nightly|fork)|${VERSION_CORE}-perf\\.\\d{1,3}\\.(linux-x64|darwin-arm64)\\.fork|[0-9a-f]{12}\\.(linux-x64|darwin-arm64)\\.base)$`,
      description:
        "<date>.<platform>.nightly (a nightly); <version>.<platform>.fork (a fork release); <date>.<platform>.fork (the nightly fork-head record: the fork's latest release measured on that night, with paired_nightly); <first 12 hex of the merge-base SHA>.<platform>.base (a base record).",
    },
    kind: { type: "string", enum: ["nightly", "fork", "base"], description: "base: an upstream tree built from source at a fork release's merge-base SHA" },
    cell: { type: "string", enum: CELLS },
    series_level: { type: "string", enum: SERIES_LEVELS },
    metric_id: { type: "string", enum: metrics.map((m) => m.id) },
    verdict: { type: ["string", "null"], enum: [...VERDICTS, null] },
    note: { type: ["string", "null"], enum: [...NOTES, null] },
    problem: { type: "string", enum: PROBLEMS },
    stat,
    level_stats: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(levelIds.map((id) => [id, ref(`stat_${boundKey(boundsFor(byId.get(id)))}`)])),
    },
    record_stats: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(recordIds.map((id) => [id, ref(`stat_${boundKey(boundsFor(byId.get(id)))}`)])),
    },
    level_values: {
      type: "object",
      additionalProperties: false,
      required: levelIds,
      properties: Object.fromEntries(levelIds.map((id) => [id, valueSchema(boundsFor(byId.get(id)))])),
    },
    ...Object.fromEntries(
      [...new Map(catalogue.metrics.map((m) => boundsFor(m)).map((b) => [boundKey(b), b])).entries()].map(([key, b]) => [`stat_${key}`, boundedStat(b)]),
    ),
    release: obj({
      tag: ref("tag"),
      sha: ref("sha"),
      date: ref("date"),
      version: ref("version"),
      archive: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["name", "sha256", "bytes"],
        properties: {
          name: { type: "string", pattern: `^t3-${VERSION_CORE}${SUFFIX}?-(linux-x64|darwin-arm64)\\.tar\\.gz$` },
          sha256: ref("sha256"),
          bytes: { type: ["integer", "null"], minimum: 1 },
        },
      },
      binary_sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
      build: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["source_repo", "script_sha256"],
        description: "Fork and base records: the public repository the tree was built from (its commit is release.sha) and the build script's sha256; the built t3 is binary_sha256. Null for nightlies (the upstream archive).",
        properties: { source_repo: { type: "string", enum: BUILD_REPOS }, script_sha256: ref("sha256") },
      },
    }),
    base: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["tag", "date", "sha"],
      properties: { tag: ref("nightly_tag"), date: ref("date"), sha: ref("sha") },
    },
    paired_nightly: {
      type: "object",
      additionalProperties: false,
      required: ["tag", "date"],
      properties: { tag: ref("nightly_tag"), date: ref("date") },
      description:
        "Only on a nightly fork-head record (record_id <date>.<platform>.fork): the upstream nightly of the night it was measured beside, whose date is the record id's. Absent on every other record.",
    },
    platform: obj({
      id: ref("platform_id"),
      machine: { type: "string", pattern: "^(n2d-standard-16|Mac\\d{1,2},\\d{1,2})$" },
      cpu_model: { type: "string", pattern: "^(AMD EPYC 7B13|Apple M[1-9]( Pro| Max| Ultra)?)$" },
      cores: int(1, 256),
      memory_gib: { type: "number", minimum: 1, maximum: 4096 },
      os: { type: "string", pattern: "^(Debian \\d{1,2}|macOS \\d{2}(\\.\\d{1,2}){0,2})$" },
      kernel: { type: "string", pattern: "^\\d{1,2}\\.\\d{1,3}(\\.\\d{1,3})?(\\+deb\\d{2})?(-cloud)?(-amd64|-arm64)?$" },
      provisioning: { type: "string", enum: ["spot", "on-demand", "dedicated"] },
      runtime_node: { type: "string", pattern: "^\\d{2}\\.\\d{1,2}\\.\\d{1,2}$" },
    }),
    // Each harness hash is what run.ts (tools/server-bench/run.ts at the harness's public tag) reports in result.json,
    // computed by run.ts's own function, so a reader recomputes it from the tag by that one method.
    harness: obj({
      version: { type: "string", pattern: "^t3cp-harness/\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$" },
      sha: {
        ...ref("sha"),
        description:
          "In a record: the public commit the harness version's tag points at, as pinned in tools/t3cp/public-refs.json. An attempt carries the commit its run reported; merge checks the four hashes below against the pin and replaces it with that public commit.",
      },
      files_sha256: {
        type: "string",
        pattern: "^[0-9a-f]{64}$",
        description: "run.ts's identity.harness_files_sha256, by its exported harnessFilesSha256(): sha256 over the lines '<repository-relative path>\\0<sha256 of the file>\\n' for every file of the harness's run-time closure (package.json, tools/server-bench, apps/server/scripts/dev-replay-agent.ts and the recordings), sorted by path, tests, docs and generated state excluded.",
      },
      driver_sha256: {
        type: ["string", "null"],
        pattern: "^[0-9a-f]{64}$",
        description: "run.ts's knobs.workload.driver_sha256, by its exported driverHash(): sha256 over '<name>\\0<sha256>\\n' lines for the load driver, its module directory and the local modules they import.",
      },
      fakes_sha256: {
        type: ["string", "null"],
        pattern: "^[0-9a-f]{64}$",
        description: "run.ts's knobs.workload.fakes_sha256, by its exported fakesHash(): sha256 over '<path>\\0<sha256>\\n' lines for the replaying fake providers' files (fake-claude, fake-codex, fake-acp, fake-common; tests and READMEs excluded) and the local modules they import.",
      },
      preload_sha256: {
        type: ["string", "null"],
        pattern: "^[0-9a-f]{64}$",
        description:
          "run.ts's identity.preload.sha256: sha256 over the lines '<file name>\\0<sha256 of the file>\\n' for the preload file the run loaded (by default tools/server-bench/preload/bench-preload.cjs; run.ts --preload names another) and then bench-preload.mjs in that file's directory, each when present; null when the run loaded no preload.",
      },
    }),
    fixture: obj({
      id: { type: "string", pattern: "^(large-\\d{2,3}(-s\\d{1,3})?|none)$", description: "large-<migration>: an era fixture; -s<pct>: a scaled validation build; none: an empty database. Only plain large-<n> records are published." },
      sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
      bytes: { type: ["integer", "null"], minimum: 1 },
      migration: { type: ["integer", "null"], minimum: 1, maximum: 9999 },
      recipe_sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
    }),
    cell_profile: obj(
      {
        sessions: int(1, 1000),
        subscribers: int(0, 1000),
        pollers: int(0, 1000),
        turn_gap_s: { type: ["number", "null"], minimum: 0 },
        switch_interval_s: { type: ["number", "null"], minimum: 0 },
        poll_interval_s: { type: ["number", "null"], minimum: 0 },
        mode: { type: ["string", "null"], enum: [...runner.modes, null] },
        distribution_tolerance: { type: ["number", "null"], minimum: 0, maximum: 5, description: "The driver's recorded distribution tolerance for fixture-backed cells; null for fresh cells. A change starts a new reference window." },
        fixture: { type: "string", enum: ["era", "none"] },
      },
      ["sessions", "subscribers", "pollers", "fixture"],
    ),
    workload: obj({
      profile: { type: "string", enum: runner.profiles },
      suite: { type: "string", pattern: SUITE_PATTERN },
      warmup_s: int(0, 3600),
      window_s: int(1, 86400),
      levels: arrayOf({ type: "integer", minimum: 1, maximum: 1000 }, { uniqueItems: true, minItems: 1, maxItems: 12 }),
      empty_cell: { type: "boolean" },
      attempts_per_level: int(1, 9),
      seed: { type: "string", pattern: "^\\d{1,12}$" },
      now: ref("datetime"),
      cells: {
        type: "object",
        additionalProperties: false,
        description: "Per cell, the load arguments the runner ran it with (agents = sessions); written by the merge, absent on attempts.",
        properties: Object.fromEntries(CELLS.map((cell) => [cell, ref("cell_profile")])),
      },
    }, ["profile", "suite", "warmup_s", "window_s", "levels", "empty_cell", "attempts_per_level", "seed", "now"]),
    era: obj({
      has: arrayOf({ type: "string", enum: featureEras }, { uniqueItems: true }),
      missing: arrayOf({ type: "string", enum: featureEras }, { uniqueItems: true }),
    }),
    attempt_summary: obj({
      n: int(1, 9),
      valid: { type: "boolean" },
      problems: arrayOf(ref("problem"), { maxItems: 16, uniqueItems: true }),
      started_at: { type: ["string", "null"], pattern: DATETIME },
      cycle_s: numOrNull,
      contaminated: CONTAMINATED,
      maintenance_in_window: { type: ["integer", "string", "null"], minimum: 0, maximum: 1000, pattern: "^(unscheduled_pre_marker|unobserved_no_span)$" },
      saturated: { type: "boolean", description: "valid, but the server did not serve every agent in the window" },
      saturated_by: arrayOf(ref("problem"), { maxItems: 16, uniqueItems: true }),
      agents_total: { type: ["integer", "null"], minimum: 1, maximum: 1000 },
      distribution: ref("distribution_check"),
      metric_reasons: {
        type: "object",
        additionalProperties: false,
        description: "Per metric whose value is null although the attempt is valid, why: not_measured_saturated (a count taken by start time on a saturated attempt).",
        properties: Object.fromEntries(levelMetricIds(catalogue).map((id) => [id, { type: "string", enum: METRIC_REASONS }])),
      },
    }, ["n", "valid", "problems", "started_at", "cycle_s", "contaminated", "maintenance_in_window", "saturated", "saturated_by", "agents_total"]),
    distribution_check: {
      ...obj({
        test: { type: "string", enum: ["binomial", "ratio_tolerance"] },
        p50_ratio: { type: ["number", "null"], minimum: 0, maximum: 10000 },
        p95_ratio: { type: ["number", "null"], minimum: 0, maximum: 10000 },
        passed: { type: "boolean" },
      }),
      type: ["object", "null"],
      description:
        "The driver's post-window check that the exercised threads are a plausible sample of the fixture (the sample is drawn with the record's seed, so the attempts of a cell share it): their p50 and p95 turn-item ratios to the fixture's, and its verdict (binomial: an exact two-sided test of the counts below the fixture's p50 and above its p95; ratio_tolerance: both ratios within the cell's distribution_tolerance). A failed check is the problem distribution_mismatch. Null when the cell has no fixture threads to match.",
    },
    cell_record: obj({
      attempts: arrayOf(ref("attempt_summary"), { maxItems: 9 }),
      valid: int(0, 9),
      total: int(0, 9),
      saturated: { type: "boolean", description: "the median agents served is below agents_total: latencies here are context, without verdicts" },
      agents_total: { type: ["integer", "null"], minimum: 1, maximum: 1000 },
      metrics: ref("level_stats"),
    }),
    host_guard: obj({
      contaminated: { type: "boolean" },
      host_busy_pct_max: numOrNull,
      host_steal_pct_max: numOrNull,
      host_iowait_pct_max: numOrNull,
      foreign_pct_mean_max: numOrNull,
      thermal_limit_min: numOrNull,
    }),
    attempt_guard: obj({
      busy_pct_max: numOrNull,
      steal_pct_max: numOrNull,
      iowait_pct_max: numOrNull,
      foreign_pct_mean: numOrNull,
    }),
    extras_part: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["metrics"],
      properties: { metrics: ref("record_stats") },
    },
    migration: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["per_migration"],
      properties: {
        per_migration: arrayOf(obj({ id: int(1, 9999), s: { type: "number", minimum: 0 } }), { maxItems: 200 }),
      },
    },
    // Scenario records (scenarios.json rows other than the ladder): keyed by the row's cell names, with the row's
    // metrics (the catalogue's scenario lane) and the public scenario reasons.
    scenario_problem: { type: "string", enum: SCENARIO_PROBLEMS },
    scenario_fixture: obj({
      id: { type: "string", pattern: "^(none|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$", maxLength: 41, description: "The row's fixture id (a published fixture, fixture/fixtures.json), or none: an empty database." },
      sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
      bytes: { type: ["integer", "null"], minimum: 1 },
      migration: { type: ["integer", "null"], minimum: 1, maximum: 9999 },
      recipe_sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
    }),
    scenario_load: obj(
      {
        sessions: int(1, 1000),
        subscribers: int(0, 1000),
        pollers: int(0, 1000),
        mode: { type: "string", enum: ["fresh", "history", "mixed"], description: "The driver's --mode." },
        turn_gap_s: { type: "number", minimum: 0 },
        switch_interval_s: { type: ["number", "null"], minimum: 0 },
        poll_interval_s: { type: ["number", "null"], minimum: 0 },
        fixture: { type: "string", enum: ["era", "none"], description: "era: the cell starts from the row's fixture; none: from an empty database." },
        warmup_s: int(0, 3600),
        window_s: int(10, 14400),
        seed_compacted_at: { type: "boolean" },
        post: { type: "string", enum: ["none", "turn-start-gap", "prune-mark"] },
        mark_age_days: { type: ["integer", "null"], minimum: 1, maximum: 30 },
      },
      ["sessions", "subscribers", "pollers", "mode", "turn_gap_s", "switch_interval_s", "poll_interval_s", "fixture", "warmup_s", "window_s", "seed_compacted_at", "post", "mark_age_days"],
    ),
    scenario_workload: obj(
      {
        suite: { type: "string", pattern: SCENARIO_SUITE_PATTERN, description: "<id>@<version>: the scenarios.json row." },
        scenario: obj({ id: { type: "string", pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", maxLength: 41 }, version: int(1, 999999) }),
        attempts_per_cell: int(1, 5),
        seed: { type: "string", pattern: "^\\d{1,12}$" },
        now: ref("datetime"),
        cells: {
          type: "object",
          propertyNames: { type: "string", pattern: SCENARIO_CELL_PATTERN },
          additionalProperties: ref("scenario_load"),
          description: "Per cell, the load it ran with, as the row gives it; written by the merge, absent on attempts.",
        },
      },
      ["suite", "scenario", "attempts_per_cell", "seed", "now"],
    ),
    scenario_values: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(scenarioMetricIds(catalogue).map((id) => [id, valueSchema(boundsFor(byId.get(id)))])),
      description: "The row's metrics, each a value or null (with its reason in metric_reasons, or on an invalid attempt).",
    },
    scenario_stats: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(scenarioMetricIds(catalogue).map((id) => [id, scenarioStat(boundsFor(byId.get(id)))])),
    },
    scenario_attempt_summary: obj({
      n: int(1, 5),
      valid: { type: "boolean" },
      problems: arrayOf(ref("scenario_problem"), { maxItems: 16, uniqueItems: true }),
      started_at: { type: ["string", "null"], pattern: DATETIME },
      cycle_s: numOrNull,
      contaminated: CONTAMINATED,
      maintenance_in_window: { type: ["integer", "string", "null"], minimum: 0, maximum: 1000, pattern: "^(unscheduled_pre_marker|unobserved_no_span)$" },
    }),
    scenario_cell_record: obj({
      attempts: arrayOf(ref("scenario_attempt_summary"), { maxItems: 5 }),
      valid: int(0, 5),
      total: int(0, 5),
      metrics: ref("scenario_stats"),
    }),
  };
}

/** Keeps only the $defs a schema reaches, transitively, so each file stays self-contained and small. */
function withDefs(schema, defs) {
  const used = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object") return;
    if (typeof node.$ref === "string") {
      const name = node.$ref.slice("#/$defs/".length);
      if (!used.has(name)) {
        used.add(name);
        visit(defs[name]);
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(schema);
  const $defs = Object.fromEntries([...used].sort().map((name) => [name, defs[name]]));
  return { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema, $defs };
}

/**
 * The t3cp code that produced a record, by version and content hash only: the repository is recreated from one
 * squashed root at go-live, so no t3cp commit SHA may appear in a record.
 */
const CODE_IDS = {
  exporter_version: { type: "string", pattern: "^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$" },
  exporter_files_sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
  runner_version: { type: ["string", "null"], pattern: "^t3cp-runner/\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$" },
  runner_files_sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
};

const synthetic = { const: true, description: "Present only on development data from tools/t3cp/dev/synth-data.mjs; refused under data/." };

export function buildSchemas(catalogue) {
  const defs = definitions(catalogue);
  const identity = {
    record_id: ref("record_id"),
    kind: ref("kind"),
    release: ref("release"),
    base: ref("base"),
    platform: ref("platform"),
    harness: ref("harness"),
    fixture: ref("fixture"),
    workload: ref("workload"),
    era: ref("era"),
  };

  const record = withDefs(
    {
      $id: "https://t3cp.io/schema/record-1.json",
      title: "t3cp/record/1: one benchmark record for one release on one platform",
      ...obj(
        {
          schema: { const: "t3cp/record/1" },
          synthetic,
          ...identity,
          paired_nightly: ref("paired_nightly"),
          cells: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(CELLS.map((cell) => [cell, ref("cell_record")])),
          },
          extras: obj({ fixture: ref("extras_part"), empty: ref("extras_part"), migration: ref("migration"), weekly: { type: "null" } }),
          host_guard: ref("host_guard"),
          status: { type: "string", enum: ["complete", "partial", "missing"] },
          status_reason: { type: ["string", "null"], enum: [...STATUS_REASONS, null] },
          compaction_schedule: {
            type: ["string", "null"],
            enum: ["unscheduled", "scheduled", null],
            description: "The compaction schedule era: unscheduled releases start a maintenance pass after every start (their own era; no verdict, reference or band crosses it); null when no attempt could tell",
          },
          pipeline: obj({
            generated_at: ref("datetime"),
            run_id: { type: ["integer", "null"], minimum: 0 },
            lease: { type: ["integer", "null"], minimum: 0, maximum: 99 },
            ...CODE_IDS,
          }),
        },
        ["schema", ...Object.keys(identity), "cells", "extras", "host_guard", "status", "status_reason", "compaction_schedule", "pipeline"],
      ),
    },
    defs,
  );

  const attempt = withDefs(
    {
      $id: "https://t3cp.io/schema/attempt-1.json",
      title: "t3cp/attempt/1: the exporter's output for one attempt, the per-attempt slice of t3cp/record/1",
      ...obj(
        {
          schema: { const: "t3cp/attempt/1" },
          synthetic,
          ...identity,
          paired_nightly: ref("paired_nightly"),
          cell: ref("cell"),
          n: int(1, 9),
          profile: ref("cell_profile"),
          host_guard: ref("attempt_guard"),
          attempt: obj({
            valid: { type: "boolean" },
            problems: arrayOf(ref("problem"), { maxItems: 16, uniqueItems: true }),
            started_at: { type: ["string", "null"], pattern: DATETIME },
            cycle_s: numOrNull,
            contaminated: CONTAMINATED,
      maintenance_in_window: { type: ["integer", "string", "null"], minimum: 0, maximum: 1000, pattern: "^(unscheduled_pre_marker|unobserved_no_span)$" },
            saturated: { type: "boolean" },
            saturated_by: arrayOf(ref("problem"), { maxItems: 16, uniqueItems: true }),
            agents_total: { type: ["integer", "null"], minimum: 1, maximum: 1000 },
            distribution: ref("distribution_check"),
            metric_reasons: {
              type: "object",
              additionalProperties: false,
              description: "Per metric whose value is null although the attempt is valid, why: not_measured_saturated (a count taken by start time on a saturated attempt).",
              properties: Object.fromEntries(levelMetricIds(catalogue).map((id) => [id, { type: "string", enum: METRIC_REASONS }])),
            },
          }),
          metrics: ref("level_values"),
          pipeline: obj({
            exported_at: ref("datetime"),
            ...CODE_IDS,
          }),
        },
        ["schema", ...Object.keys(identity), "cell", "n", "profile", "host_guard", "attempt", "metrics", "pipeline"],
      ),
    },
    defs,
  );

  const scenarioIdentity = { ...identity, fixture: ref("scenario_fixture"), workload: ref("scenario_workload") };
  const scenarioAttempt = withDefs(
    {
      $id: "https://t3cp.io/schema/scenario-attempt-1.json",
      title: "t3cp/scenario-attempt/1: the exporter's output for one attempt of a scenario cell (a scenarios.json row's cell)",
      ...obj(
        {
          schema: { const: "t3cp/scenario-attempt/1" },
          synthetic,
          ...scenarioIdentity,
          cell: { type: "string", pattern: SCENARIO_CELL_PATTERN },
          n: int(1, 5),
          load: ref("scenario_load"),
          host_guard: ref("attempt_guard"),
          attempt: obj({
            valid: { type: "boolean" },
            problems: arrayOf(ref("scenario_problem"), { maxItems: 16, uniqueItems: true }),
            started_at: { type: ["string", "null"], pattern: DATETIME },
            cycle_s: numOrNull,
            contaminated: CONTAMINATED,
            maintenance_in_window: { type: ["integer", "string", "null"], minimum: 0, maximum: 1000, pattern: "^(unscheduled_pre_marker|unobserved_no_span)$" },
            metric_reasons: {
              type: "object",
              additionalProperties: false,
              description: "Per metric whose value is null although the attempt is valid, its public reason.",
              properties: Object.fromEntries(scenarioMetricIds(catalogue).map((id) => [id, { type: "string", enum: SCENARIO_REASONS }])),
            },
          }),
          metrics: ref("scenario_values"),
          pipeline: obj({
            exported_at: ref("datetime"),
            ...CODE_IDS,
          }),
        },
        ["schema", ...Object.keys(scenarioIdentity), "cell", "n", "load", "host_guard", "attempt", "metrics", "pipeline"],
      ),
    },
    defs,
  );

  const scenarioRecord = withDefs(
    {
      $id: "https://t3cp.io/schema/scenario-record-1.json",
      title: "t3cp/scenario-record/1: one record of a scenarios.json row for one release on one platform",
      ...obj(
        {
          schema: { const: "t3cp/scenario-record/1" },
          synthetic,
          ...scenarioIdentity,
          cells: {
            type: "object",
            propertyNames: { type: "string", pattern: SCENARIO_CELL_PATTERN },
            additionalProperties: ref("scenario_cell_record"),
          },
          host_guard: ref("host_guard"),
          status: { type: "string", enum: ["complete", "partial", "missing"] },
          status_reason: { type: ["string", "null"], enum: [...STATUS_REASONS, null] },
          pipeline: obj({
            generated_at: ref("datetime"),
            run_id: { type: ["integer", "null"], minimum: 0 },
            lease: { type: ["integer", "null"], minimum: 0, maximum: 99 },
            ...CODE_IDS,
          }),
        },
        ["schema", ...Object.keys(scenarioIdentity), "cells", "host_guard", "status", "status_reason", "pipeline"],
      ),
    },
    defs,
  );

  const extras = withDefs(
    {
      $id: "https://t3cp.io/schema/extras-1.json",
      title: "t3cp/extras/1: the exporter's output for one record's extras (startup, migrations, snapshot, first turn)",
      ...obj(
        {
          schema: { const: "t3cp/extras/1" },
          synthetic,
          record_id: ref("record_id"),
          fixture: ref("extras_part"),
          empty: ref("extras_part"),
          migration: ref("migration"),
          pipeline: obj({
            exported_at: ref("datetime"),
            ...CODE_IDS,
          }),
        },
        ["schema", "record_id", "fixture", "empty", "migration", "pipeline"],
      ),
    },
    defs,
  );

  const facts = withDefs(
    {
      $id: "https://t3cp.io/schema/facts-1.json",
      title: "t3cp/facts/1: the runner's machine and harness facts, an input of the exporter (never published as is)",
      ...obj({
        schema: { const: "t3cp/facts/1" },
        platform: ref("platform"),
        harness: obj({
          version: { type: "string", pattern: "^t3cp-harness/\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$" },
          preload_sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
        }),
        fixture: obj({
          bytes: int(1),
          migration: int(1, 9999),
          recipe_sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
        }),
        release: obj({
          archive_bytes: { type: ["integer", "null"], minimum: 1 },
          binary_sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
          build_script_sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
        }),
      }),
    },
    defs,
  );

  const levelSeries = obj({
    band: numOrNull,
    threshold: numOrNull,
    median: arrayOf(numOrNull),
    min: arrayOf(numOrNull),
    max: arrayOf(numOrNull),
    n: arrayOf(int(0, 9)),
    ref: arrayOf(numOrNull),
    delta: arrayOf(numOrNull),
    verdict: arrayOf(ref("verdict")),
    note: arrayOf(ref("note")),
    thin: arrayOf({ type: "boolean" }),
    dod_delta: arrayOf(numOrNull),
    dod_verdict: arrayOf(ref("verdict")),
    saturated: arrayOf({ type: "boolean" }),
    saturated_by: arrayOf(ref("saturated_by")),
    reason: arrayOf(ref("series_reason")),
  }, ["band", "threshold", "median", "min", "max", "n", "ref", "delta", "verdict", "note", "thin", "dod_delta", "dod_verdict", "saturated"]);
  const forkLevel = obj({
    value: arrayOf(numOrNull),
    min: arrayOf(numOrNull),
    max: arrayOf(numOrNull),
    n: arrayOf(int(0, 9)),
    vs_base: arrayOf(numOrNull),
    vs_base_verdict: arrayOf(ref("verdict")),
    vs_base_note: arrayOf(ref("note")),
    vs_prev: arrayOf(numOrNull),
    vs_prev_verdict: arrayOf(ref("verdict")),
    vs_prev_note: arrayOf(ref("note")),
    saturated: arrayOf({ type: "boolean" }),
    saturated_by: arrayOf(ref("saturated_by")),
    step: arrayOf(numOrNull),
  }, ["value", "min", "max", "n", "vs_base", "vs_base_verdict", "vs_base_note", "vs_prev", "vs_prev_verdict", "vs_prev_note", "saturated", "step"]);
  defs.saturated_by = {
    type: ["array", "null"],
    items: ref("problem"),
    maxItems: 16,
    uniqueItems: true,
    description: "A saturated level's symptoms: the union of the cell's attempts' saturated_by problem codes, sorted; null where the level is not saturated.",
  };
  defs.series_reason = {
    type: ["string", "null"],
    enum: [...SERIES_REASONS, null],
    description:
      "Why the value is missing, where a public reason exists; set only beside the note no_data, else null. extra_timeout: the measurement timed out; no_setup_span: the release writes no database setup span, so db_ready cannot be measured; timeout: the record did not finish in time, and this level or extra was never measured.",
  };
  defs.level_series = levelSeries;
  defs.fork_level = forkLevel;
  const levelsOf = (name) => ({
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(SERIES_LEVELS.map((level) => [level, ref(name)])),
  });
  const series = withDefs(
    {
      $id: "https://t3cp.io/schema/series-1.json",
      title: "t3cp/series/1: one metric on one platform over time, with verdicts computed at build time",
      description:
        "Arrays under levels.<L> align with dates. delta and dod_delta are the raw relative change (v - r) / r in percent with its real sign; verdicts are already sign-adjusted for the metric's direction. fork.levels.<L>.step aligns with dates (the latest fork release on or before each date, held until the next); the other fork arrays align with fork.tags.",
      ...obj(
        {
          schema: { const: "t3cp/series/1" },
          synthetic,
          id: ref("metric_id"),
          platform: ref("platform_id"),
          shard: { type: "string", pattern: "^(all|latest|20\\d{2})$" },
          generated_at: ref("datetime"),
          from: { type: ["string", "null"], pattern: DATE },
          to: { type: ["string", "null"], pattern: DATE },
          band: numOrNull,
          threshold: numOrNull,
          dates: arrayOf(ref("date")),
          tags: arrayOf(ref("nightly_tag")),
          status: arrayOf({ type: "string", enum: ["complete", "partial", "missing"] }),
          levels: levelsOf("level_series"),
          fork: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["tags", "dates", "base_tags", "base_dates", "base_shas", "prev_tags", "step_tags", "levels"],
            properties: {
              tags: arrayOf(ref("fork_tag")),
              dates: arrayOf(ref("date")),
              base_tags: arrayOf({ type: ["string", "null"], pattern: `^v${VERSION_CORE}-nightly\\.20\\d{6}\\.\\d{1,6}$` }),
              base_dates: arrayOf({ type: ["string", "null"], pattern: DATE }),
              base_shas: arrayOf({ type: ["string", "null"], pattern: "^[0-9a-f]{40}$" }),
              prev_tags: arrayOf({ type: ["string", "null"], pattern: `^v${VERSION_CORE}-perf\\.\\d{1,3}$` }),
              step_tags: arrayOf({ type: ["string", "null"], pattern: `^v${VERSION_CORE}-perf\\.\\d{1,3}$` }),
              levels: levelsOf("fork_level"),
            },
          },
          eras: arrayOf(obj({ date: ref("date"), kind: { type: "string", enum: ["fixture", "harness", "profile", "compaction", "metric"] }, label: { type: "string", pattern: "^[A-Za-z0-9 .:/()-]{1,64}$" } })),
        },
        ["schema", "id", "platform", "shard", "generated_at", "from", "to", "band", "threshold", "dates", "tags", "status", "levels", "fork", "eras"],
      ),
    },
    defs,
  );

  const bandsEntry = obj(
    {
      band: { type: "number", minimum: 0, maximum: 10000 },
      n: int(2, 999),
      levels: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          CELLS.concat("once").map((level) => [level, obj({ band: { type: "number", minimum: 0, maximum: 10000 }, n: int(2, 999) })]),
        ),
      },
    },
    ["band", "n"],
  );
  defs.band_entry = bandsEntry;
  const bands = withDefs(
    {
      $id: "https://t3cp.io/schema/bands-1.json",
      title: "t3cp/bands/1: measured noise bands per platform and metric (percent), optionally per level",
      description:
        "band = (max - min) / median in percent over repeated identical attempts; the regression threshold is band + 5 points. A metric without an entry has no band and gets no verdict.",
      ...obj(
        {
          schema: { const: "t3cp/bands/1" },
          synthetic,
          method: { type: "string", pattern: "^[A-Za-z0-9 ,.;:()%/+=-]{1,400}$" },
          platforms: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(
              PLATFORM_IDS.map((p) => [
                p,
                obj(
                  {
                    pending: { const: true, description: "No bands measured yet for this platform: its records build with no verdicts (note no_band). Without this mark, a platform with records and no bands fails the build." },
                    measured: obj({ from: ref("date"), to: ref("date"), attempts: int(1, 9999), machines: int(1, 999), tag: ref("tag") }),
                    metrics: {
                      type: "object",
                      additionalProperties: false,
                      properties: Object.fromEntries(catalogue.metrics.map((m) => [m.id, ref("band_entry")])),
                    },
                  },
                  [],
                ),
              ]),
            ),
          },
        },
        ["schema", "method", "platforms"],
      ),
    },
    defs,
  );

  const change = obj({
    date: ref("date"),
    platform: ref("platform_id"),
    level: ref("series_level"),
    metric: ref("metric_id"),
    tag: ref("nightly_tag"),
    verdict: { type: "string", enum: ["regressed", "improved"] },
    value: num,
    reference: numOrNull,
    delta: numOrNull,
    band: numOrNull,
    threshold: numOrNull,
    thin: { type: "boolean" },
    dod_delta: numOrNull,
  });
  const changes = withDefs(
    {
      $id: "https://t3cp.io/schema/changes-1.json",
      title: "t3cp/changes/1: the changes feed, the last 90 days of verdicts where the 7-day and day-over-day verdicts agree",
      ...obj(
        {
          schema: { const: "t3cp/changes/1" },
          synthetic,
          generated_at: ref("datetime"),
          window_days: int(1, 366),
          from: { type: ["string", "null"], pattern: DATE },
          to: { type: ["string", "null"], pattern: DATE },
          items: arrayOf(change),
        },
        ["schema", "generated_at", "window_days", "from", "to", "items"],
      ),
    },
    defs,
  );

  const side = obj({ record_id: ref("record_id"), kind: ref("kind"), tag: ref("tag"), date: ref("date") });
  const compare = withDefs(
    {
      $id: "https://t3cp.io/schema/compare-1.json",
      title: "t3cp/compare/1: one precomputed comparison, b against a (fork vs base, fork vs previous fork, day over day)",
      ...obj(
        {
          schema: { const: "t3cp/compare/1" },
          synthetic,
          kind: { type: "string", enum: ["fork-vs-base", "fork-vs-prev", "day-over-day"] },
          platform: ref("platform_id"),
          a: side,
          b: side,
          rows: arrayOf(
            obj({
              metric: ref("metric_id"),
              level: ref("series_level"),
              a: numOrNull,
              b: numOrNull,
              delta: numOrNull,
              band: numOrNull,
              threshold: numOrNull,
              verdict: ref("verdict"),
              note: ref("note"),
            }),
          ),
        },
        ["schema", "kind", "platform", "a", "b", "rows"],
      ),
    },
    defs,
  );

  const catalogueEntry = obj({
    id: ref("metric_id"),
    name: { type: "string", maxLength: 120 },
    short: { type: "string", maxLength: 40 },
    group: { type: "string", enum: catalogue.groups.map((g) => g.id) },
    unit: { type: "string", maxLength: 20 },
    better: { type: "string", enum: ["lower", "higher", "context"] },
    definition: { type: "string", maxLength: 400 },
    lane: { type: "string", enum: ["daily", "record", "weekly", "release", "later"] },
    scope: { type: "string", enum: ["level", "record"] },
    form: { type: "string", enum: ["ts", "ladder", "bars", "slope"] },
    era_start: { type: ["string", "null"], pattern: DATE },
    upstream: { type: "string", enum: ["yes", "yes L", "pre", "fork"] },
    platforms: arrayOf(ref("platform_id")),
    na_on: arrayOf(ref("platform_id")),
    empty_cell: { type: "boolean" },
    gate: { type: "boolean" },
    counter: { type: ["string", "null"], enum: ["absolute", "rise", null] },
    headline: { type: ["integer", "null"], minimum: 1, maximum: 8 },
    source: obj({ file: { type: "string", maxLength: 40 }, field: { type: "string", maxLength: 200 } }),
    bands: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(PLATFORM_IDS.map((p) => [p, { type: ["object", "null"], additionalProperties: false, required: ["band", "threshold", "n"], properties: { band: num, threshold: num, n: int(2, 999) } }])),
    },
  });
  const statusRef = { type: "string", enum: ["complete", "partial", "missing"] };
  const platformRecord = obj({ record_id: ref("record_id"), status: statusRef, path: { type: "string", pattern: "^(records/(linux-x64|darwin-arm64)/[A-Za-z0-9.-]+|fork/[A-Za-z0-9.-]+|base/[A-Za-z0-9.-]+)\\.json$" } });
  const platformsMap = {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(PLATFORM_IDS.map((p) => [p, platformRecord])),
  };
  // records-index.json's entries also carry the aggregator's comparability, so no reader re-implements it.
  const comparableRecord = obj({
    ...platformRecord.properties,
    segment: {
      type: "object",
      additionalProperties: false,
      required: ["once"],
      description:
        "Per level the record has, an opaque id: two records compare at a level exactly when their ids there are equal (the same fixture era, harness, suite, profile, cell load arguments and compaction era; a record of unknown compaction era shares its ids with no other record). Each id is derived from its segment alone (48 bits of a hash), so adding or removing a record never changes another record's ids. Ids are shared across platforms: the platform is not part of the key, so a reader checks the platform first.",
      properties: Object.fromEntries(SERIES_LEVELS.map((L) => [L, int(0, 281474976710655)])),
    },
    banded: { type: "boolean", description: "Whether a noise band applies to the record's non-counter metrics: only in the scheduled compaction era. A band applies to a comparison only when both records are banded." },
  });
  const comparablePlatformsMap = {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(PLATFORM_IDS.map((p) => [p, comparableRecord])),
  };
  const index = withDefs(
    {
      $id: "https://t3cp.io/schema/index-1.json",
      title: "t3cp/index/1: the site's manifest",
      ...obj(
        {
          schema: { const: "t3cp/index/1" },
          synthetic,
          generated_at: ref("datetime"),
          schemas: obj({
            record: { const: "t3cp/record/1" },
            series: { const: "t3cp/series/1" },
            bands: { const: "t3cp/bands/1" },
            changes: { const: "t3cp/changes/1" },
            compare: { const: "t3cp/compare/1" },
          }),
          levels: arrayOf({ type: "integer" }),
          empty_cell: { const: "1e" },
          headline_levels: arrayOf({ type: "integer" }),
          default_headline_level: { type: "integer" },
          groups: arrayOf(obj({ id: { type: "string", pattern: "^[a-z]+$" }, name: { type: "string", maxLength: 60 } })),
          headlines: obj(Object.fromEntries(PLATFORM_IDS.map((p) => [p, arrayOf(ref("metric_id"), { minItems: 8, maxItems: 8 })]))),
          catalogue: arrayOf(catalogueEntry),
          platforms: arrayOf(
            obj({
              id: ref("platform_id"),
              name: { type: "string", maxLength: 40 },
              host: { type: "string", maxLength: 60 },
              live: { type: "boolean" },
              latest: { type: ["string", "null"], pattern: `^20\\d{2}-\\d{2}-\\d{2}\\.(linux-x64|darwin-arm64)\\.nightly$` },
              latest_date: { type: ["string", "null"], pattern: DATE },
              latest_tag: { type: ["string", "null"], pattern: `^v${VERSION_CORE}-nightly\\.20\\d{6}\\.\\d{1,6}$` },
              latest_status: { type: ["string", "null"], enum: ["complete", "partial", "missing", null] },
              records: int(0),
            }),
          ),
          eras: obj({
            fixture: arrayOf(obj({ id: { type: "string", pattern: "^large-\\d{2,3}$" }, from: ref("date"), to: { type: ["string", "null"], pattern: DATE }, migration: int(1, 9999) })),
            feature: arrayOf(obj({ id: { type: "string", pattern: "^[a-z_]+$" }, from: ref("date"), what: { type: "string", maxLength: 80 } })),
            harness: arrayOf(obj({ version: { type: "string", pattern: "^t3cp-harness/\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$" }, files_sha256: ref("sha256"), from: ref("date"), to: ref("date") })),
          }),
          fixtures: arrayOf(obj({ id: { type: "string", pattern: "^large-\\d{2,3}$" }, sha256: ref("sha256"), bytes: int(1), migration: int(1, 9999) })),
          records_index: { const: "records-index.json", description: "The file that lists every nightly record (t3cp/records-index/1); it is never part of the overview payload." },
          budgets: obj({
            overview_gz_bytes: {
              type: "object",
              additionalProperties: false,
              description: "Per platform with records, the overview payload as built (index.json, changes.json and the eight headline latest shards), in gzipped bytes; it counts this file too, so it may exceed its own size by a few bytes, never fall below it.",
              properties: Object.fromEntries(PLATFORM_IDS.map((p) => [p, int(0)])),
            },
            overview_limit_gz_bytes: int(1),
          }),
          fork: arrayOf(
            obj({
              tag: ref("fork_tag"),
              date: ref("date"),
              sha: ref("sha"),
              base_tag: { type: ["string", "null"], pattern: `^v${VERSION_CORE}-nightly\\.20\\d{6}\\.\\d{1,6}$` },
              base_date: { type: ["string", "null"], pattern: DATE },
              prev_tag: { type: ["string", "null"], pattern: `^v${VERSION_CORE}-perf\\.\\d{1,3}$` },
              base_sha: { type: ["string", "null"], pattern: "^[0-9a-f]{40}$" },
              base_record: { type: ["string", "null"], pattern: "^base/[0-9a-f]{12}\\.(linux-x64|darwin-arm64)\\.json$" },
              platforms: platformsMap,
            }),
          ),
          bases: arrayOf(obj({ sha: ref("sha"), date: ref("date"), tag: ref("tag"), platforms: platformsMap })),
          series: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(
              PLATFORM_IDS.map((p) => [
                p,
                { type: "object", propertyNames: ref("metric_id"), additionalProperties: arrayOf({ type: "string", pattern: "^(all|latest|20\\d{2})$" }) },
              ]),
            ),
          },
          compare: arrayOf({ type: "string", pattern: "^compare/[A-Za-z0-9.-]+__[A-Za-z0-9.-]+\\.(linux-x64|darwin-arm64)\\.json$" }),
          downloads: arrayOf(obj({ path: { type: "string", pattern: "^downloads/[a-z0-9.-]+$" }, bytes: int(0), sha256: ref("sha256") })),
        },
        [
          "schema", "generated_at", "schemas", "levels", "empty_cell", "headline_levels", "default_headline_level", "groups",
          "headlines", "catalogue", "platforms", "eras", "fixtures", "records_index", "budgets", "fork", "bases", "series", "compare", "downloads",
        ],
      ),
    },
    defs,
  );

  const bundleSide = { type: ["object", "null"], additionalProperties: false, required: ["tag", "date"], properties: { tag: { type: ["string", "null"], pattern: `^v${VERSION_CORE}${SUFFIX}?$` }, date: ref("date"), sha: { type: ["string", "null"], pattern: "^[0-9a-f]{40}$" } } };
  const bundleRowProps = {
    id: ref("metric_id"),
    name: { type: "string", maxLength: 120 },
    unit: { type: "string", maxLength: 20 },
    better: { type: "string", enum: ["lower", "higher", "context"] },
    headline: { type: ["integer", "null"], minimum: 1, maximum: 8 },
    platform: ref("platform_id"),
    level: ref("series_level"),
    fork: obj({ median: numOrNull, min: numOrNull, max: numOrNull, n: int(0, 9) }),
    base: { type: ["object", "null"], additionalProperties: false, required: ["median", "min", "max", "n"], properties: { median: numOrNull, min: numOrNull, max: numOrNull, n: int(0, 9) } },
    prev: { type: ["object", "null"], additionalProperties: false, required: ["median", "min", "max", "n"], properties: { median: numOrNull, min: numOrNull, max: numOrNull, n: int(0, 9) } },
    band_pct: numOrNull,
    threshold_pct: numOrNull,
    delta_pct: numOrNull,
    worse_pct: numOrNull,
    verdict: ref("verdict"),
    note: ref("note"),
    delta_vs_prev_pct: numOrNull,
    worse_vs_prev_pct: numOrNull,
    verdict_vs_prev: ref("verdict"),
    note_vs_prev: ref("note"),
    saturated: obj({ fork: { type: "boolean" }, base: { type: ["boolean", "null"] }, prev: { type: ["boolean", "null"] } }),
    text: obj({
      fork: { type: "string" },
      base: { type: ["string", "null"] },
      prev: { type: ["string", "null"] },
      delta_pct: { type: ["string", "null"] },
      band_pct: { type: ["string", "null"] },
      threshold_pct: { type: ["string", "null"] },
      delta_vs_prev_pct: { type: ["string", "null"] },
    }),
  };
  // saturated is required: without it the posts tooling cannot apply the saturated rule, so it would pass a verdict.
  const bundleRow = obj(bundleRowProps);
  const releaseBundle = withDefs(
    {
      $id: "https://t3cp.io/schema/release-bundle-1.json",
      title: "t3cp/release-bundle/1: the numbers for one fork release's post, from site/build/aggregate.mjs releaseBundle()",
      description:
        "delta_pct = (fork - base) / base in percent with its real sign; worse_pct is the same change sign-adjusted so positive means worse (the value the verdict rule compares with the threshold). text holds the display strings the prose may copy.",
      ...obj(
        {
          schema: { const: "t3cp/release-bundle/1" },
          synthetic,
          release: obj({ tag: ref("fork_tag"), date: ref("date"), sha: ref("sha") }),
          base: bundleSide,
          prev: bundleSide,
          platforms: arrayOf(ref("platform_id")),
          levels: arrayOf(ref("series_level")),
          counts: obj({ regressed: int(0), improved: int(0), within: int(0), no_verdict: int(0) }),
          metrics: arrayOf(bundleRow),
          allowed_numbers: arrayOf({ type: "string" }, { uniqueItems: true }),
          allowed_metric_names: arrayOf({ type: "string" }, { uniqueItems: true }),
        },
        ["schema", "release", "base", "prev", "platforms", "levels", "counts", "metrics", "allowed_numbers", "allowed_metric_names"],
      ),
    },
    defs,
  );

  const statusPlatform = obj({
    latest_record_id: { type: ["string", "null"], pattern: `^20\\d{2}-\\d{2}-\\d{2}\\.(linux-x64|darwin-arm64)\\.nightly$` },
    latest_date: { type: ["string", "null"], pattern: DATE },
    latest_status: { type: ["string", "null"], enum: ["complete", "partial", "missing", null] },
    queue: obj({ pending: int(0, 9999), active: int(0, 999) }),
    last_failure: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["record_id", "at", "reason"],
      properties: {
        record_id: ref("record_id"),
        at: ref("datetime"),
        reason: { type: "string", enum: STATUS_REASONS, description: STATUS_REASONS.map((r) => `${r}: ${STATUS_REASON_WORDS[r]}`).join("; ") },
      },
    },
    heartbeat_at: { type: ["string", "null"], pattern: DATETIME },
  });
  const status = withDefs(
    {
      $id: "https://t3cp.io/schema/status-1.json",
      title: "t3cp/status/1: the public pipeline state (data/v1/status.json, written by the ops tick): numbers, dates and reason codes only, no free text",
      ...obj(
        {
          schema: { const: "t3cp/status/1" },
          synthetic,
          generated_at: ref("datetime"),
          platforms: { type: "object", additionalProperties: false, properties: Object.fromEntries(PLATFORM_IDS.map((p) => [p, statusPlatform])) },
        },
        ["schema", "generated_at", "platforms"],
      ),
    },
    defs,
  );

  const recordsIndex = withDefs(
    {
      $id: "https://t3cp.io/schema/records-index-1.json",
      title: "t3cp/records-index/1: every nightly record, by date and tag (read by the compare page and the site build)",
      ...obj(
        {
          schema: { const: "t3cp/records-index/1" },
          synthetic,
          generated_at: ref("datetime"),
          records: arrayOf(obj({ date: ref("date"), tag: ref("nightly_tag"), sha: ref("sha"), platforms: comparablePlatformsMap })),
        },
        ["schema", "generated_at", "records"],
      ),
    },
    defs,
  );

  return {
    "status-1.json": status,
    "record-1.json": record,
    "attempt-1.json": attempt,
    "extras-1.json": extras,
    "facts-1.json": facts,
    "series-1.json": series,
    "index-1.json": index,
    "records-index-1.json": recordsIndex,
    "bands-1.json": bands,
    "changes-1.json": changes,
    "compare-1.json": compare,
    "release-bundle-1.json": releaseBundle,
    "scenario-attempt-1.json": scenarioAttempt,
    "scenario-record-1.json": scenarioRecord,
  };
}

/** Serialises a schema the way the committed files are written. */
export const serialise = (schema) => `${JSON.stringify(schema, null, 2)}\n`;

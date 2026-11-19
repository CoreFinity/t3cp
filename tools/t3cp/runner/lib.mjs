// t3cp record runner: the JSON side of run-record.sh (no dependencies; Node 22 or later).
//   validate <spec> <schema>              exit 2 with the errors when the spec breaks the schema
//   spec-sh <spec>                        shell assignments for run-record.sh (values single-quoted); a scenario
//                                         suite gives SCENARIO_REF (id@version), its order is the catalogue row's
//   write-new <dir> <t:key=value>...      the same as a new <dir>/<UTC timestamp>.json, never over a file; prints it
//   write-json <file> <t:key=value>...    an object from typed pairs, written atomically; t is s (string),
//                                         i (integer), f (number), b (bool), j (JSON), @ (a JSON file), n (null)
//   cpu-model <cpuinfo>                   the first "model name"
//   window <raw attempt dir>              {start, end, run} of the valid run.ts run (else the last one), ms
//   guard <host-guard.ndjson> <start ms> <end ms>   the host guard over the window and the contamination verdict
//   finish-try <raw> <try> <started> <ended> <ms> <exit> [<class>]   window, guard, maintenance -> <raw>/try.json;
//                                         prints contaminated
//   maintenance-class <server binary>     compaction scheduling of the release (maintenance.mjs)
//   version-at-least <name/X.Y.Z> <name/X.Y.Z>   exit 0 when the first is the second or later
//   private-patterns                      exit 0 when T3CP_PRIVATE_PATTERNS is usable (the exporter's loader)
//   diagnostics-attempt <raw> <dir> <exporter exit> [<export log>]   a failed attempt's bundle (diagnostics.mjs)
//   diagnostics-runner <work> <dir> <record id> <reason> <detail>    a failed runner's bundle
//   inventory <out> <spec>                {attempts: [{cell, n, present}], extras: [{name, present}]} (a scenario
//                                         record's from its row, in T3CP_SCENARIOS or the repository's scenarios.json)
//   host <spec>                           host facts for attempt-meta.json
//   sha256 <file>                         hex digest, streamed
import { createHash } from "node:crypto";
import { createReadStream, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { maintenanceClass, tryMaintenance } from "./maintenance.mjs";
import { isMain } from "./is-main.mjs";
import { loadCatalogue, scenarioOrder, scenarioRow } from "./scenarios.mjs";
import { attemptDiagnostics, attemptReasons, runnerDiagnostics, scrubber } from "./diagnostics.mjs";
import { privatePatternsFromEnv } from "../lib/scan.mjs";

export const EXTRAS = ["startup", "migration", "snapshot", "first_turn"];
export const RUNNER_VERSION = "t3cp-runner/1.0.0";

// Contamination thresholds (share of the whole host, window means), overridable for calibration.
export const GUARD_DEFAULTS = { foreign_pct_mean_max: 3, steal_pct_mean_max: 2 };

/** A JSON Schema subset: the keywords schema/record-spec-1.json uses. Returns error strings. */
export function validate(value, schema, path = "$", root = schema) {
  const errors = [];
  const type = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (schema.$ref) return validate(value, resolveRef(root, schema.$ref), path, root);
  if (schema.type) {
    const t = type(value);
    const ok = schema.type === t || (schema.type === "number" && (t === "integer" || t === "number"));
    if (!ok) return [`${path}: expected ${schema.type}, got ${t}`];
  }
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
    if (!Number.isFinite(value)) errors.push(`${path}: not finite`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${path}: items not unique`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items, `${path}[${i}]`, root)));
  }
  if (type(value) === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}: missing ${key}`);
    for (const [key, v] of Object.entries(value)) {
      if (schema.properties && key in schema.properties) errors.push(...validate(v, schema.properties[key], `${path}.${key}`, root));
      else if (schema.additionalProperties === false) errors.push(`${path}: unknown key ${key}`);
    }
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((s) => validate(value, s, path, root).length === 0).length;
    if (passing !== 1) errors.push(`${path}: matches ${passing} of the oneOf alternatives, not exactly one`);
  }
  for (const sub of schema.allOf ?? []) {
    if (sub.if) {
      if (validate(value, sub.if, path, root).length === 0 && sub.then) errors.push(...validate(value, sub.then, path, root));
    } else errors.push(...validate(value, sub, path, root));
  }
  return errors;
}

function resolveRef(root, ref) {
  return ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((node, key) => node[key], root);
}

/** Platform of the host as record ids name it, or null. */
export function hostPlatform() {
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  return null;
}

/** The scenario catalogue the runner reads: T3CP_SCENARIOS (run-record.sh sets it), else the repository's own. */
export const scenarioCatalogue = () => process.env.T3CP_SCENARIOS || fileURLToPath(new URL("../../../scenarios.json", import.meta.url));

/** A scenario suite's row reference, id@version, or null for the ladder. */
export const scenarioRef = (suite) => (suite?.scenario ? `${suite.scenario.id}@${suite.scenario.version}` : null);

/** The record's attempts: the ladder's interleaved order, or a scenario row's (from the catalogue). */
export function specOrder(spec, catalogue = scenarioCatalogue()) {
  const ref = scenarioRef(spec.suite);
  return ref === null ? attemptOrder(spec.suite) : scenarioOrder(scenarioRow(loadCatalogue(catalogue), ref));
}

/** The interleaved order: every level, then the empty cell, round after round. */
export function attemptOrder(suite) {
  const order = [];
  for (let n = 1; n <= suite.attempts_per_level; n++) {
    for (const level of suite.levels) order.push({ cell: `${level}-${n}`, name: String(level), n, level });
    if (suite.empty_cell) order.push({ cell: `1e-${n}`, name: "1e", n, level: 1 });
  }
  return order;
}

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

export function specShell(spec) {
  const platform = spec.record_id.split(".").at(-2);
  // A scenario suite: its order and timings are the row's, which run-record.sh reads from the catalogue (SC_*, P_*).
  const scenario = scenarioRef(spec.suite);
  const fixture = spec.fixture.id === "none" ? { id: "none", path: "", sha256: "", migration: "" } : spec.fixture;
  const vars = {
    RECORD_ID: spec.record_id,
    KIND: spec.kind,
    PLATFORM: platform,
    REL_TAG: spec.release.tag,
    REL_SHA: spec.release.sha,
    REL_VERSION: spec.release.version,
    REL_ARCHIVE_NAME: spec.release.archive_name,
    REL_ARCHIVE_SHA256: spec.release.archive_sha256,
    REL_ARCHIVE_PATH: spec.release.archive_path,
    FX_ID: fixture.id,
    FX_PATH: fixture.path,
    FX_SHA256: fixture.sha256,
    FX_MIGRATION: fixture.migration,
    SUITE_ID: spec.suite.id,
    PROFILE: spec.suite.profile ?? "",
    WARMUP_S: spec.suite.warmup_s ?? "",
    WINDOW_S: spec.suite.window_s ?? "",
    EXTRAS: scenario !== null || spec.suite.extras === false ? 0 : 1,
    NOW: spec.now,
    SEED: spec.seed,
    LEASE: spec.lease ?? 0,
    CPU_MODEL_EXPECTED: spec.cpu_model ?? (platform === "linux-x64" ? "AMD EPYC 7B13" : ""),
    ORDER: scenario === null ? attemptOrder(spec.suite).map((a) => a.cell).join(" ") : "",
    ATTEMPTS_TOTAL: scenario === null ? attemptOrder(spec.suite).length : 0,
    SCENARIO_REF: scenario ?? "",
  };
  return Object.entries(vars)
    .map(([k, v]) => `${k}=${shq(v)}`)
    .join("\n");
}

export function typedObject(pairs) {
  const out = {};
  for (const pair of pairs) {
    const match = /^([sifbj@n]):([A-Za-z0-9_.]+)=(.*)$/s.exec(pair);
    if (!match) throw new Error(`bad pair ${pair}`);
    const [, t, key, raw] = match;
    let value;
    if (t === "s") value = raw;
    else if (t === "i") value = raw === "" ? null : Number.parseInt(raw, 10);
    else if (t === "f") value = raw === "" ? null : Number(raw);
    else if (t === "b") value = raw === "true" || raw === "1";
    else if (t === "j") value = JSON.parse(raw);
    else if (t === "@") value = existsSync(raw) ? JSON.parse(readFileSync(raw, "utf8")) : null;
    else value = null;
    if ((t === "i" || t === "f") && value !== null && !Number.isFinite(value)) throw new Error(`not a number: ${pair}`);
    const parts = key.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = value;
  }
  return out;
}

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(tmp, file);
}

/** UTC timestamp for file names: 20261116T003512345Z. */
export const stamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, "").replace(".", "");

/** A new file <dir>/<timestamp>.json (or -1, -2 ... on a clash): created whole, never over an existing one. */
export function writeNew(dir, value, at = new Date()) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  const name = stamp(at);
  try {
    for (let k = 0; k < 1000; k++) {
      const file = join(dir, `${name}${k === 0 ? "" : `-${k}`}.json`);
      try {
        linkSync(tmp, file);
        return file;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    throw new Error("no free name");
  } finally {
    unlinkSync(tmp);
  }
}

/** The newest <timestamp>.json in dir, or null. */
export function newest(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^\d{8}T\d{9}Z(-\d+)?\.json$/.test(f));
  files.sort((a, b) => {
    const [an, ak = 0] = a.replace(".json", "").split("-");
    const [bn, bk = 0] = b.replace(".json", "").split("-");
    return an === bn ? Number(ak) - Number(bk) : an < bn ? -1 : 1;
  });
  return files.length ? join(dir, files.at(-1)) : null;
}

export function cpuModel(cpuinfo) {
  const match = /^model name\s*:\s*(.+)$/m.exec(readFileSync(cpuinfo, "utf8"));
  return match ? match[1].trim() : null;
}

const iso = (text) => (text ? Date.parse(text) : Number.NaN);

/** The window of the run run.ts counted (run = its attempt number): the last valid run, else the last run. */
export function attemptWindow(raw) {
  const runs = join(raw, "work", "runs", "release");
  if (!existsSync(runs)) return { start: null, end: null, run: null, valid: false };
  const dirs = readdirSync(runs)
    .filter((d) => /^attempt-\d+$/.test(d))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  let chosen = null;
  for (const d of dirs) {
    const file = join(runs, d, "run.json");
    if (!existsSync(file)) continue;
    let run;
    try {
      run = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const start = iso(run.window?.start);
    const end = iso(run.window?.end);
    const entry = { start: Number.isFinite(start) ? start : null, end: Number.isFinite(end) ? end : null, run: Number(d.slice(8)), valid: run.valid === true };
    if (entry.valid || chosen === null || !chosen.valid) chosen = entry;
  }
  return chosen ?? { start: null, end: null, run: null, valid: false };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const max = (xs) => (xs.length ? Math.max(...xs) : null);
const r3 = (x) => (x === null ? null : Math.round(x * 1000) / 1000);

/** Host guard over [start, end] (ms) from host-guard.ndjson rows; the window is the measured one. */
export function guardSummary(rows, start, end, thresholds = GUARD_DEFAULTS) {
  // A sample at t covers the second before it; it counts when that second's midpoint is inside the window.
  const inWindow = rows.filter((r) => r.t !== undefined && (start === null || r.t - 500 >= start) && (end === null || r.t - 500 <= end));
  const col = (k) => inWindow.map((r) => r[k]).filter((v) => typeof v === "number" && Number.isFinite(v));
  const foreign = col("foreign_pct");
  const method = rows.some((r) => r.meta) ? (rows.find((r) => r.meta).meta.cgroup ? "proc-stat-cgroup" : "proc-stat") : "none";
  const summary = {
    method,
    samples: inWindow.length,
    window_start_ms: start,
    window_end_ms: end,
    busy_pct_mean: r3(mean(col("busy_pct"))),
    busy_pct_max: r3(max(col("busy_pct"))),
    foreign_pct_mean: r3(mean(foreign)),
    foreign_pct_max: r3(max(foreign)),
    steal_pct_mean: r3(mean(col("steal_pct"))),
    steal_pct_max: r3(max(col("steal_pct"))),
    iowait_pct_mean: r3(mean(col("iowait_pct"))),
    iowait_pct_max: r3(max(col("iowait_pct"))),
    thresholds,
  };
  const reasons = [];
  if (summary.foreign_pct_mean !== null && summary.foreign_pct_mean > thresholds.foreign_pct_mean_max) reasons.push("foreign_cpu");
  if (summary.steal_pct_mean !== null && summary.steal_pct_mean > thresholds.steal_pct_mean_max) reasons.push("steal");
  // A guard that cannot judge fails closed: no samples, none in the window, or no foreign CPU or steal figures (no
  // cgroup to tell the runner's own CPU apart) give contaminated null, never false (the exporter: host_guard_unavailable).
  if (method === "none" || inWindow.length === 0 || foreign.length === 0 || col("steal_pct").length === 0) {
    return { host_guard: summary, contaminated: null, contamination_reasons: [], notes: ["host_guard_unavailable"] };
  }
  return { host_guard: summary, contaminated: reasons.length > 0, contamination_reasons: reasons, notes: [] };
}

export function inventory(out, spec) {
  const attempts = specOrder(spec).map((a) => ({
    cell: a.name,
    n: a.n,
    present: existsSync(join(out, "attempts", a.cell, "attempt.json")),
  }));
  // A scenario record has no record extras.
  const extras =
    spec.suite.extras === false || scenarioRef(spec.suite) !== null
      ? []
      : EXTRAS.map((name) => ({ name, present: existsSync(join(out, "extras", `${name}.json`)) }));
  return { attempts, extras };
}

export function osName() {
  try {
    const text = readFileSync("/etc/os-release", "utf8");
    const field = (k) => new RegExp(`^${k}="?([^"\\n]*)"?$`, "m").exec(text)?.[1] ?? null;
    const name = field("NAME")?.replace(/ GNU\/Linux$/, "") ?? null;
    const version = field("VERSION_ID");
    return name && version ? `${name} ${version}` : name;
  } catch {
    return process.platform === "darwin" ? "macOS" : null;
  }
}

export function hostFacts(spec, cpuinfo) {
  let model = null;
  try {
    model = cpuModel(cpuinfo);
  } catch {
    model = cpus()[0]?.model?.trim() ?? null;
  }
  return {
    cpu_model: model,
    cores: cpus().length,
    memory_gib: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    kernel: release(),
    os: osName(),
    machine: spec.host?.machine ?? null,
    provisioning: spec.host?.provisioning ?? null,
    runtime_node: process.versions.node,
  };
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file, { highWaterMark: 8 * 1024 * 1024 })
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const readRows = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        })
    : [];

/** Whether "name/X.Y.Z" is the same name as the minimum at its version or later. */
export function versionAtLeast(version, minimum) {
  const parse = (v) => /^([a-z0-9-]+)\/(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? ""));
  const a = parse(version);
  const b = parse(minimum);
  if (!a || !b || a[1] !== b[1]) return false;
  for (let i = 2; i <= 4; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  }
  return true;
}

/** The diagnostics' scrub: the private list when one is set; a list that is set but unusable lets no log text through. */
function diagnosticsScrub() {
  try {
    return scrubber({ patterns: privatePatternsFromEnv() ?? [] });
  } catch {
    return () => "[not scrubbable: the private pattern list is unusable]";
  }
}

async function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "validate": {
      let spec;
      try {
        spec = readJson(args[0]);
      } catch (error) {
        process.stderr.write(`spec is not JSON: ${error.message}\n`);
        return 2;
      }
      const errors = validate(spec, readJson(args[1]));
      if (errors.length > 0) {
        for (const e of errors) process.stderr.write(`${e}\n`);
        return 2;
      }
      return 0;
    }
    case "spec-sh":
      process.stdout.write(`${specShell(readJson(args[0]))}\n`);
      return 0;
    case "host-platform":
      process.stdout.write(`${hostPlatform() ?? ""}\n`);
      return 0;
    case "write-json":
      writeJsonAtomic(args[0], typedObject(args.slice(1)));
      return 0;
    case "write-new":
      // write-new <dir> <typed pairs>: a new <timestamp>.json there; prints its path
      process.stdout.write(`${writeNew(args[0], typedObject(args.slice(1)))}\n`);
      return 0;
    case "cpu-model":
      process.stdout.write(`${cpuModel(args[0]) ?? ""}\n`);
      return 0;
    case "window":
      process.stdout.write(`${JSON.stringify(attemptWindow(args[0]))}\n`);
      return 0;
    case "guard": {
      const num = (v) => (v === "" || v === "null" || v === undefined ? null : Number(v));
      const thresholds = {
        foreign_pct_mean_max: Number(process.env.T3CP_GUARD_FOREIGN_PCT ?? GUARD_DEFAULTS.foreign_pct_mean_max),
        steal_pct_mean_max: Number(process.env.T3CP_GUARD_STEAL_PCT ?? GUARD_DEFAULTS.steal_pct_mean_max),
      };
      process.stdout.write(`${JSON.stringify(guardSummary(readRows(args[0]), num(args[1]), num(args[2]), thresholds))}\n`);
      return 0;
    }
    case "finish-try": {
      // finish-try <raw> <try> <started> <ended> <ms> <run.ts exit> [<maintenance class>]: the window, the host guard
      // over it, the compaction passes in it (maintenance.mjs), try.json; prints whether the try is contaminated
      const [raw, tryN, started, ended, ms, rc, cls] = args;
      const window = attemptWindow(raw);
      const maintenance = await tryMaintenance(raw, window, cls === undefined || cls === "-" ? null : cls);
      const thresholds = {
        foreign_pct_mean_max: Number(process.env.T3CP_GUARD_FOREIGN_PCT ?? GUARD_DEFAULTS.foreign_pct_mean_max),
        steal_pct_mean_max: Number(process.env.T3CP_GUARD_STEAL_PCT ?? GUARD_DEFAULTS.steal_pct_mean_max),
      };
      const guard = guardSummary(readRows(join(raw, "host-guard.ndjson")), window.start, window.end, thresholds);
      writeJsonAtomic(join(raw, "try.json"), {
        try: Number(tryN),
        started_at: started,
        ended_at: ended,
        cycle_s: Number(ms) / 1000,
        run_ts_exit: Number(rc),
        window,
        window_start_ms: window.start,
        window_end_ms: window.end,
        valid_run: window.run,
        host_guard: guard.host_guard,
        contaminated: guard.contaminated,
        contamination_reasons: guard.contamination_reasons,
        guard_notes: guard.notes,
        maintenance_in_window: maintenance,
      });
      process.stdout.write(`${guard.contaminated}\n`);
      return 0;
    }
    case "diagnostics-attempt": {
      // diagnostics-attempt <raw> <dir> <exporter exit> [<export log>]: when the attempt failed or is invalid, a new
      // <dir>/<UTC timestamp>.json (diagnostics.mjs, for the private bucket only); prints its path, else nothing
      const [raw, dir, rc, exportLog] = args;
      const meta = readJson(join(raw, "attempt-meta.json"));
      const reasons = attemptReasons(meta, rc);
      if (reasons.length === 0) return 0;
      const bundle = attemptDiagnostics(raw, meta, { reasons, scrub: diagnosticsScrub(), exportLog: exportLog || null });
      process.stdout.write(`${writeNew(dir, bundle)}\n`);
      return 0;
    }
    case "diagnostics-runner": {
      // diagnostics-runner <work> <dir> <record id> <reason> <detail>: a new <dir>/<UTC timestamp>.json; prints its path
      const [work, dir, recordId, reason, detail] = args;
      const bundle = runnerDiagnostics(work, { record_id: recordId, reason, detail }, { scrub: diagnosticsScrub() });
      process.stdout.write(`${writeNew(dir, bundle)}\n`);
      return 0;
    }
    case "private-patterns": {
      // private-patterns: exit 0 when T3CP_PRIVATE_PATTERNS names a usable private pattern list (the exporter's own
      // loader), else exit 1 with why (the message never holds a pattern)
      try {
        if (privatePatternsFromEnv() === null) throw new Error("T3CP_PRIVATE_PATTERNS is not set");
      } catch (error) {
        process.stderr.write(`private pattern list: ${error.message}\n`);
        return 1;
      }
      return 0;
    }
    case "version-at-least": {
      // version-at-least <name/X.Y.Z> <name/X.Y.Z>: exit 0 when the first is the same name at the second's version or
      // later, 1 otherwise (another name, or a version that is not X.Y.Z)
      return versionAtLeast(args[0], args[1]) ? 0 : 1;
    }
    case "maintenance-class": {
      // maintenance-class <server binary>: how the release schedules compaction (maintenance.mjs), "-" without a binary
      process.stdout.write(`${(await maintenanceClass(args[0])) ?? "-"}\n`);
      return 0;
    }
    case "runner-identity": {
      // runner-identity <tools/t3cp dir>: {version, files_sha256} of run-record.sh and the runner's files (no tests)
      const root = args[0];
      const files = ["run-record.sh", ...readdirSync(join(root, "runner"))
        .filter((f) => !/\.test\.mjs$/.test(f) && f !== "testdata" && !f.startsWith("."))
        .map((f) => `runner/${f}`)]
        .filter((f) => statSync(join(root, f)).isFile())
        .sort();
      const hash = createHash("sha256");
      for (const f of files) hash.update(`${f}\0${await sha256File(join(root, f))}\n`);
      process.stdout.write(`${JSON.stringify({ version: RUNNER_VERSION, files_sha256: hash.digest("hex") })}\n`);
      return 0;
    }
    case "inventory":
      process.stdout.write(`${JSON.stringify(inventory(args[0], readJson(args[1])))}\n`);
      return 0;
    case "host":
      process.stdout.write(`${JSON.stringify(hostFacts(readJson(args[0]), args[1] ?? "/proc/cpuinfo"))}\n`);
      return 0;
    case "sha256":
      process.stdout.write(`${await sha256File(args[0])}\n`);
      return 0;
    case "merge-tries": {
      // merge-tries <out> <try.json>... -- <typed pairs>: attempt-meta.json from the runner's facts and its tries
      const split = args.indexOf("--");
      const files = args.slice(1, split < 0 ? undefined : split);
      const tries = files.filter((f) => existsSync(f)).map(readJson);
      const last = tries.at(-1) ?? {};
      const meta = typedObject(split < 0 ? [] : args.slice(split + 1));
      Object.assign(meta, {
        started_at: tries[0]?.started_at ?? null,
        ended_at: last.ended_at ?? null,
        cycle_s: tries.length ? Math.round(tries.reduce((t, x) => t + (x.cycle_s ?? 0), 0) * 1000) / 1000 : null,
        run_ts_exit: last.run_ts_exit ?? null,
        window_start_ms: last.window_start_ms ?? null,
        window_end_ms: last.window_end_ms ?? null,
        valid_run: last.valid_run ?? null,
        host_guard: last.host_guard ?? null,
        contaminated: last.contaminated ?? null,
        contamination_reasons: last.contamination_reasons ?? [],
        host_guard_max_busy_pct: tries.reduce((m, x) => Math.max(m, x.host_guard?.busy_pct_max ?? -Infinity), -Infinity),
        maintenance_in_window: last.maintenance_in_window ?? null,
        tries,
      });
      if (!Number.isFinite(meta.host_guard_max_busy_pct)) meta.host_guard_max_busy_pct = null;
      writeJsonAtomic(args[0], meta);
      return 0;
    }
    case "write-done": {
      // write-done <out> <spec> <host.json> <timings.json>: done.json, complete when every attempt and extra is present
      const spec = readJson(args[1]);
      const inv = inventory(args[0], spec);
      const missing = [...inv.attempts.filter((a) => !a.present).map((a) => `${a.cell}-${a.n}`), ...inv.extras.filter((e) => !e.present).map((e) => e.name)];
      writeJsonAtomic(join(args[0], "done.json"), {
        schema: "t3cp/done/1",
        record_id: spec.record_id,
        lease: spec.lease ?? null,
        status: missing.length === 0 ? "complete" : "partial",
        missing,
        attempts: inv.attempts,
        extras: inv.extras,
        host: readJson(args[2]),
        timings: readJson(args[3]),
      });
      process.stdout.write(`${missing.length === 0 ? "complete" : "partial"}\n`);
      return 0;
    }
    case "foreign-work": {
      // foreign-work <out> <runner.json>: each attempt and extra in <out> this runner did not make, one per line as
      // "<path> <why>": other_runner (its pipeline names another runner), no_runner_identity (none, or not a
      // well-formed one), unreadable. A run reuses only its own work, so any line fails the record closed.
      const out = args[0];
      const me = readJson(args[1]);
      const files = [];
      if (existsSync(join(out, "attempts"))) {
        for (const cell of readdirSync(join(out, "attempts")).sort()) {
          if (existsSync(join(out, "attempts", cell, "attempt.json"))) files.push(`attempts/${cell}/attempt.json`);
        }
      }
      if (existsSync(join(out, "extras"))) {
        for (const name of readdirSync(join(out, "extras")).sort()) {
          if (name.endsWith(".json") && statSync(join(out, "extras", name)).isFile()) files.push(`extras/${name}`);
        }
      }
      const lines = [];
      for (const rel of files) {
        let doc;
        try {
          doc = readJson(join(out, rel));
        } catch {
          lines.push(`${rel} unreadable`);
          continue;
        }
        const version = doc?.pipeline?.runner_version;
        const sha = doc?.pipeline?.runner_files_sha256;
        if (typeof version !== "string" || typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) lines.push(`${rel} no_runner_identity`);
        else if (version !== me.version || sha !== me.files_sha256) lines.push(`${rel} other_runner`);
      }
      if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
      return 0;
    }
    case "stamp-runner": {
      // stamp-runner <extras doc> <runner.json>: the exporter leaves an extra's pipeline runner fields null (it does
      // not know the runner); the runner that made the extra names itself there, so a later run can tell its own work.
      // A doc that already names a runner keeps it (exit 1 when that is another one).
      const doc = readJson(args[0]);
      const me = readJson(args[1]);
      const pipeline = doc.pipeline ?? {};
      if (pipeline.runner_version == null && pipeline.runner_files_sha256 == null) {
        writeJsonAtomic(args[0], { ...doc, pipeline: { ...pipeline, runner_version: me.version, runner_files_sha256: me.files_sha256 } });
        return 0;
      }
      return pipeline.runner_version === me.version && pipeline.runner_files_sha256 === me.files_sha256 ? 0 : 1;
    }
    case "startup-timed-out": {
      // startup-timed-out <startup.json> <runs> <budget_s>: a startup extra stopped at its timeout keeps the starts
      // it wrote and says timed_out; one stopped before it wrote any gets an empty one (never a 0).
      const file = args[0];
      const doc = existsSync(file) ? readJson(file) : { schema: "t3cp/extras-startup/1", runs: Number(args[1]), budget_s: Number(args[2]), starts: [], summary: {} };
      writeJsonAtomic(file, { ...doc, timed_out: true });
      return 0;
    }
    case "heartbeat": {
      // heartbeat <out> <spec|-> <record_id> <lease> <state> <cell|-> <total> [<ms taken just before the state was
      // read>]: a new heartbeats/<UTC timestamp>.json named for that moment, so a slow write of an older state never
      // sorts after a newer state's heartbeat
      const [out, specFile, recordId, lease, state, cell, total, readAt] = args;
      const at = readAt && /^\d+$/.test(readAt) ? new Date(Number(readAt)) : new Date();
      // A spec whose attempts cannot be listed (a scenario row the catalogue does not have) counts none done: the
      // heartbeat of its refusal is still written.
      let done = 0;
      try {
        if (specFile !== "-") done = inventory(out, readJson(specFile)).attempts.filter((a) => a.present).length;
      } catch {
        done = 0;
      }
      const file = writeNew(join(out, "heartbeats"), {
        schema: "t3cp/heartbeat/1",
        record_id: recordId,
        lease: Number(lease),
        state,
        cell: cell === "-" ? null : cell,
        attempts_done: done,
        attempts_total: Number(total),
        updated_at: at.toISOString().replace(/\.\d{3}Z$/, "Z"),
      }, at);
      process.stdout.write(`${file}\n`);
      return 0;
    }
    case "count-done":
      process.stdout.write(`${inventory(args[0], readJson(args[1])).attempts.filter((a) => a.present).length}\n`);
      return 0;
    case "json-get": {
      // json-get <file> <dotted.key>: a scalar as text, anything else as JSON, missing as empty
      let node = readJson(args[0]);
      for (const part of args[1].split(".")) node = node?.[part];
      process.stdout.write(node === undefined || node === null ? "\n" : typeof node === "object" ? `${JSON.stringify(node)}\n` : `${node}\n`);
      return 0;
    }
    default:
      process.stderr.write(`lib.mjs: unknown command ${command}\n`);
      return 2;
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`lib.mjs: ${error?.stack ?? error}\n`);
      process.exit(1);
    },
  );
}


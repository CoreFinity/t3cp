#!/usr/bin/env node
// The aggregator: reads the committed inputs under data/v1 (records/<platform>/<date>.<tag>.json,
// fork/<tag>.<platform>.json, base/<sha12>.<platform>.json, fork-nightly/<platform>/<date>.<tag>.json, bands.json,
// status.json) and nothing else: a derived file there fails the build. Nightly fork-head records (fork-nightly/) are the
// fork's latest release measured on a nightly's night: they give the fork step its measured value on those nights,
// records-index.json's fork_heads and a fork-head-vs-nightly comparison per night. It validates and scans every record, computes the design §4 verdicts and writes a
// complete public tree into the output directory (never under data/):
//
//   index.json, changes.json, series/<platform>/<metric>.latest.json and .all.json (or year shards when .all is
//   over budget), compare/<a>__<b>.<platform>.json, downloads/records.ndjson.gz, downloads/series.csv.gz, and the
//   inputs copied byte for byte. Release posts and the MRs list are written into the same output afterwards by
//   their own builders.
//
//   node site/build/aggregate.mjs --in data/v1 --out <dir> [--dev]
//
// Determinism: the same inputs give byte-identical output (no wall-clock time; generated_at is the newest
// record's pipeline.generated_at; gzip with a fixed header). Budgets (gzipped bytes) are enforced and the build
// fails over any of them. Synthetic files are refused unless --dev, and --dev refuses inputs under data/.
//
// The browser never computes a verdict: everything below is written into the shards.
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { formatSafeErrors, parseJsonStrict, schemaErrors } from "../../tools/t3cp/lib/safe-errors.mjs";
import { ScanConfigError, scanCsvText, scanJsonText, scanText, scanValue } from "../../tools/t3cp/lib/scan.mjs";
import { cellSaturated, loadPublicRefs } from "../../tools/t3cp/merge.mjs";
import { REPO_ROOT, isMain, loadCatalogue as loadCatalogueFile, loadScenarios, loadSchema, median } from "../../tools/t3cp/lib/repo.mjs";
import { ladderFeatureEras, scenarioLoad } from "../../tools/t3cp/lib/scenarios.mjs";

export { ladderFeatureEras };
import { EXTRAS_REASONS, PLATFORM_IDS, PROBLEMS, forkHeadProblem } from "../../tools/t3cp/lib/schemas.mjs";

export class BuildError extends Error {}

/** catalogue/catalogue.json (ids, names, units, direction, lanes, eras, headlines). */
export const loadCatalogue = () => loadCatalogueFile();

const KB = 1024;
/** Size budgets, design §5.6, in gzipped bytes (the transfer size). First matching prefix wins. */
export const BUDGETS = [
  { prefix: "index.json", limit: 64 * KB },
  { prefix: "records-index.json", limit: 128 * KB },
  { prefix: "bands.json", limit: 16 * KB },
  { prefix: "status.json", limit: 8 * KB },
  { prefix: "changes.json", limit: 32 * KB },
  { prefix: "mrs.json", limit: 32 * KB },
  { prefix: "series/", limit: 64 * KB },
  { prefix: "records/", limit: 256 * KB },
  { prefix: "fork/", limit: 256 * KB },
  { prefix: "compare/", limit: 48 * KB },
  { prefix: "releases/", limit: 48 * KB },
  { prefix: "scenarios/index.json", limit: 32 * KB },
  { prefix: "scenarios/", limit: 64 * KB },
];
/** The overview's data payload: index.json, changes.json and the eight headline latest shards. */
export const OVERVIEW_LIMIT = 100 * KB;
/** Past this share of the overview limit the build warns (and index.json's budgets let the freshness check alert). */
export const OVERVIEW_WARN_SHARE = 0.8;
const LATEST_DAYS = 90;
const CHANGES_DAYS = 90;
const LADDER = ["1", "50", "100", "150", "200", "250"];
const LEVEL_ORDER = [...LADDER, "1e", "once"];
const MARKER = ".t3cp-aggregate";
/** Files that exist only in the build output; one of them committed under the input tree fails the build. */
const DERIVED = new Set(["index.json", "records-index.json", "changes.json", "series", "compare", "downloads", "releases", "mrs.json", MARKER]);

// ---------------------------------------------------------------------------------------------------------
// small helpers

const gzip = (bytes) => {
  const out = zlib.gzipSync(bytes, { level: 9 });
  out[9] = 3; // OS byte: fixed, so the bytes do not depend on the build machine
  return out;
};
const gzSize = (bytes) => zlib.gzipSync(bytes, { level: 9 }).length;
const json = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const round2 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const round3 = (x) => (x === null || !Number.isFinite(x) ? null : Math.abs(x) < 100 ? Math.round(x * 1000) / 1000 : Math.round(x * 10) / 10);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
const byKey = (key) => (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const perfNumber = (tag) => Number(/-perf\.(\d+)$/.exec(tag)?.[1] ?? 0);
const versionKey = (tag) => tag.slice(1).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? x.padStart(8, "0") : x)).join(".");

/** Checks every file against the budgets (gzipped bytes); throws BuildError naming the first file over budget. */
export function checkBudgets(files, budgets = BUDGETS) {
  const sizes = new Map();
  for (const [rel, bytes] of files) {
    if (rel.startsWith("downloads/") || rel === MARKER) continue;
    const budget = budgets.find((b) => (b.prefix.endsWith("/") ? rel.startsWith(b.prefix) : rel === b.prefix));
    if (budget === undefined) continue;
    const size = gzSize(bytes);
    sizes.set(rel, size);
    if (size > budget.limit) throw new BuildError(`${rel}: ${size} bytes gzipped, over budget ${budget.limit}`);
  }
  return sizes;
}

// ---------------------------------------------------------------------------------------------------------
// inputs

function walkFiles(root, rel = "") {
  const out = [];
  const dir = path.join(root, rel);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byKey((e) => e.name))) {
    const r = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(root, r));
    else if (entry.isFile()) out.push(r);
    else throw new BuildError(`${r}: not a regular file`);
  }
  return out;
}

function recordMetricIds(record) {
  const out = [];
  for (const [cell, c] of Object.entries(record.cells ?? {})) for (const id of Object.keys(c?.metrics ?? {})) out.push([`cells.${cell}`, id]);
  for (const part of ["fixture", "empty"]) for (const id of Object.keys(record.extras?.[part]?.metrics ?? {})) out.push([`extras.${part}`, id]);
  return out;
}

/**
 * Reads and checks the input tree. Returns {records, forks, bands, copies, synthetic}. Throws BuildError naming
 * the file on any problem.
 */
/** A scenario record's path: scenarios/<id>/<version>/ and the ladder's own records/, fork/ or base/ path. */
const SCENARIO_PATH =
  /^scenarios\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([1-9][0-9]{0,5})\/(?:records\/(linux-x64|darwin-arm64)\/(\d{4}-\d{2}-\d{2})\.(v[0-9A-Za-z.-]+)\.json|fork\/(v[0-9A-Za-z.-]+)\.(linux-x64|darwin-arm64)\.json|base\/([0-9a-f]{12})\.(linux-x64|darwin-arm64)\.json)$/;

export function loadInputs(inDir, { dev = false, catalogue = loadCatalogue(), publicRefs, scenarios = loadScenarios() } = {}) {
  // The suites the ladder's paths accept: the ladder rows' (ladder-<version>); every other row publishes under
  // scenarios/<id>/<version>/.
  const ladderSuites = new Set(scenarios.rows.filter((r) => r.id === "ladder").map((r) => r.suite));
  const scenarioRecords = [];
  // Every committed record names only public commits (the VM's merge checks this too): its harness a pinned version at
  // the pinned public commit and content hashes, a fork release the commit pinned for its tag. A dev build reads
  // synthetic data, which is never published, and skips this.
  let refs = null;
  if (!dev) {
    try {
      refs = publicRefs ?? loadPublicRefs();
    } catch (error) {
      throw new BuildError(`public-refs.json: ${error.message}`);
    }
  }
  if (!fs.existsSync(inDir)) throw new BuildError(`input directory missing`);
  const known = new Set(catalogue.metrics.map((m) => m.id));
  const recordSchema = loadSchema("record-1.json");
  const records = [];
  const forks = [];
  const bases = [];
  // Nightly fork-head records (fork-nightly/<platform>/<date>.<tag>.json): checked, passed through and drawn on the fork line.
  const forkNightlies = [];
  const seenHeads = new Set();
  const copies = new Map();
  let bands = null;
  let synthetic = false;
  const seen = new Set();
  for (const rel of walkFiles(inDir)) {
    const top = rel.split("/")[0];
    if (DERIVED.has(top)) throw new BuildError(`${rel}: a derived file is committed under the input tree (derived files exist only in the build output)`);
    if (!rel.endsWith(".json")) throw new BuildError(`${rel}: unexpected file in the input tree`);
    const bytes = fs.readFileSync(path.join(inDir, rel));
    // Strict parsing (no duplicate or prototype keys); the raw bytes are scanned too, and what is published is
    // the re-serialised parsed value, never the raw bytes.
    let value;
    try {
      value = parseJsonStrict(bytes.toString("utf8"));
    } catch (error) {
      // The kind and the offset only (safe-errors.mjs): the strict parser's own text names the record's keys.
      throw new BuildError(`${rel}: ${error.message}`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BuildError(`${rel}: not a JSON object`);
    if (/^(records|fork|base|fork-nightly)\//.test(rel) && !ladderSuites.has(value.workload?.suite)) {
      throw new BuildError(`${rel}: only the published suite (${[...ladderSuites].join(", ")}) is accepted here; validation and noise-band records are never published`);
    }
    if (value.synthetic === true) {
      if (!dev) throw new BuildError(`${rel}: synthetic development data is refused (only --dev builds accept it)`);
      synthetic = true;
    }
    // Keys and strings with both lists, numbers with the public list only (scanValue); the raw bytes with the public list.
    const scanned = [...scanText(bytes.toString("utf8"), { privatePatterns: [], env: false }), ...scanValue(value)];
    if (scanned.length > 0) throw new BuildError(`${rel}: forbidden pattern(s) ${[...new Set(scanned.map((h) => h.pattern))].join(", ")}`);
    const published = json(value);

    const recordMatch = /^records\/(linux-x64|darwin-arm64)\/(\d{4}-\d{2}-\d{2})\.(v[0-9A-Za-z.-]+)\.json$/.exec(rel);
    const forkMatch = /^fork\/(v[0-9A-Za-z.-]+)\.(linux-x64|darwin-arm64)\.json$/.exec(rel);
    const baseMatch = /^base\/([0-9a-f]{12})\.(linux-x64|darwin-arm64)\.json$/.exec(rel);
    const headMatch = /^fork-nightly\/(linux-x64|darwin-arm64)\/(\d{4}-\d{2}-\d{2})\.(v[0-9A-Za-z.-]+)\.json$/.exec(rel);
    if (recordMatch || forkMatch || baseMatch || headMatch) {
      if (refs !== null) publicOnly(rel, value, refs);
      for (const [where, id] of recordMetricIds(value ?? {})) {
        if (!known.has(id)) throw new BuildError(`${rel}: unknown metric id ${id} at ${where}`);
      }
      const errors = schemaErrors(recordSchema, value);
      if (errors.length > 0) throw new BuildError(`${rel}: ${formatSafeErrors(errors, recordSchema, 5)}`);
      // paired_nightly belongs to a nightly fork-head record, and names that night's upstream nightly.
      const headProblem = forkHeadProblem(value);
      if (headProblem) throw new BuildError(`${rel}: ${headProblem}`);
      // A cell's saturated flag is never trusted: it must be the merge's rule over the cell's attempts and agents served.
      for (const [L, cell] of Object.entries(value.cells)) {
        const derived = cellSaturated({ attempts: cell.attempts, agentsServedMedian: cell.metrics.agents_served?.median ?? null, agentsTotal: cell.agents_total });
        if (cell.saturated !== derived) throw new BuildError(`${rel}: cell ${L} says saturated ${cell.saturated}, its attempts and agents served say ${derived}`);
      }
      if (recordMatch) {
        const [, platform, date, tag] = recordMatch;
        if (!/^large-\d{2,3}$/.test(value.fixture.id) || value.fixture.sha256 === null) throw new BuildError(`${rel}: a validation record (no era fixture, or a scaled one) is never published`);
        if (value.kind !== "nightly" || value.platform.id !== platform || value.release.date !== date || value.release.tag !== tag) {
          throw new BuildError(`${rel}: file name does not match the record's kind, platform, date and tag`);
        }
        if (value.record_id !== `${date}.${platform}.nightly`) throw new BuildError(`${rel}: record_id does not match the file name`);
        if (seen.has(`${platform}|${date}`)) throw new BuildError(`${rel}: a second nightly record for ${date} on ${platform}`);
        seen.add(`${platform}|${date}`);
        records.push({ rel, record: value });
      } else if (headMatch) {
        const [, platform, date, tag] = headMatch;
        if (!/^large-\d{2,3}$/.test(value.fixture.id) || value.fixture.sha256 === null) throw new BuildError(`${rel}: a validation record (no era fixture, or a scaled one) is never published`);
        if (value.kind !== "fork" || value.platform.id !== platform || value.release.tag !== tag || value.record_id !== `${date}.${platform}.fork` || value.base === null) {
          throw new BuildError(`${rel}: file name does not match the fork-head record's night, platform and release tag`);
        }
        if (seenHeads.has(`${platform}|${date}`)) throw new BuildError(`${rel}: a second fork-head record for ${date} on ${platform}`);
        seenHeads.add(`${platform}|${date}`);
        forkNightlies.push({ rel, record: value });
      } else if (baseMatch) {
        const [, sha12, platform] = baseMatch;
        if (!/^large-\d{2,3}$/.test(value.fixture.id) || value.fixture.sha256 === null) throw new BuildError(`${rel}: a validation record (no era fixture, or a scaled one) is never published`);
        if (value.kind !== "base" || value.platform.id !== platform || !value.release.sha.startsWith(sha12)) {
          throw new BuildError(`${rel}: file name does not match the base record's kind, platform and merge-base SHA`);
        }
        if (value.record_id !== `${sha12}.${platform}.base`) throw new BuildError(`${rel}: record_id does not match the file name`);
        if (bases.some((b) => b.record.platform.id === platform && b.record.release.sha === value.release.sha)) throw new BuildError(`${rel}: a second base record for the same SHA`);
        bases.push({ rel, record: value });
      } else {
        const [, tag, platform] = forkMatch;
        if (!/^large-\d{2,3}$/.test(value.fixture.id) || value.fixture.sha256 === null) throw new BuildError(`${rel}: a validation record (no era fixture, or a scaled one) is never published`);
        if (value.kind !== "fork" || value.platform.id !== platform || value.release.tag !== tag || value.base === null) {
          throw new BuildError(`${rel}: file name does not match the fork record's tag and platform, or base is missing`);
        }
        if (value.record_id !== `${value.release.version}.${platform}.fork`) throw new BuildError(`${rel}: record_id does not match the file name`);
        forks.push({ rel, record: value });
      }
      copies.set(rel, published);
    } else if (rel === "bands.json") {
      const errors = schemaErrors(loadSchema("bands-1.json"), value);
      if (errors.length > 0) throw new BuildError(`bands.json: ${formatSafeErrors(errors, loadSchema("bands-1.json"), 5)}`);
      for (const [platform, entry] of Object.entries(value.platforms)) {
        const measured = entry.measured !== undefined || entry.metrics !== undefined;
        if (entry.pending === true ? measured : !(entry.measured && entry.metrics)) {
          throw new BuildError(`bands.json: ${platform} must be either "pending": true or carry measured and metrics`);
        }
        if (entry.pending !== true) {
          if (Object.keys(entry.metrics).length === 0) throw new BuildError(`bands.json: ${platform} is measured but has no metric bands`);
          const missing = catalogue.headlines[platform].filter((id) => entry.metrics[id] === undefined);
          if (missing.length > 0) throw new BuildError(`bands.json: ${platform} has no band for the headline metric(s) ${missing.join(", ")}`);
        }
      }
      bands = value;
      copies.set(rel, published);
    } else if (rel.startsWith("scenarios/")) {
      scenarioRecords.push(scenarioInput(rel, value, { scenarios, refs, known, seen: scenarioRecords }));
      copies.set(rel, published);
    } else if (rel === "status.json") {
      // written by the ops tick: numbers, dates and reason codes only (schema/status-1.json), published re-serialised
      const errors = schemaErrors(loadSchema("status-1.json"), value);
      if (errors.length > 0) throw new BuildError(`status.json: ${formatSafeErrors(errors, loadSchema("status-1.json"), 5)}`);
      copies.set(rel, published);

    } else {
      throw new BuildError(`${rel}: unexpected file in the input tree`);
    }
  }
  if (records.length === 0 && forks.length === 0) throw new BuildError("no records in the input tree");
  return { records, forks, bases, forkNightlies, bands, copies, synthetic, scenarioRecords };
}

/**
 * One scenario record from scenarios/<id>/<version>/...: a t3cp/scenario-record/1 record of a row of scenarios.json
 * (never the ladder's), under its own row's path and file name, running the harness its row pins, by its public pins.
 */
function scenarioInput(rel, value, { scenarios, refs, known, seen }) {
  const m = SCENARIO_PATH.exec(rel);
  if (!m) throw new BuildError(`${rel}: not a scenario record path (scenarios/<id>/<version>/records|fork|base/...)`);
  if (value.schema !== "t3cp/scenario-record/1") throw new BuildError(`${rel}: not a t3cp/scenario-record/1 record`);
  const suite = value.workload?.suite;
  const row = scenarios.rows.find((r) => r.id !== "ladder" && r.suite === suite);
  if (!row) throw new BuildError(`${rel}: suite ${typeof suite === "string" ? suite : "(none)"} is not a row of scenarios.json`);
  if (row.id !== m[1] || String(row.version) !== m[2]) throw new BuildError(`${rel}: the path is not its row's (scenarios/${row.id}/${row.version}/)`);
  if (refs !== null) publicOnly(rel, value, refs);
  if (value.harness?.version !== row.harness) throw new BuildError(`${rel}: harness ${value.harness?.version} is not the one its row pins (${row.harness})`);
  const schema = loadSchema("scenario-record-1.json");
  const errors = schemaErrors(schema, value);
  if (errors.length > 0) throw new BuildError(`${rel}: ${formatSafeErrors(errors, schema, 5)}`);
  // The record implements its row: the scenario, attempts per cell, fixture and platform; per cell it ran, the row's load
  // for that cell and exactly the row's metrics (a cell with no attempt is left out of a partial record).
  const w = value.workload;
  if (w.scenario.id !== row.id || w.scenario.version !== row.version) throw new BuildError(`${rel}: workload.scenario is not its row's`);
  if (w.attempts_per_cell !== row.attempts) throw new BuildError(`${rel}: attempts_per_cell is not its row's (${row.attempts})`);
  if (value.fixture.id !== row.fixture) throw new BuildError(`${rel}: fixture ${value.fixture.id} is not its row's (${row.fixture})`);
  if (!row.platforms.includes(value.platform.id)) throw new BuildError(`${rel}: platform ${value.platform.id} is not one of its row's`);
  for (const name of Object.keys(w.cells ?? {})) if (!value.cells[name]) throw new BuildError(`${rel}: workload.cells names ${name}, which has no cell`);
  const rowMetrics = canonical([...row.metrics].sort());
  for (const [name, cell] of Object.entries(value.cells)) {
    const c = row.cells.find((x) => x.name === name);
    if (!c) throw new BuildError(`${rel}: cell ${name} is not one of its row's`);
    if (canonical(w.cells?.[name] ?? null) !== canonical(scenarioLoad(row, c))) throw new BuildError(`${rel}: cell ${name} did not run its row's load`);
    for (const id of Object.keys(cell.metrics)) if (!known.has(id)) throw new BuildError(`${rel}: unknown metric id ${id}`);
    if (canonical(Object.keys(cell.metrics).sort()) !== rowMetrics) throw new BuildError(`${rel}: cell ${name} does not carry exactly its row's metrics`);
  }
  const platform = value.platform.id;
  if (m[3]) {
    if (value.kind !== "nightly" || m[3] !== platform || value.release.date !== m[4] || value.release.tag !== m[5] || value.record_id !== `${m[4]}.${platform}.nightly`) {
      throw new BuildError(`${rel}: file name does not match the record's kind, platform, date and tag`);
    }
  } else if (m[6]) {
    if (value.kind !== "fork" || m[7] !== platform || value.release.tag !== m[6] || value.base === null || value.record_id !== `${value.release.version}.${platform}.fork`) {
      throw new BuildError(`${rel}: file name does not match the fork record's tag and platform, or base is missing`);
    }
  } else if (value.kind !== "base" || m[9] !== platform || !value.release.sha.startsWith(m[8]) || value.record_id !== `${m[8]}.${platform}.base`) {
    throw new BuildError(`${rel}: file name does not match the base record's kind, platform and merge-base SHA`);
  }
  if (seen.some((x) => x.record.record_id === value.record_id && x.row === row)) throw new BuildError(`${rel}: a second record ${value.record_id} of ${row.suite}`);
  return { rel, record: value, row };
}

/**
 * A scenario series' segment at a cell: the fixture (id and content), the row, the harness tree and the cell's load. A
 * value is comparable only with values of its own segment.
 */
const scenarioSegment = (r, cell) => JSON.stringify([r.fixture.id, r.fixture.sha256, r.workload.suite, r.harness.files_sha256, canonical(r.workload.cells?.[cell] ?? null)]);

/**
 * The scenario rows' outputs, for rows with records: per row, platform and metric one series shard
 * (scenarios/<id>/<version>/series/<platform>/<metric>.json: nightly, fork and base values per cell with their segment,
 * and the eras of that row's own records), and scenarios/index.json. Nothing when no scenario record exists.
 */
function scenarioOutputs(inputs, catalogue, scenarios, mark) {
  const out = new Map();
  if (inputs.scenarioRecords.length === 0) return out;
  // The scenario outputs' own time: the latest of their records (the ladder's outputs keep theirs).
  const generatedAt = inputs.scenarioRecords.map((x) => x.record.pipeline.generated_at).sort().at(-1);
  const segmentId = (key) => Number.parseInt(sha256(key).slice(0, 12), 16);
  const byId = new Map(catalogue.metrics.map((m) => [m.id, m]));
  const rows = [];
  for (const row of scenarios.rows) {
    const mine = inputs.scenarioRecords.filter((x) => x.row === row).map((x) => x.record);
    if (mine.length === 0) continue;
    // A row's series carry its own records' time, so another row's records never move them.
    const rowGeneratedAt = mine.map((r) => r.pipeline.generated_at).sort().at(-1);
    const platforms = {};
    const seriesPaths = {};
    for (const p of [...new Set(mine.map((r) => r.platform.id))].sort()) {
      const onP = mine.filter((r) => r.platform.id === p);
      const nightly = onP.filter((r) => r.kind === "nightly").sort(byKey((r) => r.release.date));
      const forks = onP.filter((r) => r.kind === "fork").sort(byKey((r) => `${r.release.date}|${versionKey(r.release.tag)}`));
      const bases = onP.filter((r) => r.kind === "base").sort(byKey((r) => `${r.release.date}|${r.release.sha}`));
      const latest = nightly.at(-1) ?? null;
      platforms[p] = { records: onP.length, latest_date: latest?.release.date ?? null, latest_tag: latest?.release.tag ?? null };
      seriesPaths[p] = [];
      for (const metric of row.metrics) {
        const m = byId.get(metric);
        const valueAt = (r, c) => {
          const stat = r.cells[c.name]?.metrics?.[metric] ?? null;
          return { median: stat?.median ?? null, min: stat?.min ?? null, max: stat?.max ?? null, n: stat?.n ?? 0, reason: stat?.reason ?? null, segment: segmentId(scenarioSegment(r, c.name)) };
        };
        const cells = Object.fromEntries(
          row.cells.map((c) => {
            const values = nightly.map((r) => valueAt(r, c));
            return [c.name, Object.fromEntries(["median", "min", "max", "n", "reason", "segment"].map((k) => [k, values.map((v) => v[k])]))];
          }),
        );
        const point = (r) => Object.fromEntries(row.cells.map((c) => [c.name, valueAt(r, c)]));
        const eras = [];
        for (let i = 1; i < nightly.length; i++) {
          const [a, b] = [nightly[i - 1], nightly[i]];
          if (a.harness.files_sha256 !== b.harness.files_sha256) eras.push({ date: b.release.date, kind: "harness", label: b.harness.version });
          if (a.fixture.id !== b.fixture.id || a.fixture.sha256 !== b.fixture.sha256) eras.push({ date: b.release.date, kind: "fixture", label: b.fixture.id });
        }
        if (m.era_start !== null && nightly.length > 0 && nightly[0].release.date < m.era_start) {
          const first = nightly.find((r) => r.release.date >= m.era_start);
          const era = catalogue.feature_eras.find((e) => e.id === m.era);
          if (first) eras.push({ date: first.release.date, kind: "metric", label: era?.what ?? "metric data starts" });
        }
        eras.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.kind < y.kind ? -1 : 1));
        const rel = `scenarios/${row.id}/${row.version}/series/${p}/${metric}.json`;
        seriesPaths[p].push(rel);
        out.set(
          rel,
          json(
            mark({
              schema: "t3cp/scenario-series/1",
              generated_at: rowGeneratedAt,
              suite: row.suite,
              scenario: { id: row.id, version: row.version },
              platform: p,
              metric,
              unit: m.unit,
              nightly: { dates: nightly.map((r) => r.release.date), tags: nightly.map((r) => r.release.tag), cells },
              fork: forks.map((r) => ({ tag: r.release.tag, date: r.release.date, base_tag: r.base?.tag ?? null, base_date: r.base?.date ?? null, cells: point(r) })),
              base: bases.map((r) => ({ tag: r.release.tag, sha: r.release.sha, date: r.release.date, cells: point(r) })),
              eras,
            }),
          ),
        );
      }
    }
    rows.push({ id: row.id, version: row.version, suite: row.suite, status: row.status, metrics: row.metrics, cells: row.cells.map((c) => c.name), platforms, series: seriesPaths });
  }
  out.set("scenarios/index.json", json(mark({ schema: "t3cp/scenarios-index/1", generated_at: generatedAt, rows })));
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// the model: series values and the §4 verdict rule

function makeModel(inputs, catalogue) {
  const byId = new Map(catalogue.metrics.map((m) => [m.id, m]));
  const pins = new Map(catalogue.platforms.map((p) => [p.id, p.cpu_pin]));
  const nightlies = new Map();
  const forks = new Map();
  for (const { record } of inputs.records) {
    if (!nightlies.has(record.platform.id)) nightlies.set(record.platform.id, []);
    nightlies.get(record.platform.id).push(record);
  }
  for (const { record } of inputs.forks) {
    if (!forks.has(record.platform.id)) forks.set(record.platform.id, []);
    forks.get(record.platform.id).push(record);
  }
  const bases = new Map();
  for (const { record } of inputs.bases ?? []) {
    if (!bases.has(record.platform.id)) bases.set(record.platform.id, new Map());
    bases.get(record.platform.id).set(record.release.sha, record);
  }
  // Nightly fork-head records by platform and night (paired_nightly.date).
  const heads = new Map();
  for (const { record } of inputs.forkNightlies ?? []) {
    if (!heads.has(record.platform.id)) heads.set(record.platform.id, new Map());
    heads.get(record.platform.id).set(record.paired_nightly.date, record);
  }
  for (const list of nightlies.values()) list.sort(byKey((r) => r.release.date));
  // A fork-head record is paired with its night's upstream nightly: where that nightly is published, it must be the
  // build paired_nightly names, or the comparison and the tooltip would name another build.
  for (const { rel, record } of inputs.forkNightlies ?? []) {
    const n = (nightlies.get(record.platform.id) ?? []).find((r) => r.release.date === record.paired_nightly.date);
    if (n && n.release.tag !== record.paired_nightly.tag) throw new BuildError(`${rel}: paired_nightly.tag is not the published nightly of ${record.paired_nightly.date}`);
  }
  for (const list of forks.values()) list.sort((a, b) => (a.release.date < b.release.date ? -1 : a.release.date > b.release.date ? 1 : versionKey(a.release.tag) < versionKey(b.release.tag) ? -1 : 1));
  const platforms = PLATFORM_IDS.filter((p) => nightlies.has(p) || forks.has(p));
  // Bands are mandatory: a platform with records needs measured bands, or an explicit "pending": true until its
  // noise-band run lands. A build never silently publishes records without verdicts.
  for (const p of platforms) {
    if (inputs.bands === null) throw new BuildError(`bands.json is missing: ${p} has records (mark the platform "pending": true until its noise-band run lands)`);
    if (inputs.bands.platforms?.[p] === undefined) throw new BuildError(`bands.json has no entry for ${p}, which has records (mark it "pending": true until its noise-band run lands)`);
  }
  const seriesMetrics = catalogue.metrics.filter((m) => m.lane === "daily" || m.lane === "record");
  return { catalogue, byId, pins, nightlies, forks, bases, heads, platforms, seriesMetrics, bands: inputs.bands };
}

/** The levels a metric has: the six ladder levels (scope level) or "once" (scope record), plus "1e" when flagged. */
export const levelsFor = (m) => [...(m.scope === "level" ? LADDER : ["once"]), ...(m.empty_cell ? ["1e"] : [])];

// A fork-head record is measured on its night, with that night's harness and fixture: its data date is the night's.
const dataDate = (record) => (record.paired_nightly ? record.paired_nightly.date : record.kind === "fork" && record.base ? record.base.date : record.release.date);

/** Whether a record can carry metric m at all: a fork-only row on a fork record, an era metric from its era start. */
const inEra = (record, m) => !(m.era_start === null && m.upstream === "fork" && record.kind !== "fork") && !(m.era_start !== null && dataDate(record) < m.era_start);

/**
 * Whether the record ran level L with no valid attempt (its cell exists, none of its attempts is valid) for a metric it
 * can carry: that level is hollow, never no_data, which is a level not run or a metric outside its era.
 */
const ranNoValid = (record, m, L) => m.scope === "level" && inEra(record, m) && record.cells?.[L] !== undefined && record.cells[L].valid === 0;

/**
 * Why a value noted no_data is missing, where the record gives a public reason (series levels.<L>.reason): the stat's
 * own (extra_timeout, no_setup_span), else timeout where a record that did not finish in time never measured the level
 * or the extra (its cell or its stat is absent) for a metric it can carry; else null.
 */
function missingReason(record, m, L) {
  const stat = statAt(record, m, L);
  if (EXTRAS_REASONS.includes(stat?.reason) || stat?.reason === "no_flush_in_window") return stat.reason;
  if (record.status_reason !== "timeout" || !inEra(record, m)) return null;
  if (m.scope === "level") return record.cells?.[L] === undefined ? "timeout" : null;
  return stat === null ? "timeout" : null;
}

/** The stat {median, min, max, n} of metric m at level L in a record, or null when there is none. */
function statAt(record, m, L) {
  if (!inEra(record, m)) return null;
  if (m.source.file === "merge" && m.scope === "level") {
    const cell = record.cells[L];
    if (!cell) return null;
    // Killed stops: the attempts whose stop the harness forced, where every attempt says; else not known.
    if (m.id === "shutdown_killed" && !cell.attempts.every((a) => typeof a.stop_forced === "boolean")) return null;
    const value =
      m.id === "attempts_valid"
        ? cell.valid
        : m.id === "attempts_total"
          ? cell.total
          : m.id === "shutdown_killed"
            ? cell.attempts.filter((a) => a.stop_forced === true).length
            : cell.attempts.filter((a) => a.contaminated).length;
    return { median: value, min: value, max: value, n: cell.total };
  }
  const stat = m.scope === "level" ? record.cells[L]?.metrics?.[m.id] : (L === "once" ? record.extras.fixture : record.extras.empty)?.metrics?.[m.id];
  return stat ?? null;
}

const GATE_EXEMPT = new Set(["client_errors", "client_unfinished"]);
/**
 * Validity gates (§4) at a level, as published in records-index.json: "fail" when the CPU is not the platform's pinned
 * model, the cell has a contaminated valid attempt or there is no cell; "client" when the cell had client errors or
 * unfinished calls (only the gate-exempt metrics, those calls' own counts, pass); else "pass". "once" is the pin alone.
 */
function gateState(model, record, L) {
  const pin = model.pins.get(record.platform.id);
  if (pin && record.platform.cpu_model !== pin) return "fail";
  if (L === "once") return "pass";
  const cell = record.cells[L];
  if (!cell) return "fail";
  if (cell.attempts.some((a) => a.valid && a.contaminated)) return "fail";
  for (const gate of GATE_EXEMPT) {
    const s = cell.metrics[gate];
    if (s && s.median !== null && s.median > 0) return "client";
  }
  return "pass";
}
/** Whether metric m at level L passes its gates: a once-per-record metric reads "once" at either of its levels. */
function gatesPass(model, record, m, L) {
  const g = gateState(model, record, m.scope === "record" ? "once" : L);
  return g === "pass" || (g === "client" && GATE_EXEMPT.has(m.id));
}

/**
 * The series segment a value belongs to: the fixture era, the harness, the suite and load profile, and at a
 * ladder level the cell's own load arguments. A reference window or a comparison never crosses segments.
 */
const segment = (record, L) =>
  [
    record.fixture.id,
    record.harness.files_sha256,
    record.workload.suite ?? "",
    record.workload.profile,
    L === "once" ? "" : canonical(record.workload.cells?.[L] ?? null),
    // A record that could not tell its compaction era shares a window with no other record, even another such one.
    record.compaction_schedule == null ? `unknown:${record.record_id}` : record.compaction_schedule,
  ].join("|");
const comparable = (a, b, L) => segment(a, L) === segment(b, L);

/** The content hashes a published harness is identified by; each must be the pinned public tree's. */
const HARNESS_HASHES = ["files_sha256", "driver_sha256", "fakes_sha256", "preload_sha256"];

/** Refuses a record that names a commit the pinned public references do not (see loadInputs). */
function publicOnly(rel, record, refs) {
  const h = record.harness ?? {};
  const pinned = refs.harness[h.version];
  if (!pinned) throw new BuildError(`${rel}: harness ${h.version} has no public tag pinned in public-refs.json`);
  if (h.sha !== pinned.sha) throw new BuildError(`${rel}: harness.sha is not the public commit pinned for ${h.version}`);
  for (const k of HARNESS_HASHES) if (h[k] !== pinned[k]) throw new BuildError(`${rel}: harness ${k} is not the pinned public tree's`);
  if (record.kind === "fork") {
    const commit = refs.fork[record.release?.tag];
    if (commit === undefined) throw new BuildError(`${rel}: fork_tag_unpinned (no public commit pinned for ${record.release?.tag})`);
    if (commit !== record.release.sha) throw new BuildError(`${rel}: release.sha is not the public commit pinned for ${record.release.tag}`);
  }
}

/**
 * The compaction schedule era of a record: "unscheduled", "scheduled", or "unknown" when the record could not tell
 * (null), which is an era of its own: it shares no reference window with either other era.
 */
const compactionOf = (record) => record.compaction_schedule ?? "unknown";

/**
 * Per record of a nightly list, the run of consecutive records of one segment at level L it belongs to. A reference
 * window is drawn from the record's own run only, so it never reaches back across another segment, not even to
 * records of the same segment before it: a harness, fixture era, load or compaction era that returns starts a new run,
 * and the first record after any boundary has no reference. A record of unknown compaction era has a segment of its
 * own, so it is a run of its own and ends the one before.
 */
function segmentRuns(list, L) {
  const runs = [];
  let id = 0;
  for (let i = 0; i < list.length; i++) {
    if (i > 0 && segment(list[i], L) !== segment(list[i - 1], L)) id++;
    runs.push(id);
  }
  return runs;
}

/** Bands are measured in the scheduled era: a record of any other era gets none (counters need none). */
const capFor = (cap, m, ...records) => (!m.counter && records.some((r) => compactionOf(r) !== "scheduled") ? { band: null, threshold: null, note: cap.note ?? "no_band" } : cap);

/**
 * The ladder decision: at a saturated level (the server did not serve every agent) only throughput keeps
 * verdicts; every other metric is context there, and saturated records never enter its reference.
 */
const THROUGHPUT = new Set(["turns_completed", "agents_served"]);
const saturatedAt = (record, L) => L !== "once" && record.cells?.[L]?.saturated === true;
/**
 * A saturated level's symptoms: the union of its attempts' saturated_by codes, sorted; null where the level is not
 * saturated. Every code is a known problem code (the input's schema already refuses others; this never trusts it).
 */
const saturatedByAt = (record, L) => {
  if (!saturatedAt(record, L)) return null;
  const codes = new Set();
  for (const a of record.cells[L].attempts ?? []) for (const code of a.saturated_by ?? []) codes.add(code);
  for (const code of codes) if (!PROBLEMS.includes(code) || code === "other_problem") throw new BuildError(`${record.record_id}: cell ${L}: saturated_by holds an unknown code`);
  return [...codes].sort();
};

/** {band, threshold} for a verdict, or {note} saying why there is none. band is in percent. */
function capability(model, p, m, L) {
  if (m.counter) return { band: null, threshold: null, note: null }; // counters need no band (decide() below)
  const entry = model.bands?.platforms?.[p]?.metrics?.[m.id];
  const level = entry?.levels?.[L] ?? entry;
  const band = level?.band ?? null;
  const threshold = band === null ? null : round2(band + 5);
  if (m.better === "context") return { band, threshold, note: "context" };
  if (band === null) return { band, threshold, note: "no_band" };
  if (m.group === "client" && band >= 40) return { band, threshold, note: "wide_band" }; // §3: client p95s with bands >= 40 % are context only
  return { band, threshold, note: null };
}

/** The relative change in percent, real sign; null when the reference is 0 and the value is not. */
const rawDelta = (v, r) => (v === null || r === null ? null : r === 0 ? (v === 0 ? 0 : null) : ((v - r) / Math.abs(r)) * 100);

/** §4: d sign-adjusted so positive means worse; d > t regressed, d < -t improved, else within. */
function judge(m, v, r, threshold) {
  let worse;
  if (r === 0) worse = v === 0 ? 0 : (v > 0 ? 1 : -1) * Number.POSITIVE_INFINITY;
  else worse = ((v - r) / Math.abs(r)) * 100;
  if (m.better === "higher") worse = -worse;
  return { verdict: worse > threshold ? "regressed" : worse < -threshold ? "improved" : "within", worse };
}

/** Valid values a day needs for a verdict: two of three attempts per level (§4); once-per-record extras have one. */
const minN = (m) => (m.scope === "record" ? 1 : 2);

/**
 * The verdict of value v against reference r once the value itself is usable, with no percentage for counters:
 *  - absolute counters (client errors, unfinished calls) flag any value above zero, on every record, the first
 *    one and the first after an era boundary included;
 *  - rise counters (log-line counts) flag only a rise above the reference, so a steady non-zero count stays
 *    within noise; with no reference there is no verdict;
 *  - otherwise a capability note stops it; no reference gives no_reference; a zero reference allows only zero
 *    (within noise) and notes anything else zero_reference; else the §4 rule.
 */
function decide(m, v, r, cap) {
  const counted = { worse: null, delta: null, exact: null };
  if (m.counter === "absolute") return { ...counted, verdict: v > 0 ? "regressed" : "within", note: null };
  if (m.counter === "rise") return r === null ? { ...counted, verdict: null, note: "no_reference" } : { ...counted, verdict: v > r ? "regressed" : "within", note: null };
  const exact = rawDelta(v, r);
  const base = { delta: round2(exact), exact };
  if (cap.note) return { ...base, verdict: null, worse: null, note: cap.note };
  if (r === null) return { ...base, verdict: null, worse: null, note: "no_reference" };
  if (r === 0) return v === 0 ? { ...base, verdict: "within", worse: 0, note: null } : { delta: null, exact: null, verdict: null, worse: null, note: "zero_reference" };
  const { verdict, worse } = judge(m, v, r, cap.threshold);
  return { ...base, verdict, worse, note: null };
}

const usable = (model, record, m, L) => {
  const stat = statAt(record, m, L);
  if (!THROUGHPUT.has(m.id) && saturatedAt(record, L)) return null;
  return stat !== null && stat.median !== null && stat.n >= minN(m) && gatesPass(model, record, m, L) ? stat : null;
};

/**
 * One metric on one platform at one level over every nightly: values, references, deltas and verdicts.
 * Arrays align with the platform's nightly list.
 */
function nightlySeries(model, p, m, L) {
  const list = model.nightlies.get(p) ?? [];
  const cap = capability(model, p, m, L);
  const out = { median: [], min: [], max: [], n: [], ref: [], delta: [], verdict: [], note: [], reason: [], thin: [], dod_delta: [], dod_verdict: [], saturated: [], saturated_by: [], worse: [], dod_worse: [] };
  const eligible = []; // indexes of complete records with a usable value
  const run = segmentRuns(list, L);
  for (let i = 0; i < list.length; i++) {
    const record = list[i];
    const stat = statAt(record, m, L);
    const v = stat?.median ?? null;
    // The same unbroken run of the record's segment at this level (segmentRuns).
    const prior = eligible.filter((j) => run[j] === run[i]);
    const window = prior.slice(-7).map((j) => statAt(list[j], m, L).median);
    let ref = null;
    let thin = false;
    if (window.length >= 3) ref = median(window);
    else if (window.length > 0) {
      ref = window.at(-1);
      thin = true;
    }
    const dodRef = window.length > 0 ? window.at(-1) : null;
    let pre = null;
    if (v === null) pre = stat?.reason === "not_measured_saturated" ? "saturated" : ranNoValid(record, m, L) ? "hollow" : "no_data";
    else if (stat.n < minN(m)) pre = "hollow";
    else if (!gatesPass(model, record, m, L)) pre = "gated";
    else if (!THROUGHPUT.has(m.id) && saturatedAt(record, L)) pre = "saturated";
    const capR = capFor(cap, m, record);
    const week = pre === null ? decide(m, v, ref, capR) : { verdict: null, worse: null, note: pre, delta: m.counter ? null : round2(rawDelta(v, ref)) };
    const day = pre === null ? decide(m, v, dodRef, capR) : { verdict: null, worse: null, delta: m.counter ? null : round2(rawDelta(v, dodRef)) };
    out.median.push(v);
    out.min.push(stat?.min ?? null);
    out.max.push(stat?.max ?? null);
    out.n.push(stat?.n ?? 0);
    out.saturated.push(saturatedAt(record, L));
    out.saturated_by.push(saturatedByAt(record, L));
    out.ref.push(round3(ref));
    out.delta.push(week.delta);
    out.verdict.push(week.verdict);
    out.note.push(week.note);
    out.reason.push(week.note === "no_data" ? missingReason(record, m, L) : null);
    out.thin.push(ref !== null && thin);
    out.dod_delta.push(day.delta);
    out.dod_verdict.push(day.verdict);
    out.worse.push(week.worse);
    out.dod_worse.push(day.worse);
    if (record.status === "complete" && usable(model, record, m, L)) eligible.push(i);
  }
  return { ...out, band: cap.band, threshold: cap.threshold };
}

/** b against a for one metric and level: values, raw delta, and the verdict with the reason when there is none. */
function compareOne(model, p, m, L, a, b, { upstreamRef = false } = {}) {
  const sa = statAt(a, m, L);
  const sb = statAt(b, m, L);
  const va = sa?.median ?? null;
  const vb = sb?.median ?? null;
  const cap = capability(model, p, m, L);
  let pre = null;
  // A side without a value: hollow where that record ran the level with no valid attempt (b first, the side judged);
  // otherwise no_data for b, and no_reference for a missing a.
  if (vb === null) pre = ranNoValid(b, m, L) ? "hollow" : "no_data";
  else if (va === null) pre = ranNoValid(a, m, L) ? "hollow" : "no_reference";
  else if (sa.n < minN(m) || sb.n < minN(m)) pre = "hollow";
  else if (!gatesPass(model, a, m, L) || !gatesPass(model, b, m, L)) pre = "gated";
  else if (!THROUGHPUT.has(m.id) && (saturatedAt(a, L) || saturatedAt(b, L))) pre = "saturated";
  else if (upstreamRef && compactionOf(a) !== compactionOf(b)) pre = "no_base"; // a base in another compaction era is no base
  else if ((upstreamRef && m.upstream === "fork") || !comparable(a, b, L)) pre = "not_comparable";
  const d =
    pre === null
      ? decide(m, vb, va, capFor(cap, m, a, b))
      : { verdict: null, worse: null, note: pre, delta: m.counter ? null : round2(rawDelta(vb, va)), exact: m.counter ? null : rawDelta(vb, va) };
  // The band that applies to this pair: none outside the scheduled era (capFor), never the metric's band beside no_band.
  const applies = capFor(cap, m, a, b);
  return { a: va, b: vb, sa, sb, delta: d.delta, exact: d.exact, band: applies.band, threshold: applies.threshold, verdict: d.verdict, worse: d.worse, note: d.note };
}

/** The fork's base record: the upstream tree built at its exact merge-base SHA, same platform; null when absent. */
function baseOf(model, fork) {
  return model.bases.get(fork.platform.id)?.get(fork.base?.sha) ?? null;
}

/**
 * The fork step series of one metric and level: per release values and verdicts, plus the step per nightly date: the
 * value measured that night where a fork-head record exists (null without one, head_note saying why), else the held
 * release value. head_note is present only when the platform has fork-head records.
 */
function forkSeries(model, p, m, L, dates) {
  const list = model.forks.get(p) ?? [];
  const heads = model.heads.get(p);
  if (list.length === 0 && !heads) return null;
  const out = { value: [], min: [], max: [], n: [], vs_base: [], vs_base_verdict: [], vs_base_note: [], vs_prev: [], vs_prev_verdict: [], vs_prev_note: [], saturated: [], saturated_by: [], step: [] };
  list.forEach((record, k) => {
    const stat = statAt(record, m, L);
    out.value.push(stat?.median ?? null);
    out.min.push(stat?.min ?? null);
    out.max.push(stat?.max ?? null);
    out.n.push(stat?.n ?? 0);
    out.saturated.push(saturatedAt(record, L));
    out.saturated_by.push(saturatedByAt(record, L));
    const base = baseOf(model, record);
    const vb = base === null ? { delta: null, verdict: null, note: "no_base" } : compareOne(model, p, m, L, base, record, { upstreamRef: true });
    out.vs_base.push(vb.delta);
    out.vs_base_verdict.push(vb.verdict);
    out.vs_base_note.push(vb.note);
    const prev = k > 0 ? list[k - 1] : null;
    const vp = prev === null ? { delta: null, verdict: null, note: "no_reference" } : compareOne(model, p, m, L, prev, record);
    out.vs_prev.push(vp.delta);
    out.vs_prev_verdict.push(vp.verdict);
    out.vs_prev_note.push(vp.note);
  });
  if (heads) out.head_note = [];
  for (const date of dates) {
    const h = heads?.get(date);
    if (h) {
      const stat = statAt(h, m, L), v = stat?.median ?? null;
      out.step.push(v);
      out.head_note.push(v !== null ? null : stat?.reason === "not_measured_saturated" || saturatedAt(h, L) ? "saturated" : ranNoValid(h, m, L) ? "hollow" : "no_data");
      continue;
    }
    let held = -1;
    for (let k = 0; k < list.length; k++) if (list[k].release.date <= date) held = k;
    out.step.push(held < 0 ? null : out.value[held]);
    if (heads) out.head_note.push(null);
  }
  return out;
}

function forkHeader(model, p, dates) {
  const list = model.forks.get(p) ?? [];
  const heads = model.heads.get(p);
  if (list.length === 0 && !heads) return null;
  const stepTags = dates.map((date) => {
    if (heads?.has(date)) return heads.get(date).release.tag;
    let tag = null;
    for (const r of list) if (r.release.date <= date) tag = r.release.tag;
    return tag;
  });
  return {
    tags: list.map((r) => r.release.tag),
    dates: list.map((r) => r.release.date),
    base_tags: list.map((r) => r.base?.tag ?? null),
    base_dates: list.map((r) => r.base?.date ?? null),
    base_shas: list.map((r) => r.base?.sha ?? null),
    prev_tags: list.map((_, k) => (k > 0 ? list[k - 1].release.tag : null)),
    step_tags: stepTags,
    ...(heads ? { head_tags: dates.map((date) => heads.get(date)?.release.tag ?? null) } : {}),
  };
}

function seriesEras(model, p, m) {
  const list = model.nightlies.get(p) ?? [];
  const eras = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    if (a.fixture.id !== b.fixture.id) eras.push({ date: b.release.date, kind: "fixture", label: b.fixture.id });
    if (a.harness.files_sha256 !== b.harness.files_sha256) eras.push({ date: b.release.date, kind: "harness", label: b.harness.version });
    if (a.workload.profile !== b.workload.profile || a.workload.suite !== b.workload.suite || canonical(a.workload.cells ?? null) !== canonical(b.workload.cells ?? null)) {
      eras.push({ date: b.release.date, kind: "profile", label: b.workload.profile });
    }
    // A run of records of unknown compaction era is marked once where it starts, and its end where the known era resumes.
    if (compactionOf(a) !== compactionOf(b)) {
      eras.push({ date: b.release.date, kind: "compaction", label: compactionOf(b) === "unknown" ? "compaction schedule unknown" : "compaction schedule era" });
    }
  }
  if (m.era_start !== null && list.length > 0 && list[0].release.date < m.era_start) {
    const first = list.find((r) => r.release.date >= m.era_start);
    const era = model.catalogue.feature_eras.find((e) => e.id === m.era);
    if (first) eras.push({ date: first.release.date, kind: "metric", label: era?.what ?? "metric data starts" });
  }
  return eras.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.kind < y.kind ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------
// outputs

const PUBLIC_LEVEL_KEYS = ["band", "threshold", "median", "min", "max", "n", "ref", "delta", "verdict", "note", "thin", "dod_delta", "dod_verdict", "saturated", "saturated_by", "reason"];

function shardOf(full, from, to, shardName, generatedAt, synthetic) {
  const keep = full.dates.map((d) => d >= from && d <= to);
  const pick = (arr) => arr.filter((_, i) => keep[i]);
  const levels = {};
  for (const [L, s] of Object.entries(full.levels)) {
    levels[L] = Object.fromEntries(PUBLIC_LEVEL_KEYS.map((k) => [k, k === "band" || k === "threshold" ? s[k] : pick(s[k])]));
  }
  let fork = null;
  if (full.fork) {
    const fk = full.fork.dates.map((d) => d >= from && d <= to);
    const pickF = (arr) => arr.filter((_, i) => fk[i]);
    fork = {
      tags: pickF(full.fork.tags),
      dates: pickF(full.fork.dates),
      base_tags: pickF(full.fork.base_tags),
      base_dates: pickF(full.fork.base_dates),
      base_shas: pickF(full.fork.base_shas),
      prev_tags: pickF(full.fork.prev_tags),
      step_tags: pick(full.fork.step_tags),
      ...(full.fork.head_tags ? { head_tags: pick(full.fork.head_tags) } : {}),
      levels: Object.fromEntries(
        Object.entries(full.fork.levels).map(([L, s]) => [
          L,
          Object.fromEntries(Object.entries(s).map(([k, arr]) => [k, k === "step" || k === "head_note" ? pick(arr) : pickF(arr)])),
        ]),
      ),
    };
  }
  const dates = pick(full.dates);
  return {
    schema: "t3cp/series/1",
    ...(synthetic ? { synthetic: true } : {}),
    id: full.id,
    platform: full.platform,
    shard: shardName,
    generated_at: generatedAt,
    from: dates[0] ?? null,
    to: dates.at(-1) ?? null,
    band: full.band,
    threshold: full.threshold,
    dates,
    tags: pick(full.tags),
    status: pick(full.status),
    levels,
    fork,
    eras: full.eras.filter((e) => e.date >= from && e.date <= to),
  };
}

const formatGroup = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const MINUS = "−";
/** A value as the prose may write it: report.ts's rules, a real minus sign, and the unit. */
export function formatValue(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const magnitude = Math.abs(value);
  let text;
  if (Number.isInteger(value) || magnitude >= 1000) text = formatGroup.format(magnitude);
  else if (magnitude >= 100) text = magnitude.toFixed(0);
  else if (magnitude >= 10) text = magnitude.toFixed(1);
  else text = magnitude.toFixed(2);
  if (value < 0 && Number(text.replaceAll(",", "")) !== 0) text = `${MINUS}${text}`;
  const suffix = { n: "", "0–1": "", "%": " %", "% of one core": " %", "/s": "/s", "% per agent": " % per agent" }[unit];
  return `${text}${suffix ?? ` ${unit}`}`;
}
/** A percent change with its sign: "+8.0 %", "−23.4 %". */
export function formatPct(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const abs = Math.abs(value).toFixed(1);
  return `${value > 0 && abs !== "0.0" ? "+" : value < 0 && abs !== "0.0" ? MINUS : ""}${abs} %`;
}

/** Builds every output file from an input directory. Returns Map<relative path, Buffer>. Pure apart from reading inDir. */
export function buildOutputs(
  inDir,
  { dev = false, budgets = BUDGETS, catalogue = loadCatalogue(), overviewLimit = OVERVIEW_LIMIT, warn = (line) => process.stderr.write(`WARN ${line}\n`), publicRefs, scenarios = loadScenarios() } = {},
) {
  const inputs = loadInputs(inDir, { dev, catalogue, publicRefs, scenarios });
  const model = makeModel(inputs, catalogue);
  const synthetic = inputs.synthetic;
  const all = [...inputs.records, ...inputs.forks, ...inputs.bases, ...(inputs.forkNightlies ?? [])].map((x) => x.record);
  const generatedAt = all.map((r) => r.pipeline.generated_at).sort().at(-1);
  const files = new Map();
  for (const [rel, bytes] of [...inputs.copies].sort(byKey(([rel]) => rel))) files.set(rel, bytes);
  const mark = (o) => (synthetic ? { schema: o.schema, synthetic: true, ...o } : o);

  // series
  const seriesIndex = {};
  const changes = [];
  const csvRows = [];
  const metricOrder = new Map(catalogue.metrics.map((m, i) => [m.id, i]));
  for (const p of model.platforms) {
    seriesIndex[p] = {};
    const list = model.nightlies.get(p) ?? [];
    const dates = list.map((r) => r.release.date);
    const newest = dates.at(-1) ?? (model.forks.get(p) ?? []).map((r) => r.release.date).sort().at(-1);
    const latestFrom = addDays(newest, -(LATEST_DAYS - 1));
    const changesFrom = addDays(newest, -(CHANGES_DAYS - 1));
    for (const m of model.seriesMetrics) {
      if (m.na_on.includes(p)) continue;
      const levels = {};
      const forkLevels = {};
      for (const L of levelsFor(m)) {
        const s = nightlySeries(model, p, m, L);
        levels[L] = s;
        const f = forkSeries(model, p, m, L, dates);
        if (f) forkLevels[L] = f;
        s.median.forEach((v, i) => {
          if (v !== null) csvRows.push([p, metricOrder.get(m.id), LEVEL_ORDER.indexOf(L), dates[i], `${dates[i]},${list[i].release.tag},${p},${L},${m.id},${v},${s.min[i] ?? ""},${s.max[i] ?? ""},${s.n[i]},${s.verdict[i] ?? ""}`]);
          if (dates[i] >= changesFrom && (s.verdict[i] === "regressed" || s.verdict[i] === "improved") && s.dod_verdict[i] === s.verdict[i]) {
            changes.push({
              key: [dates[i], p, metricOrder.get(m.id), LEVEL_ORDER.indexOf(L)],
              item: { date: dates[i], platform: p, level: L, metric: m.id, tag: list[i].release.tag, verdict: s.verdict[i], value: v, reference: s.ref[i], delta: s.delta[i], band: s.band, threshold: s.threshold, thin: s.thin[i], dod_delta: s.dod_delta[i] },
            });
          }
        });
      }
      const header = forkHeader(model, p, dates);
      const first = levels[levelsFor(m)[0]];
      const full = {
        id: m.id,
        platform: p,
        band: first.band,
        threshold: first.threshold,
        dates,
        tags: list.map((r) => r.release.tag),
        status: list.map((r) => r.status),
        levels: Object.fromEntries(Object.entries(levels).map(([L, s]) => [L, { band: s.band, threshold: s.threshold, ...Object.fromEntries(PUBLIC_LEVEL_KEYS.slice(2).map((k) => [k, s[k]])) }])),
        fork: header === null ? null : { ...header, levels: forkLevels },
        eras: seriesEras(model, p, m),
      };
      // Band and threshold at the top are the metric's own (level overrides stay on each level).
      const entry = model.bands?.platforms?.[p]?.metrics?.[m.id];
      full.band = entry?.band ?? null;
      full.threshold = full.band === null ? null : round2(full.band + 5);
      const shards = [];
      const latest = shardOf(full, latestFrom, "9999-12-31", "latest", generatedAt, synthetic);
      files.set(`series/${p}/${m.id}.latest.json`, json(latest));
      shards.push("latest");
      const allShard = json(shardOf(full, "0000-01-01", "9999-12-31", "all", generatedAt, synthetic));
      if (gzSize(allShard) <= (budgets.find((b) => b.prefix === "series/")?.limit ?? Number.POSITIVE_INFINITY)) {
        files.set(`series/${p}/${m.id}.all.json`, allShard);
        shards.push("all");
      } else {
        const years = [...new Set([...dates, ...(full.fork?.dates ?? [])].map((d) => d.slice(0, 4)))].sort();
        for (const year of years) {
          files.set(`series/${p}/${m.id}.${year}.json`, json(shardOf(full, `${year}-01-01`, `${year}-12-31`, year, generatedAt, synthetic)));
          shards.push(year);
        }
      }
      seriesIndex[p][m.id] = shards;
    }
  }

  // changes feed (newest first)
  changes.sort((x, y) => {
    for (let i = 0; i < 4; i++) {
      const a = x.key[i];
      const b = y.key[i];
      if (a !== b) return i === 0 ? (a < b ? 1 : -1) : a < b ? -1 : 1;
    }
    return 0;
  });
  files.set(
    "changes.json",
    json(mark({ schema: "t3cp/changes/1", generated_at: generatedAt, window_days: CHANGES_DAYS, from: changes.length ? changes.at(-1).item.date : null, to: changes.length ? changes[0].item.date : null, items: changes.map((c) => c.item) })),
  );

  // compare files
  const comparePaths = [];
  const compareFile = (kind, p, a, b) => {
    const rows = [];
    for (const m of model.seriesMetrics) {
      if (m.na_on.includes(p)) continue;
      for (const L of levelsFor(m)) {
        const c = compareOne(model, p, m, L, a, b, { upstreamRef: kind === "fork-vs-base" });
        if (c.a === null && c.b === null) continue;
        rows.push({ metric: m.id, level: L, a: c.a, b: c.b, delta: c.delta, band: c.band, threshold: c.threshold, verdict: c.verdict, note: c.note });
      }
    }
    const side = (r) => ({ record_id: r.record_id, kind: r.kind, tag: r.release.tag, date: r.paired_nightly?.date ?? r.release.date });
    const name = (r) => (r.paired_nightly ? `head-${r.paired_nightly.date}` : r.kind === "base" ? `base-${r.release.sha.slice(0, 12)}` : r.release.tag);
    const rel = `compare/${name(a)}__${name(b)}.${p}.json`;
    files.set(rel, json(mark({ schema: "t3cp/compare/1", kind, platform: p, a: side(a), b: side(b), rows })));
    comparePaths.push(rel);
  };
  for (const p of model.platforms) {
    const list = model.nightlies.get(p) ?? [];
    for (let i = 1; i < list.length; i++) compareFile("day-over-day", p, list[i - 1], list[i]);
    const fl = model.forks.get(p) ?? [];
    fl.forEach((f, k) => {
      const base = baseOf(model, f);
      if (base) compareFile("fork-vs-base", p, base, f);
      if (k > 0) compareFile("fork-vs-prev", p, fl[k - 1], f);
    });
    // Each fork-head night against the upstream nightly it was paired with, where that nightly is published.
    for (const [date, h] of [...(model.heads.get(p) ?? new Map())].sort(byKey(([d]) => d))) {
      const n = list.find((r) => r.release.date === date);
      if (n) compareFile("fork-head-vs-nightly", p, n, h);
    }
  }
  comparePaths.sort();

  // downloads
  const ndjson = Buffer.from(all.slice().sort(byKey((r) => r.record_id)).map((r) => `${JSON.stringify(r)}\n`).join(""));
  csvRows.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1] || x[2] - y[2] || (x[3] < y[3] ? -1 : x[3] > y[3] ? 1 : 0)));
  const csv = Buffer.from(`date,tag,platform,level,metric,median,min,max,n,verdict\n${csvRows.map((r) => `${r[4]}\n`).join("")}`);
  const csvScan = scanCsvText(csv.toString("utf8"));
  if (csvScan.length > 0) throw new BuildError(`downloads/series.csv.gz: forbidden pattern(s) ${[...new Set(csvScan.map((h) => h.pattern))].join(", ")}`);
  files.set("downloads/records.ndjson.gz", gzip(ndjson));
  files.set("downloads/series.csv.gz", gzip(csv));
  const downloads = ["downloads/records.ndjson.gz", "downloads/series.csv.gz"].map((rel) => ({ path: rel, bytes: files.get(rel).length, sha256: sha256(files.get(rel)) }));

  // index
  const recordPath = (r) =>
    r.kind === "nightly"
      ? `records/${r.platform.id}/${r.release.date}.${r.release.tag}.json`
      : r.paired_nightly
        ? `fork-nightly/${r.platform.id}/${r.paired_nightly.date}.${r.release.tag}.json`
        : r.kind === "fork"
          ? `fork/${r.release.tag}.${r.platform.id}.json`
          : `base/${r.release.sha.slice(0, 12)}.${r.platform.id}.json`;
  // Each nightly's comparability, published so no reader re-implements it: per level an opaque id of the
  // aggregator's own segment, the first 48 bits of the key's sha256 (so inserting or removing a record never changes
  // another record's ids), whether a noise band applies (capFor's rule: the scheduled compaction era), and the
  // validity gates' result (gateState). The levels are the record's cells and once, and 1e wherever the record has
  // the empty-server measurement, which once-per-record metrics are compared at even without a 1e cell.
  const segmentId = (key) => Number.parseInt(sha256(key).slice(0, 12), 16);
  const byTag = new Map();
  const nightlyOrder = inputs.records.map((x) => x.record).sort(byKey((r) => `${r.release.date}|${r.release.tag}|${r.platform.id}`));
  for (const r of nightlyOrder) {
    const key = `${r.release.date}|${r.release.tag}`;
    if (!byTag.has(key)) byTag.set(key, { date: r.release.date, tag: r.release.tag, sha: r.release.sha, platforms: {} });
    const levels = LEVEL_ORDER.filter((L) => L === "once" || r.cells?.[L] !== undefined || (L === "1e" && r.extras?.empty != null));
    byTag.get(key).platforms[r.platform.id] = {
      record_id: r.record_id,
      status: r.status,
      path: recordPath(r),
      segment: Object.fromEntries(levels.map((L) => [L, segmentId(segment(r, L))])),
      banded: compactionOf(r) === "scheduled",
      gates: Object.fromEntries(levels.map((L) => [L, gateState(model, r, L)])),
    };
  }
  const forkByTag = new Map();
  const forkOrder = inputs.forks.map((x) => x.record).sort((a, b) => (a.release.date < b.release.date ? -1 : a.release.date > b.release.date ? 1 : versionKey(a.release.tag) < versionKey(b.release.tag) ? -1 : 1));
  for (const r of forkOrder) {
    const base = baseOf(model, r);
    if (!forkByTag.has(r.release.tag)) {
      forkByTag.set(r.release.tag, { tag: r.release.tag, date: r.release.date, sha: r.release.sha, base_tag: r.base?.tag ?? null, base_date: r.base?.date ?? null, prev_tag: null, base_sha: r.base?.sha ?? null, base_record: base ? recordPath(base) : null, platforms: {} });
    }
    forkByTag.get(r.release.tag).platforms[r.platform.id] = { record_id: r.record_id, status: r.status, path: recordPath(r) };
  }
  const forkList = [...forkByTag.values()];
  forkList.forEach((f, k) => (f.prev_tag = k > 0 ? forkList[k - 1].tag : null));
  const harnessEras = [];
  for (const r of [...inputs.records.map((x) => x.record)].sort(byKey((x) => x.release.date))) {
    const lastEra = harnessEras.at(-1);
    if (lastEra && lastEra.files_sha256 === r.harness.files_sha256) lastEra.to = r.release.date;
    else harnessEras.push({ version: r.harness.version, files_sha256: r.harness.files_sha256, from: r.release.date, to: r.release.date });
  }
  // The fixture and feature eras as the published nightlies show them, never the catalogue's plan: an era starts at its
  // first published nightly (a closed fixture era ends at its last; an open one stays open), and an era with none is left
  // out, so no page names nightlies that are not published. They grow back as the records land.
  const nightlyDates = (keep) => inputs.records.map((x) => x.record).filter(keep).map((r) => r.release.date).sort();
  const fixtureEras = catalogue.fixture_eras.flatMap((e) => {
    const dates = nightlyDates((r) => r.fixture.id === e.id);
    return dates.length === 0 ? [] : [{ ...e, from: dates[0], to: e.to === null ? null : dates.at(-1) }];
  });
  // The ladder's index lists the ladder's metrics and eras: a scenario-lane metric, and a feature era only scenario
  // metrics use, belong to the scenario rows' own outputs.
  const ladderMetrics = catalogue.metrics.filter((m) => m.lane !== "scenario");
  const featureEras = ladderFeatureEras(catalogue).flatMap((e) => {
    const dates = nightlyDates((r) => r.release.date >= e.from);
    return dates.length === 0 ? [] : [{ ...e, from: dates[0] }];
  });
  const fixtures = new Map();
  for (const r of all) if (!fixtures.has(r.fixture.id)) fixtures.set(r.fixture.id, { id: r.fixture.id, sha256: r.fixture.sha256, bytes: r.fixture.bytes, migration: r.fixture.migration });
  const bandsFor = (m) =>
    Object.fromEntries(
      PLATFORM_IDS.map((p) => {
        const e = model.bands?.platforms?.[p]?.metrics?.[m.id];
        return [p, e ? { band: e.band, threshold: round2(e.band + 5), n: e.n } : null];
      }),
    );
  const capOf = (m) =>
    Object.fromEntries(
      PLATFORM_IDS.map((p) => [
        p,
        Object.fromEntries(
          levelsFor(m).map((L) => {
            const c = capability(model, p, m, L);
            return [L, { threshold: c.threshold, note: c.note }];
          }),
        ),
      ]),
    );
  const index = mark({
    schema: "t3cp/index/1",
    generated_at: generatedAt,
    schemas: { record: "t3cp/record/1", series: "t3cp/series/1", bands: "t3cp/bands/1", changes: "t3cp/changes/1", compare: "t3cp/compare/1" },
    levels: catalogue.levels,
    empty_cell: catalogue.empty_cell,
    headline_levels: catalogue.headline_levels,
    default_headline_level: catalogue.default_headline_level,
    groups: catalogue.groups,
    headlines: catalogue.headlines,
    // The compare page's rule inputs (records-index.json carries the per-record ones): capability() per platform and
    // level, and the metric's place in the gate and saturation rules.
    catalogue: ladderMetrics.map((m) => {
      const { era, ...rest } = m;
      return { ...rest, bands: bandsFor(m), cap: capOf(m), gate_exempt: GATE_EXEMPT.has(m.id), throughput: THROUGHPUT.has(m.id) };
    }),
    platforms: catalogue.platforms.map((pl) => {
      const list = model.nightlies.get(pl.id) ?? [];
      const last = list.at(-1) ?? null;
      return { id: pl.id, name: pl.name, host: pl.host, live: pl.live, latest: last?.record_id ?? null, latest_date: last?.release.date ?? null, latest_tag: last?.release.tag ?? null, latest_status: last?.status ?? null, records: list.length };
    }),
    eras: { fixture: fixtureEras, feature: featureEras, harness: harnessEras },
    fixtures: [...fixtures.values()],
    records_index: "records-index.json",
    budgets: { overview_gz_bytes: {}, overview_limit_gz_bytes: overviewLimit },
    fork: forkList,
    bases: (() => {
      const bySha = new Map();
      for (const { record: r } of [...inputs.bases].sort(byKey((x) => `${x.record.release.date}|${x.record.release.sha}`))) {
        if (!bySha.has(r.release.sha)) bySha.set(r.release.sha, { sha: r.release.sha, date: r.release.date, tag: r.release.tag, platforms: {} });
        bySha.get(r.release.sha).platforms[r.platform.id] = { record_id: r.record_id, status: r.status, path: recordPath(r) };
      }
      return [...bySha.values()];
    })(),
    series: seriesIndex,
    compare: comparePaths,
    downloads,
  });
  // Every nightly record's entry lives in records-index.json, never in the overview payload.
  // The fork-head records by night, each with the nightly it was paired with; the key only when there are any.
  // One entry per night, release and paired nightly: platforms that measured different releases on one night get one each.
  const headByNight = new Map();
  for (const { record: r } of [...(inputs.forkNightlies ?? [])].sort(byKey((x) => `${x.record.paired_nightly.date}|${versionKey(x.record.release.tag)}|${x.record.platform.id}`))) {
    const key = `${r.paired_nightly.date}|${r.release.tag}|${r.release.sha}|${r.paired_nightly.tag}`;
    if (!headByNight.has(key)) headByNight.set(key, { date: r.paired_nightly.date, tag: r.release.tag, sha: r.release.sha, paired_tag: r.paired_nightly.tag, platforms: {} });
    headByNight.get(key).platforms[r.platform.id] = { record_id: r.record_id, status: r.status, path: recordPath(r) };
  }
  files.set(
    "records-index.json",
    json(mark({ schema: "t3cp/records-index/1", generated_at: generatedAt, records: [...byTag.values()].sort(byKey((r) => `${r.date}|${r.tag}`)), ...(headByNight.size ? { fork_heads: [...headByNight.values()] } : {}) })),
  );
  // index.json publishes the overview payload it is itself part of: iterate to the size it has with its own figures in
  // it, and if no exact fixed point turns up, settle on figures that are never below the payload as built.
  const overviewRest = Object.fromEntries(
    model.platforms.map((p) => [p, ["changes.json", ...catalogue.headlines[p].map((id) => `series/${p}/${id}.latest.json`)].reduce((sum, rel) => sum + (files.has(rel) ? gzSize(files.get(rel)) : 0), 0)]),
  );
  let indexBytes;
  for (let round = 0; ; round++) {
    indexBytes = json(index);
    const size = gzSize(indexBytes);
    const measured = Object.fromEntries(model.platforms.map((p) => [p, size + overviewRest[p]]));
    const published = index.budgets.overview_gz_bytes;
    if (round > 0 && model.platforms.every((p) => published[p] === measured[p])) break;
    if (round >= 4 && model.platforms.every((p) => published[p] >= measured[p])) break;
    if (round >= 32) throw new BuildError("index.json: the overview payload figures do not settle");
    index.budgets.overview_gz_bytes = Object.fromEntries(model.platforms.map((p) => [p, round >= 4 ? Math.max(published[p] ?? 0, measured[p]) : measured[p]]));
  }
  files.set("index.json", indexBytes);
  for (const [rel, bytes] of scenarioOutputs(inputs, catalogue, scenarios, mark)) files.set(rel, bytes);
  files.set(MARKER, Buffer.from("t3cp aggregate output\n"));

  // scan every derived JSON file, then the budgets and the overview payload
  for (const [rel, bytes] of files) {
    if (!rel.endsWith(".json") || inputs.copies.has(rel)) continue;
    const hits = scanJsonText(bytes.toString("utf8"));
    if (hits.length > 0) throw new BuildError(`${rel}: forbidden pattern(s) ${[...new Set(hits.map((h) => h.pattern))].join(", ")}`);
  }
  const sizes = checkBudgets(files, budgets);
  for (const p of model.platforms) {
    const parts = ["index.json", "changes.json", ...catalogue.headlines[p].map((id) => `series/${p}/${id}.latest.json`)];
    const total = parts.reduce((sum, rel) => sum + (sizes.get(rel) ?? (files.has(rel) ? gzSize(files.get(rel)) : 0)), 0);
    if (total > overviewLimit) throw new BuildError(`overview payload on ${p}: ${total} bytes gzipped, over budget ${overviewLimit}`);
    if (total > OVERVIEW_WARN_SHARE * overviewLimit) warn(`overview payload on ${p}: ${total} bytes gzipped, ${Math.floor((total / overviewLimit) * 100)} % of the ${overviewLimit}-byte limit`);
  }
  return files;
}

/** Overview payload per platform (gzipped bytes) of a built file map, for reports. */
export function overviewPayload(files, platform, catalogue = loadCatalogue()) {
  const parts = ["index.json", "changes.json", ...catalogue.headlines[platform].map((id) => `series/${platform}/${id}.latest.json`)];
  const sizes = Object.fromEntries(parts.map((rel) => [rel, files.has(rel) ? gzSize(files.get(rel)) : 0]));
  return { parts: sizes, total: Object.values(sizes).reduce((a, b) => a + b, 0) };
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Builds and writes the tree. The output directory is replaced as a whole (build into a sibling temporary
 * directory, then swap), so stale files never survive; it must be empty, absent, or a previous aggregate output.
 */
export function aggregate({ inDir, outDir, dev = false, budgets = BUDGETS, publicRefs }) {
  const input = real(inDir);
  const output = path.resolve(outDir);
  const outputReal = real(output);
  if (inside(outputReal, input) || inside(input, outputReal)) throw new BuildError("the output directory must not be or contain the input directory");
  if (inside(outputReal, real(path.join(REPO_ROOT, "data")))) throw new BuildError("the output directory must not be under data/");
  if (outputReal === real(REPO_ROOT)) throw new BuildError("the output directory must not be the repository");
  if (dev && inside(input, real(path.join(REPO_ROOT, "data")))) throw new BuildError("--dev never reads from data/");
  if (fs.existsSync(output) && fs.readdirSync(output).length > 0 && !fs.existsSync(path.join(output, MARKER))) {
    throw new BuildError("the output directory is not empty and is not a previous aggregate output");
  }
  const files = buildOutputs(inDir, { dev, budgets, publicRefs });
  const tmp = `${output}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [rel, bytes] of files) {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.renameSync(tmp, output);
  return files;
}

// ---------------------------------------------------------------------------------------------------------
// release posts

/**
 * The numbers for one fork release on one platform, for the release post.
 *
 * @param {{dataDir: string, tag: string, platform: string, dev?: boolean}} args  dataDir is an input tree (data/v1)
 * @returns {{release: {tag, date, sha}, base: {tag, date, sha, record}|null, prev: {tag, date, sha}|null, rows: Array<{
 *   metric: string, level: string, fork: {median, min, max, n}, base: {median, min, max, n}|null,
 *   prev: {median, min, max, n}|null, band_pct: number|null, threshold_pct: number|null,
 *   delta: number|null,            // vs base, sign-adjusted FRACTION: positive = worse (0.12 = 12 % worse)
 *   delta_pct_raw: number|null,    // vs base, (fork - base) / base in percent, real sign
 *   verdict: "regressed"|"improved"|"within"|null, note: string|null, thin_reference: false,
 *   delta_vs_prev: number|null, delta_vs_prev_pct_raw: number|null, verdict_vs_prev, note_vs_prev,
 *   saturated: {fork: boolean, base: boolean|null, prev: boolean|null}}>}}
 *   Saturated levels (the server did not serve every agent): only turns_completed and agents_served keep
 *   verdicts; every other row there has verdict null and note "saturated". A base in another compaction
 *   schedule era gives note "no_base".
 *   Rows cover every catalogued metric with a value on the fork record, at every level it has
 *   ("1".."250", "1e", "once"). Verdicts follow design §4: fork vs its upstream base nightly, and vs the
 *   previous fork release; fork-only metrics never get a verdict against upstream.
 */
// base.sha is the fork's merge-base SHA and base.record the id of the base record built there (null when that
// record does not exist yet: then every row's verdict is null with note "no_base"); base.tag is the nightly of
// that day, kept as context only.
export function forkRelease({ dataDir, tag, platform, dev = false, publicRefs }) {
  const catalogue = loadCatalogue();
  const model = makeModel(loadInputs(dataDir, { dev, catalogue, publicRefs }), catalogue);
  return forkReleaseFromModel(model, tag, platform);
}

function forkReleaseFromModel(model, tag, platform) {
  const list = model.forks.get(platform) ?? [];
  const k = list.findIndex((r) => r.release.tag === tag);
  if (k < 0) throw new BuildError(`no fork record ${tag} on ${platform}`);
  const record = list[k];
  const base = baseOf(model, record);
  const prev = k > 0 ? list[k - 1] : null;
  const pickStat = (s) => (s ? { median: s.median, min: s.min, max: s.max, n: s.n } : null);
  const rows = [];
  for (const m of model.seriesMetrics) {
    if (m.na_on.includes(platform)) continue;
    for (const L of levelsFor(m)) {
      const s = statAt(record, m, L);
      if (s === null || s.median === null) continue;
      const vb = base ? compareOne(model, platform, m, L, base, record, { upstreamRef: true }) : null;
      const vp = prev ? compareOne(model, platform, m, L, prev, record) : null;
      // The band that applies to the fork's comparison with its base: none outside the scheduled era.
      const cap = capFor(capability(model, platform, m, L), m, record, ...(base ? [base] : []));
      const signed = (c) => (c === null || c.exact === null ? null : (m.better === "higher" ? -c.exact : c.exact) / 100);
      rows.push({
        metric: m.id,
        level: L,
        fork: pickStat(s),
        base: pickStat(vb?.sa ?? null),
        prev: pickStat(vp?.sa ?? null),
        band_pct: cap.band,
        threshold_pct: cap.threshold,
        delta: signed(vb),
        delta_pct_raw: vb?.delta ?? null,
        verdict: vb?.verdict ?? null,
        note: vb ? vb.note : "no_base",
        thin_reference: false,
        delta_vs_prev: signed(vp),
        delta_vs_prev_pct_raw: vp?.delta ?? null,
        verdict_vs_prev: vp?.verdict ?? null,
        note_vs_prev: vp ? vp.note : "no_reference",
        // At a saturated level only throughput keeps a verdict: these say which side was saturated.
        saturated: { fork: saturatedAt(record, L), base: base ? saturatedAt(base, L) : null, prev: prev ? saturatedAt(prev, L) : null },
      });
    }
  }
  return {
    release: { tag: record.release.tag, date: record.release.date, sha: record.release.sha },
    // The base is the tree at the fork's merge-base SHA; the nightly tag of that day is kept as context.
    base: record.base ? { tag: record.base.tag, date: base?.release.date ?? record.base.date, sha: record.base.sha, record: base ? base.record_id : null } : null,
    prev: prev ? { tag: prev.release.tag, date: prev.release.date, sha: prev.release.sha } : null,
    rows,
  };
}

/**
 * The design §5.9 input bundle for one fork tag (schema/release-bundle-1.json): for the eight headline metrics
 * and every metric with a verdict, on every platform with a record of the tag, at 1, 50, 100 and 250 agents (and
 * "once" for the once-per-record metrics), the fork, base and previous values with display strings.
 *
 * @param {{dataDir: string, tag: string, levels?: string[], dev?: boolean}} args
 */
export function releaseBundle({ dataDir, tag, levels = ["1", "50", "100", "250"], dev = false, publicRefs }) {
  const catalogue = loadCatalogue();
  const inputs = loadInputs(dataDir, { dev, catalogue, publicRefs });
  const model = makeModel(inputs, catalogue);
  const platforms = model.platforms.filter((p) => (model.forks.get(p) ?? []).some((r) => r.release.tag === tag));
  if (platforms.length === 0) throw new BuildError(`no fork record ${tag}`);
  const metrics = [];
  let head = null;
  for (const p of platforms) {
    const rel = forkReleaseFromModel(model, tag, p);
    head ??= rel;
    const headlines = new Set(catalogue.headlines[p]);
    for (const row of rel.rows) {
      const m = model.byId.get(row.metric);
      if (!levels.includes(row.level) && row.level !== "once") continue;
      // agents_served at a level where the fork or its base is saturated stays whatever its verdicts: the release
      // page's saturated line quotes it.
      const servedLine = m.id === "agents_served" && (row.saturated?.fork === true || row.saturated?.base === true);
      if (!headlines.has(m.id) && row.verdict === null && row.verdict_vs_prev === null && !servedLine) continue;
      const deltaPct = row.delta_pct_raw;
      metrics.push({
        id: m.id,
        name: m.name,
        unit: m.unit,
        better: m.better,
        headline: catalogue.headlines[p].indexOf(m.id) >= 0 ? catalogue.headlines[p].indexOf(m.id) + 1 : null,
        platform: p,
        level: row.level,
        fork: { median: row.fork.median, min: row.fork.min, max: row.fork.max, n: row.fork.n },
        base: row.base,
        prev: row.prev,
        band_pct: row.band_pct,
        threshold_pct: row.threshold_pct,
        delta_pct: deltaPct,
        worse_pct: row.delta === null ? null : round2(row.delta * 100),
        verdict: row.verdict,
        note: row.note,
        delta_vs_prev_pct: row.delta_vs_prev_pct_raw,
        worse_vs_prev_pct: row.delta_vs_prev === null ? null : round2(row.delta_vs_prev * 100),
        verdict_vs_prev: row.verdict_vs_prev,
        note_vs_prev: row.note_vs_prev,
        saturated: row.saturated,
        text: {
          fork: formatValue(row.fork.median, m.unit),
          base: formatValue(row.base?.median ?? null, m.unit),
          prev: formatValue(row.prev?.median ?? null, m.unit),
          delta_pct: formatPct(deltaPct),
          band_pct: row.band_pct === null ? null : `${row.band_pct.toFixed(1)} %`,
          threshold_pct: row.threshold_pct === null ? null : `${row.threshold_pct.toFixed(1)} %`,
          delta_vs_prev_pct: formatPct(row.delta_vs_prev_pct_raw),
        },
      });
    }
  }
  const counts = { regressed: 0, improved: 0, within: 0, no_verdict: 0 };
  for (const row of metrics) counts[row.verdict ?? "no_verdict"]++;
  const numbers = new Set();
  for (const row of metrics) for (const t of Object.values(row.text)) if (t !== null) numbers.add(t);
  for (const v of Object.values(counts)) numbers.add(String(v));
  for (const L of levels) numbers.add(L);
  return {
    schema: "t3cp/release-bundle/1",
    ...(inputs.synthetic ? { synthetic: true } : {}),
    release: head.release,
    base: head.base ? { tag: head.base.tag, date: head.base.date, sha: head.base.sha } : null,
    prev: head.prev,
    platforms,
    levels,
    counts,
    metrics,
    allowed_numbers: [...numbers].sort(),
    allowed_metric_names: [...new Set(metrics.map((r) => r.name))].sort(),
  };
}

// ---------------------------------------------------------------------------------------------------------

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { in: { type: "string" }, out: { type: "string" }, dev: { type: "boolean" }, tag: { type: "string" }, "public-refs": { type: "string" } },
  });
  try {
    if (positionals[0] === "bundle") {
      if (!values.in || !values.tag) throw new BuildError("usage: aggregate.mjs bundle --in <data/v1> --tag <fork tag> [--dev]");
      process.stdout.write(`${JSON.stringify(releaseBundle({ dataDir: values.in, tag: values.tag, dev: values.dev === true }), null, 2)}\n`);
      return 0;
    }
    if (!values.in || !values.out) throw new BuildError("usage: aggregate.mjs --in <data/v1> --out <dir> [--dev] | bundle --in <dir> --tag <tag>");
    // --public-refs names another references file (tests only); the pinned tools/t3cp/public-refs.json otherwise.
    const publicRefs = values["public-refs"] ? loadPublicRefs(values["public-refs"]) : undefined;
    const files = aggregate({ inDir: values.in, outDir: values.out, dev: values.dev === true, publicRefs });
    const catalogue = loadCatalogue();
    const platforms = PLATFORM_IDS.filter((p) => files.has(`series/${p}/${catalogue.headlines[p][0]}.latest.json`));
    const payload = platforms.map((p) => `${p} ${overviewPayload(files, p, catalogue).total} B`).join(", ");
    process.stderr.write(`aggregate: ${files.size} files; overview payload gzipped (measured): ${payload}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`aggregate: ${error instanceof BuildError || error instanceof ScanConfigError ? error.message : error?.stack ?? String(error)}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));

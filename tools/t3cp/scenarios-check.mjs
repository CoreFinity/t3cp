#!/usr/bin/env node
// The scenario catalogue's check: scenarios.json (schema/scenarios-1.json) against its schema, the metric catalogue,
// the pinned harness versions and its lock file, scenarios.lock.json. A row is never edited: any change is a new
// version. The lock holds each id@version's content hash (sha256 of the row as canonical JSON: keys sorted, no
// whitespace), and an entry any committed lock held keeps its hash, so a row cannot be edited by rewriting its lock
// entry in the same commit. Retiring is the one change the lock takes: the status from active to retired, every other
// byte of the row as locked, its entry unchanged; and it is one way, so a row any commit had retired stays retired.
//
//   node tools/t3cp/scenarios-check.mjs [--repo <dir>]           exit 0 when clean, 2 with each problem on stderr
//   node tools/t3cp/scenarios-check.mjs --lock [--repo <dir>]    adds the lock entry of each row the lock lacks (never
//                                                                changes or drops one), then checks
// Exit 1 on an error (a file that cannot be read or parsed, a git history that cannot be read).
//
// The runner VM never runs this file and it reads no file the exporter closure (EXPORTER_FILES) holds but the catalogue
// and public-refs.json, so a change here moves no image pin.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { REPO_ROOT, isMain } from "./lib/repo.mjs";
import { validate } from "./lib/validate.mjs";

export const SCENARIOS_FILE = "scenarios.json";
export const LOCK_FILE = "scenarios.lock.json";
export const SCHEMA_FILE = "schema/scenarios-1.json";
export const LOCK_SCHEMA = "t3cp/scenarios-lock/1";
/** The ladder's scenario id: its rows publish as suite ladder-<version>. */
export const LADDER_ID = "ladder";
/** The lane of the metrics scenario rows publish; the ladder publishes the daily and record lanes. */
const SCENARIO_LANE = "scenario";
const HASH = /^[0-9a-f]{64}$/;
const LEVEL = /^[1-9][0-9]*$/;

/** id@version, the row's key in the lock and in a spec's suite.scenario. */
export const rowKey = (row) => `${row.id}@${row.version}`;

/** The suite a row's records publish as: ladder-<version> for the ladder, <id>@<version> for every other row. */
export const rowSuite = (row) => (row.id === LADDER_ID ? `${LADDER_ID}-${row.version}` : rowKey(row));

const canonical = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );

/** The row's content hash: sha256 of its canonical JSON (keys sorted, no whitespace), so layout is not an edit. */
export const rowHash = (row) => createHash("sha256").update(canonical(row)).digest("hex");

const seconds = (duration) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(duration);
  return Number(m[1]) * (m[2] === "ms" ? 0.001 : m[2] === "m" ? 60 : 1);
};

/**
 * The problems of a catalogue against its schema, the metric catalogue and the pinned harness versions (the lock
 * aside): a list of lines, each naming the row and the rule. Empty when clean.
 */
export function checkScenarios({ scenarios, schema, catalogue, publicRefs, fixtures }) {
  const errors = validate(schema, scenarios);
  if (errors.length > 0) return errors.map((e) => `${SCENARIOS_FILE} ${e.path}: ${e.message}`);
  const problems = [];
  const metrics = new Map(catalogue.metrics.map((m) => [m.id, m]));
  const platforms = new Set(catalogue.platforms.map((p) => p.id));
  const pinned = new Set(Object.keys(publicRefs?.harness ?? {}));
  const published = new Set((fixtures ?? []).map((f) => f.id));
  const seen = new Set();
  const measuredBy = new Map();
  for (const row of scenarios.rows) {
    const key = rowKey(row);
    const ladder = row.id === LADDER_ID;
    if (seen.has(key)) problems.push(`${key}: duplicate id@version`);
    seen.add(key);
    if (row.suite !== rowSuite(row)) problems.push(`${key}: suite must be ${rowSuite(row)}`);
    if (!pinned.has(row.harness)) problems.push(`${key}: harness ${row.harness} has no pin in tools/t3cp/public-refs.json`);
    for (const p of row.platforms) if (!platforms.has(p)) problems.push(`${key}: platform ${p} is not in the catalogue`);
    if (row.metrics === "catalogue") {
      if (!ladder) problems.push(`${key}: only the ladder publishes "catalogue" (every metric no other row names)`);
    } else {
      if (ladder) problems.push(`${key}: the ladder publishes "catalogue"`);
      for (const id of row.metrics) {
        const m = metrics.get(id);
        if (!m) problems.push(`${key}: unknown metric key ${id}`);
        else if (m.lane !== SCENARIO_LANE) problems.push(`${key}: ${id} is a ${m.lane} metric; a scenario row publishes scenario-lane metrics only`);
        const ids = measuredBy.get(id) ?? new Set();
        ids.add(row.id);
        measuredBy.set(id, ids);
      }
    }
    if (ladder !== (row.fixture === "era")) problems.push(`${key}: the fixture era is the ladder's, and the ladder's fixture is era`);
    else if (!ladder && row.fixture !== "none" && !published.has(row.fixture)) {
      problems.push(`${key}: fixture ${row.fixture} is not a published fixture (fixture/fixtures.json)`);
    }
    const names = row.cells.map((c) => c.name);
    if (new Set(names).size !== names.length) problems.push(`${key}: cell names are not unique`);
    for (const c of row.cells) {
      const at = `${key} cell ${c.name}`;
      if (c.mark_age_days !== undefined && c.post !== "prune-mark") problems.push(`${at}: mark_age_days goes with the prune-mark post step only`);
      if ((c.fixture === "none" || row.fixture === "none") && c.mode !== "fresh") problems.push(`${at}: a cell without a fixture runs fresh`);
      if (c.poll_rate !== undefined && !(Number.isFinite(Number(c.poll_rate)) && Number(c.poll_rate) > 0)) problems.push(`${at}: poll_rate must be a finite number above 0`);
      if (ladder && !(LEVEL.test(c.name) || c.name === "1e")) problems.push(`${at}: the ladder's cells are its levels and 1e`);
      if (ladder && (c.name === "1e") !== (c.fixture === "none")) problems.push(`${at}: 1e, and only 1e, runs on an empty database`);
      if (ladder && LEVEL.test(c.name) && c.sessions !== Number(c.name)) problems.push(`${at}: a ladder level runs that many sessions`);
      if (ladder && c.name === "1e" && c.sessions !== 1) problems.push(`${at}: the empty cell runs one session`);
      if (ladder && (c.switch_interval === undefined || c.poll_rate === undefined)) problems.push(`${at}: the ladder's cells name their switch interval and poll rate`);
    }
    if (ladder && !row.cells.some((c) => LEVEL.test(c.name))) problems.push(`${key}: a ladder has at least one level`);
    if (ladder && !names.includes("1e")) problems.push(`${key}: a ladder has the empty cell 1e`);
    if (ladder && (new Set(row.cells.map((c) => c.warmup_s)).size > 1 || new Set(row.cells.map((c) => c.window_s)).size > 1)) {
      problems.push(`${key}: the ladder's cells share one warm-up and one window`);
    }
  }
  for (const [id, ids] of measuredBy) {
    if (ids.size > 1) problems.push(`${id} is measured by more than one scenario: ${[...ids].sort().join(", ")}`);
  }
  return problems;
}

/** Throws unless the lock is a t3cp/scenarios-lock/1 document mapping id@version to a 64-hex hash. */
export function assertLockShape(lock, what = LOCK_FILE) {
  const ok =
    lock !== null &&
    typeof lock === "object" &&
    !Array.isArray(lock) &&
    lock.schema === LOCK_SCHEMA &&
    Object.keys(lock).every((k) => ["schema", "description", "rows"].includes(k)) &&
    (lock.description === undefined || typeof lock.description === "string") &&
    lock.rows !== null &&
    typeof lock.rows === "object" &&
    !Array.isArray(lock.rows) &&
    Object.entries(lock.rows).every(([k, v]) => /^[a-z][a-z0-9-]*@[1-9][0-9]*$/.test(k) && typeof v === "string" && HASH.test(v));
  if (!ok) throw new Error(`${what} is not a ${LOCK_SCHEMA} document mapping id@version to a sha256`);
}

/**
 * Why a row whose hash is not its lock entry's is refused, or null when it is retired as locked: retiring is the one
 * change the lock takes (status active to retired, every other byte of the row as locked). A row retired with any
 * other change, or locked retired and made active, is an edit.
 */
function lockProblem(key, row, locked) {
  if (row.status === "retired") {
    if (rowHash({ ...row, status: "active" }) === locked) return null;
    return `${key}: retired with another change, but retiring a row changes its status only: publish the change as a new version`;
  }
  if (rowHash({ ...row, status: "retired" }) === locked) return `${key}: retired when it was locked, and a retired row is never made active again`;
  return `${key}: edited, but a row is never edited: publish the change as a new version`;
}

/** The problems of the catalogue against its lock: a row edited, a row removed, or a row the lock lacks. */
export function checkLock(scenarios, lock) {
  const problems = [];
  const rows = new Map(scenarios.rows.map((r) => [rowKey(r), r]));
  for (const [key, row] of rows) {
    const locked = lock.rows[key];
    if (locked === undefined) problems.push(`${key}: not in ${LOCK_FILE} (node tools/t3cp/scenarios-check.mjs --lock adds it)`);
    else if (locked !== rowHash(row)) {
      const problem = lockProblem(key, row, locked);
      if (problem !== null) problems.push(problem);
    }
  }
  for (const key of Object.keys(lock.rows)) {
    if (!rows.has(key)) problems.push(`${key}: locked but no longer in ${SCENARIOS_FILE}: a row is never removed (retire it)`);
  }
  return problems;
}

/** The environment variables that point git at a repository other than the one it finds from its directory. */
const GIT_LOCATING = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_NAMESPACE",
]);

/** Whether `dir` or a directory above it holds a .git entry (a directory, or a file naming one). */
function hasGitMetadata(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/**
 * Every committed version of `file` in `root`: {checked: true, versions: [{at, text}]}, newest first, or
 * {checked: false} when `root` is outside any git work tree. Fails closed: a git that cannot run, a repository git
 * refuses to read, a shallow clone (its history stops at its boundary, so what lies before it is unseen), or a committed
 * version it cannot read throws (`what` names the history), so a history that was not read whole never passes. A
 * commit that removed the file lists no version; the commits before it are read on their own.
 */
function committedVersions(root, file, what, gitBin) {
  // Git finds the repository from the root alone: variables that point it elsewhere are dropped.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !GIT_LOCATING.has(k)));
  const run = (args) => spawnSync(gitBin, ["-C", root, ...args], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  const fail = (step, r) => {
    const why = r.error ? `git cannot run (${r.error.code ?? r.error.message})` : `git ${step} failed: ${(r.stderr ?? "").trim().split("\n")[0]}`;
    return new Error(`cannot read ${what}: ${why}`);
  };
  const out = (step, args) => {
    const r = run(args);
    if (r.error || r.status !== 0) throw fail(step, r);
    return r.stdout;
  };
  const inside = run(["rev-parse", "--is-inside-work-tree"]);
  if (inside.error) throw fail("rev-parse", inside);
  if (inside.status !== 0) {
    // Outside any work tree only when no .git exists at the root or above it; metadata git cannot read is an error.
    if (/not a git repository/i.test(inside.stderr ?? "") && !hasGitMetadata(root)) return { checked: false };
    throw fail("rev-parse", inside);
  }
  if (inside.stdout.trim() !== "true") return { checked: false };
  if (out("rev-parse --is-shallow-repository", ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    throw new Error(`cannot read ${what}: the repository is a shallow clone, whose history stops at its boundary (git fetch --unshallow reads all of it)`);
  }
  // A repository without commits has nothing committed to keep; any other HEAD that does not resolve is an error.
  const head = run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.error) throw fail("rev-parse HEAD", head);
  if (head.status !== 0) {
    if (out("rev-list --all", ["rev-list", "-n", "1", "--all"]).trim() === "") return { checked: true, versions: [] };
    throw fail("rev-parse HEAD", head);
  }
  const versions = [];
  for (const sha of out("log", ["log", "--full-history", "--format=%H", "HEAD", "--", file]).split("\n").filter(Boolean)) {
    const at = sha.slice(0, 12);
    if (out(`ls-tree ${at}`, ["ls-tree", "--name-only", sha, "--", file]).trim() === "") continue;
    versions.push({ at, text: out(`show ${at}:${file}`, ["show", `${sha}:${file}`]) });
  }
  return { checked: true, versions };
}

/**
 * The lock's git history in `root`: every committed version of the lock must hold its entries in the current lock with
 * the same hash. Returns {checked: true, problems}, or {checked: false} when `root` is outside any git work tree. Fails
 * closed (committedVersions).
 */
export function checkLockHistory(root, lock, { gitBin = "git" } = {}) {
  const history = committedVersions(root, LOCK_FILE, "the lock's history", gitBin);
  if (!history.checked) return { checked: false };
  const problems = [];
  for (const { at, text } of history.versions) {
    let past;
    try {
      past = JSON.parse(text);
      assertLockShape(past, `${LOCK_FILE} at ${at}`);
    } catch (error) {
      problems.push(error instanceof SyntaxError ? `${LOCK_FILE} at ${at} does not parse` : error.message);
      continue;
    }
    for (const [key, hash] of Object.entries(past.rows)) {
      if (lock.rows[key] !== hash) problems.push(`${key}: commit ${at} locked it with another hash (or the entry is gone): a locked row is never edited or removed`);
    }
  }
  return { checked: true, problems: [...new Set(problems)] };
}

/**
 * Retirement is one way: a row any committed scenarios.json had retired is retired in `scenarios` too (the newest such
 * commit is named). A row gone from the catalogue is the lock's to refuse. Returns {checked: true, problems}, or
 * {checked: false} when `root` is outside any git work tree. Fails closed (committedVersions).
 */
export function checkRetirementHistory(root, scenarios, { gitBin = "git" } = {}) {
  const history = committedVersions(root, SCENARIOS_FILE, `the history of ${SCENARIOS_FILE}`, gitBin);
  if (!history.checked) return { checked: false };
  const now = new Map(scenarios.rows.map((r) => [rowKey(r), r]));
  const problems = new Map();
  for (const { at, text } of history.versions) {
    let past;
    try {
      past = JSON.parse(text);
    } catch {
      problems.set(`parse ${at}`, `${SCENARIOS_FILE} at ${at} does not parse`);
      continue;
    }
    if (!Array.isArray(past?.rows)) {
      problems.set(`rows ${at}`, `${SCENARIOS_FILE} at ${at} has no rows`);
      continue;
    }
    for (const row of past.rows) {
      if (row?.status !== "retired") continue;
      const key = rowKey(row);
      const current = now.get(key);
      if (current !== undefined && current.status !== "retired" && !problems.has(key)) {
        problems.set(key, `${key}: commit ${at} had it retired, and a retired row is never made active again`);
      }
    }
  }
  return { checked: true, problems: [...problems.values()] };
}

const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const LOCK_DESCRIPTION =
  "The content hash of every scenarios.json row, by id@version: sha256 of the row as canonical JSON (keys sorted, no whitespace). An entry is never changed or removed; node tools/t3cp/scenarios-check.mjs --lock adds the entries of new rows. Retiring a row is not an edit: its status alone goes from active to retired, never back, and its entry stays the hash of the row as it was locked.";

/** Reads a repository's catalogue, lock (null when it has none), references and published fixtures. */
export function loadRepo(root = REPO_ROOT) {
  return {
    scenarios: readJson(root, SCENARIOS_FILE),
    lock: fs.existsSync(path.join(root, LOCK_FILE)) ? readJson(root, LOCK_FILE) : null,
    schema: readJson(root, SCHEMA_FILE),
    catalogue: readJson(root, "catalogue/catalogue.json"),
    publicRefs: readJson(root, "tools/t3cp/public-refs.json"),
    fixtures: readJson(root, "fixture/fixtures.json"),
  };
}

/** Every check over a repository: {problems, history: "checked" | "not a git work tree"}. */
export function checkRepo(root = REPO_ROOT, { history = true } = {}) {
  const repo = loadRepo(root);
  if (repo.lock === null) return { problems: [`${LOCK_FILE} is missing (node tools/t3cp/scenarios-check.mjs --lock writes it)`], history: "not read" };
  assertLockShape(repo.lock);
  const problems = checkScenarios(repo);
  if (problems.length > 0) return { problems, history: "not read" };
  problems.push(...checkLock(repo.scenarios, repo.lock));
  if (!history) return { problems, history: "not read" };
  const past = checkLockHistory(root, repo.lock);
  if (past.checked) problems.push(...past.problems);
  const retired = checkRetirementHistory(root, repo.scenarios);
  if (retired.checked) problems.push(...retired.problems);
  return { problems, history: past.checked ? "checked" : "not a git work tree" };
}

/** Adds the lock entry of each row the lock lacks; never changes or drops an entry. Returns the keys added. */
export function writeLock(root = REPO_ROOT) {
  const repo = loadRepo(root);
  repo.lock ??= { schema: LOCK_SCHEMA, description: LOCK_DESCRIPTION, rows: {} };
  assertLockShape(repo.lock);
  const problems = checkScenarios(repo);
  if (problems.length > 0) throw new Error(`${SCENARIOS_FILE} has problems; nothing locked:\n${problems.join("\n")}`);
  const added = [];
  const rows = { ...repo.lock.rows };
  for (const row of repo.scenarios.rows) {
    const key = rowKey(row);
    if (rows[key] === undefined) {
      rows[key] = rowHash(row);
      added.push(key);
    }
  }
  if (added.length > 0) {
    const lock = { schema: LOCK_SCHEMA, ...(repo.lock.description === undefined ? {} : { description: repo.lock.description }), rows };
    fs.writeFileSync(path.join(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  }
  return added;
}

/** The ladder row's workload as a ladder record publishes it (workload, less profile, seed and now). */
export function ladderWorkload(row) {
  const cells = {};
  for (const c of row.cells) {
    const rate = c.poll_rate === undefined ? 0 : Number(c.poll_rate);
    cells[c.name] = {
      sessions: c.sessions,
      subscribers: c.subscribers,
      pollers: c.pollers,
      turn_gap_s: seconds(c.turn_gap),
      switch_interval_s: c.switch_interval === undefined ? null : seconds(c.switch_interval),
      poll_interval_s: rate > 0 ? Math.round((1 / rate) * 1000) / 1000 : null,
      mode: c.mode,
      fixture: c.fixture === "none" ? "none" : "era",
    };
  }
  return {
    suite: rowSuite(row),
    warmup_s: row.cells[0].warmup_s,
    window_s: row.cells[0].window_s,
    levels: row.cells.filter((c) => LEVEL.test(c.name)).map((c) => Number(c.name)),
    empty_cell: row.cells.some((c) => c.name === "1e"),
    attempts_per_level: row.attempts,
    cells,
  };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { repo: { type: "string" }, lock: { type: "boolean" } } });
  const root = path.resolve(values.repo ?? REPO_ROOT);
  try {
    if (values.lock) for (const key of writeLock(root)) process.stdout.write(`locked ${key}\n`);
    const { problems, history } = checkRepo(root);
    for (const line of problems) process.stderr.write(`scenarios-check: ${line}\n`);
    if (problems.length > 0) return 2;
    process.stdout.write(`scenarios-check: clean (lock history ${history})\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`scenarios-check: ${error.message}\n`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));

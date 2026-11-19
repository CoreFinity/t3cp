// The scenario catalogue (scenarios.json, schema/scenarios-1.json) and its check: a row is never edited (the lock, and
// the lock's history), the validator's refusals (an unknown metric key, an unpinned harness, a duplicate id@version, a
// cell argument outside the driver's options), the public audit over the catalogue, and row 1 as today's suite.
// Planted registry-style ids are built from parts at run time, so this file passes the scan it tests.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOCK_FILE,
  SCENARIOS_FILE,
  checkLock,
  checkRepo,
  checkScenarios,
  ladderWorkload,
  loadRepo,
  rowHash,
  rowKey,
  writeLock,
} from "./scenarios-check.mjs";
import { EXPORTER_FILES } from "./export.mjs";
import { REPO_ROOT } from "./lib/repo.mjs";
import { WORKLOAD } from "./lib/fake.mjs";
import { cellProfile, loadProfiles, metaProfile } from "./runner/profiles.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "scenarios-check.mjs");
const AUDIT = path.join(REPO_ROOT, "tools", "audit", "audit-public-tree.mjs");
const j = (...parts) => parts.join("");
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const repo = loadRepo();
const clone = (value) => structuredClone(value);

/** A scenario row the validator accepts (a test row: an invented id, the pinned harness, a record-lane metric). */
function testRow(overrides = {}) {
  return {
    id: "test-row",
    version: 1,
    suite: "test-row@1",
    status: "active",
    added: "2026-11-19",
    harness: Object.keys(repo.publicRefs.harness)[0],
    platforms: ["linux-x64"],
    fixture: "none",
    attempts: 3,
    metrics: [repo.catalogue.metrics.find((m) => m.lane === "record").id],
    cells: [{ name: "c", mode: "fresh", sessions: 1, subscribers: 1, pollers: 0, turn_gap: "5s", warmup_s: 10, window_s: 30, seed_compacted_at: true, post: "none" }],
    ...overrides,
  };
}

/** The repository's catalogue with extra rows, checked against the repository's schema, catalogue and references. */
const check = (rows, base = repo.scenarios) => checkScenarios({ ...repo, scenarios: { ...clone(base), rows: [...clone(base.rows), ...rows] } });

/** A scratch repository: the files the check reads, with `scenarios` and `lock` as given (null: no lock file). */
function scratch(scenarios, lock) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-scenarios-"));
  temps.push(root);
  for (const rel of ["schema/scenarios-1.json", "catalogue/catalogue.json", "tools/t3cp/public-refs.json"]) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
  }
  fs.writeFileSync(path.join(root, SCENARIOS_FILE), `${JSON.stringify(scenarios, null, 2)}\n`);
  if (lock !== null) fs.writeFileSync(path.join(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  return root;
}

const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  }).trim();

const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("red first: an edited row at an existing id@version is refused (the lock records each id@version's content hash)", () => {
  const edited = clone(repo.scenarios);
  edited.rows[0].attempts += 1;
  assert.deepEqual(checkLock(edited, repo.lock), [`${rowKey(edited.rows[0])}: edited, but a row is never edited: publish the change as a new version`]);
  // An edit in a single cell is an edit; layout and key order are not (the hash is of the canonical JSON).
  const cell = clone(repo.scenarios);
  cell.rows[0].cells.at(-1).window_s += 1;
  assert.equal(checkLock(cell, repo.lock).length, 1);
  const reordered = clone(repo.scenarios);
  reordered.rows[0] = Object.fromEntries(Object.entries(reordered.rows[0]).reverse());
  assert.deepEqual(checkLock(reordered, repo.lock), []);
  // A removed row is refused (retire it instead), and so is a row the lock lacks.
  assert.match(checkLock({ ...repo.scenarios, rows: [] }, repo.lock).join("\n"), /locked but no longer in scenarios\.json/);
  const added = { ...repo.scenarios, rows: [...repo.scenarios.rows, testRow()] };
  assert.match(checkLock(added, repo.lock).join("\n"), /test-row@1: not in scenarios\.lock\.json/);
  // A change published as a new version is accepted once it is locked; its predecessor keeps its hash.
  const v2 = { ...clone(repo.scenarios.rows[0]), version: 2, suite: "ladder-2", attempts: 4 };
  const next = { ...repo.scenarios, rows: [repo.scenarios.rows[0], v2] };
  assert.deepEqual(checkLock(next, { ...repo.lock, rows: { ...repo.lock.rows, "ladder@2": rowHash(v2) } }), []);
});

test("the CLI: --lock adds new rows' entries and never rewrites one; an edited row exits 2", () => {
  const scenarios = { ...clone(repo.scenarios), rows: [...clone(repo.scenarios.rows), testRow()] };
  const root = scratch(scenarios, null);
  let r = cli(["--repo", root]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /scenarios\.lock\.json is missing/);
  r = cli(["--repo", root, "--lock"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /locked ladder@1\nlocked test-row@1\n/);
  const lock = JSON.parse(fs.readFileSync(path.join(root, LOCK_FILE), "utf8"));
  assert.deepEqual(lock.rows, { ...repo.lock.rows, "test-row@1": rowHash(testRow()) });
  scenarios.rows[1].attempts = 5;
  fs.writeFileSync(path.join(root, SCENARIOS_FILE), JSON.stringify(scenarios));
  r = cli(["--repo", root, "--lock"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /test-row@1: edited/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, LOCK_FILE), "utf8")), lock, "--lock rewrote nothing");
});

test("the lock's history: an entry any commit locked keeps its hash, so a row is not edited by rewriting its entry too", () => {
  const scenarios = { ...clone(repo.scenarios), rows: [...clone(repo.scenarios.rows), testRow()] };
  const root = scratch(scenarios, null);
  assert.deepEqual(writeLock(root), ["ladder@1", "test-row@1"]);
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "catalogue"]);
  assert.deepEqual(checkRepo(root), { problems: [], history: "checked" });
  // Edit the row and its lock entry together, and commit: the history refuses it.
  scenarios.rows[1].cells[0].window_s = 31;
  fs.writeFileSync(path.join(root, SCENARIOS_FILE), JSON.stringify(scenarios));
  const lock = JSON.parse(fs.readFileSync(path.join(root, LOCK_FILE), "utf8"));
  lock.rows["test-row@1"] = rowHash(scenarios.rows[1]);
  fs.writeFileSync(path.join(root, LOCK_FILE), JSON.stringify(lock));
  assert.deepEqual(checkLock(scenarios, lock), [], "the edit passes the lock alone");
  git(root, ["commit", "-q", "-am", "edit"]);
  const result = checkRepo(root);
  assert.equal(result.history, "checked");
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /^test-row@1: commit [0-9a-f]{12} locked it with another hash/);
  // Dropping the row and its entry is refused the same way.
  scenarios.rows.pop();
  delete lock.rows["test-row@1"];
  fs.writeFileSync(path.join(root, SCENARIOS_FILE), JSON.stringify(scenarios));
  fs.writeFileSync(path.join(root, LOCK_FILE), JSON.stringify(lock));
  assert.match(checkRepo(root).problems.join("\n"), /test-row@1: commit [0-9a-f]{12} locked it with another hash \(or the entry is gone\)/);
});

test("the validator refuses an unknown metric key", () => {
  assert.deepEqual(check([testRow()]), []);
  assert.deepEqual(check([testRow({ metrics: ["no_such_metric"] })]), ["test-row@1: unknown metric key no_such_metric"]);
  const weekly = repo.catalogue.metrics.find((m) => m.lane === "weekly").id;
  assert.deepEqual(check([testRow({ metrics: [weekly] })]), [`test-row@1: ${weekly} is a weekly metric, which no record publishes`]);
});

test("the validator refuses a harness version with no pin in public-refs.json", () => {
  assert.deepEqual(check([testRow({ harness: "t3cp-harness/9.9.9" })]), ["test-row@1: harness t3cp-harness/9.9.9 has no pin in tools/t3cp/public-refs.json"]);
  assert.match(check([testRow({ harness: "v9.9.9" })]).join("\n"), /\$\.rows\[1\]\.harness: does not match pattern/);
});

test("the validator refuses a duplicate id@version", () => {
  assert.deepEqual(check([testRow(), testRow({ status: "retired" })]), ["test-row@1: duplicate id@version"]);
  assert.deepEqual(check([testRow(), testRow({ version: 2, suite: "test-row@2" })]), [], "a new version is a new row");
});

test("the validator refuses a cell argument outside the driver's options", () => {
  const cell = testRow().cells[0];
  const withCell = (over) => check([testRow({ cells: [{ ...cell, ...over }] })]).join("\n");
  assert.match(withCell({ think_time: "5s" }), /\$\.rows\[1\]\.cells\[0\]\.think_time: unknown property/);
  assert.match(withCell({ mode: "replay" }), /cells\[0\]\.mode: not one of the allowed values/);
  assert.match(withCell({ post: "vacuum" }), /cells\[0\]\.post: not one of the allowed values/);
  assert.match(withCell({ sessions: 0 }), /cells\[0\]\.sessions: below the minimum 1/);
  assert.match(withCell({ pollers: 1001 }), /cells\[0\]\.pollers: above the maximum 1000/);
  assert.match(withCell({ turn_gap: "5 seconds" }), /cells\[0\]\.turn_gap: does not match pattern/);
  assert.match(withCell({ window_s: 5 }), /cells\[0\]\.window_s: below the minimum 10/);
  assert.match(withCell({ poll_rate: "0" }), /test-row@1 cell c: poll_rate must be above 0/);
  assert.match(withCell({ mark_age_days: 3 }), /test-row@1 cell c: mark_age_days goes with the prune-mark post step only/);
  assert.match(withCell({ mode: "history" }), /test-row@1 cell c: a cell without a fixture runs fresh/);
  assert.equal(withCell({ mode: "history", post: "prune-mark", mark_age_days: 3 }).includes("mark_age_days"), false);
});

test("the validator: suite names, the ladder's own fields, and one scenario per metric", () => {
  assert.deepEqual(check([testRow({ suite: "test-row-1" })]), ["test-row@1: suite must be test-row@1"]);
  assert.deepEqual(check([testRow({ metrics: "catalogue" })]), ['test-row@1: only the ladder publishes "catalogue" (every metric no other row names)']);
  assert.deepEqual(check([testRow({ fixture: "era" })]), ["test-row@1: the fixture era is the ladder's, and the ladder's fixture is era"]);
  assert.deepEqual(check([testRow({ id: "cell-names", suite: "cell-names@1", cells: [testRow().cells[0], testRow().cells[0]] })]), ["cell-names@1: cell names are not unique"]);
  const metric = testRow().metrics[0];
  assert.deepEqual(check([testRow(), testRow({ id: "other-row", suite: "other-row@1" })]), [`${metric} is measured by more than one scenario: other-row, test-row`]);
  const ladder2 = { ...clone(repo.scenarios.rows[0]), version: 2, suite: "ladder-2" };
  assert.deepEqual(check([ladder2]), [], "the ladder's next version");
  assert.deepEqual(check([{ ...ladder2, suite: "ladder@2" }]), ["ladder@2: suite must be ladder-2"]);
  const sessions = clone(ladder2);
  sessions.cells[1].sessions = 49;
  assert.deepEqual(check([sessions]), ["ladder@2 cell 50: a ladder level runs that many sessions"]);
  const windows = clone(ladder2);
  windows.cells[2].window_s = 301;
  assert.deepEqual(check([windows]), ["ladder@2: the ladder's cells share one warm-up and one window"]);
});

test("the repository's scenarios.json passes the check, with its lock and the lock's history", () => {
  const { problems, history } = checkRepo();
  assert.deepEqual(problems, []);
  if (fs.existsSync(path.join(REPO_ROOT, ".git"))) assert.equal(history, "checked");
  const r = cli([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^scenarios-check: clean/);
});

test("row 1 is today's suite: ladder@1 at the pinned harness, published as ladder-1, the default profile's cells", () => {
  const row = repo.scenarios.rows[0];
  assert.equal(rowKey(row), "ladder@1");
  assert.equal(row.suite, "ladder-1");
  assert.equal(row.status, "active");
  assert.deepEqual(Object.keys(repo.publicRefs.harness), [row.harness], "the one pinned harness");
  assert.deepEqual(row.platforms, repo.catalogue.platforms.map((p) => p.id));
  const workload = ladderWorkload(row);
  // The runner's load profile (profiles.json, its default) gives each cell's counts, mode, intervals and fixture.
  const profiles = loadProfiles();
  for (const [name, cell] of Object.entries(workload.cells)) {
    const p = cellProfile(profiles, profiles.default, name, "large-76");
    assert.deepEqual({ ...metaProfile(p), fixture: p.fixture }, cell, `cell ${name}`);
  }
  // The synthetic data's suite (tools/t3cp/lib/fake.mjs) is the same suite.
  const { profile, seed, now, ...synthetic } = WORKLOAD;
  const { cells, ...suite } = workload;
  assert.equal(profile, profiles.default);
  assert.deepEqual(synthetic, suite);
});

test("row 1 is today's suite: every committed ladder-1 record's workload is row 1's", () => {
  const row = repo.scenarios.rows[0];
  const workload = ladderWorkload(row);
  let n = 0;
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".json")) {
        const record = JSON.parse(fs.readFileSync(file, "utf8"));
        if (record.schema !== "t3cp/record/1" || record.workload?.suite !== row.suite) continue;
        const { profile, seed, now, ...published } = record.workload;
        assert.deepEqual(published, workload, path.relative(REPO_ROOT, file));
        assert.equal(record.harness.version, row.harness, path.relative(REPO_ROOT, file));
        n++;
      }
    }
  };
  for (const kind of ["records", "fork", "base", "fork-nightly"]) walk(path.join(REPO_ROOT, "data", "v1", kind));
  if (fs.existsSync(path.join(REPO_ROOT, "data", "v1", "records"))) assert.ok(n > 0, "the committed ladder-1 records were read");
});

test("a test row carrying an invented registry-style id fails the public audit over the catalogue", () => {
  const id = j("zq-9", "01-long-thread");
  const scenarios = { ...clone(repo.scenarios), rows: [...clone(repo.scenarios.rows), testRow({ id, suite: `${id}@1` })] };
  assert.deepEqual(check(scenarios.rows.slice(1)), [], "the row itself is well-formed");
  const root = scratch(scenarios, null);
  const r = spawnSync(process.execPath, [AUDIT, "--tree", root], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^scenarios\.json:\d+: id-registry$/m);
  // Upper case, in a cell or a description, the same.
  const upper = scratch({ ...clone(repo.scenarios), description: j("From QXZ-9", "01.") }, null);
  assert.match(spawnSync(process.execPath, [AUDIT, "--tree", upper], { encoding: "utf8" }).stdout, /^scenarios\.json:\d+: id-registry$/m);
  // The repository's own catalogue is clean.
  const clean = scratch(repo.scenarios, repo.lock);
  assert.equal(spawnSync(process.execPath, [AUDIT, "--tree", clean], { encoding: "utf8" }).status, 0);
});

test("the catalogue, its schema, lock and check are outside the exporter closure: this landing moves no image pin", () => {
  for (const rel of [SCENARIOS_FILE, LOCK_FILE, "schema/scenarios-1.json", "tools/t3cp/scenarios-check.mjs"]) {
    assert.ok(!EXPORTER_FILES.includes(rel), rel);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), rel);
  }
});

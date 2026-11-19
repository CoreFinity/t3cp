// A catalogue row (scenario id@version) becomes the runner's cells: their order, counts, intervals and driver
// arguments. A row not in the pinned catalogue, or a retired one, is refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { cellMeta, loadCatalogue, scenarioCell, scenarioOrder, scenarioRow } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const draft = join(here, "testdata", "scenarios-draft.json");
const catalogue = loadCatalogue(draft);
const STD = ["--call-timeout", "300s", "--stall-timeout", "600s", "--max-error-rate", "0.2", "--setup-concurrency", "16"];
const root = mkdtempSync(join(tmpdir(), "t3cp-scenarios-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("a row is found by id@version; one missing from the catalogue, another version, or a retired row is refused", () => {
  assert.equal(scenarioRow(catalogue, "long-thread-turn-start@1").fixture, "long-thread-1");
  assert.throws(() => scenarioRow(catalogue, "no-such-scenario@1"), /not in the catalogue/);
  assert.throws(() => scenarioRow(catalogue, "long-thread-turn-start@2"), /not in the catalogue/);
  assert.throws(() => scenarioRow(catalogue, "retired-example@1"), /retired/);
  assert.throws(() => scenarioRow(catalogue, "long-thread-turn-start"), /id@version/);
});

test("a row's attempts run cell by cell, round after round, named <cell>-<n>", () => {
  const row = { ...scenarioRow(catalogue, "long-thread-turn-start@1"), cells: [{ name: "a" }, { name: "b" }] };
  assert.deepEqual(
    scenarioOrder(row).map((a) => a.cell),
    ["a-1", "b-1", "a-2", "b-2", "a-3", "b-3"],
  );
});

test("a cell becomes exactly its counts, intervals, compaction seeding, post step and driver arguments", () => {
  const lt = scenarioCell(scenarioRow(catalogue, "long-thread-turn-start@1"), "lt");
  assert.deepEqual(
    { ...lt, driver_args: undefined },
    {
      scenario: { id: "long-thread-turn-start", version: 1 },
      cell: "lt",
      sessions: 1,
      subscribers: 0,
      pollers: 0,
      mode: "history",
      turn_gap: "20s",
      turn_gap_s: 20,
      warmup_s: 30,
      window_s: 600,
      seed_compacted_at: true,
      post: "turn-start-gap",
      mark_age_days: null,
      switch_interval: null,
      poll_rate: null,
      fixture: "row",
      driver_args: undefined,
    },
  );
  assert.deepEqual(lt.driver_args, ["--mode", "history", "--turn-gap", "20s", "--pollers", "0", ...STD]);
  const cmp = scenarioCell(scenarioRow(catalogue, "event-log-compaction@1"), "cmp");
  assert.equal(cmp.seed_compacted_at, false);
  assert.equal(cmp.post, "prune-mark");
  assert.deepEqual(cmp.driver_args, ["--mode", "history", "--turn-gap", "5s", "--pollers", "0", ...STD]);
  assert.throws(() => scenarioCell(scenarioRow(catalogue, "event-log-compaction@1"), "lt"), /no cell lt/);
});

test("a prune-mark cell names the age its fixture's prune mark is set to at each try's start; no other cell may", () => {
  const row = scenarioRow(catalogue, "event-log-compaction@1");
  assert.equal(scenarioCell(row, "cmp").mark_age_days, 3);
  const withCell = (patch) => ({ ...row, cells: [{ ...row.cells[0], ...patch }] });
  for (const bad of [0, 1.5, "3", -1]) {
    assert.throws(() => scenarioCell(withCell({ mark_age_days: bad }), "cmp"), /mark_age_days/, String(bad));
  }
  assert.throws(() => scenarioCell(withCell({ post: "turn-start-gap" }), "cmp"), /mark_age_days/);
});

test("the command line gives run-record.sh its shell variables, and refuses a row it does not have", () => {
  const cli = join(here, "scenarios.mjs");
  const order = spawnSync(process.execPath, [cli, "order", draft, "long-thread-turn-start@1"], { encoding: "utf8" });
  assert.equal(order.status, 0, order.stderr);
  assert.match(order.stdout, /^SC_ORDER='lt-1 lt-2 lt-3'$/m);
  assert.match(order.stdout, /^SC_ATTEMPTS_TOTAL='3'$/m);
  assert.match(order.stdout, /^SC_FIXTURE='long-thread-1'$/m);
  const meta = join(root, "cell.json");
  const sh = spawnSync(process.execPath, [cli, "sh", draft, "event-log-compaction@1", "cmp", meta], { encoding: "utf8" });
  assert.equal(sh.status, 0, sh.stderr);
  for (const line of ["P_SESSIONS='1'", "P_SUBSCRIBERS='1'", "P_POLLERS='0'", "P_WARMUP_S='60'", "P_WINDOW_S='300'", "P_SEED_COMPACTED='0'", "P_POST='prune-mark'", "P_MARK_AGE_DAYS='3'"]) {
    assert.ok(sh.stdout.split("\n").includes(line), `${line} in\n${sh.stdout}`);
  }
  assert.deepEqual(JSON.parse(readFileSync(meta, "utf8")).scenario, { id: "event-log-compaction", version: 1 });
  const lt = spawnSync(process.execPath, [cli, "sh", draft, "long-thread-turn-start@1", "lt", join(root, "lt.json")], { encoding: "utf8" });
  assert.ok(lt.stdout.split("\n").includes("P_MARK_AGE_DAYS=''"), lt.stdout);
  const missing = spawnSync(process.execPath, [cli, "order", draft, "no-such-scenario@1"], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /not in the catalogue/);
});

test("a row is a scenario row only when its suite is <id>@<version>: the ladder row runs by the ladder path", () => {
  const base = scenarioRow(catalogue, "long-thread-turn-start@1");
  const ladder = { ...base, id: "ladder", version: 1, suite: "ladder-1" };
  const withRows = (...rows) => ({ ...catalogue, rows: [...catalogue.rows, ...rows] });
  assert.throws(() => scenarioRow(withRows(ladder), "ladder@1"), /not a scenario row/);
  const { suite, ...noSuite } = { ...base, id: "no-suite" };
  assert.throws(() => scenarioRow(withRows(noSuite), "no-suite@1"), /not a scenario row/);
});

test("a cell's switch interval, poll rate and empty database are honoured; an empty-database cell is fresh", () => {
  const base = scenarioRow(catalogue, "event-log-compaction@1");
  const row = (patch) => ({ ...base, cells: [{ ...base.cells[0], ...patch }] });
  const cell = scenarioCell(row({ mode: "fresh", switch_interval: "300s", poll_rate: "0.01", fixture: "none" }), "cmp");
  assert.deepEqual(cell.driver_args.slice(0, 8), ["--mode", "fresh", "--switch-interval", "300s", "--poll-rate", "0.01", "--turn-gap", "5s"]);
  assert.equal(cell.fixture, "none");
  assert.deepEqual(cellMeta(cell).profile, { sessions: 1, subscribers: 1, pollers: 0, mode: "fresh", turn_gap_s: 5, switch_interval_s: 300, poll_interval_s: 100 });
  assert.throws(() => scenarioCell(row({ fixture: "none" }), "cmp"), /fresh/);
  assert.throws(() => scenarioCell({ ...row({}), fixture: "none" }, "cmp"), /fresh/);
  assert.throws(() => scenarioCell(row({ poll_rate: "often" }), "cmp"), /poll_rate/);
  assert.throws(() => scenarioCell(row({ fixture: "large-76" }), "cmp"), /fixture/);
  assert.throws(() => scenarioCell(row({ subscribe_rate: 1 }), "cmp"), /unknown/);
  const cli = join(here, "scenarios.mjs");
  const file = join(root, "empty-cell.json");
  writeFileSync(file, JSON.stringify({ ...catalogue, rows: [row({ mode: "fresh", fixture: "none" })] }));
  const sh = spawnSync(process.execPath, [cli, "sh", file, "event-log-compaction@1", "cmp", join(root, "empty-cell.meta.json")], { encoding: "utf8" });
  assert.equal(sh.status, 0, sh.stderr);
  assert.ok(sh.stdout.split("\n").includes("P_FIXTURE='none'"), sh.stdout);
});

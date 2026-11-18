// The migration chain parser (record extras): per-migration seconds and the chain total, read from the
// server's own "Upgrading database" / "migration: <id>_<name>" log lines.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseMigrationLog } from "./migration-log.mjs";

const captured = readFileSync(new URL("./testdata/migration-log-77-95.txt", import.meta.url), "utf8");

test("a captured upgrade from migration 76 lists 77 to 95 with seconds per migration", () => {
  const result = parseMigrationLog(captured);
  assert.deepEqual(
    result.migrations.map((m) => m.id),
    Array.from({ length: 19 }, (_, i) => 77 + i),
  );
  assert.equal(result.migrations[0].name, "RepairBooleanSettledOverride");
  assert.equal(result.migrations[18].name, "TurnItemInlineWorkOutput");
  // 77 starts at 15.012, 78 at 15.021; 95 starts at 15.070 and the chain finishes at 15.073.
  assert.equal(result.migrations[0].seconds, 0.009);
  assert.equal(result.migrations[18].seconds, 0.003);
  // Started at 15.008, finished at 15.073.
  assert.equal(result.chain_s, 0.065);
  assert.equal(result.from_migration, 76);
  assert.equal(result.to_migration, 95);
  assert.equal(result.started, true);
  assert.equal(result.finished, true);
  assert.deepEqual(result.reasons, {});
  for (const m of result.migrations) assert.ok(Number.isFinite(m.seconds) && m.seconds >= 0);
});

test("the per-migration seconds add up to the time from the first progress line to the finish", () => {
  const result = parseMigrationLog(captured);
  const sum = result.migrations.reduce((total, m) => total + m.seconds, 0);
  assert.ok(Math.abs(sum - 0.061) < 1e-9, `sum ${sum}`);
});

test("colour codes and a log span on the header line do not change the result", () => {
  const coloured = captured
    .split("\n")
    .map((line) =>
      line.replace(/^\[([0-9:.]+)\] INFO \(#(\d+)\):/, "\x1b[37m[$1]\x1b[0m \x1b[32mINFO\x1b[0m (#$2) Sqlite.setup=40ms:"),
    )
    .join("\n");
  assert.deepEqual(parseMigrationLog(coloured), parseMigrationLog(captured));
});

test("a chain that crosses midnight keeps positive seconds", () => {
  const log = [
    "[23:59:59.500] INFO (#3): Running database migrations",
    "[23:59:59.600] INFO (#3): Upgrading database",
    "  migration: 90_A",
    "  progress: 1 of 2",
    "[00:00:01.100] INFO (#3): Upgrading database",
    "  migration: 91_B",
    "  progress: 2 of 2",
    "[00:00:02.000] INFO (#3): Migrations ran successfully",
    "  migrations: [ '90_A', '91_B' ]",
  ].join("\n");
  const result = parseMigrationLog(log);
  assert.deepEqual(
    result.migrations.map((m) => [m.id, m.name, m.seconds]),
    [
      [90, "A", 1.5],
      [91, "B", 0.9],
    ],
  );
  assert.equal(result.chain_s, 2.5);
});

test("a release without progress lines gives no migrations and says why, never zeros", () => {
  const log = [
    "[10:00:00.000] INFO (#3): Running database migrations",
    "[10:00:04.250] INFO (#3): Migrations ran successfully",
    "  migrations: [ '60_A', '61_B' ]",
  ].join("\n");
  const result = parseMigrationLog(log);
  assert.deepEqual(result.migrations, []);
  assert.equal(result.chain_s, 4.25);
  assert.equal(result.reasons.migrations, "no_progress_lines");
  assert.equal(result.to_migration, 61);
});

test("a chain that never finishes leaves the last migration and the total null with a reason", () => {
  const log = [
    "[10:00:00.000] INFO (#3): Running database migrations",
    "[10:00:00.100] INFO (#3): Upgrading database",
    "  migration: 77_A",
    "  progress: 1 of 2",
    "[10:00:03.100] INFO (#3): Upgrading database",
    "  migration: 78_B",
    "  progress: 2 of 2",
  ].join("\n");
  const result = parseMigrationLog(log);
  assert.equal(result.migrations[0].seconds, 3);
  assert.equal(result.migrations[1].seconds, null);
  assert.equal(result.chain_s, null);
  assert.equal(result.finished, false);
  assert.equal(result.reasons.chain_s, "chain_not_finished");
});

test("a log with no migration lines at all says so", () => {
  const result = parseMigrationLog("[10:00:00.000] INFO (#1): Listening on port\n");
  assert.deepEqual(result.migrations, []);
  assert.equal(result.chain_s, null);
  assert.equal(result.started, false);
  assert.equal(result.reasons.chain_s, "no_migration_lines");
});

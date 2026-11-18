// extras-collect.mjs on a synthetic extras run: the snapshot GET must start after the measured window, and what was
// not measured is null with a reason.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function run({ snapshot, driver, firstTurn, fixtureId = "large-76", windowEnd = "2026-11-16T01:10:00.000Z" }) {
  const root = mkdtempSync(join(tmpdir(), "t3cp-extras-"));
  roots.push(root);
  const dir = join(root, "run", "work", "runs", "release", "attempt-1");
  mkdirSync(join(dir, "driver"), { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({ valid: true, window: { start: "2026-11-16T01:09:30.000Z", end: windowEnd } }));
  if (snapshot) writeFileSync(join(dir, "snapshot-after.json"), JSON.stringify(snapshot));
  if (driver) writeFileSync(join(dir, "driver", "driver.json"), JSON.stringify(driver));
  if (firstTurn) writeFileSync(join(dir, "first-turn.json"), JSON.stringify(firstTurn));
  const result = spawnSync(process.execPath, [join(here, "extras-collect.mjs"), "--run", join(root, "run"), "--out-dir", root, "--run-exit", "0", "--fixture-id", fixtureId], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return {
    snapshot: JSON.parse(readFileSync(join(root, "snapshot.json"), "utf8")),
    firstTurn: JSON.parse(readFileSync(join(root, "first_turn.json"), "utf8")),
  };
}

const after10 = { schema: "t3cp/snapshot-after/1", reasons: {}, thread_turn_items: 2000, ms: 812.4, wire_bytes: 90000, body_bytes: 1200000, status: 200, started_at: "2026-11-16T01:10:20.000Z", ended_at: "2026-11-16T01:10:20.812Z" };

test("a snapshot GET after the window is kept, with its no-overlap flag", () => {
  const { snapshot } = run({ snapshot: after10, driver: { status: "ok" } });
  assert.equal(snapshot.schema, "t3cp/extras-snapshot/1");
  assert.equal(snapshot.after_window, true);
  assert.equal(snapshot.ms, 812.4);
  assert.equal(snapshot.body_bytes, 1200000);
  assert.deepEqual(snapshot.reasons, {});
});

test("a snapshot GET that started inside the window is refused: null with a reason", () => {
  const { snapshot } = run({ snapshot: { ...after10, started_at: "2026-11-16T01:09:50.000Z" }, driver: { status: "ok" } });
  assert.equal(snapshot.after_window, false);
  assert.equal(snapshot.ms, null);
  assert.equal(snapshot.body_bytes, null);
  assert.equal(snapshot.reasons.ms, "overlaps_window");
});

const timed = {
  schema: "t3cp/first-turn-timed/1",
  ms: 6540,
  started_at: "2026-11-16T01:09:20.000Z",
  ended_at: "2026-11-16T01:09:26.540Z",
  run_status: "completed",
  thread_turn_items: 900,
  reasons: {},
};

test("no fixture: neither the snapshot nor the first turn (a history turn needs fixture threads), each with its reason", () => {
  const { snapshot, firstTurn } = run({ fixtureId: "none", driver: { status: "ok" }, firstTurn: timed });
  assert.equal(snapshot.ms, null);
  assert.equal(snapshot.reasons.ms, "no_fixture");
  assert.equal(firstTurn.ms, null);
  assert.equal(firstTurn.reasons.ms, "no_fixture");
});

test("the first turn is the runner's own timing of it (first-turn.json), not a driver key", () => {
  const { firstTurn } = run({ snapshot: after10, driver: { status: "ok" }, firstTurn: timed });
  assert.equal(firstTurn.schema, "t3cp/extras-first-turn/1");
  assert.equal(firstTurn.ms, 6540);
  assert.equal(firstTurn.started_at, "2026-11-16T01:09:20.000Z");
  assert.equal(firstTurn.ended_at, "2026-11-16T01:09:26.540Z");
  assert.equal(firstTurn.thread_turn_items, 900);
  assert.deepEqual(firstTurn.reasons, {});
});

test("a first turn the runner could not time is null with the runner's reason; no record at all has its own", () => {
  const failed = run({ snapshot: after10, driver: { status: "ok" }, firstTurn: { ...timed, ms: null, run_status: "failed", reasons: { ms: "first_turn_failed" } } }).firstTurn;
  assert.equal(failed.ms, null);
  assert.equal(failed.reasons.ms, "first_turn_failed");
  const missing = run({ snapshot: after10, driver: { status: "ok" } }).firstTurn;
  assert.equal(missing.ms, null);
  assert.equal(missing.reasons.ms, "no_first_turn_record");
});

test("an extras run stopped at its timeout, or never started for want of time: both extras say extra_timeout, never 0", () => {
  const root = mkdtempSync(join(tmpdir(), "t3cp-collect-timeout-"));
  try {
    const result = spawnSync(
      process.execPath,
      [join(here, "extras-collect.mjs"), "--run", join(root, "run"), "--out-dir", root, "--run-exit", "124", "--fixture-id", "large-76", "--timed-out"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const name of ["snapshot", "first_turn"]) {
      const raw = JSON.parse(readFileSync(join(root, `${name}.json`), "utf8"));
      assert.equal(raw.ms, null, name);
      assert.equal(raw.reasons.ms, "extra_timeout", name);
      assert.equal(raw.timed_out, true, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a timed-out extras run keeps what it measured: a first turn timed before the stop stays, the rest says extra_timeout", () => {
  const root = mkdtempSync(join(tmpdir(), "t3cp-collect-partial-"));
  try {
    // The run was stopped before run.ts wrote run.json, after the runner timed the first turn.
    const dir = join(root, "run", "work", "runs", "release", "attempt-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "first-turn.json"), JSON.stringify({ ms: 7719, started_at: "2026-11-16T01:09:30.000Z", ended_at: "2026-11-16T01:09:37.719Z", thread_turn_items: 34 }));
    const result = spawnSync(
      process.execPath,
      [join(here, "extras-collect.mjs"), "--run", join(root, "run"), "--out-dir", root, "--run-exit", "124", "--fixture-id", "large-76", "--timed-out"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const firstTurn = JSON.parse(readFileSync(join(root, "first_turn.json"), "utf8"));
    assert.equal(firstTurn.ms, 7719);
    assert.deepEqual(firstTurn.reasons, {});
    const snapshot = JSON.parse(readFileSync(join(root, "snapshot.json"), "utf8"));
    assert.equal(snapshot.ms, null);
    assert.equal(snapshot.reasons.ms, "extra_timeout");
    assert.equal(snapshot.timed_out, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

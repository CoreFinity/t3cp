// The extras contract on a REAL extras run from a validation VM: driver/driver.json and run.json as harness 2.0.0 wrote
// them, cut to the keys the extras read (no host, address, path, provider text or process id), snapshot-after.json
// and the first-turn.json the runner's extras driver wrote there. extras-collect.mjs makes the raw extras from them and the REAL exporter (tools/t3cp/export.mjs
// --extras) must publish a finite first turn and snapshot. A renamed or missing key on either side fails here
// instead of turning into a silent null on every record.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { fakeSpec } from "../lib/fake-raw.mjs";
import { firstTurnFrom } from "./first-turn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const t3cp = join(here, "..");
const real = join(here, "testdata", "extras-run-2.0.0");
const root = mkdtempSync(join(tmpdir(), "t3cp-extras-contract-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("the recorded run holds only what the extras read: no host, address, path, provider text or process id", () => {
  const files = ["run.json", "driver/driver.json", "snapshot-after.json", "first-turn.json"];
  const allowed = {
    "driver/driver.json": ["schemaVersion", "status", "knobs", "timeline", "windowSeconds", "workload"],
    "run.json": ["schema", "label", "attempt", "valid", "problems", "saturated", "started_at", "window", "sessions_served", "sessions_total", "driver_failure", "server"],
  };
  const strings = (value) =>
    typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  const keys = (value) => (value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)]) : []);
  for (const file of files) {
    const value = JSON.parse(readFileSync(join(real, file), "utf8"));
    if (allowed[file]) assert.deepEqual(Object.keys(value).filter((k) => !allowed[file].includes(k)), [], file);
    for (const k of keys(value)) assert.ok(!/^(host|url|pid|providers|fakeStateDirectories|out|message)$/.test(k), `${file}: key ${k}`);
    for (const v of strings(value)) assert.ok(!/^\/|:\/\/|\bClaude\b/.test(v), `${file}: ${v}`);
  }
});

test("a real 2.0.0 driver.json has what the runner's first-turn timing reads: the warm-up mark and one history session", () => {
  const driver = JSON.parse(readFileSync(join(real, "driver", "driver.json"), "utf8"));
  assert.match(driver.timeline?.warmup ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(driver.workload?.historySessions, 1);
  assert.equal(driver.knobs?.mode, "mixed");
  // The record the extras driver wrote from it: the mark, then the session's first run settling.
  const timed = JSON.parse(readFileSync(join(real, "first-turn.json"), "utf8"));
  assert.equal(timed.started_at, driver.timeline.warmup);
  assert.equal(timed.run_status, "completed");
  assert.ok(Number.isFinite(timed.ms) && timed.ms > 0);
  // And the timing rule gives the same number from the mark and the settled run's time.
  const again = firstTurnFrom({
    initial: new Map([["t", { latestRunId: "old", itemCount: timed.thread_turn_items }]]),
    events: [{ t: Date.parse(timed.ended_at), id: "t", latestRunId: "new", status: "completed" }],
    warmup: driver.timeline.warmup,
  });
  assert.equal(again.ms, timed.ms);
});

test("extras-collect and the real exporter publish a finite first turn and snapshot from a real extras run", () => {
  const rawExtras = join(root, "raw-extras");
  const run = join(rawExtras, "run", "work", "runs", "release", "attempt-1");
  mkdirSync(run, { recursive: true });
  cpSync(real, run, { recursive: true });
  const collected = spawnSync(process.execPath, [join(here, "extras-collect.mjs"), "--run", join(rawExtras, "run"), "--out-dir", rawExtras, "--run-exit", "0", "--fixture-id", "large-76"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(collected.status, 0, collected.stderr);
  const spec = fakeSpec({ record_id: "2026-11-15.linux-x64.nightly", host: { machine: "n2d-standard-16", provisioning: "spot" }, cpu_model: "AMD EPYC 7B13" });
  spec.fixture = { id: "large-76", path: "/t3cp/fixtures/large-76.sqlite", sha256: "3".repeat(64), migration: 76 };
  const specFile = join(root, "spec.json");
  writeFileSync(specFile, JSON.stringify(spec));
  const patterns = join(root, "private.txt");
  writeFileSync(patterns, "a-pattern-no-extras-file-contains-[0-9]{9}\n");
  const out = join(root, "extras-out");
  const exported = spawnSync(process.execPath, [join(t3cp, "export.mjs"), "--extras", rawExtras, "--out", out, "--spec", specFile], {
    env: { ...process.env, T3CP_PRIVATE_PATTERNS: patterns },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(exported.status, 0, exported.stdout + exported.stderr);
  const firstTurn = JSON.parse(readFileSync(join(out, "first_turn.json"), "utf8"));
  const ms = firstTurn.fixture?.metrics?.first_turn_after_start_ms?.values?.[0];
  assert.ok(Number.isFinite(ms) && ms > 0, JSON.stringify(firstTurn.fixture));
  const snapshot = JSON.parse(readFileSync(join(out, "snapshot.json"), "utf8"));
  assert.ok(Number.isFinite(snapshot.fixture?.metrics?.snapshot_full_get_ms?.values?.[0]), JSON.stringify(snapshot.fixture));
});

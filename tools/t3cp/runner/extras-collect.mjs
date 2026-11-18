#!/usr/bin/env node
// t3cp record extras: snapshot.json and first_turn.json from the extras run's run.ts directory (the snapshot GET's
// record and the runner's own first-turn timing, both written by extras-driver.mjs).
// usage: extras-collect.mjs --run <raw-extras/run> --out-dir <raw-extras> --run-exit <code> --fixture-id <id|none>
//                           [--timed-out]: the run was stopped at its timeout, or never started for want of time
// A value that could not be measured is null and its key is in reasons with a code; never 0.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const runRoot = flag("--run");
const outDir = flag("--out-dir");
const fixtureId = flag("--fixture-id") ?? "none";
const runExit = Number(flag("--run-exit") ?? "1");
const timedOut = args.includes("--timed-out");
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** The run.ts run the result counts: the last valid one, else the last one. */
function chosenRun() {
  const dir = join(runRoot, "work", "runs", "release");
  if (!existsSync(dir)) return null;
  let chosen = null;
  for (const name of readdirSync(dir)
    .filter((d) => /^attempt-\d+$/.test(d))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))) {
    const run = readJson(join(dir, name, "run.json"));
    // A run stopped at its timeout may have no run.json yet: what it measured before the stop still counts.
    if (run === null && !timedOut) continue;
    const entry = { dir: join(dir, name), run, valid: run?.valid === true };
    if (entry.valid || chosen === null || !chosen.valid) chosen = entry;
  }
  return chosen;
}

const chosen = chosenRun();
const windowEnd = chosen?.run?.window?.end ?? null;
const snapshot = {
  schema: "t3cp/extras-snapshot/1",
  fixture_id: fixtureId,
  thread_turn_items: null,
  ms: null,
  wire_bytes: null,
  body_bytes: null,
  status: null,
  started_at: null,
  ended_at: null,
  window_end: windowEnd,
  after_window: null,
  reasons: {},
};
// A run stopped at its timeout keeps what it measured; only what it left unmeasured says extra_timeout.
const missing = (reason) => (timedOut ? "extra_timeout" : reason);
if (fixtureId === "none") snapshot.reasons.ms = "no_fixture";
else if (chosen === null) snapshot.reasons.ms = missing(`extras_run_failed_exit_${runExit}`);
else {
  const after = readJson(join(chosen.dir, "snapshot-after.json"));
  if (after === null) snapshot.reasons.ms = missing("no_snapshot_record");
  else {
    for (const key of ["thread_turn_items", "ms", "wire_bytes", "body_bytes", "status", "started_at", "ended_at"]) {
      if (after[key] !== undefined) snapshot[key] = after[key];
    }
    Object.assign(snapshot.reasons, after.reasons ?? {});
    if (snapshot.started_at && windowEnd) snapshot.after_window = Date.parse(snapshot.started_at) >= Date.parse(windowEnd);
    if (snapshot.after_window === false) {
      snapshot.reasons.ms = "overlaps_window";
      snapshot.ms = null;
    } else if (timedOut && windowEnd === null && snapshot.ms !== null) {
      // Without the run's window it cannot be shown to have run after it.
      snapshot.reasons.ms = "extra_timeout";
      snapshot.ms = null;
    }
  }
}
for (const key of ["wire_bytes", "body_bytes"]) if (snapshot.ms === null && snapshot[key] !== null) snapshot[key] = null;
if (timedOut) snapshot.timed_out = true;
writeJsonAtomic(join(outDir, "snapshot.json"), snapshot);

// The first turn is the runner's own timing (extras-driver.mjs, first-turn.mjs), never a driver key.
const firstTurn = { schema: "t3cp/extras-first-turn/1", fixture_id: fixtureId, ms: null, started_at: null, ended_at: null, thread_turn_items: null, reasons: {} };
if (fixtureId === "none") firstTurn.reasons.ms = "no_fixture";
else if (chosen === null) firstTurn.reasons.ms = missing(`extras_run_failed_exit_${runExit}`);
else {
  const timed = readJson(join(chosen.dir, "first-turn.json"));
  if (timed === null) firstTurn.reasons.ms = missing("no_first_turn_record");
  else {
    for (const key of ["started_at", "ended_at", "thread_turn_items"]) if (timed[key] !== undefined) firstTurn[key] = timed[key];
    if (typeof timed.ms === "number" && Number.isFinite(timed.ms) && timed.ms > 0) firstTurn.ms = timed.ms;
    else firstTurn.reasons.ms = timed.reasons?.ms ?? missing("first_turn_not_timed");
  }
}
if (timedOut) firstTurn.timed_out = true;
writeJsonAtomic(join(outDir, "first_turn.json"), firstTurn);
process.stdout.write(`${JSON.stringify({ snapshot: snapshot.ms, first_turn: firstTurn.ms })}\n`);

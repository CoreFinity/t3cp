// The first turn after a cold start, timed by the runner itself: the driver's history session dispatches its first
// turn the moment the driver marks warm-up, and the runner's own shell stream sees that thread's new run settle.
import assert from "node:assert/strict";
import { test } from "node:test";

import { firstTurnFrom } from "./first-turn.mjs";

const at = (s) => Date.parse(`2026-11-16T10:00:${s}Z`);
const warmup = "2026-11-16T10:00:10.000Z";
// The fixture's threads as the stream's starting snapshot had them: latest run ids from the fixture's history.
const initial = new Map([
  ["t-1", { latestRunId: "r-old-1", itemCount: 40 }],
  ["t-2", { latestRunId: "r-old-2", itemCount: 900 }],
]);

test("the first turn runs from the warm-up mark to its new run's settled shell", () => {
  const events = [
    { t: at("09.000"), id: "t-2", latestRunId: "r-old-2", status: "completed" }, // a subscriber's read: no new run
    { t: at("10.400"), id: "t-2", latestRunId: "r-new", status: "running" },
    { t: at("12.000"), id: "t-2", latestRunId: "r-new", status: "running" },
    { t: at("16.540"), id: "t-2", latestRunId: "r-new", status: "completed" },
    { t: at("25.000"), id: "t-2", latestRunId: "r-next", status: "completed" }, // the second turn
  ];
  const r = firstTurnFrom({ initial, events, warmup });
  assert.deepEqual(r.reasons, {});
  assert.equal(r.ms, 6540);
  assert.equal(r.started_at, warmup);
  assert.equal(r.ended_at, "2026-11-16T10:00:16.540Z");
  assert.equal(r.run_status, "completed");
  assert.equal(r.thread_turn_items, 900);
});

test("a run seen only once it has settled still ends the first turn", () => {
  const events = [{ t: at("13.000"), id: "t-1", latestRunId: "r-new", status: "completed" }];
  const r = firstTurnFrom({ initial, events, warmup });
  assert.equal(r.ms, 3000);
  assert.equal(r.thread_turn_items, 40);
});

test("a first turn that did not complete is null with its status; one never settled or never seen too", () => {
  const failed = firstTurnFrom({ initial, events: [{ t: at("14.000"), id: "t-1", latestRunId: "r-new", status: "failed" }], warmup });
  assert.equal(failed.ms, null);
  assert.equal(failed.run_status, "failed");
  assert.equal(failed.reasons.ms, "first_turn_failed");
  const open = firstTurnFrom({ initial, events: [{ t: at("14.000"), id: "t-1", latestRunId: "r-new", status: "running" }], warmup });
  assert.equal(open.ms, null);
  assert.equal(open.reasons.ms, "first_turn_unfinished");
  const none = firstTurnFrom({ initial, events: [{ t: at("14.000"), id: "t-1", latestRunId: "r-old-1", status: "completed" }], warmup });
  assert.equal(none.ms, null);
  assert.equal(none.reasons.ms, "no_first_turn_seen");
});

test("a run that began before the warm-up mark is not the session's first turn", () => {
  const events = [
    { t: at("05.000"), id: "t-1", latestRunId: "r-early", status: "completed" },
    { t: at("11.000"), id: "t-2", latestRunId: "r-new", status: "completed" },
  ];
  const r = firstTurnFrom({ initial, events, warmup });
  assert.equal(r.ms, 1000);
  assert.equal(r.thread_turn_items, 900);
});

test("without the driver's warm-up mark there is nothing to time from", () => {
  const r = firstTurnFrom({ initial, events: [{ t: at("11.000"), id: "t-2", latestRunId: "r-new", status: "completed" }], warmup: null });
  assert.equal(r.ms, null);
  assert.equal(r.reasons.ms, "no_warmup_mark");
});

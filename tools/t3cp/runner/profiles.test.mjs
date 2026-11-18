// The load profiles: per cell, what run.ts and the driver get, from the committed table the spec names.
import assert from "node:assert/strict";
import { test } from "node:test";

import { cellProfile, loadProfiles, metaProfile } from "./profiles.mjs";

const profiles = loadProfiles();
const STD = ["--call-timeout", "300s", "--stall-timeout", "600s", "--max-error-rate", "0.2", "--setup-concurrency", "16"];

test("primary-scaled: subscribers ceil(agents/10), pollers ceil(agents/4), 300 s switches, 0.01 polls/s, 60 s turn gap", () => {
  const expected = { 50: [5, 13], 100: [10, 25], 150: [15, 38], 200: [20, 50], 250: [25, 63] };
  for (const [level, [subscribers, pollers]] of Object.entries(expected)) {
    const p = cellProfile(profiles, "primary-scaled", level, "large-76");
    assert.deepEqual([p.sessions, p.subscribers, p.pollers, p.mode, p.turn_gap], [Number(level), subscribers, pollers, "mixed", "60s"]);
    assert.deepEqual(p.driver_args, ["--mode", "mixed", "--switch-interval", "300s", "--poll-rate", "0.01", "--turn-gap", "60s", ...STD]);
  }
  // The 1-agent cells are the single-session profile in both.
  for (const cell of ["1", "1e"]) {
    const { profile: _a, ...a } = cellProfile(profiles, "primary-scaled", cell, "large-76");
    const { profile: _b, ...b } = cellProfile(profiles, "real3", cell, "large-76");
    assert.deepEqual(a, b);
  }
});

test("on an empty-database record every cell runs fresh", () => {
  const p = cellProfile(profiles, "real3", "50", "none");
  assert.equal(p.fixture, "none");
  assert.equal(p.mode, "fresh");
  assert.equal(p.driver_args[1], "fresh");
});

test("an unknown profile or cell is refused", () => {
  assert.throws(() => cellProfile(profiles, "nope", "50", "large-76"), /unknown profile/);
  assert.throws(() => cellProfile(profiles, "real3", "x", "large-76"), /cell/);
});

test("real3: N agents, 3 watchers switching every 300 s, pollers ceil(N/4) at 0.01 calls/s, 60 s turn gap", () => {
  const expected = { 50: 13, 100: 25, 150: 38, 200: 50, 250: 63 };
  for (const [level, pollers] of Object.entries(expected)) {
    assert.deepEqual(cellProfile(profiles, "real3", level, "large-76"), {
      profile: "real3",
      cell: level,
      fixture: "era",
      sessions: Number(level),
      subscribers: 3,
      pollers,
      mode: "mixed",
      turn_gap: "60s",
      turn_gap_s: 60,
      driver_args: ["--mode", "mixed", "--switch-interval", "300s", "--poll-rate", "0.01", "--turn-gap", "60s", ...STD],
    });
  }
  assert.deepEqual(
    [1, "1e"].map((cell) => {
      const p = cellProfile(profiles, "real3", String(cell), "large-76");
      return [p.fixture, p.sessions, p.subscribers, p.pollers, p.turn_gap, p.mode];
    }),
    [
      ["era", 1, 1, 0, "5s", "mixed"],
      ["none", 1, 1, 0, "5s", "fresh"],
    ],
  );
});

test("real3 is the default profile and its levels are written out as data", () => {
  assert.equal(profiles.default, "real3");
  const levels = profiles.profiles.real3.levels;
  assert.deepEqual(Object.keys(levels), ["50", "100", "150", "200", "250"]);
  assert.deepEqual(levels["250"], { sessions: 250, subscribers: 3, pollers: 63 });
  // A level outside the table follows the same rule.
  assert.deepEqual(
    (({ sessions, subscribers, pollers }) => [sessions, subscribers, pollers])(cellProfile(profiles, "real3", "10", "large-76")),
    [10, 3, 3],
  );
});

test("attempt-meta.json records the counts, the mode and the intervals only", () => {
  assert.deepEqual(metaProfile(cellProfile(profiles, "real3", "250", "large-76")), {
    sessions: 250,
    subscribers: 3,
    pollers: 63,
    mode: "mixed",
    turn_gap_s: 60,
    switch_interval_s: 300,
    poll_interval_s: 100,
  });
  assert.equal(metaProfile(cellProfile(profiles, "real3", "1", "large-76")).poll_interval_s, 1);
});

test("every fixture-backed cell runs mixed, the 1-agent cell too, in every profile; fresh is for the empty cell only", () => {
  for (const id of Object.keys(profiles.profiles)) {
    const p = cellProfile(profiles, id, "1", "large-76");
    assert.equal(p.fixture, "era", id);
    assert.equal(p.mode, "mixed", id);
    assert.equal(cellProfile(profiles, id, "1e", "large-76").mode, "fresh", id);
    for (const level of ["50", "250"]) assert.equal(cellProfile(profiles, id, level, "large-76").mode, "mixed", `${id} ${level}`);
  }
});

test("profiles.json is exactly the chosen tables: real3, the default, and primary-scaled, entry for entry", () => {
  const single = { sessions: 1, subscribers: 1, pollers: 0, mode: "mixed", turn_gap: "5s", switch_interval: "30s", poll_rate: "1" };
  const empty = { ...single, mode: "fresh" };
  const ladder = { sessions: "L", pollers: { ceil_div: 4 }, mode: "mixed", turn_gap: "60s", switch_interval: "300s", poll_rate: "0.01" };
  const tables = (profile) => Object.fromEntries(Object.entries(profile).filter(([key]) => key !== "description"));
  assert.equal(profiles.default, "real3");
  assert.deepEqual(Object.keys(profiles.profiles).sort(), ["primary-scaled", "real3"]);
  assert.deepEqual(profiles.common_driver_args, STD);
  assert.deepEqual(tables(profiles.profiles.real3), {
    single,
    empty,
    ladder: { ...ladder, subscribers: 3 },
    levels: {
      50: { sessions: 50, subscribers: 3, pollers: 13 },
      100: { sessions: 100, subscribers: 3, pollers: 25 },
      150: { sessions: 150, subscribers: 3, pollers: 38 },
      200: { sessions: 200, subscribers: 3, pollers: 50 },
      250: { sessions: 250, subscribers: 3, pollers: 63 },
    },
  });
  assert.deepEqual(tables(profiles.profiles["primary-scaled"]), { single, empty, ladder: { ...ladder, subscribers: { ceil_div: 10 } } });
});

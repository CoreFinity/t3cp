// The synthetic records and raw attempts name the real3 profile; their cells must carry what the runner would record
// for real3 from profiles.json (runner/profiles.mjs resolves it), so dev pages built from them agree with the prose.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cellProfile, loadProfiles, metaProfile } from "../runner/profiles.mjs";
import { WORKLOAD, fakeProfile } from "./fake.mjs";
import { fakeSpec, writeRawAttempt } from "./fake-raw.mjs";

const profiles = loadProfiles();
const CELLS = [...WORKLOAD.levels.map(String), "1e"];
const expected = (cell) => metaProfile(cellProfile(profiles, WORKLOAD.profile, cell, "large-76"));

test("fake records: every cell's load profile is the real3 entry of profiles.json", () => {
  assert.equal(WORKLOAD.profile, "real3");
  for (const cell of CELLS) {
    const want = { ...expected(cell), fixture: cell === "1e" ? "none" : "era" };
    assert.deepEqual(fakeProfile(cell), want, cell);
  }
  // The rule as the methodology states it: 3 watching and ceil(N/4) pollers per level; 1 and 0 at one agent.
  assert.deepEqual([fakeProfile("100").subscribers, fakeProfile("100").pollers, fakeProfile("150").pollers], [3, 25, 38]);
  assert.deepEqual([fakeProfile("1").subscribers, fakeProfile("1").pollers, fakeProfile("1").turn_gap_s], [1, 0, 5]);
});

test("fake raw attempts: attempt-meta.json records the real3 entry of profiles.json for the cell", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-fake-profile-"));
  try {
    for (const cell of CELLS) {
      const dir = writeRawAttempt(root, { cell, spec: fakeSpec() });
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "attempt-meta.json"), "utf8"));
      assert.deepEqual(meta.profile, expected(cell), cell);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fake raw attempts: loop-window.json names the schema the harness's preload writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-fake-loop-"));
  try {
    const dir = writeRawAttempt(root, { cell: "100", spec: fakeSpec() });
    const lw = JSON.parse(fs.readFileSync(path.join(dir, "work", "runs", "release", "attempt-1", "loop-window.json"), "utf8"));
    assert.equal(lw.schema, "t3-server-bench/loop-window/1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

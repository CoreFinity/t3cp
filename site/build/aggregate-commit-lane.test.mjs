// The two ladder additions through the merge and the aggregator: the commit lane's busy share keeps its public reason
// (no_flush_in_window) where no valid attempt measured a flush, and shutdown_killed counts each cell's attempts whose
// stop was forced (null for records that do not say). Inputs are hand-made synthetic records (tools/t3cp/lib/fake.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildOutputs } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { FAKE_PUBLIC_REFS, fakeAttempts, fakeExtras, fakeIdentity } from "../../tools/t3cp/lib/fake.mjs";
import { loadCatalogue } from "../../tools/t3cp/lib/repo.mjs";

const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function nightly(date, edit = () => {}) {
  const identity = fakeIdentity({ date });
  const attempts = fakeAttempts(catalogue, identity, { jitter: 0 });
  for (const a of attempts) edit(a);
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
}
const BANDS = { schema: "t3cp/bands/1", method: "test bands", platforms: { "linux-x64": { measured: { from: "2026-11-01", to: "2026-11-02", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" }, metrics: Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }])) } } };
function build(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-commit-lane-"));
  temps.push(dir);
  for (const r of records) {
    const file = path.join(dir, "records", r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(dir, "bands.json"), JSON.stringify(BANDS));
  return buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS, warn: () => {} });
}
const series = (files, id) => JSON.parse(files.get(`series/linux-x64/${id}.all.json`).toString("utf8"));

test("red first: shutdown_killed counts each cell's attempts whose stop was forced; a record that does not say gives null", () => {
  const dates = [0, 1, 2].map((i) => addDays("2026-11-10", i));
  const records = [
    nightly(dates[0], (a) => (a.attempt.stop_forced = a.cell === "250" && a.n <= 2)),
    nightly(dates[1], (a) => (a.attempt.stop_forced = false)),
    nightly(dates[2], (a) => delete a.attempt.stop_forced),
  ];
  const s = series(build(records), "shutdown_killed");
  assert.deepEqual(s.levels["250"].median, [2, 0, null]);
  assert.deepEqual(s.levels["50"].median, [0, 0, null]);
});

test("the commit lane's busy share keeps no_flush_in_window where no valid attempt measured a flush", () => {
  const dates = [0, 1].map((i) => addDays("2026-11-10", i));
  const idle = (a) => {
    if (a.cell !== "1") return;
    a.metrics.commit_lane_busy_share = null;
    a.attempt.metric_reasons = { ...a.attempt.metric_reasons, commit_lane_busy_share: "no_flush_in_window" };
  };
  const records = [nightly(dates[0], idle), nightly(dates[1])];
  assert.deepEqual(records[0].cells["1"].metrics.commit_lane_busy_share, { median: null, min: null, max: null, n: 0, values: [null, null, null], reason: "no_flush_in_window" });
  const s = series(build(records), "commit_lane_busy_share");
  assert.equal(s.levels["1"].median[0], null);
  assert.equal(s.levels["1"].reason[0], "no_flush_in_window");
  assert.ok(typeof s.levels["1"].median[1] === "number");
});

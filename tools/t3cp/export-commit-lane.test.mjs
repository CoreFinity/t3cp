// The exporter's two ladder additions: the commit lane's busy share (the flush spans' summed duration over the window,
// from the commit batch era on; null with no_flush_in_window when no flush ended in the window) and each attempt's
// forced stop (attempt.stop_forced, which the aggregator counts per cell as shutdown_killed). Synthetic inputs only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { exportAttempt } from "./export.mjs";
import { fakeSpec, writeRawAttempt } from "./lib/fake-raw.mjs";
import { loadSchema } from "./lib/repo.mjs";
import { validate } from "./lib/validate.mjs";

const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const FLUSH = "orchestrationV2.ProviderCommitBatch.flush";

function exported({ totalMs = 150_000, date = "2026-11-15", edit } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-commit-lane-"));
  temps.push(root);
  const tag = `v0.1.10-nightly.${date.replaceAll("-", "")}.4749`;
  const spec = fakeSpec({ record_id: `${date}.linux-x64.nightly`, release: { tag, version: tag.slice(1), date } });
  const dir = writeRawAttempt(root, {
    cell: "100",
    n: 1,
    spec,
    edit: (f) => {
      if (totalMs === null) delete f.result.metrics.spans[FLUSH];
      else f.result.metrics.spans[FLUSH] = { count: 900, errors: 0, total_ms: totalMs, avg_ms: totalMs / 900, p50_ms: 100, p95_ms: 300, max_ms: 900 };
      edit?.(f);
    },
  });
  const a = exportAttempt(dir, spec, { privatePatterns: [] });
  assert.deepEqual(validate(loadSchema("attempt-1.json"), a), []);
  return a;
}

test("red first: the commit lane's busy share is the flush spans' summed duration over the window", () => {
  assert.equal(exported({ totalMs: 150_000 }).metrics.commit_lane_busy_share, 0.5);
  // Spans that end in the window count whole: a share can slightly exceed 1, and is published as measured.
  assert.equal(exported({ totalMs: 303_000 }).metrics.commit_lane_busy_share, 1.01);
});

test("no flush in the window, in the commit batch era: null with no_flush_in_window; before the era: null, no reason", () => {
  let a = exported({ totalMs: null });
  assert.equal(a.metrics.commit_lane_busy_share, null);
  assert.equal(a.attempt.metric_reasons.commit_lane_busy_share, "no_flush_in_window");
  a = exported({ totalMs: null, date: "2026-11-05" });
  assert.equal(a.metrics.commit_lane_busy_share, null);
  assert.equal(a.attempt.metric_reasons.commit_lane_busy_share, undefined);
  // As for every ladder metric with an era, the aggregator, not the exporter, leaves pre-era values out of the series.
});

test("each attempt says whether its server's stop was forced (the harness killed it after the grace)", () => {
  assert.equal(exported().attempt.stop_forced, false);
  assert.equal(exported({ edit: (f) => (f.run.server.stop.forced = true) }).attempt.stop_forced, true);
  assert.equal(exported({ edit: (f) => delete f.run.server.stop }).attempt.stop_forced, null);
});

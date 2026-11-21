// The ladder golden: today's suite, row 1 of scenarios.json (ladder@1, published as ladder-1), on the synthetic
// development data. A change may add metrics, but every series shard, compare row and record segment of the metrics the
// golden names (site/build/testdata/ladder-1-golden.json, from tools/t3cp/dev/golden.mjs) stays byte-identical, and
// anything new belongs to a metric the golden does not name.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { GOLDEN_FILE, GOLDEN_SCHEMA, goldenOutputs, goldenParts, seriesMetric } from "../../tools/t3cp/dev/golden.mjs";
import { WORKLOAD } from "../../tools/t3cp/lib/fake.mjs";
import { ladderWorkload, loadRepo } from "../../tools/t3cp/scenarios-check.mjs";

test("golden: row 1 of scenarios.json keeps every series shard, compare row and segment of the golden's metrics", () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8"));
  assert.equal(golden.schema, GOLDEN_SCHEMA);
  // The synthetic data runs row 1.
  const row = loadRepo().scenarios.rows.find((r) => r.id === "ladder" && r.version === 1);
  assert.ok(row, "scenarios.json has row ladder@1");
  const { cells, ...suite } = ladderWorkload(row);
  const { profile, seed, now, ...synthetic } = WORKLOAD;
  assert.deepEqual(synthetic, suite);

  const known = new Set(golden.metrics);
  const parts = goldenParts(goldenOutputs());
  for (const [rel, digest] of Object.entries(golden.series)) assert.equal(parts.series[rel], digest, rel);
  for (const rel of Object.keys(parts.series)) {
    if (golden.series[rel] === undefined) assert.ok(!known.has(seriesMetric(rel)), `${rel}: a new shard of a golden metric`);
  }
  assert.deepEqual(Object.keys(parts.compare).sort(), Object.keys(golden.compare).sort(), "the same compare files");
  for (const [rel, want] of Object.entries(golden.compare)) {
    const have = parts.compare[rel];
    assert.equal(have.head, want.head, `${rel}: head`);
    for (const [metric, digest] of Object.entries(want.rows)) assert.equal(have.rows[metric], digest, `${rel}: ${metric} rows`);
    for (const metric of Object.keys(have.rows)) {
      if (want.rows[metric] === undefined) assert.ok(!known.has(metric), `${rel}: new rows of the golden metric ${metric}`);
    }
  }
  assert.deepEqual(parts.segments, golden.segments, "every record's segment ids");
  assert.ok(Object.keys(golden.series).length > 100 && Object.keys(golden.compare).length > 10 && Object.keys(golden.segments).length > 10);
});

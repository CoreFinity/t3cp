// The ladder golden: today's suite, row 1 of scenarios.json (ladder@1, published as ladder-1), gives byte-identical
// aggregator output on the synthetic development data to main before the scenario catalogue existed. The golden
// (site/build/testdata/ladder-1-golden.json) holds one sha256 per output file, from tools/t3cp/dev/golden.mjs; a change
// that moves any published ladder file, a series shard, a compare file or a segment, fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { GOLDEN_FILE, GOLDEN_SCHEMA, goldenFiles } from "../../tools/t3cp/dev/golden.mjs";
import { WORKLOAD } from "../../tools/t3cp/lib/fake.mjs";
import { ladderWorkload, loadRepo } from "../../tools/t3cp/scenarios-check.mjs";

test("golden: row 1 of scenarios.json gives byte-identical aggregator output to main on the synthetic data", () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8"));
  assert.equal(golden.schema, GOLDEN_SCHEMA);
  // The synthetic data runs row 1.
  const row = loadRepo().scenarios.rows.find((r) => r.id === "ladder" && r.version === 1);
  assert.ok(row, "scenarios.json has row ladder@1");
  const { cells, ...suite } = ladderWorkload(row);
  const { profile, seed, now, ...synthetic } = WORKLOAD;
  assert.deepEqual(synthetic, suite);
  const files = goldenFiles();
  assert.deepEqual(Object.keys(files), Object.keys(golden.files), "the same output files");
  for (const [rel, sha] of Object.entries(golden.files)) assert.equal(files[rel], sha, rel);
  assert.ok(Object.keys(files).some((rel) => rel.startsWith("series/")) && Object.keys(files).some((rel) => rel.startsWith("compare/")));
});

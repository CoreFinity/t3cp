// Scenario metrics (catalogue lane "scenario") belong to the scenario rows' own outputs: the ladder's index, series and
// compare files never list them or the feature eras only they use, so adding them moves no ladder output (the
// ladder-1 golden holds the rest byte-identical).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildOutputs } from "./aggregate.mjs";
import { synthInputs } from "../../tools/t3cp/dev/synth-data.mjs";
import { loadCatalogue } from "../../tools/t3cp/lib/repo.mjs";

const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test("the ladder's outputs list no scenario-lane metric and no feature era only scenario metrics use", () => {
  const catalogue = loadCatalogue();
  const scenario = catalogue.metrics.filter((m) => m.lane === "scenario");
  assert.ok(scenario.length > 0, "the catalogue has scenario metrics");
  const ladderEras = new Set(catalogue.metrics.filter((m) => m.lane !== "scenario").map((m) => m.era).filter(Boolean));
  const scenarioOnly = [...new Set(scenario.map((m) => m.era))].filter((e) => !ladderEras.has(e));
  assert.ok(scenarioOnly.length > 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-scenario-lane-"));
  temps.push(dir);
  synthInputs(dir);
  const files = buildOutputs(dir, { dev: true, warn: () => {} });
  const index = JSON.parse(files.get("index.json").toString("utf8"));
  const ids = new Set(scenario.map((m) => m.id));
  assert.deepEqual(index.catalogue.filter((m) => ids.has(m.id)), []);
  assert.deepEqual(index.eras.feature.filter((e) => scenarioOnly.includes(e.id)), []);
  for (const rel of files.keys()) {
    if (rel.startsWith("series/") || rel.startsWith("compare/")) {
      for (const id of ids) assert.ok(!rel.includes(id), `${rel} names ${id}`);
    }
  }
  for (const [rel, bytes] of files) {
    if (rel.startsWith("compare/")) {
      const rows = JSON.parse(bytes.toString("utf8")).rows ?? [];
      assert.ok(!rows.some((r) => ids.has(r.metric ?? r.id)), `${rel} has a scenario metric row`);
    }
  }
});

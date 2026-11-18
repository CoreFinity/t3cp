// The synthetic development tree: complete, marked synthetic everywhere, and refused outside --dev builds.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { synthInputs, FORKS } from "./synth-data.mjs";
import { buildOutputs, overviewPayload } from "../../../site/build/aggregate.mjs";

/** Temporary directories this file made; removed when the file's tests end. */
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test("synth-data: 30 nightlies, 8 fork releases, both fixture eras, planted changes, every file synthetic", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-synth-"));
  temps.push(dir);
  synthInputs(dir);
  assert.throws(() => buildOutputs(dir), /synthetic/);
  const files = buildOutputs(dir, { dev: true });
  for (const [rel, bytes] of files) {
    if (!rel.endsWith(".json")) continue;
    assert.equal(JSON.parse(bytes.toString("utf8")).synthetic, true, rel);
  }
  for (const line of zlib.gunzipSync(files.get("downloads/records.ndjson.gz")).toString("utf8").trim().split("\n")) {
    assert.equal(JSON.parse(line).synthetic, true);
  }
  const index = JSON.parse(files.get("index.json").toString("utf8"));
  const recordsIndex = JSON.parse(files.get("records-index.json").toString("utf8"));
  assert.equal(recordsIndex.synthetic, true);
  assert.equal(recordsIndex.records.length, 30);
  assert.equal(recordsIndex.records[0].date, "2026-10-17");
  assert.equal(recordsIndex.records.at(-1).date, "2026-11-15");
  assert.equal(index.records_index, "records-index.json");
  assert.deepEqual(index.fork.map((f) => f.tag), FORKS.map((f) => `v${f.version}-perf.${f.perf}`));
  assert.deepEqual(index.fixtures.map((f) => f.id), ["large-63", "large-76"]);
  assert.equal(index.bases.length, 6);
  const p95 = JSON.parse(files.get("series/linux-x64/turn_p95_ms.latest.json").toString("utf8"));
  const sat = p95.dates.indexOf("2026-11-10");
  assert.equal(p95.levels["250"].saturated[sat], true);
  assert.equal(p95.levels["250"].note[sat], "saturated");
  assert.ok(p95.eras.some((e) => e.kind === "compaction" && e.date === "2026-10-20"));
  const served = JSON.parse(files.get("series/linux-x64/agents_served.latest.json").toString("utf8"));
  assert.equal(served.levels["250"].median[sat], 210);
  for (const f of index.fork) assert.ok(f.base_record?.startsWith("base/"), `${f.tag} has its base record`);
  const changes = JSON.parse(files.get("changes.json").toString("utf8"));
  const seen = new Set(changes.items.map((c) => `${c.date} ${c.metric} ${c.verdict}`));
  assert.ok(seen.has("2026-11-08 turns_completed regressed"));
  assert.ok(seen.has("2026-11-12 turn_p50_ms improved"));
  const elu = JSON.parse(files.get("series/linux-x64/elu.latest.json").toString("utf8"));
  assert.equal(elu.levels["100"].median[elu.dates.indexOf("2026-10-19")], null);
  assert.ok(elu.levels["100"].median[elu.dates.indexOf("2026-10-20")] > 0);
  const payload = overviewPayload(files, "linux-x64");
  assert.ok(payload.total < 100 * 1024, `overview payload ${payload.total}`);
});

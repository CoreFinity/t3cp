// The verdict threshold is the cell's own band (design §4): bands.json's per-level band overrides the metric's, so a
// change inside the 250-agent cell's band but outside the 100-agent cell's is flagged only at 100. The metric's
// published band is bands.json's metric band, which bands.mjs makes the widest cell band. Written after the rule
// (the per-level override is in the aggregator's first version); a mutation that ignores levels fails it.
// Inputs are hand-made synthetic records.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildOutputs } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from "../../tools/t3cp/lib/fake.mjs";
import { loadCatalogue } from "../../tools/t3cp/lib/repo.mjs";

const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

test("the threshold is the cell's own band: a -12 % turns change is regressed at 100 (band 4.6 %) and within noise at 250 (band 10 %)", () => {
  const days = Array.from({ length: 9 }, (_, i) => addDays("2026-11-01", i));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-cell-band-"));
  temps.push(dir);
  days.forEach((date, i) => {
    const identity = fakeIdentity({ date });
    const value = (id, cell) => (id === "turns_completed" && (cell === "100" || cell === "250") ? (i === days.length - 1 ? 264 : 300) : undefined);
    const r = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0, value }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
    r.compaction_schedule = "scheduled";
    const file = path.join(dir, "records", r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  });
  const headline = Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }]));
  const measured = { from: "2026-11-01", to: "2026-11-02", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" };
  const turns = { band: 10, n: 6, levels: { 100: { band: 4.6, n: 6 }, 250: { band: 10, n: 6 } } };
  fs.writeFileSync(path.join(dir, "bands.json"), JSON.stringify({ schema: "t3cp/bands/1", method: "test bands", platforms: { "linux-x64": { measured, metrics: { ...headline, turns_completed: turns } } } }));
  const files = buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS });
  const s = JSON.parse(files.get("series/linux-x64/turns_completed.latest.json").toString("utf8"));
  const last = s.dates.length - 1;
  assert.equal(s.levels["100"].delta[last], -12);
  assert.equal(s.levels["100"].threshold, 9.6, "100: its own band 4.6 % plus 5 points");
  assert.equal(s.levels["100"].verdict[last], "regressed");
  assert.equal(s.levels["250"].threshold, 15, "250: its own band 10 % plus 5 points");
  assert.equal(s.levels["250"].verdict[last], "within");
  const index = JSON.parse(files.get("index.json").toString("utf8"));
  assert.equal(index.catalogue.find((m) => m.id === "turns_completed").bands["linux-x64"].band, 10, "the published metric band is bands.json's, the widest cell band");
});

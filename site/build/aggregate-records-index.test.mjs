// The records list lives in its own file, records-index.json (fetched by the compare page, read by the site build), so
// the overview payload (index.json, changes.json and the eight headline latest shards) no longer grows with every
// record. index.json names the file and publishes the measured overview payload and its limit; the build warns at 80 %
// of the limit and fails over it. Inputs are hand-made synthetic records.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildOutputs, overviewPayload, BuildError, BUDGETS, OVERVIEW_LIMIT } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from "../../tools/t3cp/lib/fake.mjs";
import { loadCatalogue, loadSchema } from "../../tools/t3cp/lib/repo.mjs";
import { validate } from "../../tools/t3cp/lib/validate.mjs";

const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function nightly(date) {
  const identity = fakeIdentity({ date });
  const attempts = fakeAttempts(catalogue, identity, { jitter: 0 });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
}
const HEADLINE_BANDS = Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }]));
const BANDS = {
  schema: "t3cp/bands/1",
  method: "test bands",
  platforms: { "linux-x64": { measured: { from: "2026-11-01", to: "2026-11-02", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" }, metrics: { ...HEADLINE_BANDS, turns_completed: { band: 4.6, n: 6 } } } },
};
function writeTree(records, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-ri-"));
  temps.push(dir);
  for (const r of records) {
    const file = path.join(dir, "records", r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(dir, "bands.json"), `${JSON.stringify(BANDS, null, 2)}\n`);
  for (const [rel, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, rel), text);
  return dir;
}
const records = Array.from({ length: 5 }, (_, i) => nightly(addDays("2026-11-01", i)));
const read = (files, rel) => JSON.parse(files.get(rel).toString("utf8"));

test("records-index.json holds every nightly's entry, sorted; index.json names it and carries no records list", () => {
  const files = buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS });
  const ri = read(files, "records-index.json");
  assert.equal(ri.schema, "t3cp/records-index/1");
  assert.deepEqual(validate(loadSchema("records-index-1.json"), ri), []);
  assert.deepEqual(ri.records.map((r) => r.date), records.map((r) => r.release.date));
  assert.deepEqual(Object.keys(ri.records[0]), ["date", "tag", "sha", "platforms"]);
  const { segment, banded, gates, ...entry } = ri.records[0].platforms["linux-x64"];
  assert.deepEqual(entry, { record_id: records[0].record_id, status: records[0].status, path: `records/linux-x64/${records[0].release.date}.${records[0].release.tag}.json` });
  assert.ok(segment && typeof banded === "boolean" && gates, "and the aggregator's comparability and gates");
  const index = read(files, "index.json");
  assert.equal(index.records, undefined, "no records list in the overview's manifest");
  assert.equal(index.records_index, "records-index.json");
  assert.equal(index.platforms.find((p) => p.id === "linux-x64").records, 5, "the count stays");
  assert.deepEqual(validate(loadSchema("index-1.json"), index), []);
  assert.ok(BUDGETS.some((b) => b.prefix === "records-index.json"), "its own size budget");
  assert.ok(!overviewPayload(files, "linux-x64").parts["records-index.json"], "never part of the overview payload");
});

test("index.json publishes the overview payload it is part of, measured, and the limit", () => {
  const files = buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS });
  const index = read(files, "index.json");
  assert.equal(index.budgets.overview_limit_gz_bytes, OVERVIEW_LIMIT);
  const measured = overviewPayload(files, "linux-x64").total;
  assert.ok(index.budgets.overview_gz_bytes["linux-x64"] >= measured, "never below the payload as built");
  assert.ok(index.budgets.overview_gz_bytes["linux-x64"] - measured <= 16, "and at most a few bytes above it");
  assert.deepEqual(Object.keys(index.budgets.overview_gz_bytes), ["linux-x64"], "only platforms with records");
});

test("the overview guard: a WARN past 80 % of the limit, a build error past the limit, silence below", () => {
  const dir = writeTree(records);
  const measured = overviewPayload(buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS }), "linux-x64").total;
  const warned = [];
  buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS, overviewLimit: Math.ceil(measured / 0.9), warn: (line) => warned.push(line) });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /^overview payload on linux-x64: \d+ bytes gzipped, \d+ % of the \d+-byte limit$/);
  const quiet = [];
  buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS, overviewLimit: Math.ceil(measured / 0.5), warn: (line) => quiet.push(line) });
  assert.deepEqual(quiet, []);
  assert.throws(() => buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS, overviewLimit: Math.floor(measured * 0.9), warn: () => {} }), (e) => e instanceof BuildError && /over budget/.test(e.message));
});

test("records-index.json is derived: an input tree that carries one is refused", () => {
  assert.throws(() => buildOutputs(writeTree(records, { "records-index.json": "{}\n" }), { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError);
});

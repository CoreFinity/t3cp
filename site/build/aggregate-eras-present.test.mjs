// index.json's fixture and feature eras describe the published nightlies, never the catalogue's plan: an era starts at
// its first published nightly (a closed fixture era ends at its last), and an era with no published nightly is left
// out, so no page names nightlies that are not published. They grow back as the records land. Inputs are hand-made
// synthetic records built by tools/t3cp/lib/fake.mjs (large-63 to 2026-10-30, large-76 from 10-31).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildOutputs, ladderFeatureEras } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from "../../tools/t3cp/lib/fake.mjs";
import { loadCatalogue, loadSchema } from "../../tools/t3cp/lib/repo.mjs";
import { validate } from "../../tools/t3cp/lib/validate.mjs";

const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const days = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));

function nightly(date) {
  const identity = fakeIdentity({ date });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0 }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
}
const BANDS = {
  schema: "t3cp/bands/1",
  method: "test bands",
  platforms: {
    "linux-x64": {
      measured: { from: "2026-10-17", to: "2026-10-17", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" },
      metrics: Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }])),
    },
  },
};
function indexOf(dates) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-eras-"));
  temps.push(dir);
  const put = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
  };
  for (const r of dates.map(nightly)) put(`records/${r.platform.id}/${r.release.date}.${r.release.tag}.json`, r);
  put("bands.json", BANDS);
  const ix = JSON.parse(buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS }).get("index.json").toString("utf8"));
  assert.deepEqual(validate(loadSchema("index-1.json"), ix), []);
  return ix;
}
const catalogueEra = (id) => catalogue.fixture_eras.find((e) => e.id === id);
const featureFrom = (ix) => Object.fromEntries(ix.eras.feature.map((e) => [e.id, e.from]));

test("the catalogue plans eras before the launch window (the premise of these tests)", () => {
  assert.equal(catalogueEra("large-63").from, "2026-10-17");
  assert.equal(catalogueEra("large-76").to, null);
  // Every ladder era starts before the launch window, but the commit lane's (commit_batch, 11-06), inside it.
  assert.ok(ladderFeatureEras(catalogue).filter((e) => e.id !== "commit_batch").every((e) => e.from <= "2026-10-21"));
  assert.equal(ladderFeatureEras(catalogue).find((e) => e.id === "commit_batch").from, "2026-11-06");
});

test("launch shape (nightlies from 11-02 only): one fixture era, from the first record, open; every feature era starts there", () => {
  const ix = indexOf(days("2026-11-02", 3));
  assert.deepEqual(ix.eras.fixture, [{ ...catalogueEra("large-76"), from: "2026-11-02", to: null }]);
  // An era that starts after the last record (commit_batch, 11-06) is left out.
  assert.deepEqual(
    ix.eras.feature,
    ladderFeatureEras(catalogue).filter((e) => e.from <= "2026-11-04").map((e) => ({ ...e, from: "2026-11-02" })),
  );
});

test("records across the fixture change: a closed era ends at its last record, the open one starts at its first", () => {
  const ix = indexOf(days("2026-10-28", 6)); // 10-28..10-30 large-63, 10-31..11-02 large-76
  assert.deepEqual(ix.eras.fixture, [
    { ...catalogueEra("large-63"), from: "2026-10-28", to: "2026-10-30" },
    { ...catalogueEra("large-76"), from: "2026-10-31", to: null },
  ]);
});

test("a closed era with records only in part of it names those records' dates", () => {
  const ix = indexOf(days("2026-10-20", 3)); // 10-20..10-22, inside large-63 (to 10-30)
  assert.deepEqual(ix.eras.fixture, [{ ...catalogueEra("large-63"), from: "2026-10-20", to: "2026-10-22" }]);
});

test("feature eras: one that starts after the last record is left out; the others start at their first record on or after the planned date", () => {
  const ix = indexOf(days("2026-10-17", 4)); // 10-17..10-20
  const from = featureFrom(ix);
  for (const e of ladderFeatureEras(catalogue)) {
    if (e.from > "2026-10-20") assert.equal(from[e.id], undefined, `${e.id} starts ${e.from}, after the last record`);
    else assert.equal(from[e.id], e.from < "2026-10-17" ? "2026-10-17" : e.from, e.id);
  }
  assert.ok(ladderFeatureEras(catalogue).some((e) => e.from > "2026-10-20"), "the catalogue has an era after 10-20 (run_metrics, 10-21)");
  // The order is the catalogue's.
  assert.deepEqual(ix.eras.feature.map((e) => e.id), ladderFeatureEras(catalogue).filter((e) => from[e.id] !== undefined).map((e) => e.id));
});

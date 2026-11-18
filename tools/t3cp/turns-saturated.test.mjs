// Turns completed is counted by start time: a turn counts when it starts in the window and ends by its close. At
// saturation turns run longer than the window, so the count is biased to near zero and would read as "no work done".
// A saturated attempt therefore publishes turns_completed null with the reason not_measured_saturated (agents served
// is the measure there); an unsaturated measured window with no turn row stays 0. Inputs are hand-made synthetic.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeSpec, harnessRun, writeRawAttempt } from "./lib/fake-raw.mjs";
import { FAKE_PUBLIC_REFS, fakeAttempts, fakeIdentity } from "./lib/fake.mjs";
import { MergeError, mergeRecord } from "./merge.mjs";
import { loadCatalogue, loadSchema } from "./lib/repo.mjs";
import { validate } from "./lib/validate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function exportOne(cell, edit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-turns-sat-"));
  temps.push(root);
  const spec = structuredClone(fakeSpec());
  spec.fixture.path = path.join(root, "fixture.sqlite");
  spec.release.archive_path = path.join(root, "archive.tar.gz");
  fs.writeFileSync(spec.fixture.path, Buffer.alloc(4096));
  fs.writeFileSync(spec.release.archive_path, Buffer.alloc(2048));
  const raw = writeRawAttempt(path.join(root, "raw"), { cell, n: 1, edit, spec });
  const specFile = path.join(root, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const out = path.join(root, "out");
  const r = spawnSync(process.execPath, [path.join(here, "export.mjs"), raw, "--out", out, "--spec", specFile, "--no-private-patterns"], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(fs.readFileSync(path.join(out, "attempt.json"), "utf8"));
}

test("export: a saturated attempt's turns_completed is null with not_measured_saturated; agents served stays", () => {
  // The v13 smoke's 250-1 shape: 147 of 250 served, sessions_starved at an ELU of 0.95 or more, no turn row.
  const a = exportOne("250", (f) => {
    harnessRun({ codes: ["sessions_starved"], elu: 0.99, served: 147, total: 250 })(f);
    delete f.result.metrics.driver.calls["session.turn"];
    delete f.run.metrics.driver.calls["session.turn"];
  });
  assert.equal(a.attempt.saturated, true);
  assert.equal(a.metrics.turns_completed, null);
  assert.deepEqual(a.attempt.metric_reasons, { turns_completed: "not_measured_saturated" });
  assert.equal(a.metrics.agents_served, 147);
  // A saturated window that does have a turn row is still not measured.
  const withRow = exportOne("250", (f) => harnessRun({ codes: ["sessions_starved"], elu: 0.99, served: 147, total: 250 })(f));
  assert.equal(withRow.metrics.turns_completed, null);
  assert.deepEqual(validate(loadSchema("attempt-1.json"), a), []);
});

test("export: the 1-1 shape keeps its count; an unsaturated measured window with no turn row is 0", () => {
  const one = exportOne("1", () => {});
  assert.equal(one.metrics.turns_completed, 318, "the fake's session.turn count");
  assert.deepEqual(one.attempt.metric_reasons, {});
  const none = exportOne("100", (f) => {
    delete f.result.metrics.driver.calls["session.turn"];
    delete f.run.metrics.driver.calls["session.turn"];
  });
  assert.equal(none.attempt.saturated, false);
  assert.equal(none.metrics.turns_completed, 0);
});

const identity = fakeIdentity({ date: "2026-11-10" });
const merge = (attempts) => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: "2026-11-10T18:00:00Z" });
const saturate = (a) => {
  a.attempt.saturated = true;
  a.attempt.saturated_by = ["sessions_starved"];
  a.attempt.problems = ["sessions_starved"];
  a.attempt.metric_reasons = { turns_completed: "not_measured_saturated" };
  a.metrics.turns_completed = null;
};

test("merge: a cell with any saturated attempt has a null turns stat with the reason; the record validates", () => {
  const attempts = fakeAttempts(catalogue, identity);
  saturate(attempts.find((a) => a.cell === "250" && a.n === 2)); // a mixed cell
  for (const a of attempts.filter((x) => x.cell === "200")) saturate(a); // a saturated cell
  const record = merge(attempts);
  for (const L of ["200", "250"]) {
    assert.deepEqual(record.cells[L].metrics.turns_completed, { median: null, min: null, max: null, n: 0, values: [], reason: "not_measured_saturated" }, L);
  }
  assert.equal(typeof record.cells["150"].metrics.turns_completed.median, "number", "an unsaturated cell keeps its count");
  assert.deepEqual(validate(loadSchema("record-1.json"), record), []);
});

test("merge guard: a valid null turns count is allowed only with not_measured_saturated on a saturated attempt", () => {
  const plainNull = fakeAttempts(catalogue, identity);
  plainNull.find((a) => a.cell === "100" && a.n === 1).metrics.turns_completed = null;
  assert.throws(() => merge(plainNull), (e) => e instanceof MergeError && /turns_completed/.test(e.message), "unsaturated valid null");
  const reasonNotSaturated = fakeAttempts(catalogue, identity);
  const r = reasonNotSaturated.find((a) => a.cell === "100" && a.n === 1);
  r.metrics.turns_completed = null;
  r.attempt.metric_reasons = { turns_completed: "not_measured_saturated" };
  assert.throws(() => merge(reasonNotSaturated), (e) => e instanceof MergeError && /turns_completed/.test(e.message), "the reason on an unsaturated attempt");
  const countWhileSaturated = fakeAttempts(catalogue, identity);
  const c = countWhileSaturated.find((a) => a.cell === "250" && a.n === 1);
  saturate(c);
  c.metrics.turns_completed = 12;
  assert.throws(() => merge(countWhileSaturated), (e) => e instanceof MergeError && /turns_completed/.test(e.message), "a count on a saturated attempt");
  const ok = fakeAttempts(catalogue, identity);
  saturate(ok.find((a) => a.cell === "250" && a.n === 1));
  assert.ok(merge(ok));
});

test("aggregate: a saturated level's turns read 'saturated', not 'no data'; agents served keeps its verdict", async () => {
  const { buildOutputs } = await import("../../site/build/aggregate.mjs");
  const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const records = Array.from({ length: 4 }, (_, i) => {
    const id = fakeIdentity({ date: addDays("2026-11-01", i) });
    const attempts = fakeAttempts(catalogue, id, { jitter: 0 });
    if (i === 3) {
      for (const a of attempts.filter((x) => x.cell === "250")) {
        saturate(a);
        a.metrics.agents_served = 147;
      }
    }
    return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: `${id.release.date}T18:00:00Z` });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-turns-agg-"));
  temps.push(dir);
  for (const r of records) {
    const file = path.join(dir, "records", r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(r));
  }
  fs.writeFileSync(path.join(dir, "bands.json"), JSON.stringify({ schema: "t3cp/bands/1", method: "t", platforms: { "linux-x64": { measured: { from: "2026-11-01", to: "2026-11-02", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" }, metrics: Object.fromEntries([...catalogue.headlines["linux-x64"], "agents_served"].map((id) => [id, { band: 2, n: 6 }])) } } }));
  const files = buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS });
  const s = JSON.parse(files.get("series/linux-x64/turns_completed.latest.json").toString("utf8"));
  assert.equal(s.levels["250"].median[3], null);
  assert.equal(s.levels["250"].note[3], "saturated");
  const served = JSON.parse(files.get("series/linux-x64/agents_served.latest.json").toString("utf8"));
  assert.equal(served.levels["250"].verdict[3], "regressed");
});

// bands.mjs: noise bands from the noise-band run's merged records (repeated identical attempts per cell).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeBands } from "./bands.mjs";
import { mergeRecord } from "./merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from "./lib/fake.mjs";
import { loadCatalogue, loadSchema } from "./lib/repo.mjs";
import { validate } from "./lib/validate.mjs";

/** Temporary directories this file made; removed when the file's tests end. */
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogue = loadCatalogue();

/** One noise-band VM: six identical attempts per cell, with planted turns_completed values at 100 agents. */
function vmRecord(turns, platform) {
  const identity = fakeIdentity({ date: "2026-11-15", ...(platform ? { platform } : {}) });
  identity.workload.attempts_per_level = turns.length;
  const attempts = fakeAttempts(catalogue, identity, { jitter: 0, value: (id, cell) => (id === "turns_completed" && cell === "100" ? undefined : undefined) });
  for (const a of attempts) if (a.cell === "100") a.metrics.turns_completed = turns[a.n - 1];
  for (const a of attempts) if (a.cell === "50") a.metrics.client_errors = 0;
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: "2026-11-15T20:00:00Z" });
}

test("bands: (max - min) / median in percent, pooled over the machines, per cell; the metric's band is its largest level band", () => {
  const a = vmRecord([300, 310, 305]);
  const b = vmRecord([295, 302, 308]);
  const bands = computeBands([a, b], { method: "test" });
  assert.deepEqual(validate(loadSchema("bands-1.json"), bands), []);
  const turns = bands.platforms["linux-x64"].metrics.turns_completed;
  // pooled 295..310, median 303.5: 15 / 303.5 = 4.94 %
  assert.equal(turns.levels["100"].band, 4.9);
  assert.equal(turns.levels["100"].n, 6);
  assert.equal(turns.band, Math.max(...Object.values(turns.levels).map((l) => l.band)));
  assert.equal(bands.platforms["linux-x64"].measured.machines, 2);
  assert.equal(bands.platforms["linux-x64"].measured.attempts, 42);
  assert.ok(bands.platforms["linux-x64"].metrics.db_ready_warm_ms.levels.once.band >= 0, "record-scope extras get a band at once");
  assert.equal(bands.platforms["linux-x64"].metrics.client_errors, undefined, "a metric whose median is 0 has no band");
});

test("bands: records of different releases, kinds or profiles are refused", () => {
  const a = vmRecord([300, 310, 305]);
  const other = structuredClone(a);
  other.release.tag = "v0.1.10-nightly.20261114.4700";
  assert.throws(() => computeBands([a, other], { method: "test" }), /same release/);
  const profile = structuredClone(a);
  profile.workload.profile = "other";
  assert.throws(() => computeBands([a, profile], { method: "test" }), /same release/);
});

test("bands CLI: writes bands.json from record files; refuses an unreadable record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-bands-"));
  temps.push(dir);
  const files = [vmRecord([300, 310, 305]), vmRecord([295, 302, 308])].map((r, i) => {
    const f = path.join(dir, `r${i}.json`);
    fs.writeFileSync(f, JSON.stringify(r));
    return f;
  });
  const out = path.join(dir, "bands.json");
  const ok = spawnSync(process.execPath, [path.join(here, "bands.mjs"), ...files, "--out", out, "--method", "noise-band run, 3 attempts per cell"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(validate(loadSchema("bands-1.json"), JSON.parse(fs.readFileSync(out, "utf8"))), []);
  fs.writeFileSync(files[1], "{");
  fs.rmSync(out);
  const bad = spawnSync(process.execPath, [path.join(here, "bands.mjs"), ...files, "--out", out, "--method", "x"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.ok(!fs.existsSync(out));
});

// merge.mjs folds the attempts of one record (18 ladder + 3 empty-database) and its extras into t3cp/record/1.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MergeError, mergeRecord } from "./merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from "./lib/fake.mjs";
import { validate } from "./lib/validate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogue = JSON.parse(fs.readFileSync(path.join(here, "../../catalogue/catalogue.json"), "utf8"));
const recordSchema = JSON.parse(fs.readFileSync(path.join(here, "../../schema/record-1.json"), "utf8"));
const identity = fakeIdentity({ date: "2026-11-10" });
const GEN = "2026-11-10T18:00:00Z";
/** Marks an attempt saturated as the exporter writes one: turns completed not measured, with the reason. */
const markSaturated = (a, on = true) => {
  a.attempt.saturated = on;
  if (on) {
    a.metrics.turns_completed = null;
    a.attempt.metric_reasons = { turns_completed: "not_measured_saturated" };
  }
};
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test("merge: 21 valid attempts give complete cells with median, min, max, n and values per metric", () => {
  const attempts = fakeAttempts(catalogue, identity, { value: (id, cell) => (id === "turns_completed" && cell === "100" ? undefined : undefined) });
  // Plant known values for one metric at one level: 312, 324, 318 (attempt order 1, 2, 3).
  for (const a of attempts) if (a.cell === "100") a.metrics.turns_completed = { 1: 312, 2: 324, 3: 318 }[a.n];
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: GEN });
  assert.deepEqual(validate(recordSchema, record), []);
  assert.equal(record.status, "complete");
  assert.deepEqual(Object.keys(record.cells), ["1", "50", "100", "150", "200", "250", "1e"]);
  assert.deepEqual(record.cells["100"].metrics.turns_completed, { median: 318, min: 312, max: 324, n: 3, values: [312, 324, 318] });
  assert.equal(record.cells["100"].valid, 3);
  assert.equal(record.cells["100"].total, 3);
  assert.deepEqual(record.cells["100"].attempts.map((a) => a.n), [1, 2, 3]);
});

test("merge: the empty-database cell carries only its own metrics plus the validity gates", () => {
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity), extras: [], catalogue, generatedAt: GEN });
  const ids = Object.keys(record.cells["1e"].metrics);
  assert.ok(ids.includes("turn_p50_ms"));
  assert.ok(ids.includes("client_errors"), "gate metrics stay for the verdict gates");
  assert.ok(!ids.includes("turns_completed"));
  assert.ok(!ids.includes("main_busy_pct"));
});

test("merge: a level with fewer than two valid attempts makes the record partial", () => {
  const attempts = fakeAttempts(catalogue, identity, { attempt: (cell, n) => (cell === "250" && n !== 1 ? { valid: false, problems: ["server_exited"] } : {}) });
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN });
  assert.equal(record.status, "partial");
  assert.equal(record.cells["250"].valid, 1);
  assert.equal(record.cells["250"].metrics.turns_completed.n, 1);
  assert.deepEqual(record.cells["250"].attempts[1].problems, ["server_exited"]);
});

test("merge: 17 valid of 18 ladder attempts (two valid at one level) stays complete under the two-valid rule", () => {
  const attempts = fakeAttempts(catalogue, identity, { attempt: (cell, n) => (cell === "150" && n === 2 ? { valid: false, problems: ["driver_failed"] } : {}) });
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN });
  assert.equal(record.status, "complete");
  assert.equal(record.cells["150"].valid, 2);
});

test("merge: a missing cell makes the record partial", () => {
  const attempts = fakeAttempts(catalogue, identity).filter((a) => a.cell !== "200");
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN });
  assert.equal(record.status, "partial");
  assert.equal(record.cells["200"], undefined);
});

test("merge: a null value (missing span) stays null in values and is not counted, never 0", () => {
  const attempts = fakeAttempts(catalogue, identity);
  for (const a of attempts) if (a.cell === "50" && a.n === 2) a.metrics.get_thread_shell_p95_ms = null;
  for (const a of attempts) if (a.cell === "50") a.metrics.snapshot_window_p95_ms = null;
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN });
  const shell = record.cells["50"].metrics.get_thread_shell_p95_ms;
  assert.equal(shell.n, 2);
  assert.equal(shell.values[1], null);
  assert.deepEqual(record.cells["50"].metrics.snapshot_window_p95_ms, { median: null, min: null, max: null, n: 0, values: [null, null, null] });
});

test("merge: invalid attempts never enter the statistics", () => {
  const attempts = fakeAttempts(catalogue, identity);
  for (const a of attempts) {
    if (a.cell === "100" && a.n === 3) {
      a.attempt.valid = false;
      a.attempt.problems = ["contaminated"];
      a.attempt.contaminated = true;
      a.metrics.turns_completed = 99999;
    }
  }
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN });
  assert.equal(record.cells["100"].metrics.turns_completed.n, 2);
  assert.ok(!record.cells["100"].metrics.turns_completed.values.includes(99999));
  assert.equal(record.host_guard.contaminated, true);
});

test("merge: extras fold into record-scope metrics and the CPU-per-agent slope is derived from the ladder", () => {
  const attempts = fakeAttempts(catalogue, identity);
  for (const a of attempts) if (a.cell !== "1e" && a.cell !== "1") a.metrics.proc_cpu_pct = 100 + 2 * Number(a.cell);
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: GEN });
  assert.equal(record.extras.fixture.metrics.cpu_per_session_pct.median, 2);
  assert.ok(record.extras.fixture.metrics.db_ready_warm_ms.n === 3);
  assert.ok(record.extras.empty.metrics.db_ready_warm_ms.median > 0);
  assert.equal(record.extras.migration.per_migration.length, 4);
});

test("CPU per served agent: the slope's x is each level's median agents served; one value, n 1; under two distinct served levels it is null with its reason", () => {
  // v9's shape: from 100 agents up the server is saturated and serves fewer (54, 101, 143, 143).
  const served = { 50: 50, 100: 54, 150: 101, 200: 143, 250: 143 };
  const cpu = { 50: 120, 100: 128, 150: 165, 200: 199, 250: 201 };
  const attempts = fakeAttempts(catalogue, identity);
  for (const a of attempts) {
    if (a.cell === "1e" || a.cell === "1") continue;
    a.metrics.agents_served = served[a.cell];
    a.metrics.proc_cpu_pct = cpu[a.cell];
    if (served[a.cell] < Number(a.cell)) {
      markSaturated(a);
      a.attempt.saturated_by = ["sessions_starved"];
      a.attempt.problems = ["sessions_starved"];
    }
  }
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN });
  const xs = Object.keys(served).map((L) => served[L]);
  const ys = Object.keys(served).map((L) => cpu[L]);
  const mx = xs.reduce((a, b) => a + b) / xs.length;
  const my = ys.reduce((a, b) => a + b) / ys.length;
  const expected = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const got = record.extras.fixture.metrics.cpu_per_session_pct;
  assert.ok(Math.abs(got.median - expected) < 1e-3, `${got.median} vs ${expected}`);
  assert.equal(got.n, 1, "one fitted value");
  assert.deepEqual(got.values, [got.median]);
  assert.deepEqual(validate(recordSchema, record), []);

  // Every level served the same number of agents: no slope can be fitted.
  const flat = fakeAttempts(catalogue, identity);
  for (const a of flat) {
    if (a.cell === "1e" || a.cell === "1") continue;
    a.metrics.agents_served = 40;
    markSaturated(a, Number(a.cell) > 40);
    a.attempt.saturated_by = a.attempt.saturated ? ["sessions_starved"] : [];
    a.attempt.problems = a.attempt.saturated ? ["sessions_starved"] : [];
  }
  const none = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: flat, extras: [], catalogue, generatedAt: GEN }).extras.fixture.metrics.cpu_per_session_pct;
  assert.deepEqual(none, { median: null, min: null, max: null, n: 0, values: [], reason: "fewer_than_two_served_levels" });
});

test("merge: attempts from different records, harnesses or machines are refused", () => {
  const attempts = fakeAttempts(catalogue, identity);
  attempts[3] = { ...attempts[3], harness: { ...attempts[3].harness, files_sha256: "0".repeat(64) } };
  assert.throws(() => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN }), /harness differs/);
  const other = fakeAttempts(catalogue, identity);
  other[0] = { ...other[0], record_id: "2026-11-11.linux-x64.nightly" };
  assert.throws(() => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: other, extras: [], catalogue, generatedAt: GEN }), /record_id differs/);
  const dup = fakeAttempts(catalogue, identity);
  dup.push(structuredClone(dup[0]));
  assert.throws(() => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: dup, extras: [], catalogue, generatedAt: GEN }), /duplicate attempt/);
});

test("merge CLI: folds an output directory into record.json; a schema-invalid attempt exits 2 and writes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-merge-"));
  temps.push(dir);
  for (const a of fakeAttempts(catalogue, identity)) {
    fs.mkdirSync(path.join(dir, "attempts", `${a.cell}-${a.n}`), { recursive: true });
    fs.writeFileSync(path.join(dir, "attempts", `${a.cell}-${a.n}`, "attempt.json"), JSON.stringify(a));
  }
  fs.mkdirSync(path.join(dir, "extras"));
  fs.writeFileSync(path.join(dir, "extras", "startup.json"), JSON.stringify(fakeExtras(catalogue, identity)));
  const out = path.join(dir, "record.json");
  const refsDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-merge-refs-"));
  temps.push(refsDir);
  const refs = path.join(refsDir, "public-refs.json");
  fs.writeFileSync(refs, JSON.stringify(FAKE_PUBLIC_REFS));
  const ok = spawnSync(process.execPath, [path.join(here, "merge.mjs"), dir, "--out", out, "--generated-at", GEN, "--public-refs", refs], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(validate(recordSchema, JSON.parse(fs.readFileSync(out, "utf8"))), []);
  fs.rmSync(out);
  const bad = JSON.parse(fs.readFileSync(path.join(dir, "attempts", "100-1", "attempt.json"), "utf8"));
  bad.metrics.unknown_metric = 1;
  fs.writeFileSync(path.join(dir, "attempts", "100-1", "attempt.json"), JSON.stringify(bad));
  const refused = spawnSync(process.execPath, [path.join(here, "merge.mjs"), dir, "--out", out, "--public-refs", refs], { encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.ok(!fs.existsSync(out));
});

test("merge: each cell's load profile folds into workload.cells; a profile that differs inside a cell is refused", () => {
  const attempts = fakeAttempts(catalogue, identity);
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN });
  assert.deepEqual(record.workload.cells["100"], { sessions: 100, subscribers: 3, pollers: 25, mode: "mixed", turn_gap_s: 60, switch_interval_s: 300, poll_interval_s: 100, fixture: "era" });
  assert.deepEqual(record.workload.cells["1e"], { sessions: 1, subscribers: 1, pollers: 0, mode: "fresh", turn_gap_s: 5, switch_interval_s: 30, poll_interval_s: 1, fixture: "none" });
  assert.deepEqual(validate(recordSchema, record), []);
  const odd = fakeAttempts(catalogue, identity);
  odd.find((a) => a.cell === "250" && a.n === 2).profile.subscribers = 25;
  assert.throws(() => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: odd, extras: [], catalogue, generatedAt: GEN }), /profile differs/);
});

test("merge: the record's host guard carries the largest busy, steal and iowait and the largest foreign mean of any attempt", () => {
  const attempts = fakeAttempts(catalogue, identity);
  attempts[4].host_guard = { busy_pct_max: 61.5, steal_pct_max: 0.4, iowait_pct_max: 2.5, foreign_pct_mean: 1.25 };
  attempts[9].host_guard = { busy_pct_max: 40, steal_pct_max: 1.5, iowait_pct_max: null, foreign_pct_mean: 3 };
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN });
  assert.deepEqual(record.host_guard, { contaminated: false, host_busy_pct_max: 61.5, host_steal_pct_max: 1.5, host_iowait_pct_max: 2.5, foreign_pct_mean_max: 3, thermal_limit_min: null });
  assert.deepEqual(validate(recordSchema, record), []);
});

test("merge: the record's pipeline names the exporter and runner by version and content hash; attempts that disagree are refused", () => {
  const attempts = fakeAttempts(catalogue, identity);
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN });
  assert.deepEqual(Object.keys(record.pipeline).sort(), ["exporter_files_sha256", "exporter_version", "generated_at", "lease", "run_id", "runner_files_sha256", "runner_version"]);
  assert.equal(record.pipeline.runner_version, attempts[0].pipeline.runner_version);
  const odd = fakeAttempts(catalogue, identity);
  odd[5].pipeline.runner_files_sha256 = "9".repeat(64);
  assert.throws(() => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: odd, extras: [], catalogue, generatedAt: GEN }), /pipeline differs/);
});

test("M2: the merge CLI refuses an attempt.json with a duplicate key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-merge-dup-"));
  temps.push(dir);
  for (const a of fakeAttempts(catalogue, identity)) {
    fs.mkdirSync(path.join(dir, "attempts", `${a.cell}-${a.n}`), { recursive: true });
    fs.writeFileSync(path.join(dir, "attempts", `${a.cell}-${a.n}`, "attempt.json"), JSON.stringify(a));
  }
  const file = path.join(dir, "attempts", "100-2", "attempt.json");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"turns_completed":', '"turns_completed":9999,"turns_completed":'));
  const out = path.join(dir, "record.json");
  const refsDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-merge-refs-"));
  temps.push(refsDir);
  fs.writeFileSync(path.join(refsDir, "public-refs.json"), JSON.stringify(FAKE_PUBLIC_REFS));
  const r = spawnSync(process.execPath, [path.join(here, "merge.mjs"), dir, "--out", out, "--generated-at", GEN, "--public-refs", path.join(refsDir, "public-refs.json")], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /duplicate key/);
  assert.ok(!fs.existsSync(out));
});

test("m6: extras whose exporter differs from the attempts' are refused", () => {
  const attempts = fakeAttempts(catalogue, identity);
  const extras = fakeExtras(catalogue, identity);
  extras.pipeline.exporter_files_sha256 = "8".repeat(64);
  assert.throws(() => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [extras], catalogue, generatedAt: GEN }), /pipeline differs/);
});

test("maintenance_in_window reaches each attempt summary of the record", () => {
  const attempts = fakeAttempts(catalogue, identity);
  attempts.find((a) => a.cell === "100" && a.n === 2).attempt.maintenance_in_window = "unobserved_no_span";
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN });
  assert.equal(record.cells["100"].attempts[1].maintenance_in_window, "unobserved_no_span");
  assert.equal(record.cells["100"].attempts[0].maintenance_in_window, 0);
  assert.deepEqual(validate(recordSchema, record), []);
});

test("distribution: each attempt summary of the record carries the check's ratios and verdict; a summary without one (an older export) still validates", () => {
  const attempts = fakeAttempts(catalogue, identity);
  const check = { test: "binomial", p50_ratio: 1.41, p95_ratio: 1.9, passed: false };
  for (const a of attempts) a.attempt.distribution = a.cell === "1e" ? null : { test: "binomial", p50_ratio: 1.02, p95_ratio: 0.97, passed: true };
  attempts.find((a) => a.cell === "100" && a.n === 2).attempt.distribution = check;
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN });
  assert.deepEqual(record.cells["100"].attempts[1].distribution, check);
  assert.equal(record.cells["1e"].attempts[0].distribution, null);
  assert.deepEqual(validate(recordSchema, record), []);
  delete record.cells["50"].attempts[0].distribution;
  assert.deepEqual(validate(recordSchema, record), []);
  record.cells["50"].attempts[1].distribution = { ...check, below_p50: 96 };
  assert.ok(validate(recordSchema, record).length > 0, "a count is never part of the public record");
  record.cells["50"].attempts[1].distribution = { ...check, test: "chi_square" };
  assert.ok(validate(recordSchema, record).length > 0, "an unknown test is refused");
});

test("host guard unavailable: an attempt summary carries contaminated null; the record's host guard is unaffected", () => {
  const attempts = fakeAttempts(catalogue, identity);
  const a = attempts.find((x) => x.cell === "100" && x.n === 2);
  a.attempt.valid = false;
  a.attempt.contaminated = null;
  a.attempt.problems = ["host_guard_unavailable"];
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN });
  assert.equal(record.cells["100"].attempts[1].contaminated, null);
  assert.equal(record.host_guard.contaminated, false);
  assert.deepEqual(validate(recordSchema, record), []);
});

test("profiles: each attempt's load profile must be profiles.json's entry for the record's profile and that cell", () => {
  const ok = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity), extras: [], catalogue, generatedAt: GEN });
  assert.equal(ok.workload.cells["100"].sessions, 100);
  // Every attempt of the 100-agent cell says 400 sessions: consistent inside the cell, but not real3's 100.
  const inflated = fakeAttempts(catalogue, identity);
  for (const a of inflated.filter((x) => x.cell === "100")) a.profile.sessions = 400;
  assert.throws(() => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: inflated, extras: [], catalogue, generatedAt: GEN }), (e) => e instanceof MergeError && /profiles\.json/.test(e.message));
  const poll = fakeAttempts(catalogue, identity);
  for (const a of poll.filter((x) => x.cell === "250")) a.profile.pollers = 20;
  assert.throws(() => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: poll, extras: [], catalogue, generatedAt: GEN }), (e) => e instanceof MergeError && /profiles\.json/.test(e.message));
  const unknown = fakeAttempts(catalogue, identity);
  for (const a of unknown) a.workload.profile = "no-such-profile";
  assert.throws(() => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: unknown, extras: [], catalogue, generatedAt: GEN }), (e) => e instanceof MergeError);
});

test("turns completed: a valid attempt without it is refused (the exporter gives 0 for a measured window with no completed turn); 1e and invalid attempts are exempt", () => {
  const attempts = fakeAttempts(catalogue, identity);
  attempts.find((a) => a.cell === "200" && a.n === 2).metrics.turns_completed = null;
  assert.throws(() => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN }), (e) => e instanceof MergeError && /turns_completed/.test(e.message));
  const invalid = fakeAttempts(catalogue, identity);
  const a = invalid.find((x) => x.cell === "200" && x.n === 2);
  a.attempt.valid = false;
  a.attempt.problems = ["server_exited"];
  for (const id of Object.keys(a.metrics)) a.metrics[id] = null;
  assert.equal(mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: invalid, extras: [], catalogue, generatedAt: GEN }).cells["200"].valid, 2);
  // The empty-database cell's record carries no turns count, so its attempts' value is never checked.
  const empty = fakeAttempts(catalogue, identity);
  empty.find((x) => x.cell === "1e" && x.n === 1).metrics.turns_completed = null;
  assert.equal(mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: empty, extras: [], catalogue, generatedAt: GEN }).cells["1e"].metrics.turns_completed, undefined);
});

test("saturated: a cell is saturated when its median agents served is below its agents; the cell carries both", () => {
  const attempts = fakeAttempts(catalogue, identity);
  for (const a of attempts.filter((x) => x.cell === "250")) {
    a.metrics.agents_served = { 1: 180, 2: 190, 3: 250 }[a.n];
    markSaturated(a, a.metrics.agents_served < 250);
  }
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [], catalogue, generatedAt: GEN });
  assert.equal(record.cells["250"].saturated, true);
  assert.equal(record.cells["250"].agents_total, 250);
  assert.equal(record.cells["250"].metrics.agents_served.median, 190);
  assert.equal(record.cells["100"].saturated, false);
  assert.deepEqual(validate(recordSchema, record), []);
});

test("compaction schedule era: the record takes its attempts' era; attempts that disagree are refused", () => {
  const pre = fakeAttempts(catalogue, identity);
  for (const a of pre) a.attempt.maintenance_in_window = "unscheduled_pre_marker";
  pre[2].attempt.maintenance_in_window = null; // no valid trace: no opinion
  assert.equal(mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: pre, extras: [], catalogue, generatedAt: GEN }).compaction_schedule, "unscheduled");
  const later = fakeAttempts(catalogue, identity);
  later[3].attempt.maintenance_in_window = "unobserved_no_span";
  assert.equal(mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: later, extras: [], catalogue, generatedAt: GEN }).compaction_schedule, "scheduled");
  const mixed = fakeAttempts(catalogue, identity);
  mixed[0].attempt.maintenance_in_window = "unscheduled_pre_marker";
  assert.throws(() => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: mixed, extras: [], catalogue, generatedAt: GEN }), /compaction schedule/);
});

test("distribution check: the schema says the sample is drawn with the record's seed, so a cell's attempts share it", () => {
  assert.match(recordSchema.$defs.distribution_check.description, /drawn with the record's seed, so the attempts of a cell share it/);
});

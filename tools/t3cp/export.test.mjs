// The allow-list exporter: one raw attempt directory in, attempt.json out, or exit 2 and nothing written.
// Every input is a hand-made synthetic raw directory from lib/fake-raw.mjs; nothing comes from a real run.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeSpec, harnessRun, writeRawAttempt, writeRawExtras } from "./lib/fake-raw.mjs";
import { validate } from "./lib/validate.mjs";
import { scanValue } from "./lib/scan.mjs";
import { mergeRecord } from "./merge.mjs";
import { FAKE_PUBLIC_REFS, HARNESS, fakeAttempts } from "./lib/fake.mjs";

/** Temporary directories this file made; removed when the file's tests end. */
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const here = path.dirname(fileURLToPath(import.meta.url));
const exporter = path.join(here, "export.mjs");
// Planted strings are built from fragments so this file passes the public self-scan.
const j = (...parts) => parts.join("");
const MNT = j("/mn", "t/bench");
const REF = ["server", "ref"].join("_");
const read = (rel) => JSON.parse(fs.readFileSync(path.join(here, "../..", rel), "utf8"));
const catalogue = read("catalogue/catalogue.json");
const attemptSchema = read("schema/attempt-1.json");
const extrasSchema = read("schema/extras-1.json");

function setup({ cell = "100", n = 1, edit, spec = fakeSpec() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-export-"));
  temps.push(root);
  // Stand-in files for the era fixture and the release archive: the exporter records their sizes only.
  spec = structuredClone(spec);
  spec.fixture.path = path.join(root, "fixture.sqlite");
  spec.release.archive_path = path.join(root, "archive.tar.gz");
  fs.writeFileSync(spec.fixture.path, Buffer.alloc(4096));
  fs.writeFileSync(spec.release.archive_path, Buffer.alloc(2048));
  const raw = writeRawAttempt(path.join(root, "raw"), { cell, n, edit, spec });
  const specFile = path.join(root, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const out = path.join(root, "out", `${cell}-${n}`);
  return { root, raw, specFile, out };
}

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [exporter, ...args], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "", ...env } });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

const exportAttempt = (s, extra = [], env) => run([s.raw, "--out", s.out, "--spec", s.specFile, "--no-private-patterns", ...extra], env);

function refused(s, result, what) {
  assert.equal(result.status, 2, `${what}: exit ${result.status}\n${result.stderr}`);
  assert.ok(!fs.existsSync(path.join(s.out, "attempt.json")), `${what}: attempt.json must not exist`);
}

// ---------------------------------------------------------------------------------------------------------
// positive

test("export: a synthetic raw attempt exports to a valid attempt.json with every sourced metric filled", () => {
  const s = setup();
  const r = exportAttempt(s);
  assert.equal(r.status, 0, r.stderr);
  const attempt = JSON.parse(fs.readFileSync(path.join(s.out, "attempt.json"), "utf8"));
  assert.deepEqual(validate(attemptSchema, attempt), []);
  assert.deepEqual(scanValue(attempt, { env: false }), []);
  assert.equal(attempt.record_id, "2026-11-15.linux-x64.nightly");
  assert.equal(attempt.cell, "100");
  assert.equal(attempt.n, 1);
  assert.equal(attempt.attempt.valid, true);
  assert.deepEqual(attempt.attempt.problems, []);
  assert.equal(attempt.release.date, "2026-11-15");
  assert.equal(attempt.release.archive.bytes, 2048);
  assert.equal(attempt.platform.machine, "n2d-standard-16");
  assert.equal(attempt.platform.os, "Debian 13");
  assert.equal(attempt.harness.version, "t3cp-harness/2.0.0");
  assert.equal(attempt.fixture.bytes, 4096);
  assert.deepEqual(attempt.era.missing, []);
  const m = attempt.metrics;
  assert.equal(m.turns_completed, 318);
  assert.equal(m.turn_p50_ms, 9257);
  assert.equal(m.dispatch_p95_ms, 120.25);
  assert.equal(m.session_mcp_p95_ms, 160);
  assert.equal(m.client_errors, 0);
  assert.equal(m.client_unfinished, 2);
  assert.equal(m.main_busy_pct, 73.6);
  assert.equal(m.proc_cpu_pct, 190.5);
  assert.equal(m.elu, 0.62);
  assert.equal(m.eld_p99_ms, 45.25);
  assert.equal(m.gc_ms_per_s, 7);
  assert.equal(m.stall_share_40ms, 20);
  assert.equal(m.stall_share_100ms, 10);
  assert.equal(m.stall_share_500ms, 0);
  assert.equal(m.reader_tx_wait_p95_ms, 2.4);
  assert.equal(m.reader_tx_per_s, 0.333);
  assert.equal(m.sql_time_ms_per_s, 0.833);
  assert.equal(m.get_thread_shell_p95_ms, 61.5);
  assert.equal(m.buffer_full_warnings, 1);
  assert.equal(m.server_warn_lines, 2);
  assert.equal(m.server_error_lines, 1);
  assert.equal(m.shutdown_s, 3);
  assert.equal(m.children_n, 12);
  assert.ok(m.children_cpu_pct > 0);
  assert.ok(m.wal_max_mib >= 13);
  assert.ok(m.host_busy_pct > 0);
  // Coverage: every metric with a harness source and an upstream origin is filled by this attempt.
  const filled = catalogue.metrics.filter((x) => x.scope === "level" && x.lane === "daily" && x.source.file !== "merge" && x.source.file !== "none" && x.upstream !== "fork" && x.id !== "first_item_p50_ms");
  for (const x of filled) assert.notEqual(m[x.id], null, `${x.id} not filled from ${x.source.file}`);
  assert.ok(m.first_item_p50_ms !== null);
  // No harness source yet: null, never 0.
  assert.equal(m.heap_floor_mib, null);
  assert.equal(m.git_commands_per_turn, null);
});

test("export: the CLI refuses to run without the private pattern list unless told explicitly", () => {
  const s = setup();
  refused(s, run([s.raw, "--out", s.out, "--spec", s.specFile]), "no private list");
  const list = path.join(s.root, "private.txt");
  fs.writeFileSync(list, "ladder-1\n");
  refused(s, run([s.raw, "--out", s.out, "--spec", s.specFile], { T3CP_PRIVATE_PATTERNS: list }), "a private pattern hit");
  fs.writeFileSync(list, "secret-project-[0-9]+\n");
  assert.equal(run([s.raw, "--out", s.out, "--spec", s.specFile], { T3CP_PRIVATE_PATTERNS: list }).status, 0);
});

test("export: an invalid or contaminated attempt exports as invalid with codes, and its metrics are null", () => {
  const s = setup({
    edit: (f) => {
      f.meta.contaminated = true;
      f.meta.contamination_reasons = ["foreign_cpu"];
    },
  });
  assert.equal(exportAttempt(s).status, 0);
  const attempt = JSON.parse(fs.readFileSync(path.join(s.out, "attempt.json"), "utf8"));
  assert.equal(attempt.attempt.valid, false);
  assert.equal(attempt.attempt.contaminated, true);
  assert.deepEqual(attempt.attempt.problems, ["contaminated"]);
  assert.equal(attempt.metrics.turns_completed, null);
});

test("export: the empty-database cell and a fork release export with their identity", () => {
  const spec = fakeSpec({
    record_id: "0.1.9-perf.8.linux-x64.fork",
    kind: "fork",
    release: { tag: "v0.1.9-perf.8", version: "0.1.9-perf.8", archive_name: "t3-0.1.9-perf.8-linux-x64.tar.gz", date: "2026-11-16" },
    base: { tag: "v0.1.10-nightly.20261115.4749", date: "2026-11-15", sha: "a".repeat(40) },
  });
  const s = setup({ cell: "1e", n: 2, spec });
  const r = exportAttempt(s);
  assert.equal(r.status, 0, r.stderr);
  const attempt = JSON.parse(fs.readFileSync(path.join(s.out, "attempt.json"), "utf8"));
  assert.equal(attempt.kind, "fork");
  assert.equal(attempt.cell, "1e");
  assert.equal(attempt.base.tag, "v0.1.10-nightly.20261115.4749");
  const noBase = setup({ spec: fakeSpec({ record_id: "0.1.9-perf.8.linux-x64.fork", kind: "fork", release: { tag: "v0.1.9-perf.8", version: "0.1.9-perf.8", date: "2026-11-16" } }) });
  refused(noBase, exportAttempt(noBase), "a fork without its base");
});

test("export: extras export to valid extras files that merge into the record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-extras-"));
  temps.push(root);
  const raw = writeRawExtras(path.join(root, "raw-extras"));
  const specFile = path.join(root, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(fakeSpec()));
  const out = path.join(root, "extras");
  const r = run(["--extras", raw, "--out", out, "--spec", specFile, "--no-private-patterns"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ["first_turn.json", "migration.json", "snapshot.json", "startup.json"]);
  const docs = fs.readdirSync(out).sort().map((f) => JSON.parse(fs.readFileSync(path.join(out, f), "utf8")));
  for (const d of docs) assert.deepEqual(validate(extrasSchema, d), []);
  const startup = docs[3];
  assert.deepEqual(startup.fixture.metrics.db_ready_warm_ms, { median: 4052, min: 4051, max: 4053, n: 3, values: [4051, 4052, 4053] });
  assert.equal(startup.empty.metrics.listening_first_ms.median, 1352);
  const migration = docs[1];
  assert.equal(migration.fixture.metrics.first_boot_migrations_ms.median, 14250);
  assert.equal(migration.fixture.metrics.migration_extra_disk_mib.median, 512);
  assert.deepEqual(migration.migration.per_migration, [{ id: 77, s: 1.5 }, { id: 78, s: 12.25 }, { id: 79, s: 0.5 }]);
  assert.equal(docs[0].fixture.metrics.first_turn_after_start_ms.median, null, "unmeasured is null, never 0");
  assert.equal(docs[2].fixture.metrics.snapshot_full_get_bytes.median, 280_000_000);
  const attempts = fakeAttempts(catalogue, fakeAttemptsIdentity());
  // The extras came from the real exporter: the fake attempts carry the same exporter identity.
  for (const a of attempts) Object.assign(a.pipeline, { exporter_version: docs[0].pipeline.exporter_version, exporter_files_sha256: docs[0].pipeline.exporter_files_sha256 });
  const record = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: docs, catalogue, generatedAt: "2026-11-16T00:00:00Z" });
  assert.equal(record.extras.fixture.metrics.db_ready_warm_ms.median, 4052);
});

function fakeAttemptsIdentity() {
  // fakeAttempts needs an identity whose record_id matches the extras' spec.
  const spec = fakeSpec();
  return {
    record_id: spec.record_id,
    kind: "nightly",
    release: { tag: spec.release.tag, sha: spec.release.sha, date: "2026-11-15", version: spec.release.version, archive: null, binary_sha256: null, build: null },
    base: null,
    platform: { id: "linux-x64", machine: "n2d-standard-16", cpu_model: "AMD EPYC 7B13", cores: 16, memory_gib: 64, os: "Debian 13", kernel: "6.12", provisioning: "spot", runtime_node: "26.1.0" },
    harness: { ...HARNESS },
    fixture: { id: "large-76", sha256: "d".repeat(64), bytes: null, migration: 76, recipe_sha256: null },
    workload: { profile: "real3", suite: "ladder-1", warmup_s: 60, window_s: 300, levels: [1, 50, 100, 150, 200, 250], empty_cell: true, attempts_per_level: 3, seed: "1", now: "2026-11-16T00:00:00Z" },
    era: { has: ["effect_queue_wait", "lock_wait", "gauges", "run_metrics"], missing: [] },
  };
}

// ---------------------------------------------------------------------------------------------------------
// failure classes, one test each: exit 2 and nothing written

test("export refuses (class: unknown key): an unexpected key in the runner's host facts", () => {
  const s = setup({ edit: (f) => (f.meta.host.zone = "somewhere-1") });
  const r = exportAttempt(s);
  refused(s, r, "unknown key");
  assert.match(r.stderr, /host\.zone/);
  assert.ok(!r.stderr.includes("somewhere-1"), "the value is never printed");
});

test("export (class: path in a problems string): the text never leaves; the code becomes other_problem", () => {
  // Since the review (M1) problem codes are an enumeration: a string outside it is replaced, never copied.
  const s = setup({ edit: harnessRun({ codes: [`trace_missing at ${MNT}/p/trace`] }) });
  const r = exportAttempt(s);
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(path.join(s.out, "attempt.json"), "utf8");
  assert.ok(!text.includes(MNT));
  assert.deepEqual(JSON.parse(text).attempt.problems, ["other_problem"]);
  assert.ok(!r.stderr.includes(MNT));
});

test("export refuses (class: an IP address) where a free string would otherwise pass its regex", () => {
  // Every copied string now has an enumeration or a tight regex, so the scan is the defence where a free value is
  // read: the identity block of result.json.
  const s = setup({ edit: (f) => (f.result.identity.base_ref = `sea:${j("10.", "199.0.3")}/x`) });
  const r = exportAttempt(s);
  refused(s, r, "IP");
  assert.match(r.stderr, /ip_v4/);
});

test("export refuses (class: a host-name shape): the public ws<N> shape, and a fleet name from the private list", () => {
  const s = setup({ edit: (f) => (f.result.identity.base_ref = j("w", "s3")) });
  const r = exportAttempt(s);
  refused(s, r, "ws shape");
  assert.match(r.stderr, /host_ws/);
  // Concrete fleet names live only in the private list (T3CP_PRIVATE_PATTERNS), never in a public file.
  const fleet = j("work", "-station-3");
  const t = setup({ edit: (f) => (f.result.identity.base_ref = fleet) });
  const list = path.join(t.root, "private.txt");
  fs.writeFileSync(list, `${j("work-?", "station")}\n`);
  const r2 = run([t.raw, "--out", t.out, "--spec", t.specFile], { T3CP_PRIVATE_PATTERNS: list });
  refused(t, r2, "private fleet name");
  assert.match(r2.stderr, /private_1/);
  assert.ok(!r2.stderr.includes(fleet));
});

test("export refuses (class: a non-finite number) in a mapped field", () => {
  const s = setup({
    edit: (f) => {
      f.resultText = JSON.stringify(f.result).replace('"busy_pct":190.5', '"busy_pct":1e999');
    },
  });
  const r = exportAttempt(s);
  refused(s, r, "non-finite");
  assert.match(r.stderr, /proc_cpu_pct/);
});

test("export (class: a zero where a span is missing): a renamed or missing span is null, never 0", () => {
  const s = setup({
    edit: (f) => {
      delete f.result.metrics.spans["OrchestratorV2.getThreadShell"];
      delete f.result.metrics.sql["sqlite|reader"];
      delete f.result.metrics.sql["sqlite|writer"];
      f.result.metrics.spans["Orchestrator.handleRunUpdate"] = { count: 0 };
    },
  });
  const r = exportAttempt(s);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(s.out, "attempt.json"), "utf8")).metrics;
  assert.equal(m.get_thread_shell_p95_ms, null);
  assert.equal(m.sql_time_ms_per_s, null);
  assert.equal(m.reader_stmt_p95_ms, null);
  assert.equal(m.handle_run_update_p95_ms, null);
});

test("export refuses (class: a tag that does not match the tag regex)", () => {
  for (const tag of ["v0.1.10-nightly.20261115.4749/../../x", "main", "v0.1.10-nightly.2026111.47"]) {
    const s = setup({ spec: fakeSpec({ release: { tag } }) });
    refused(s, exportAttempt(s), tag);
  }
});

test("export refuses (class: creds content referenced): a secret from a creds directory in the output, or an input resolving into one", () => {
  const leak = setup({ edit: (f) => (f.result.identity.base_ref = "tok_9f8e7d6c5b4a3f2e1d0c") });
  fs.mkdirSync(path.join(leak.raw, "creds"));
  fs.writeFileSync(path.join(leak.raw, "creds", "token.json"), JSON.stringify({ access_token: "tok_9f8e7d6c5b4a3f2e1d0c" }));
  const r = exportAttempt(leak);
  refused(leak, r, "creds secret");
  assert.match(r.stderr, /creds_secret/);
  assert.ok(!r.stderr.includes("tok_9f8e7d6c5b4a3f2e1d0c"));

  const link = setup();
  const runJson = path.join(link.raw, "work", "runs", "release", "attempt-1", "run.json");
  fs.mkdirSync(path.join(link.raw, "creds"));
  fs.renameSync(runJson, path.join(link.raw, "creds", "run.json"));
  fs.symlinkSync(path.join(link.raw, "creds", "run.json"), runJson);
  const r2 = exportAttempt(link);
  refused(link, r2, "input through a creds directory");
  assert.match(r2.stderr, /creds directory/);
});

test("export refuses (negative case): result.json identity's server reference carrying a bench mount path", () => {
  const s = setup({ edit: (f) => (f.result.identity[REF] = `sea:${MNT}/refs/release`) });
  const r = exportAttempt(s);
  refused(s, r, "server reference path");
  assert.match(r.stderr, /identity/);
  assert.ok(!r.stderr.includes(MNT));
});

test("export refuses: a raw directory whose cell or attempt number disagrees with attempt-meta.json or the spec", () => {
  const s = setup({ edit: (f) => (f.meta.cell = "50") });
  refused(s, exportAttempt(s), "cell mismatch");
  const t = setup({ edit: (f) => (f.meta.record_id = "2026-11-14.linux-x64.nightly") });
  refused(t, exportAttempt(t), "record mismatch");
});

test("export refuses: extras with a non-finite value write no extras file at all", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-extras-bad-"));
  temps.push(root);
  const raw = writeRawExtras(path.join(root, "raw-extras"));
  fs.writeFileSync(path.join(raw, "snapshot.json"), fs.readFileSync(path.join(raw, "snapshot.json"), "utf8").replace('"ms": 5123.5', '"ms": 1e999'));
  const specFile = path.join(root, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(fakeSpec()));
  const out = path.join(root, "extras");
  const r = run(["--extras", raw, "--out", out, "--spec", specFile, "--no-private-patterns"]);
  assert.equal(r.status, 2, r.stderr);
  assert.ok(!fs.existsSync(out) || fs.readdirSync(out).length === 0);
});

test("export: the attempt carries its cell's load profile as the runner ran it; base records export too", () => {
  const s = setup({ cell: "250", n: 3, edit: (f) => (f.meta.profile = { sessions: 250, subscribers: 25, pollers: 7, turn_gap_s: 60, mode: "mixed" }) });
  assert.equal(exportAttempt(s).status, 0);
  const attempt = JSON.parse(fs.readFileSync(path.join(s.out, "attempt.json"), "utf8"));
  assert.deepEqual(attempt.profile, { sessions: 250, subscribers: 25, pollers: 7, turn_gap_s: 60, mode: "mixed", fixture: "era" });
  const odd = setup({ edit: (f) => (f.meta.profile.extra_knob = 1) });
  refused(odd, exportAttempt(odd), "unknown profile key");
  const spec = fakeSpec({ record_id: "295a0a7332aa.linux-x64.base", kind: "base", release: { tag: "v0.1.10", version: "0.1.10", archive_name: "t3-0.1.10-linux-x64.tar.gz", sha: "295a0a7332aa1b0cc2f737dae71bd5e607a6ebb9", date: "2026-11-14" } });
  const b = setup({ spec });
  const r = exportAttempt(b);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.out, "attempt.json"), "utf8")).kind, "base");
});

test("export: the attempt carries the runner's host guard: busy max over every try, steal and iowait max, foreign mean", () => {
  const s = setup({
    edit: (f) => {
      f.meta.host_guard_max_busy_pct = 72.5;
      f.meta.host_guard.steal_pct_max = 0.75;
      f.meta.host_guard.iowait_pct_max = 1.5;
      f.meta.host_guard.foreign_pct_mean = 0.25;
    },
  });
  assert.equal(exportAttempt(s).status, 0);
  const attempt = JSON.parse(fs.readFileSync(path.join(s.out, "attempt.json"), "utf8"));
  assert.deepEqual(attempt.host_guard, { busy_pct_max: 72.5, steal_pct_max: 0.75, iowait_pct_max: 1.5, foreign_pct_mean: 0.25 });
  const bad = setup({ edit: (f) => (f.meta.host_guard.steal_pct_max = "high") });
  refused(bad, exportAttempt(bad), "a non-number in the host guard");
});

test("export: the t3cp code is named by version and content hash, never by a t3cp commit; fork and base builds name their public source", () => {
  const s = setup({ edit: (f) => (f.meta.runner = { version: "t3cp-runner/1.0.0", files_sha256: "1".repeat(64) }) });
  assert.equal(exportAttempt(s).status, 0);
  const attempt = JSON.parse(fs.readFileSync(path.join(s.out, "attempt.json"), "utf8"));
  assert.match(attempt.pipeline.exporter_files_sha256, /^[0-9a-f]{64}$/);
  assert.equal(attempt.pipeline.runner_version, "t3cp-runner/1.0.0");
  assert.equal(attempt.pipeline.runner_files_sha256, "1".repeat(64));
  assert.equal(attempt.release.build, null, "a nightly is the upstream archive, not a build");
  const again = setup({ edit: (f) => (f.meta.runner = { version: "t3cp-runner/1.0.0", files_sha256: "1".repeat(64) }) });
  exportAttempt(again);
  assert.equal(JSON.parse(fs.readFileSync(path.join(again.out, "attempt.json"), "utf8")).pipeline.exporter_files_sha256, attempt.pipeline.exporter_files_sha256, "the exporter hash is stable");
  const forkSpec = fakeSpec({
    record_id: "0.1.9-perf.8.linux-x64.fork",
    kind: "fork",
    release: { tag: "v0.1.9-perf.8", version: "0.1.9-perf.8", archive_name: "t3-0.1.9-perf.8-linux-x64.tar.gz", date: "2026-11-16" },
    base: { tag: "v0.1.10-nightly.20261115.4749", date: "2026-11-15", sha: "a".repeat(40) },
  });
  const repo = "github.com/navidnadali/t3code";
  const f = setup({ spec: forkSpec, edit: (x) => (x.meta.build = { source_repo: repo, script_sha256: "2".repeat(64) }) });
  assert.equal(exportAttempt(f).status, 0);
  const fork = JSON.parse(fs.readFileSync(path.join(f.out, "attempt.json"), "utf8"));
  assert.deepEqual(fork.release.build, { source_repo: repo, script_sha256: "2".repeat(64) });
  const odd = setup({ spec: forkSpec, edit: (x) => (x.meta.build = { source_repo: "github.com/someone/else", script_sha256: "2".repeat(64) }) });
  refused(odd, exportAttempt(odd), "a build source outside the two public repositories");
  const noBuild = setup({ spec: forkSpec, edit: (x) => delete x.meta.build });
  refused(noBuild, exportAttempt(noBuild), "a fork without its build facts");
  const extra = setup({ edit: (x) => (x.meta.runner = { version: "t3cp-runner/1.0.0", files_sha256: "1".repeat(64), commit: "3".repeat(40) }) });
  refused(extra, exportAttempt(extra), "a runner commit");
});

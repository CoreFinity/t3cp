// run-record.sh against a stub harness (run.ts, release.ts) and a stub exporter: resume, SIGKILL mid-attempt,
// the archive sha256 refusal and the CPU gate. Nothing here starts a server. Every runner runs in a process group of
// its own, every stub records its pid, and each test's end stops what it started (stub-procs.mjs).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { newest } from "./lib.mjs";
import { STUB_PRELUDE, carrying, owner, runInGroup, spawnInGroup, stubEnv, teardown } from "./stub-procs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "..", "run-record.sh");
const platform =
  process.platform === "linux" && process.arch === "x64"
    ? "linux-x64"
    : process.platform === "darwin" && process.arch === "arm64"
      ? "darwin-arm64"
      : null;
const skip = platform === null ? `no record platform for ${process.platform}-${process.arch}` : false;
/** Every test's setup, for the last test's check that nothing any of them started is still running. */
const everyTest = [];
/** The setups of the test now running: its end stops what it started and removes its root (stub-procs.mjs). */
const thisTest = [];
afterEach(async () => {
  for (const t of thisTest.splice(0)) await teardown(t);
});
after(async () => {
  for (const t of everyTest) await teardown(t);
});

const ORDER = [];
for (let round = 1; round <= 3; round++) {
  for (const level of ["1", "50", "100", "150", "200", "250", "1e"]) ORDER.push(`${level}-${round}`);
}

// Node below 23.6 runs .ts files only with type stripping switched on: the runner then gets a node wrapper.
const [major, minor] = process.versions.node.split(".").map(Number);
const needsStripFlag = !(major > 23 || (major === 23 && minor >= 6));

const STUB_RUN = `// stub run.ts: logs each call, writes a minimal result tree, or hangs on STUB_HANG_CELL
import * as fs from "node:fs";
import * as path from "node:path";
${STUB_PRELUDE}const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = flag("--out");
const work = flag("--work");
const cell = path.basename(out);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ cell, args }) + "\\n");
if (process.env.STUB_HANG_CELL === cell) {
  fs.writeFileSync(process.env.STUB_LOG + ".hang", String(process.pid));
  // Hangs like a run.ts in flight, but never for longer than the test could wait: a leaked stub ends by itself.
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(3), Number(process.env.STUB_HANG_MAX_MS ?? 1200000));
  // STUB_HANG_STUCK: a run.ts too stuck to stop its server on SIGTERM, whose server runs in a group of its own (as
  // run.ts starts it) and carries the run's work dir; it too ends by itself after STUB_HANG_MAX_MS.
  if (process.env.STUB_HANG_STUCK === "1") {
    process.on("SIGTERM", () => {});
    const { spawn } = await import("node:child_process");
    const max = Number(process.env.STUB_HANG_MAX_MS ?? 1200000);
    spawn(process.execPath, ["-e", "setTimeout(() => {}, " + max + ")", work], { detached: true, stdio: "ignore" }).unref();
  }
} else if (process.env.STUB_FAIL_CELL === cell) {
  // A run.ts whose driver failed: invalid, with the driver's reason, its log and the server's, and exit 1.
  const run = path.join(work, "runs", "release", "attempt-1");
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, "run.json"), JSON.stringify({ valid: false, problems: ["driver_failed"], driver: { failure_code: "sessions_starved", error: "31 of 50 sessions served" } }));
  fs.writeFileSync(path.join(run, "driver.log"), "[driver] phase: window\\n[driver] on " + (process.env.STUB_LOG_EXTRA ?? "") + "\\n[driver] fatal: exit cause starved\\n");
  fs.writeFileSync(path.join(run, "server.log"), "[server] warn: slow\\n");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "release.result.json"), JSON.stringify({ label: "release", runs: [{ valid: false }] }));
  process.exitCode = 1;
} else {
  const run = path.join(work, "runs", "release", "attempt-1");
  fs.mkdirSync(run, { recursive: true });
  const start = new Date(Date.now() - 2000).toISOString();
  const end = new Date().toISOString();
  fs.writeFileSync(path.join(run, "run.json"), JSON.stringify({ valid: true, window: { start, end } }));
  // STUB_SCENARIO=turn-start: 10 turn starts in the window, the 4th a 400 ms block, and the loop sample over it.
  if (process.env.STUB_SCENARIO === "turn-start") {
    const logs = path.join(run, "base", "userdata", "logs");
    fs.mkdirSync(logs, { recursive: true });
    const s0 = Date.parse(start);
    const ns = (ms) => String(BigInt(Math.round(ms)) * 1000000n);
    const spans = Array.from({ length: 10 }, (_, i) => [s0 + 50 + i * 100, s0 + 50 + i * 100 + (i === 3 ? 400 : 20)]);
    fs.writeFileSync(path.join(logs, "server.trace.ndjson"), spans.map(([a, b]) => JSON.stringify({ name: "ProviderTurnStartService.start", startTimeUnixNano: ns(a), endTimeUnixNano: ns(b), durationMs: b - a })).join("\\n") + "\\n");
    fs.writeFileSync(path.join(run, "loop-1hz.ndjson"), JSON.stringify({ t: s0 + 750, dt_ms: 500, delay: { max_ms: 4321 } }) + "\\n");
  }
  // STUB_DB_FROM_FIXTURE: the run's database is a copy of the fixture run.ts was given, as its restore makes it.
  if (process.env.STUB_DB_FROM_FIXTURE === "1" && flag("--fixture") !== "none") {
    fs.mkdirSync(path.join(run, "base", "userdata"), { recursive: true });
    fs.copyFileSync(flag("--fixture"), path.join(run, "base", "userdata", "statev2.sqlite"));
  }
  // STUB_DB_TEMPLATE: the run's database, as a kept run leaves it.
  if (process.env.STUB_DB_TEMPLATE) {
    fs.mkdirSync(path.join(run, "base", "userdata"), { recursive: true });
    fs.copyFileSync(process.env.STUB_DB_TEMPLATE, path.join(run, "base", "userdata", "statev2.sqlite"));
  }
  // STUB_TRACE_SPANS=N: the server trace has N prune spans inside the window and one before it.
  const spans = Number(process.env.STUB_TRACE_SPANS ?? 0);
  if (spans > 0) {
    const logs = path.join(run, "base", "userdata", "logs");
    fs.mkdirSync(logs, { recursive: true });
    const line = (endMs) => JSON.stringify({ name: "ProjectionMaintenance.pruneEventStore", durationMs: 100, endTimeUnixNano: String(BigInt(endMs) * 1000000n) });
    const lines = [line(Date.parse(start) - 60000)];
    for (let i = 0; i < spans; i++) lines.push(line(Date.parse(start) + 500 + i));
    fs.writeFileSync(path.join(logs, "server.trace.ndjson"), lines.join("\\n") + "\\n");
    // The server went 1.8 s after the driver's teardown: it stopped on SIGTERM, so the trace is complete.
    fs.mkdirSync(path.join(run, "driver"), { recursive: true });
    fs.writeFileSync(path.join(run, "driver", "driver.json"), JSON.stringify({ timeline: { teardown: end } }));
    fs.writeFileSync(path.join(run, "server-exit.json"), JSON.stringify({ gone_ms: Date.parse(end) + 1800 }));
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "release.result.json"), JSON.stringify({ label: "release", runs: [{ valid: true }] }));
}
`;

const STUB_RELEASE = `// stub release.ts: unpack makes a release directory without reading the archive
import * as fs from "node:fs";
import * as path from "node:path";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
fs.appendFileSync(process.env.STUB_LOG + ".release", JSON.stringify(args) + "\\n");
const dir = path.join(flag("--dest"), "t3-stub");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "t3"), process.env.STUB_T3_CONTENT ?? "");
if ((process.env.STUB_T3_CONTENT ?? "").startsWith("#!")) fs.chmodSync(path.join(dir, "t3"), 0o755);
fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify({ tag: flag("--tag") }));
`;

const STUB_EXPORTER = `// stub exporter: attempt.json from attempt-meta.json
import * as fs from "node:fs";
import * as path from "node:path";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = flag("--out");
fs.mkdirSync(out, { recursive: true });
if (args[0] === "--extras") process.exit(0);
// STUB_EXPORT_HANG: an attempt export that takes far longer than the record has left (it ends by itself).
if (process.env.STUB_EXPORT_HANG === "1") {
  fs.writeFileSync(process.env.STUB_LOG + ".export-started", "");
  await new Promise((resolve) => setTimeout(resolve, 600000));
}
const meta = JSON.parse(fs.readFileSync(path.join(args[0], "attempt-meta.json"), "utf8"));
// As the real exporter does, the attempt names the runner that made it (from attempt-meta.json).
const pipeline = { runner_version: meta.runner?.version ?? null, runner_files_sha256: meta.runner?.files_sha256 ?? null };
fs.writeFileSync(path.join(out, "attempt.json"), JSON.stringify({ stub: true, cell: meta.cell, n: meta.n, profile: meta.profile, pipeline }));
`;

function setup({ archiveSha256, cpuModel = "AMD EPYC 7B13", suite = {}, fixture = false, scenarioSuite = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "t3cp-run-record-"));
  const harness = join(root, "harness");
  mkdirSync(join(harness, "tools", "server-bench", "preload"), { recursive: true });
  writeFileSync(join(harness, "tools", "server-bench", "run.ts"), STUB_RUN);
  writeFileSync(join(harness, "tools", "server-bench", "release.ts"), STUB_RELEASE);
  writeFileSync(join(harness, "tools", "server-bench", "preload", "bench-preload.cjs"), "// stub\n");
  const settings = join(harness, "settings.json");
  writeFileSync(settings, "{}\n");
  // An installed harness names itself; the runner needs one whose run.ts takes --archive (2.0.0 and later).
  writeFileSync(join(harness, "t3cp-harness.json"), JSON.stringify({ version: "t3cp-harness/2.0.0", sha: "c".repeat(40), files_sha256: "d".repeat(64) }));
  const exporter = join(root, "export.mjs");
  writeFileSync(exporter, STUB_EXPORTER);
  const archive = join(root, "t3-0.1.10-nightly.20261115.4749-" + platform + ".tar.gz");
  writeFileSync(archive, "not really an archive\n");
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  // An era fixture, when asked for: a stand-in database file (the stub t3 never opens it).
  const fixtureFile = join(root, "large-76.sqlite");
  writeFileSync(fixtureFile, "not really a database\n");
  const fixtureSha = createHash("sha256").update(readFileSync(fixtureFile)).digest("hex");
  const cpuinfo = join(root, "cpuinfo");
  writeFileSync(cpuinfo, `processor\t: 0\nvendor_id\t: AuthenticAMD\nmodel name\t: ${cpuModel}\n\n`);
  const spec = join(root, "spec.json");
  writeFileSync(
    spec,
    JSON.stringify({
      schema: "t3cp/record-spec/1",
      record_id: `2026-11-15.${platform}.nightly`,
      kind: "nightly",
      release: {
        tag: "v0.1.10-nightly.20261115.4749",
        sha: "a".repeat(40),
        version: "0.1.10-nightly.20261115.4749",
        archive_name: `t3-0.1.10-nightly.20261115.4749-${platform}.tar.gz`,
        archive_sha256: archiveSha256 ?? sha256,
        archive_path: archive,
      },
      fixture: fixture ? { id: "large-76", path: fixtureFile, sha256: fixtureSha, migration: 76 } : { id: "none" },
      suite: scenarioSuite ?? {
        id: "test-stub",
        levels: [1, 50, 100, 150, 200, 250],
        attempts_per_level: 3,
        empty_cell: true,
        warmup_s: 0,
        window_s: 10,
        extras: false,
        profile: "real3",
        ...suite,
      },
      now: "2026-11-16T00:00:00Z",
      seed: "1",
      cpu_model: "AMD EPYC 7B13",
    }),
  );
  const out = join(root, "out");
  const work = join(root, "work");
  mkdirSync(out);
  mkdirSync(work);
  const log = join(root, "stub.log");
  const privatePatterns = join(root, "private-patterns.txt");
  writeFileSync(privatePatterns, "a-private-name-[0-9]{9}\n");
  const env = {
    ...process.env,
    STUB_LOG: log,
    T3CP_EXPORTER: exporter,
    T3CP_PROC_CPUINFO: cpuinfo,
    T3CP_PIN: "0",
    // State changes write heartbeats; the timed ones every 30 s keep a loaded machine from drowning in them.
    T3CP_HEARTBEAT_S: "30",
    // The exporter's private pattern list, which the runner checks before any attempt.
    T3CP_PRIVATE_PATTERNS: privatePatterns,
    // The stub's windows last 2 s: too short to judge a host; lib.test.mjs tests the guard's verdict.
    T3CP_GUARD_FOREIGN_PCT: "100",
    T3CP_GUARD_STEAL_PCT: "100",
  };
  if (needsStripFlag) {
    const node = join(root, "node");
    writeFileSync(node, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types --no-warnings "$@"\n`);
    chmodSync(node, 0o755);
    env.T3CP_NODE = node;
  }
  const args = [runner, "--spec", spec, "--out", out, "--harness", harness, "--work", work, "--settings", settings];
  const t = owner(root, work);
  Object.assign(t, { harness, out, work, log, env: { ...env, ...stubEnv(t) }, args });
  everyTest.push(t);
  thisTest.push(t);
  return t;
}

const failureOf = (out) => JSON.parse(readFileSync(newest(join(out, "failures")), "utf8"));
const heartbeats = (out) => (existsSync(join(out, "heartbeats")) ? readdirSync(join(out, "heartbeats")).sort() : []);

const calls = (log) =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).cell)
    : [];

const present = (out) =>
  ORDER.filter((cell) => existsSync(join(out, "attempts", cell, "attempt.json")));

/** This tree's runner identity, as attempts and extras made by it record it in their pipeline. */
const RUNNER = JSON.parse(spawnSync(process.execPath, [join(here, "lib.mjs"), "runner-identity", join(here, "..")], { encoding: "utf8" }).stdout);
const ownPipeline = { runner_version: RUNNER.version, runner_files_sha256: RUNNER.files_sha256 };

/** An attempt as a run of this runner left it (its pipeline names this runner), `pipeline` as given, or none (null). */
const presetJson = (cell, pipeline = ownPipeline) => JSON.stringify({ preset: cell, ...(pipeline === null ? {} : { pipeline }) });
function presetAttempt(out, cell, pipeline = ownPipeline) {
  mkdirSync(join(out, "attempts", cell), { recursive: true });
  writeFileSync(join(out, "attempts", cell, "attempt.json"), presetJson(cell, pipeline));
}

/** Running, and not a zombie waiting for its parent. */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return state !== "" && !state.startsWith("Z");
};
/** Every synchronous runner call is bounded, so a stuck runner fails the test instead of blocking the file. */
const SYNC = { encoding: "utf8", timeout: 900_000, killSignal: "SIGKILL" };

/**
 * Starts the runner with the stub hanging on `cell` and waits, at most giveUpMs, until the stub hangs there.
 * Returns the runner's child process and the hung stub's pid.
 */
async function runUntilHang(t, cell, { giveUpMs }) {
  const first = startRunner(t, { ...t.env, STUB_HANG_CELL: cell });
  const hang = `${t.log}.hang`;
  const reached = await eventually(() => existsSync(hang) && /^\d+$/.test(readFileSync(hang, "utf8")), giveUpMs);
  if (!reached) throw new Error(`the runner did not reach ${cell} within ${giveUpMs} ms`);
  return { first, orphan: Number(readFileSync(hang, "utf8")) };
}

/** Starts the runner in the background, in a process group of its own; the test's end stops it if it still runs. */
function startRunner(t, env = t.env) {
  return spawnInGroup(t, "bash", t.args, { env, stdio: "ignore" });
}

/** Runs the runner to its end (bounded), in a process group of its own. */
function runRunner(t, options) {
  return runInGroup(t, "bash", t.args, { ...SYNC, env: t.env, ...options });
}

/** What the end of a test does (afterEach, and the file's after): stop what the test started, remove its root. */
async function endOfTest(t) {
  await teardown(t);
}

/** Polls until fn() is true or the deadline passes. */
async function eventually(fn, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("with three attempts present a second invocation runs only the remaining eighteen", { skip, timeout: 1_800_000 }, () => {
  const t = setup();
  for (const cell of ["1-1", "50-1", "100-1"]) presetAttempt(t.out, cell);
  const result = runRunner(t);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const ran = calls(t.log);
  assert.equal(ran.length, 18);
  assert.deepEqual(ran, ORDER.filter((cell) => !["1-1", "50-1", "100-1"].includes(cell)));
  assert.deepEqual(present(t.out), ORDER);
  for (const cell of ["1-1", "50-1", "100-1"]) {
    assert.equal(readFileSync(join(t.out, "attempts", cell, "attempt.json"), "utf8"), presetJson(cell));
  }
  for (const cell of ran) assert.ok(existsSync(join(t.out, "attempts", cell, "export.log")), cell);
  const done = JSON.parse(readFileSync(join(t.out, "done.json"), "utf8"));
  assert.equal(done.schema, "t3cp/done/1");
  assert.equal(done.status, "complete");
  assert.equal(done.attempts.filter((a) => a.present).length, 21);
  const heartbeat = JSON.parse(readFileSync(newest(join(t.out, "heartbeats")), "utf8"));
  assert.equal(heartbeat.schema, "t3cp/heartbeat/1");
  assert.equal(heartbeat.state, "done");
  assert.equal(heartbeat.attempts_done, 21);
  const raw = existsSync(join(t.work, "raw")) ? readdirSync(join(t.work, "raw")) : [];
  if (platform === "linux-x64") assert.deepEqual(raw, [], "raw attempt directories are deleted after export on Linux");
  else assert.equal(raw.length, 18, "raw attempt directories are kept on macOS");
  // A third invocation finds everything and runs nothing, and rewrites no file it handed on: heartbeats are only
  // ever added (append-only storage), done.json stays as it was.
  const before = new Map(heartbeats(t.out).map((f) => [f, readFileSync(join(t.out, "heartbeats", f), "utf8")]));
  const doneBefore = readFileSync(join(t.out, "done.json"), "utf8");
  const again = runRunner(t);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(calls(t.log).length, 18);
  for (const [f, text] of before) assert.equal(readFileSync(join(t.out, "heartbeats", f), "utf8"), text, f);
  assert.ok(heartbeats(t.out).length > before.size, "the third run added a heartbeat");
  assert.equal(readFileSync(join(t.out, "done.json"), "utf8"), doneBefore);
  assert.ok(!existsSync(join(t.out, "heartbeat.json")));
});

test("every file handed to the update hook has a new name", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1, 50], attempts_per_level: 1 } });
  const hooked = join(t.root, "hooked.log");
  const hook = join(t.root, "hook.sh");
  writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${hooked}"\n`);
  chmodSync(hook, 0o755);
  const result = runRunner(t, { env: { ...t.env, T3CP_ON_UPDATE: hook, T3CP_ON_ATTEMPT: hook } });
  assert.equal(result.status, 0, result.stderr);
  const names = readFileSync(hooked, "utf8").split("\n").filter(Boolean);
  assert.equal(new Set(names).size, names.length, "no name handed on twice");
  assert.equal(names.filter((n) => n.includes("/attempts/")).length, 3);
  assert.ok(names.filter((n) => n.includes("/heartbeats/")).length >= 3);
  assert.equal(names.filter((n) => n.endsWith("/done.json")).length, 1);
});

test("SIGKILL mid-attempt then restart redoes the attempt in flight and nothing completed", { skip, timeout: 1_800_000 }, async () => {
  const t = setup({ suite: { levels: [1, 50], attempts_per_level: 3 } });
  const order = ["1-1", "50-1", "1e-1", "1-2", "50-2", "1e-2", "1-3", "50-3", "1e-3"];
  const { first, orphan } = await runUntilHang(t, "50-2", { giveUpMs: 900_000 });
  const exited = new Promise((resolve) => first.on("exit", resolve));
  first.kill("SIGKILL");
  await exited;
  const before = calls(t.log);
  assert.deepEqual(before, order.slice(0, order.indexOf("50-2") + 1));
  assert.ok(alive(orphan), "the in-flight run.ts outlives a SIGKILLed runner");
  assert.ok(!existsSync(join(t.out, "attempts", "50-2", "attempt.json")));

  const second = runRunner(t);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  const redo = calls(t.log).slice(before.length);
  assert.deepEqual(redo, order.slice(order.indexOf("50-2")));
  assert.ok(await eventually(() => !alive(orphan)), "the restart stops the run.ts left over from the killed runner");
  assert.equal(JSON.parse(readFileSync(join(t.out, "done.json"), "utf8")).status, "complete");
});

test("a test that gives up waiting leaves no runner and no hung stub behind", { skip, timeout: 1_800_000 }, async () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  const { first, orphan } = await runUntilHang(t, "1-1", { giveUpMs: 900_000 });
  await endOfTest(t);
  assert.ok(!alive(orphan), "the hung stub is stopped");
  assert.ok(await eventually(() => first.exitCode !== null || first.signalCode !== null, 15_000), "the runner is stopped");
  assert.deepEqual(carrying(t), [], "nothing the test started is still running");
});

test("an archive whose sha256 does not match the spec is refused before any attempt", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ archiveSha256: "0".repeat(64) });
  const result = runRunner(t);
  assert.equal(result.status, 3, result.stderr);
  const failure = failureOf(t.out);
  assert.equal(failure.schema, "t3cp/failure/1");
  assert.equal(failure.reason, "archive_sha256_mismatch");
  assert.equal(failure.retryable, false);
  assert.deepEqual(calls(t.log), []);
  assert.ok(!existsSync(`${t.log}.release`), "nothing was unpacked");
  assert.deepEqual(present(t.out), []);
  assert.ok(!existsSync(join(t.out, "done.json")));
});

test("a CPU other than the pinned model exits cpu_mismatch before any attempt", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ cpuModel: "Intel(R) Xeon(R) CPU @ 2.20GHz" });
  const result = runRunner(t);
  assert.equal(result.status, 3, result.stderr);
  const failure = failureOf(t.out);
  assert.equal(failure.reason, "cpu_mismatch");
  assert.equal(failure.retryable, true);
  assert.deepEqual(calls(t.log), []);
  assert.ok(!existsSync(`${t.log}.release`));
  assert.deepEqual(present(t.out), []);
});

test("a spec that breaks the schema is refused with spec_invalid", { skip, timeout: 1_800_000 }, () => {
  const t = setup();
  const spec = JSON.parse(readFileSync(t.args[2], "utf8"));
  spec.suite.levels = [1, 50, "x"];
  writeFileSync(t.args[2], JSON.stringify(spec));
  const result = runRunner(t);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(failureOf(t.out).reason, "spec_invalid");
  assert.deepEqual(calls(t.log), []);
});

test("the spec's profile decides what each cell's run.ts and driver get, and every attempt records it", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1, 250], attempts_per_level: 1, profile: "primary-scaled" } });
  const result = runRunner(t);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const runs = readFileSync(t.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(runs.map((r) => r.cell), ["1-1", "250-1", "1e-1"]);
  const value = (args, flag) => args[args.indexOf(flag) + 1];
  const driverArgs = (args) => args.filter((a) => a.startsWith("--driver-arg=")).map((a) => a.slice(13));
  const [one, big, empty] = runs.map((r) => r.args);
  // Counts above zero are run.ts flags; the turn gap, a zero poller count, the mode, the thread switch and the
  // poll rate are driver options, each token through its own --driver-arg= (as the P1 job layer passed them).
  assert.deepEqual([value(big, "--sessions"), value(big, "--subscribers"), value(big, "--pollers")], ["250", "25", "63"]);
  assert.ok(!big.includes("--turn-gap"));
  assert.deepEqual(driverArgs(big).slice(0, 10), ["--seed", "1", "--mode", "fresh", "--switch-interval", "300s", "--poll-rate", "0.01", "--turn-gap", "60s"]); // no era fixture: fresh
  assert.deepEqual([value(one, "--sessions"), value(one, "--subscribers")], ["1", "1"]);
  assert.ok(!one.includes("--pollers") && !one.includes("--turn-gap"));
  assert.ok(driverArgs(one).join(" ").includes("--turn-gap 5s --pollers 0"));
  assert.equal(value(empty, "--fixture"), "none");
  assert.ok(driverArgs(empty).join(" ").includes("--mode fresh"));
  const attempt = JSON.parse(readFileSync(join(t.out, "attempts", "250-1", "attempt.json"), "utf8"));
  assert.deepEqual(attempt.profile, {
    sessions: 250,
    subscribers: 25,
    pollers: 63,
    mode: "fresh",
    turn_gap_s: 60,
    switch_interval_s: 300,
    poll_interval_s: 100,
  });
});

test("a spec naming a profile the table does not have is refused before any attempt", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { profile: "no-such-profile" } });
  const result = runRunner(t);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(failureOf(t.out).reason, "spec_invalid");
  assert.deepEqual(calls(t.log), []);
});

test("a spec without suite.profile runs real3", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [250], attempts_per_level: 1, empty_cell: false } });
  const spec = JSON.parse(readFileSync(t.args[2], "utf8"));
  delete spec.suite.profile;
  writeFileSync(t.args[2], JSON.stringify(spec));
  const result = runRunner(t);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const [run] = readFileSync(t.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const value = (flag) => run.args[run.args.indexOf(flag) + 1];
  assert.deepEqual([value("--sessions"), value("--subscribers"), value("--pollers")], ["250", "3", "63"]);
  const driverArgs = run.args.filter((a) => a.startsWith("--driver-arg=")).map((a) => a.slice(13));
  assert.ok(driverArgs.join(" ").includes("--switch-interval 300s --poll-rate 0.01 --turn-gap 60s"));
  assert.equal(JSON.parse(readFileSync(join(t.out, "attempts", "250-1", "attempt.json"), "utf8")).profile.subscribers, 3);
});

test("every attempt names the runner that made it, and a built release's build facts", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  const spec = JSON.parse(readFileSync(t.args[2], "utf8"));
  spec.release.build = { source_repo: "github.com/pingdotgg/t3code", script_sha256: "e".repeat(64) };
  writeFileSync(t.args[2], JSON.stringify(spec));
  const result = runRunner(t, { env: { ...t.env, T3CP_KEEP_RAW: "1" } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const meta = JSON.parse(readFileSync(join(t.work, "raw", "1-1", "attempt-meta.json"), "utf8"));
  assert.match(meta.runner.version, /^t3cp-runner\/\d+\.\d+\.\d+$/);
  assert.match(meta.runner.files_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(meta.build, { source_repo: "github.com/pingdotgg/t3code", script_sha256: "e".repeat(64) });
  // The same runner tree gives the same hash.
  const again = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  assert.equal(runRunner(again, { env: { ...again.env, T3CP_KEEP_RAW: "1" } }).status, 0);
  const other = JSON.parse(readFileSync(join(again.work, "raw", "1-1", "attempt-meta.json"), "utf8"));
  assert.equal(other.runner.files_sha256, meta.runner.files_sha256);
  assert.equal(other.build, null);
});

test("when the runner exits, no heartbeat it was writing outlives it, and the final state's is the newest", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  const writing = join(t.root, "heartbeat-writing");
  const slow = join(t.root, "slow-heartbeats");
  // The runner's node: once the exporter has started, a heartbeat of any state but a final one takes 8 s to write.
  const node = join(t.root, "node-slow");
  writeFileSync(
    node,
    `#!/bin/sh
if [ "$2" = heartbeat ] && [ -e "${slow}" ]; then
  case "$7" in done | failed | interrupted) ;; *) : > "${writing}"; sleep 8 ;; esac
fi
exec "${process.execPath}"${needsStripFlag ? " --experimental-strip-types --no-warnings" : ""} "$@"
`,
  );
  chmodSync(node, 0o755);
  // The exporter returns only once the heartbeat loop is in the middle of a write (the runner itself waits on the
  // exporter, so the write is the loop's), or after 600 s: the runner then finishes while that write is in flight.
  const exporter = join(t.root, "export-wait.mjs");
  writeFileSync(
    exporter,
    `${STUB_EXPORTER}
fs.writeFileSync(${JSON.stringify(slow)}, "");
const until = Date.now() + 600000;
const nap = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(${JSON.stringify(writing)}) && Date.now() < until) Atomics.wait(nap, 0, 0, 100);
`,
  );
  const env = { ...t.env, T3CP_NODE: node, T3CP_EXPORTER: exporter, T3CP_HEARTBEAT_S: "1" };
  // The runner's output goes to a file, not a pipe: spawnSync then returns when the runner exits, not when the last
  // process holding its pipe does, so a writer left behind is still running when the check below looks.
  const output = join(t.root, "runner.out");
  const fd = openSync(output, "w");
  const result = runRunner(t, { env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  assert.equal(result.status, 0, readFileSync(output, "utf8"));
  assert.ok(existsSync(writing), "the heartbeat loop was writing when the runner finished");
  assert.deepEqual(carrying(t), [], "nothing the runner started outlives it");
  assert.equal(JSON.parse(readFileSync(newest(join(t.out, "heartbeats")), "utf8")).state, "done");
});

test("a runner killed by a bound while its run.ts hangs leaves nothing running once its test ends", { skip, timeout: 1_800_000 }, async () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  // The hung stub ends by itself after 120 s, so a leak this test finds does not linger.
  const runner = startRunner(t, { ...t.env, STUB_HANG_CELL: "1-1", STUB_HANG_MAX_MS: "120000" });
  const hang = `${t.log}.hang`;
  const reached = await eventually(() => existsSync(hang) && /^\d+$/.test(readFileSync(hang, "utf8")), 900_000);
  assert.ok(reached, "the stub hangs in 1-1");
  // What a bounded call does when its bound passes: SIGKILL to the runner, and to nothing else.
  const exited = new Promise((resolve) => runner.on("exit", resolve));
  runner.kill("SIGKILL");
  await exited;
  await endOfTest(t);
  assert.deepEqual(carrying(t), [], "nothing the test started is still running");
  assert.ok(!existsSync(t.root), "the test's root is removed");
});

test("every attempt records maintenance_in_window: the release's class, or the spans counted in its window", { skip, timeout: 1_800_000 }, () => {
  const counted = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  const env = { ...counted.env, T3CP_KEEP_RAW: "1", STUB_TRACE_SPANS: "2", STUB_T3_CONTENT: 'x "compacted-at" ProjectionMaintenance.pruneEventStore x' };
  const result = runRunner(counted, { env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const meta = JSON.parse(readFileSync(join(counted.work, "raw", "1-1", "attempt-meta.json"), "utf8"));
  assert.equal(meta.maintenance_in_window, 2);
  assert.equal(meta.tries.at(-1).maintenance_in_window, 2);

  // The stub release's server has no marker in it: a release from before the marker.
  const early = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  const again = runRunner(early, { env: { ...early.env, T3CP_KEEP_RAW: "1", STUB_TRACE_SPANS: "2" } });
  assert.equal(again.status, 0, again.stderr + again.stdout);
  const earlyMeta = JSON.parse(readFileSync(join(early.work, "raw", "1-1", "attempt-meta.json"), "utf8"));
  assert.equal(earlyMeta.maintenance_in_window, "unscheduled_pre_marker");
});

/** Every file under dir, relative. */
const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => !existsSync(join(dir, f)) || !statSync(join(dir, f)).isDirectory()) : []);

test("a failed attempt leaves bounded, scrubbed diagnostics outside the record, handed to the diagnostics hook", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1, 50], attempts_per_level: 1, empty_cell: false } });
  const patterns = join(t.root, "private.txt");
  writeFileSync(patterns, "private-[0-9]+\n");
  const hooked = join(t.root, "diagnostics-hooked.log");
  const hook = join(t.root, "on-diagnostics.sh");
  writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${hooked}"\n`);
  chmodSync(hook, 0o755);
  const env = { ...t.env, STUB_FAIL_CELL: "50-1", STUB_LOG_EXTRA: `private-77 ${hostname()}`, T3CP_ON_DIAGNOSTICS: hook, T3CP_PRIVATE_PATTERNS: patterns };
  const result = runRunner(t, { env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const all = filesUnder(join(t.work, "diagnostics")).map((f) => join(t.work, "diagnostics", f));
  assert.deepEqual(readFileSync(hooked, "utf8").split("\n").filter(Boolean).sort(), [...all].sort(), "every bundle handed on");
  // 1-1 is diagnosed only where the host guard cannot judge (no guard on this host): that is all it says.
  for (const file of all.filter((f) => !f.includes("/50-1/"))) assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).reasons, ["host_guard_unavailable"], file);
  const written = all.filter((f) => f.includes("/50-1/"));
  assert.equal(written.length, 1, all.join(" "));
  const text = readFileSync(written[0], "utf8");
  const d = JSON.parse(text);
  assert.equal(d.schema, "t3cp/diagnostics/1");
  assert.deepEqual([d.kind, d.cell, d.n], ["attempt", "50", 1]);
  assert.ok(d.reasons.includes("run_ts_exit_1") && d.reasons.includes("no_valid_run"), d.reasons.join(" "));
  assert.equal(d.runs[0].driver.failure_code, "sessions_starved");
  assert.ok(d.runs[0].logs["driver.log"].text.includes("fatal: exit cause starved"));
  assert.ok(!text.includes("private-77") && !text.includes(hostname()), "scrubbed");
  assert.ok(Buffer.byteLength(text) <= 262_144);
  // Never part of the record: nothing under <out> is a diagnostics file.
  for (const f of filesUnder(t.out)) assert.ok(!readFileSync(join(t.out, f), "utf8").includes("t3cp/diagnostics/1"), f);
});

test("a runner that fails leaves runner diagnostics, handed to the diagnostics hook", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ archiveSha256: "0".repeat(64) });
  const hooked = join(t.root, "diagnostics-hooked.log");
  const hook = join(t.root, "on-diagnostics.sh");
  writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${hooked}"\n`);
  chmodSync(hook, 0o755);
  const result = runRunner(t, { env: { ...t.env, T3CP_ON_DIAGNOSTICS: hook } });
  assert.equal(result.status, 3, result.stderr);
  const written = filesUnder(join(t.work, "diagnostics")).map((f) => join(t.work, "diagnostics", f));
  assert.equal(written.length, 1, written.join(" "));
  assert.deepEqual(readFileSync(hooked, "utf8").split("\n").filter(Boolean), written);
  const d = JSON.parse(readFileSync(written[0], "utf8"));
  assert.equal(d.kind, "runner");
  assert.deepEqual(d.reasons, ["archive_sha256_mismatch"]);
  assert.ok(d.logs["runner.log"].text.includes("archive_sha256_mismatch"));
});

test("a clean record leaves no diagnostics, but for a host guard that could not judge", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  const result = runRunner(t);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  // Where the guard judged the host (Linux with a cgroup) there is none; without a guard, the one it cannot judge.
  for (const f of filesUnder(join(t.work, "diagnostics"))) {
    assert.deepEqual(JSON.parse(readFileSync(join(t.work, "diagnostics", f), "utf8")).reasons, ["host_guard_unavailable"], f);
  }
});

test("every run.ts call names the verified release archive, as run.ts requires for an upstream release", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1, 50], attempts_per_level: 1, empty_cell: true } });
  const result = runRunner(t);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const archive = JSON.parse(readFileSync(t.args[2], "utf8")).release.archive_path;
  const runs = readFileSync(t.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(runs.length, 3);
  for (const { cell, args } of runs) {
    const i = args.indexOf("--archive");
    assert.ok(i >= 0, `${cell}: no --archive`);
    assert.equal(args[i + 1], `release=${archive}`, cell);
    assert.equal(args.filter((a) => a === "--archive").length, 1, cell);
  }
});

test("every run.ts call gets the bench's server environment, its chosen 8192 MiB heap limit included", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1, 50], attempts_per_level: 1, empty_cell: true } });
  const result = runRunner(t);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const runs = readFileSync(t.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(runs.length, 3);
  for (const { cell, args } of runs) {
    const env = args.flatMap((a, i) => (a === "--server-env" ? [args[i + 1]] : []));
    assert.deepEqual(
      env,
      [
        "T3CODE_TELEMETRY_ENABLED=false",
        "T3CODE_LOG_LEVEL=Warn",
        "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false",
        "NODE_OPTIONS=--max-old-space-size=8192",
      ],
      cell,
    );
  }
});

test("a harness older than 2.0.0, or one that does not name itself, is refused before any attempt", { skip, timeout: 1_800_000 }, () => {
  for (const [what, meta] of [
    ["1.0.0, whose run.ts takes no --archive", { version: "t3cp-harness/1.0.0", sha: "c".repeat(40) }],
    ["one without a version", { sha: "c".repeat(40) }],
    ["one without t3cp-harness.json", null],
  ]) {
    const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
    const file = join(t.harness, "t3cp-harness.json");
    if (meta === null) rmSync(file);
    else writeFileSync(file, JSON.stringify(meta));
    const result = runRunner(t);
    assert.equal(result.status, 3, `${what}: ${result.stderr}`);
    const failure = failureOf(t.out);
    assert.equal(failure.reason, "harness_missing", what);
    assert.match(failure.detail, /2\.0\.0/, what);
    assert.deepEqual(calls(t.log), [], `${what}: no attempt ran`);
    assert.ok(!existsSync(`${t.log}.release`), `${what}: nothing was unpacked`);
  }
  for (const version of ["t3cp-harness/2.0.0", "t3cp-harness/2.1.3", "t3cp-harness/10.0.0"]) {
    const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
    writeFileSync(join(t.harness, "t3cp-harness.json"), JSON.stringify({ version, sha: "c".repeat(40) }));
    assert.equal(runRunner(t).status, 0, version);
  }
});

/** A hook that logs its argument and fails (exit 1) when the argument matches failOn, or hangs when it matches hangOn. */
function hookScript(t, name, { failOn = null, hangOn = null } = {}) {
  const logFile = join(t.root, `${name}.log`);
  const file = join(t.root, `${name}.sh`);
  const lines = ["#!/bin/sh", `printf '%s\\n' "$1" >> "${logFile}"`];
  if (hangOn) lines.push(`case "$1" in ${hangOn}) exec sleep 600 ;; esac`);
  if (failOn) lines.push(`case "$1" in ${failOn}) exit 1 ;; esac`);
  lines.push("exit 0");
  writeFileSync(file, `${lines.join("\n")}\n`);
  chmodSync(file, 0o755);
  return { file, calls: () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []) };
}

test("an attempt whose hook failed is handed over again by the next run; a preset attempt is not", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1, 50], attempts_per_level: 1, empty_cell: false } });
  presetAttempt(t.out, "1-1");
  const failing = hookScript(t, "attempt-fails", { failOn: "*/attempts/50-1" });
  const first = runRunner(t, { env: { ...t.env, T3CP_ON_ATTEMPT: failing.file, T3CP_HOOK_BACKOFF_S: "0" } });
  assert.equal(first.status, 4, first.stderr);
  assert.equal(failureOf(t.out).reason, "hook_failed");
  assert.ok(existsSync(join(t.out, "attempts", "50-1", "attempt.json")), "the attempt is in <out>, but storage never got it");
  const working = hookScript(t, "attempt-works");
  const second = runRunner(t, { env: { ...t.env, T3CP_ON_ATTEMPT: working.file, T3CP_HOOK_BACKOFF_S: "0" } });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(working.calls(), [join(t.out, "attempts", "50-1")], "handed over again, and only it");
  assert.equal(calls(t.log).filter((c) => c === "50-1").length, 1, "not run again");
});

test("done.json whose hook failed is handed over again by the next run", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  const failing = hookScript(t, "update-fails", { failOn: "*/done.json" });
  const first = runRunner(t, { env: { ...t.env, T3CP_ON_UPDATE: failing.file, T3CP_HOOK_BACKOFF_S: "0" } });
  assert.equal(first.status, 4, first.stderr);
  assert.ok(existsSync(join(t.out, "done.json")));
  const working = hookScript(t, "update-works");
  const second = runRunner(t, { env: { ...t.env, T3CP_ON_UPDATE: working.file, T3CP_HOOK_BACKOFF_S: "0" } });
  assert.equal(second.status, 0, second.stderr);
  assert.ok(working.calls().includes(join(t.out, "done.json")), working.calls().join(" "));
});

test("a hook that hangs is stopped with its process group after T3CP_HOOK_TIMEOUT_S, logged, and the record carries on", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1, 50], attempts_per_level: 1, empty_cell: false } });
  const hanging = hookScript(t, "diagnostics-hangs", { hangOn: "*/diagnostics/50-1/*" });
  const result = runRunner(t, {
    env: { ...t.env, STUB_FAIL_CELL: "50-1", T3CP_ON_DIAGNOSTICS: hanging.file, T3CP_HOOK_TIMEOUT_S: "2", T3CP_HOOK_BACKOFF_S: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(t.out, "done.json"), "utf8")).status, "complete");
  assert.equal(hanging.calls().filter((c) => c.includes("/diagnostics/50-1/")).length, 3, "three tries");
  const log = readFileSync(join(t.work, "runner.log"), "utf8");
  assert.match(log, /timed out after 2 s/);
  assert.match(log, /diagnostics hook failed/);
  assert.deepEqual(carrying(t), [], "no hung hook is left running");
});

test("a --work inside --out is refused before anything starts", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  const args = [...t.args];
  args[args.indexOf("--work") + 1] = join(t.out, "work");
  // The runner's stand-in scratch goes under $TMPDIR: it must be gone when the runner is.
  const tmp = join(t.root, "tmp");
  mkdirSync(tmp);
  const result = runInGroup(t, "bash", args, { ...SYNC, env: { ...t.env, TMPDIR: tmp } });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(failureOf(t.out).reason, "spec_invalid");
  assert.match(failureOf(t.out).detail, /--work/);
  assert.deepEqual(calls(t.log), []);
  assert.deepEqual(readdirSync(tmp), [], "the stand-in scratch is removed");
});

test("an exporter that could not run (no usable private pattern list) is refused before any attempt", { skip, timeout: 1_800_000 }, () => {
  for (const [what, value] of [
    ["unset", undefined],
    ["unreadable", "/nonexistent/private-patterns.txt"],
  ]) {
    const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
    const env = { ...t.env };
    if (value === undefined) delete env.T3CP_PRIVATE_PATTERNS;
    else env.T3CP_PRIVATE_PATTERNS = value;
    const result = runRunner(t, { env });
    assert.equal(result.status, 3, `${what}: ${result.stderr}`);
    assert.equal(failureOf(t.out).reason, "exporter_missing", what);
    assert.match(failureOf(t.out).detail, /private pattern/, what);
    assert.deepEqual(calls(t.log), [], `${what}: no attempt ran`);
  }
});

test("an attempt whose host guard could not judge records contaminated null and is not retried", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  // Its input is a file that does not exist, on every platform (on Linux, /proc/stat would let it judge).
  const result = runRunner(t, { env: { ...t.env, T3CP_KEEP_RAW: "1", T3CP_PROC_STAT: join(t.root, "no-proc-stat") } });
  assert.equal(result.status, 0, result.stderr);
  // The host guard has nothing to read (no /proc/stat, or no guard at all off Linux): it cannot judge.
  const meta = JSON.parse(readFileSync(join(t.work, "raw", "1-1", "attempt-meta.json"), "utf8"));
  assert.equal(meta.contaminated, null);
  assert.deepEqual(meta.contamination_reasons, []);
  assert.equal(meta.tries.length, 1);
  assert.equal(calls(t.log).length, 1);
});

test("a runner SIGKILLed while it migrates leaves its migration and server to the restart, which stops them first", { skip, timeout: 1_800_000 }, async () => {
  const t = setup({ fixture: true, suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  // A t3 that never answers: the migration waits for it until its budget runs out.
  const env = { ...t.env, STUB_T3_CONTENT: "#!/bin/sh\nsleep 600\n" };
  const serving = () => carrying(t).filter((p) => p.includes(" serve --mode web "));
  const first = startRunner(t, { ...env, T3CP_MIGRATION_BUDGET_S: "900" });
  assert.ok(await eventually(() => serving().length === 1, 900_000), "runner 1's migration server is up");
  const firstServer = serving()[0].split(" ")[0];
  const exited = new Promise((resolve) => first.on("exit", resolve));
  first.kill("SIGKILL");
  await exited;
  assert.equal(serving().length, 1, "the migration server outlives a SIGKILLed runner");
  const second = runRunner(t, { env: { ...env, T3CP_MIGRATION_BUDGET_S: "3" } });
  assert.equal(second.status, 4, second.stderr);
  assert.equal(failureOf(t.out).reason, "migration_failed");
  const log = readFileSync(join(t.work, "runner.log"), "utf8");
  assert.match(log, /left by an earlier run/, "the restart stopped what runner 1 left first");
  assert.ok(!serving().some((p) => p.startsWith(`${firstServer} `)), "runner 1's server is gone");
  assert.deepEqual(carrying(t), [], "nothing of either run is left");
});

// The extras phase can never stall a record: each extra has a hard timeout and the phase one more. A timed-out
// extra's own process group is stopped (only it), its raw file says extra_timeout, and the record goes on to done.json.
const inContainer = existsSync("/.dockerenv") || process.env.T3CP_TEST_IN_CONTAINER === "1";
const rawExtra = (t, name) => JSON.parse(readFileSync(join(t.work, "raw-extras", `${name}.json`), "utf8"));

test("a startup extra that outlives its timeout is stopped with its own group only, and the record ends with done.json", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false, extras: true } });
  // A t3 that never answers: each start would wait out its 900 s budget.
  const env = { ...t.env, STUB_T3_CONTENT: "#!/bin/sh\nsleep 600\n", T3CP_KEEP_RAW: "1", T3CP_STARTUP_BUDGET_S: "900", T3CP_EXTRA_TIMEOUT_S: "4", T3CP_EXTRAS_TIMEOUT_S: "120" };
  // Another process group the runner must leave alone.
  const decoy = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  try {
    const started = Date.now();
    const result = runRunner(t, { env, timeout: 120_000 });
    assert.equal(result.status, 0, `status ${result.status} after ${Date.now() - started} ms: ${result.stderr}`);
    assert.ok(existsSync(join(t.out, "done.json")), "the record ended");
    const startup = rawExtra(t, "startup");
    assert.equal(startup.timed_out, true);
    assert.ok(startup.starts.every((s) => s.listening_ms === null), "no number for a start that never answered");
    assert.match(readFileSync(join(t.work, "runner.log"), "utf8"), /startup extra timed out after 4 s/);
    assert.ok(alive(decoy.pid), "the decoy's group was left alone");
    assert.deepEqual(carrying(t), [], "nothing of the extra is left");
  } finally {
    process.kill(decoy.pid, "SIGKILL");
  }
});

test("an extras run that hangs is stopped at its timeout; snapshot and first turn say extra_timeout", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false, extras: true } });
  // The stub run.ts hangs on the extras run (its out dir is raw-extras/run); the startup extra ends at once.
  const env = { ...t.env, STUB_HANG_CELL: "run", STUB_HANG_MAX_MS: "600000", T3CP_KEEP_RAW: "1", T3CP_STARTUP_BUDGET_S: "1", T3CP_EXTRA_TIMEOUT_S: "4", T3CP_EXTRAS_TIMEOUT_S: "120" };
  const result = runRunner(t, { env, timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(t.out, "done.json")));
  // A record without a fixture keeps no_fixture as the values' reason; the files say the run timed out.
  assert.equal(rawExtra(t, "snapshot").timed_out, true);
  assert.equal(rawExtra(t, "first_turn").timed_out, true);
  assert.match(readFileSync(join(t.work, "runner.log"), "utf8"), /extras run timed out after 4 s/);
  assert.deepEqual(carrying(t), []);
});

test("a stuck extras run whose server has a group of its own: the timeout stops that server too, and nothing else", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false, extras: true } });
  const env = { ...t.env, STUB_HANG_CELL: "run", STUB_HANG_STUCK: "1", STUB_HANG_MAX_MS: "600000", T3CP_KEEP_RAW: "1", T3CP_STARTUP_BUDGET_S: "1", T3CP_EXTRA_TIMEOUT_S: "4", T3CP_EXTRAS_TIMEOUT_S: "120" };
  const decoy = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  try {
    const result = runRunner(t, { env, timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(t.work, "runner.log"), "utf8"), /extras run timed out after 4 s/);
    assert.ok(alive(decoy.pid), "the decoy's group was left alone");
    assert.deepEqual(carrying(t), [], "the stuck run's own server is stopped too");
  } finally {
    process.kill(decoy.pid, "SIGKILL");
  }
});

test("the extras phase as a whole is bounded: an extra it leaves no time for is not started and says extra_timeout", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false, extras: true } });
  const env = { ...t.env, STUB_T3_CONTENT: "#!/bin/sh\nsleep 600\n", T3CP_KEEP_RAW: "1", T3CP_STARTUP_BUDGET_S: "900", T3CP_EXTRA_TIMEOUT_S: "900", T3CP_EXTRAS_TIMEOUT_S: "5" };
  const result = runRunner(t, { env, timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(t.out, "done.json")));
  assert.equal(rawExtra(t, "startup").timed_out, true);
  assert.equal(rawExtra(t, "snapshot").timed_out, true);
  assert.ok(!calls(t.log).includes("run"), "the extras run was not started");
  assert.deepEqual(carrying(t), []);
});

// Destructive if it fails (a group signal to -1 reaches every process the user owns): containers only.
test("a pid file holding 0, 1, -1, a blank or a non-number is never signalled", { skip: skip || (!inContainer && "only in a container"), timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  // The attempt hook plants them after the start's reap, so the runner's own stop at exit meets them.
  const hook = join(t.root, "plant-pids.sh");
  const lines = [["zero", "0"], ["one", "1"], ["minus", "-1"], ["blank", ""], ["word", "abc"]].map(
    ([name, value]) => `printf '%s\\n' '${value}' > '${join(t.work, "pids", `${name}.pid`)}'`,
  );
  writeFileSync(hook, `#!/bin/sh\nmkdir -p '${join(t.work, "pids")}'\n${lines.join("\n")}\n`);
  chmodSync(hook, 0o755);
  const result = runRunner(t, { env: { ...t.env, T3CP_ON_ATTEMPT: hook } });
  // A runner that signalled -1 or 0 would have killed this test's own process tree before it got here.
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(join(t.work, "runner.log"), "utf8");
  for (const value of ["0", "1", "-1", "abc"]) assert.match(log, new RegExp(`refused to signal '${value}'`));
});

// A run never reuses work another runner made: an attempt or extra in <out> whose pipeline names a different runner,
// or none, fails the record closed (foreign_attempts) before anything runs. Work this runner made is reused.
const FOREIGN = { runner_version: "t3cp-runner/1.0.0", runner_files_sha256: "0".repeat(64) };

test("an attempt another runner made is not reused: the record fails closed with foreign_attempts", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1, 50], attempts_per_level: 1, empty_cell: false } });
  presetAttempt(t.out, "1-1", FOREIGN);
  const result = runRunner(t);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(failureOf(t.out).reason, "foreign_attempts");
  assert.equal(failureOf(t.out).retryable, false);
  assert.match(failureOf(t.out).detail, /attempts\/1-1\/attempt\.json other_runner/);
  assert.deepEqual(calls(t.log), [], "nothing ran");
});

test("an attempt or extra with no runner identity, or a malformed one, fails closed", { skip, timeout: 1_800_000 }, () => {
  for (const [label, plant] of [
    ["no pipeline", (t) => presetAttempt(t.out, "1-1", null)],
    ["a null hash", (t) => presetAttempt(t.out, "1-1", { runner_version: RUNNER.version, runner_files_sha256: null })],
    ["a malformed hash", (t) => presetAttempt(t.out, "1-1", { runner_version: RUNNER.version, runner_files_sha256: "abc" })],
    [
      "an extra as the exporter wrote it before (runner fields null)",
      (t) => {
        mkdirSync(join(t.out, "extras"), { recursive: true });
        writeFileSync(join(t.out, "extras", "migration.json"), JSON.stringify({ schema: "t3cp/extras/1", pipeline: { runner_version: null, runner_files_sha256: null } }));
      },
    ],
  ]) {
    const t = setup({ suite: { levels: [1, 50], attempts_per_level: 1, empty_cell: false } });
    plant(t);
    const result = runRunner(t);
    assert.equal(result.status, 3, `${label}: ${result.stderr}`);
    assert.equal(failureOf(t.out).reason, "foreign_attempts", label);
    assert.deepEqual(calls(t.log), [], `${label}: nothing ran`);
  }
});

test("work this runner made is reused: its attempt is skipped and its extra kept", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1, 50], attempts_per_level: 1, empty_cell: false } });
  presetAttempt(t.out, "1-1");
  mkdirSync(join(t.out, "extras"), { recursive: true });
  writeFileSync(join(t.out, "extras", "migration.json"), JSON.stringify({ schema: "t3cp/extras/1", pipeline: ownPipeline }));
  const result = runRunner(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(t.log), ["50-1"], "only the attempt it did not have");
  assert.deepEqual(JSON.parse(readFileSync(join(t.out, "attempts", "1-1", "attempt.json"), "utf8")).preset, "1-1");
});

// A record never outlives its deadline (T3CP_RECORD_DEADLINE, absolute epoch seconds, set by the VM launcher): at the
// deadline its work stops and it fails record_timeout (not retryable, exit 5), a measured outcome, never a silent loss.
// On a VM (T3CP_VM or T3CP_BUCKET set) a missing or malformed deadline fails closed before anything runs.
const epochS = () => Math.floor(Date.now() / 1000);

test("a record still running at its deadline stops its work and fails record_timeout, leaving nothing running", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1, 50], attempts_per_level: 1, empty_cell: false } });
  const decoy = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  try {
    const deadline = epochS() + 8;
    const result = runRunner(t, { env: { ...t.env, STUB_HANG_CELL: "1-1", STUB_HANG_MAX_MS: "600000", T3CP_RECORD_DEADLINE: String(deadline) }, timeout: 120_000 });
    assert.equal(result.status, 5, `status ${result.status}: ${result.stderr}`);
    const failure = failureOf(t.out);
    assert.equal(failure.reason, "record_timeout");
    assert.equal(failure.retryable, false);
    assert.equal(failure.deadline_epoch_s, deadline);
    assert.ok(Number.isInteger(failure.elapsed_s) && failure.elapsed_s >= 0, JSON.stringify(failure));
    assert.ok(alive(decoy.pid), "the decoy's group was left alone");
    assert.deepEqual(carrying(t), [], "the hung attempt is stopped");
  } finally {
    process.kill(decoy.pid, "SIGKILL");
  }
});

test("a deadline already past runs nothing: record_timeout at once", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  const result = runRunner(t, { env: { ...t.env, T3CP_VM: "a-test-vm", T3CP_RECORD_DEADLINE: String(epochS() - 1) }, timeout: 120_000 });
  assert.equal(result.status, 5, result.stderr);
  assert.equal(failureOf(t.out).reason, "record_timeout");
  assert.deepEqual(calls(t.log), []);
});

test("on a VM a missing deadline fails closed with deadline_missing, and a malformed one with deadline_invalid", { skip, timeout: 1_800_000 }, () => {
  for (const [label, env, reason] of [
    ["T3CP_VM, no deadline", { T3CP_VM: "a-test-vm" }, "deadline_missing"],
    ["T3CP_BUCKET, no deadline", { T3CP_BUCKET: "a-test-bucket" }, "deadline_missing"],
    ["not a whole number", { T3CP_VM: "a-test-vm", T3CP_RECORD_DEADLINE: "soon" }, "deadline_invalid"],
    ["not a whole number, off a VM too", { T3CP_RECORD_DEADLINE: "12.5" }, "deadline_invalid"],
  ]) {
    const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
    const result = runRunner(t, { env: { ...t.env, ...env }, timeout: 120_000 });
    assert.equal(result.status, 3, `${label}: ${result.stderr}`);
    assert.equal(failureOf(t.out).reason, reason, label);
    assert.equal(failureOf(t.out).retryable, false, label);
    assert.deepEqual(calls(t.log), [], `${label}: nothing ran`);
  }
});

test("off a VM (development, tests) a record may run without a deadline, and says so", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  const result = runRunner(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(t.work, "runner.log"), "utf8"), /no record deadline/);
});

test("a runner killed outright leaves no deadline watchdog that could signal whatever later holds its pid", { skip, timeout: 1_800_000 }, async () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  const deadline = epochS() + 12;
  const first = startRunner(t, { ...t.env, STUB_HANG_CELL: "1-1", STUB_HANG_MAX_MS: "600000", T3CP_RECORD_DEADLINE: String(deadline) });
  const pidFile = join(t.work, "pids", "watchdog.pid");
  assert.ok(await eventually(() => existsSync(pidFile) && /^\d+$/.test(readFileSync(pidFile, "utf8").trim()), 60_000), "the watchdog runs");
  const watchdog = Number(readFileSync(pidFile, "utf8").trim());
  const exited = new Promise((resolve) => first.on("exit", resolve));
  first.kill("SIGKILL");
  await exited;
  // Its parent is gone: it leaves at once, well before the deadline, so no USR1 is ever sent.
  assert.ok(await eventually(() => !alive(watchdog), 5_000), "the watchdog outlived its runner");
  assert.ok(epochS() < deadline, "checked before the deadline");
});

test("a deadline during a hung hook stops that hook before the failure is handed on", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1, 50], attempts_per_level: 1, empty_cell: false } });
  const hook = join(t.root, "hung-hook.sh");
  const started = join(t.root, "hook-started");
  // A shell that stays (sleep is not its last word), carrying the test's root, so it is found if it outlives the run.
  writeFileSync(hook, `#!/bin/sh\n: > '${started}'\nexec sh -c 'sleep 600; :' hung-hook '${t.root}'\n`);
  chmodSync(hook, 0o755);
  // Long enough for the attempt before it, so the deadline falls while the hook hangs.
  const env = { ...t.env, T3CP_ON_ATTEMPT: hook, T3CP_HOOK_TIMEOUT_S: "600", T3CP_RECORD_DEADLINE: String(epochS() + 40) };
  const result = runRunner(t, { env, timeout: 150_000 });
  assert.equal(result.status, 5, `status ${result.status}: ${result.stderr}`);
  assert.ok(existsSync(started), "the deadline fell during the hook");
  assert.equal(failureOf(t.out).reason, "record_timeout");
  assert.deepEqual(carrying(t), [], "the hung hook is stopped with the record");
});

test("a deadline during a long foreground step (an export) is handled at once, and the step is stopped", { skip, timeout: 1_800_000 }, () => {
  const t = setup({ suite: { levels: [1], attempts_per_level: 1, empty_cell: false } });
  // Long enough for the attempt before it, so the deadline falls while the export hangs.
  const env = { ...t.env, STUB_EXPORT_HANG: "1", T3CP_RECORD_DEADLINE: String(epochS() + 40) };
  const result = runRunner(t, { env, timeout: 150_000 });
  assert.equal(result.status, 5, `status ${result.status}: ${result.stderr}`);
  assert.ok(existsSync(`${t.log}.export-started`), "the deadline fell during the export");
  assert.equal(failureOf(t.out).reason, "record_timeout");
  assert.deepEqual(carrying(t), [], "the export is stopped with the record");
});

// Scenario records (a catalogue row, id@version): the row's cells and attempts in place of the ladder, the row's
// load and windows, the row's post step, no record extras, and the record's workload naming the scenario.
const TEST_CATALOGUE = {
  schema: "t3cp/scenarios/1",
  rows: [
    {
      id: "test-turn-start",
      version: 1,
      status: "active",
      added: "2026-11-18",
      harness: "t3cp-harness/2.0.2",
      platforms: ["linux-x64", "darwin-arm64"],
      fixture: "none",
      attempts: 2,
      metrics: ["turn_start_history_gap_ms"],
      cells: [{ name: "lt", mode: "history", sessions: 1, subscribers: 0, pollers: 0, turn_gap: "20s", warmup_s: 30, window_s: 600, seed_compacted_at: true, post: "turn-start-gap" }],
    },
    {
      id: "test-compaction",
      version: 1,
      status: "active",
      added: "2026-11-18",
      harness: "t3cp-harness/2.0.2",
      platforms: ["linux-x64", "darwin-arm64"],
      fixture: "none",
      attempts: 1,
      metrics: ["event_log_unpruned_days"],
      cells: [{ name: "cmp", mode: "fresh", sessions: 1, subscribers: 1, pollers: 0, turn_gap: "5s", warmup_s: 60, window_s: 300, seed_compacted_at: false, post: "prune-mark" }],
    },
    {
      id: "test-compaction-era",
      version: 1,
      status: "active",
      added: "2026-11-19",
      harness: "t3cp-harness/2.0.2",
      platforms: ["linux-x64", "darwin-arm64"],
      fixture: "large-76",
      attempts: 1,
      metrics: ["event_log_unpruned_days"],
      cells: [{ name: "cmp", mode: "fresh", sessions: 1, subscribers: 1, pollers: 0, turn_gap: "5s", warmup_s: 60, window_s: 300, seed_compacted_at: false, post: "prune-mark", mark_age_days: 3 }],
    },
  ],
};
/** A scenario record's setup: the row's suite and a catalogue holding the test rows (T3CP_SCENARIOS). */
function scenarioSetup(ref, { fixture = false } = {}) {
  const [id, version] = ref.split("@");
  const t = setup({ fixture, scenarioSuite: { id: ref, scenario: { id, version: Number(version) } } });
  const catalogue = join(t.root, "scenarios.json");
  writeFileSync(catalogue, JSON.stringify(TEST_CATALOGUE));
  t.env = { ...t.env, T3CP_SCENARIOS: catalogue };
  return t;
}
const runsOf = (t) => readFileSync(t.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
/** run.ts's arguments with the record's own paths and times as placeholders. */
const shapeOf = (args) => {
  const out = [...args];
  for (const flag of ["--ref", "--archive", "--settings", "--out", "--work", "--now"]) {
    const i = out.indexOf(flag);
    if (i >= 0) out[i + 1] = `<${flag.slice(2)}>`;
  }
  return out;
};
const SERVER_ENV = [
  "--server-env", "T3CODE_TELEMETRY_ENABLED=false", "--server-env", "T3CODE_LOG_LEVEL=Warn",
  "--server-env", "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false", "--server-env", "NODE_OPTIONS=--max-old-space-size=8192",
];
const DRIVER_STD = ["--call-timeout", "300s", "--stall-timeout", "600s", "--max-error-rate", "0.2", "--setup-concurrency", "16"].map((a) => `--driver-arg=${a}`);

test("a scenario spec naming a row the pinned catalogue does not have is refused before any attempt", { skip, timeout: 1_800_000 }, () => {
  const t = scenarioSetup("no-such-scenario@1");
  const result = runRunner(t);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(failureOf(t.out).reason, "scenario_unknown");
  assert.deepEqual(calls(t.log), []);
});

test("a scenario row's cells become exactly these run.ts arguments, round after round, with no record extras", { skip, timeout: 1_800_000 }, () => {
  const lt = scenarioSetup("test-turn-start@1");
  const ltResult = runRunner(lt, { env: { ...lt.env, T3CP_KEEP_RAW: "1" } });
  assert.equal(ltResult.status, 0, ltResult.stderr);
  assert.deepEqual(calls(lt.log), ["lt-1", "lt-2"], "the row's attempts, and no extras run");
  // The stub logs run.ts's own arguments (process.argv.slice(2)): everything after the script's path.
  assert.deepEqual(shapeOf(runsOf(lt)[0].args), [
    "--ref", "<ref>", "--archive", "<archive>", "--fixture", "none",
    "--settings", "<settings>", "--out", "<out>", "--work", "<work>", "--runs", "1", "--retries", "2",
    "--warmup", "30s", "--window", "600s", "--sessions", "1", "--subscribers", "0",
    "--now", "<now>", "--seed-compacted-at", "--otlp-interval-ms", "1000", "--startup-timeout", "900s", "--keep-runs",
    ...SERVER_ENV, "--driver-arg=--seed", "--driver-arg=1",
    "--driver-arg=--mode", "--driver-arg=history", "--driver-arg=--turn-gap", "--driver-arg=20s", "--driver-arg=--pollers", "--driver-arg=0", ...DRIVER_STD,
  ]);
  assert.ok(!existsSync(join(lt.out, "extras")) || readdirSync(join(lt.out, "extras")).length === 0, "no record extras");
  const cmp = scenarioSetup("test-compaction@1");
  assert.equal(runRunner(cmp, { env: { ...cmp.env, T3CP_KEEP_RAW: "1" } }).status, 0);
  const cmpArgs = shapeOf(runsOf(cmp)[0].args);
  assert.ok(!cmpArgs.includes("--seed-compacted-at"), "the compaction row starts with no fresh compaction marker");
  assert.deepEqual(cmpArgs.slice(cmpArgs.indexOf("--warmup"), cmpArgs.indexOf("--now")), ["--warmup", "60s", "--window", "300s", "--sessions", "1", "--subscribers", "1"]);
});

test("a turn-start row writes its raw scenario file from the run's trace and loop samples, and names the scenario", { skip, timeout: 1_800_000 }, () => {
  const t = scenarioSetup("test-turn-start@1");
  const result = runRunner(t, { env: { ...t.env, T3CP_KEEP_RAW: "1", STUB_SCENARIO: "turn-start" } });
  assert.equal(result.status, 0, result.stderr);
  const raw = JSON.parse(readFileSync(join(t.work, "raw", "lt-1", "scenario.json"), "utf8"));
  // One raw file, every metric of the step: the longest block and the starts' median (nine of 20 ms, one of 400 ms).
  assert.deepEqual(
    { schema: raw.schema, scenario: raw.scenario, post: raw.post, metrics: raw.metrics, starts: raw.detail.starts_completed },
    {
      schema: "t3cp/scenario-raw/1",
      scenario: { id: "test-turn-start", version: 1 },
      post: "turn-start-gap",
      metrics: { turn_start_history_gap_ms: { value: 4321, reason: null }, turn_start_long_thread_ms: { value: 20, reason: null } },
      starts: 10,
    },
  );
  assert.ok(!("value" in raw) && !("metric" in raw), "values live under metrics only");
  const meta = JSON.parse(readFileSync(join(t.work, "raw", "lt-1", "attempt-meta.json"), "utf8"));
  assert.deepEqual(meta.scenario, { id: "test-turn-start", version: 1 });
  assert.notEqual(meta.maintenance_expected, true);
});

test("a compaction row reads the prune mark from the kept run's database, read-only, and expects maintenance", { skip, timeout: 1_800_000 }, () => {
  const t = scenarioSetup("test-compaction@1");
  const db = join(t.root, "template.sqlite");
  const mark = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const made = spawnSync("python3", ["-I", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2]); c.execute(sys.argv[3], (sys.argv[4],)); c.commit(); c.close()", db,
    "CREATE TABLE orchestration_v2_projection_metadata (projection_name TEXT PRIMARY KEY, schema_version INTEGER, last_sequence INTEGER, updated_at TEXT)",
    "INSERT INTO orchestration_v2_projection_metadata VALUES ('event-log-prune-mark', 2, 151, ?)", mark], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const result = runRunner(t, { env: { ...t.env, T3CP_KEEP_RAW: "1", STUB_DB_TEMPLATE: db } });
  assert.equal(result.status, 0, result.stderr);
  const raw = JSON.parse(readFileSync(join(t.work, "raw", "cmp-1", "scenario.json"), "utf8"));
  assert.deepEqual(raw.metrics, { event_log_unpruned_days: { value: 2, reason: null } });
  assert.equal(raw.detail.mark_updated_at, mark);
  const meta = JSON.parse(readFileSync(join(t.work, "raw", "cmp-1", "attempt-meta.json"), "utf8"));
  assert.equal(meta.maintenance_expected, true);
});

test("a compaction row's prune mark is re-dated on the migrated fixture before each try, so a backfill reads the row's age, not the fixture's", { skip, timeout: 1_800_000 }, () => {
  const t = scenarioSetup("test-compaction-era@1", { fixture: true });
  const spec = JSON.parse(readFileSync(join(t.root, "spec.json"), "utf8"));
  // The release has migrated the era fixture already (a restart finds it): its prune mark is 30 days old.
  const migrated = join(t.work, "fixture", "base", "userdata", "statev2.sqlite");
  mkdirSync(dirname(migrated), { recursive: true });
  const stale = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const made = spawnSync("python3", ["-I", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2]); c.execute(sys.argv[3], (sys.argv[4],)); c.commit(); c.close()", migrated,
    "CREATE TABLE orchestration_v2_projection_metadata (projection_name TEXT PRIMARY KEY, schema_version INTEGER, last_sequence INTEGER, updated_at TEXT)",
    "INSERT INTO orchestration_v2_projection_metadata VALUES ('event-log-prune-mark', 2, 151, ?)", stale], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  writeFileSync(join(t.work, "fixture.done"), `${spec.fixture.sha256} ${spec.release.archive_sha256}\n`);
  const fixtureBefore = createHash("sha256").update(readFileSync(spec.fixture.path)).digest("hex");
  const before = Date.now();
  const result = runRunner(t, { env: { ...t.env, T3CP_KEEP_RAW: "1", STUB_DB_FROM_FIXTURE: "1" } });
  const after = Date.now();
  assert.equal(result.status, 0, result.stderr);
  const raw = JSON.parse(readFileSync(join(t.work, "raw", "cmp-1", "scenario.json"), "utf8"));
  assert.deepEqual(raw.metrics, { event_log_unpruned_days: { value: 2, reason: null } });
  const mark = Date.parse(raw.detail.mark_updated_at);
  assert.ok(mark >= before - 3 * 86_400_000 && mark <= after - 3 * 86_400_000, `mark ${raw.detail.mark_updated_at} is 3 days before the try`);
  assert.equal(createHash("sha256").update(readFileSync(spec.fixture.path)).digest("hex"), fixtureBefore, "the spec's fixture is never written");
  assert.match(readFileSync(join(t.work, "runner.log"), "utf8"), /cmp-1 try 1: prune mark set 3 days before the try/);
});

// Last in the file: tests run in order, and each one's end has run by now.
test("no process any test in this file started is still running", { skip, timeout: 1_800_000 }, () => {
  for (const t of everyTest) assert.deepEqual(carrying(t), [], t.root);
});

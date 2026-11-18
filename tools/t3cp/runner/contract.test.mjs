// The runner/exporter contract: run-record.sh writes a complete raw attempt directory (its own attempt-meta.json,
// through a stub run.ts that leaves the harness's files as data's synthetic writer makes them), and the REAL
// exporter (tools/t3cp/export.mjs) must accept it; the same directory with one field the exporter's schema refuses
// must be refused. A change on either side that breaks the pair fails here, in CI, before it reaches a VM.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { hex } from "../lib/fake.mjs";
import { fakeSpec } from "../lib/fake-raw.mjs";
import { STUB_PRELUDE, owner, runInGroup, stubEnv, teardown } from "./stub-procs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const t3cp = join(here, "..");
const platform =
  process.platform === "linux" && process.arch === "x64"
    ? "linux-x64"
    : process.platform === "darwin" && process.arch === "arm64"
      ? "darwin-arm64"
      : null;
const skip = platform === null ? `no record platform for ${process.platform}-${process.arch}` : false;
const root = mkdtempSync(join(tmpdir(), "t3cp-contract-"));
// The runner runs in a process group of its own; the file's end stops whatever of it is left, then removes root.
const procs = owner(root, join(root, "work"));
after(() => teardown(procs));

const [major, minor] = process.versions.node.split(".").map(Number);
const needsStripFlag = !(major > 23 || (major === 23 && minor >= 6));

// run.ts stand-in: the harness's output for one attempt, from data's synthetic writer (fake-raw.mjs).
const STUB_RUN = `import * as path from "node:path";
import * as fs from "node:fs";
${STUB_PRELUDE}const { writeRawAttempt } = await import(process.env.CONTRACT_FAKE_RAW);
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
const [cell, n] = path.basename(out).split("-");
const spec = JSON.parse(fs.readFileSync(process.env.CONTRACT_SPEC, "utf8"));
writeRawAttempt(path.dirname(out), { cell, n: Number(n), spec });
`;
const STUB_RELEASE = `import * as fs from "node:fs";
import * as path from "node:path";
const args = process.argv.slice(2);
const dir = path.join(args[args.indexOf("--dest") + 1], "t3-stub");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "t3"), "");
fs.writeFileSync(path.join(dir, "release.json"), "{}");
`;
// The runner's own exporter call is replaced by one that succeeds: the test runs the real exporter itself, after
// pinning the machine-dependent host facts (os, kernel) to a publishable runner's, so CI's own OS does not decide.
const PASS_EXPORTER = `import * as fs from "node:fs";
const a = process.argv.slice(2); fs.mkdirSync(a[a.indexOf("--out") + 1], { recursive: true });
if (a[0] !== "--extras") fs.writeFileSync(a[a.indexOf("--out") + 1] + "/attempt.json", "{}");
`;

function runnerAttempt() {
  const harness = join(root, "harness");
  mkdirSync(join(harness, "tools", "server-bench", "preload"), { recursive: true });
  writeFileSync(join(harness, "tools", "server-bench", "run.ts"), STUB_RUN);
  writeFileSync(join(harness, "tools", "server-bench", "release.ts"), STUB_RELEASE);
  writeFileSync(join(harness, "tools", "server-bench", "preload", "bench-preload.cjs"), "// stub\n");
  // The identity the synthetic result.json carries (data's writer), so attempt-meta and result agree.
  // 2.0.0: the first harness whose run.ts takes --archive, the oldest the runner accepts.
  writeFileSync(join(harness, "t3cp-harness.json"), JSON.stringify({ version: "t3cp-harness/2.0.0", sha: hex("harness", 40), files_sha256: hex("harness-files") }));
  writeFileSync(join(harness, "settings.json"), "{}\n");
  writeFileSync(join(root, "export-pass.mjs"), PASS_EXPORTER);
  const archive = join(root, `t3-0.1.10-nightly.20261115.4749-${platform}.tar.gz`);
  writeFileSync(archive, "stub archive\n");
  const spec = fakeSpec({
    record_id: `2026-11-15.${platform}.nightly`,
    release: {
      archive_name: `t3-0.1.10-nightly.20261115.4749-${platform}.tar.gz`,
      archive_sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
      archive_path: archive,
    },
    suite: { id: "val-contract", profile: "real3", levels: [100], attempts_per_level: 1, empty_cell: false, warmup_s: 60, window_s: 300, extras: false },
    host: { machine: "n2d-standard-16", provisioning: "spot" },
    cpu_model: "AMD EPYC 7B13",
  });
  spec.fixture = { id: "none" };
  const specFile = join(root, "spec.json");
  writeFileSync(specFile, JSON.stringify(spec));
  const cpuinfo = join(root, "cpuinfo");
  writeFileSync(cpuinfo, "model name\t: AMD EPYC 7B13\n");
  const env = {
    ...process.env,
    CONTRACT_FAKE_RAW: join(t3cp, "lib", "fake-raw.mjs"),
    CONTRACT_SPEC: specFile,
    T3CP_EXPORTER: join(root, "export-pass.mjs"),
    T3CP_PROC_CPUINFO: cpuinfo,
    T3CP_PIN: "0",
    T3CP_KEEP_RAW: "1",
    T3CP_HEARTBEAT_S: "30",
    T3CP_GUARD_FOREIGN_PCT: "100",
    T3CP_GUARD_STEAL_PCT: "100",
    T3CP_PRIVATE_PATTERNS: join(root, "private.txt"),
    ...stubEnv(procs),
  };
  if (needsStripFlag) {
    const node = join(root, "node");
    writeFileSync(node, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types --no-warnings "$@"\n`);
    chmodSync(node, 0o755);
    env.T3CP_NODE = node;
  }
  writeFileSync(join(root, "private.txt"), "a-pattern-no-attempt-contains-[0-9]{9}\n");
  const work = join(root, "work");
  const result = runInGroup(procs, "bash", [join(t3cp, "run-record.sh"), "--spec", specFile, "--out", join(root, "out"), "--harness", harness, "--work", work, "--settings", join(harness, "settings.json")], { env, encoding: "utf8", timeout: 900_000, killSignal: "SIGKILL" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const raw = join(work, "raw", "100-1");
  assert.ok(existsSync(join(raw, "attempt-meta.json")), "the runner wrote attempt-meta.json");
  // A publishable runner's machine facts; everything else is exactly what the runner wrote.
  const meta = JSON.parse(readFileSync(join(raw, "attempt-meta.json"), "utf8"));
  meta.host.os = "Debian 13";
  meta.host.kernel = "6.12.48+deb13-cloud-amd64";
  writeFileSync(join(raw, "attempt-meta.json"), JSON.stringify(meta, null, 1));
  return { raw, specFile };
}

/** The runner's attempt, made once for every test here. */
let made;
const runnerAttemptOnce = () => (made ??= runnerAttempt());

/** A copy of the runner's raw attempt with attempt-meta edited. */
function editedCopy(raw, name, edit) {
  const copy = join(root, name, "100-1");
  cpSync(raw, copy, { recursive: true });
  const meta = JSON.parse(readFileSync(join(copy, "attempt-meta.json"), "utf8"));
  edit(meta);
  writeFileSync(join(copy, "attempt-meta.json"), JSON.stringify(meta, null, 1));
  return copy;
}

function exportAttempt(raw, specFile, out) {
  const patterns = join(root, "private.txt");
  writeFileSync(patterns, "a-pattern-no-attempt-contains-[0-9]{9}\n");
  return spawnSync(process.execPath, [join(t3cp, "export.mjs"), raw, "--out", out, "--spec", specFile], {
    env: { ...process.env, T3CP_PRIVATE_PATTERNS: patterns },
    encoding: "utf8",
    timeout: 900_000,
    killSignal: "SIGKILL",
  });
}

test("the real exporter accepts the attempt directory the runner writes, and refuses a broken attempt-meta field", { skip, timeout: 1_800_000 }, () => {
  const { raw, specFile } = runnerAttemptOnce();
  const ok = exportAttempt(raw, specFile, join(root, "export-ok", "100-1"));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const attempt = JSON.parse(readFileSync(join(root, "export-ok", "100-1", "attempt.json"), "utf8"));
  assert.equal(attempt.schema, "t3cp/attempt/1");
  assert.equal(attempt.cell, "100");

  const broken = [
    ["valid_run as a run directory name", (m) => (m.valid_run = "attempt-1")],
    ["a host-guard method outside the exporter's form", (m) => (m.host_guard.method = "proc_stat_cgroup")],
    ["an unknown attempt-meta key", (m) => (m.surprise = true)],
  ];
  for (const [i, [what, edit]] of broken.entries()) {
    const copy = editedCopy(raw, `broken-${i}`, edit);
    const refused = exportAttempt(copy, specFile, join(root, `out-broken-${i}`, "100-1"));
    assert.equal(refused.status, 2, `${what}: ${refused.stdout}${refused.stderr}`);
  }
});

test("the runner writes maintenance_in_window; the real exporter accepts every value the runner can write and refuses any other", { skip, timeout: 1_800_000 }, () => {
  const { raw, specFile } = runnerAttemptOnce();
  // The stub release's server binary has no compaction marker in it.
  const written = JSON.parse(readFileSync(join(raw, "attempt-meta.json"), "utf8"));
  assert.equal(written.maintenance_in_window, "unscheduled_pre_marker");
  const values = [
    [0, true],
    [2, true],
    ["unscheduled_pre_marker", true],
    ["unobserved_no_span", true],
    [null, true],
    [-1, false],
    [1.5, false],
    ["other", false],
  ];
  for (const [i, [value, accepted]] of values.entries()) {
    const copy = editedCopy(raw, `maintenance-${i}`, (m) => (m.maintenance_in_window = value));
    const result = exportAttempt(copy, specFile, join(root, `out-maintenance-${i}`, "100-1"));
    assert.equal(result.status, accepted ? 0 : 2, `maintenance_in_window ${JSON.stringify(value)}: ${result.stdout}${result.stderr}`);
  }
});

test("an attempt whose host guard could not judge is published invalid with host_guard_unavailable", { skip, timeout: 1_800_000 }, () => {
  const { raw, specFile } = runnerAttemptOnce();
  // The runner's own attempt here had no host guard to read (a stub harness): it wrote contaminated null.
  const written = JSON.parse(readFileSync(join(raw, "attempt-meta.json"), "utf8"));
  assert.equal(written.contaminated, null);
  const result = exportAttempt(raw, specFile, join(root, "out-guard-null", "100-1"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const attempt = JSON.parse(readFileSync(join(root, "out-guard-null", "100-1", "attempt.json"), "utf8"));
  assert.equal(attempt.attempt.valid, false);
  assert.ok(attempt.attempt.problems.includes("host_guard_unavailable"), JSON.stringify(attempt.attempt.problems));
  // A guard that judged the host clean publishes valid.
  const clean = editedCopy(raw, "guard-clean", (m) => {
    m.contaminated = false;
    m.host_guard = { ...m.host_guard, method: "proc-stat-cgroup", samples: 300, foreign_pct_mean: 0.1, steal_pct_mean: 0 };
    m.contamination_reasons = [];
  });
  const ok = exportAttempt(clean, specFile, join(root, "out-guard-clean", "100-1"));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(!JSON.parse(readFileSync(join(root, "out-guard-clean", "100-1", "attempt.json"), "utf8")).attempt.problems.includes("host_guard_unavailable"));
});

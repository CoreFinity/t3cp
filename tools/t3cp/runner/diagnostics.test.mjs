// Diagnostics of a failed or invalid attempt (or a failed runner): bounded tails of the logs that say why, scrubbed,
// for the private bucket only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { attemptDiagnostics, attemptReasons, runnerDiagnostics, scrubber, tailText } from "./diagnostics.mjs";

const root = mkdtempSync(join(tmpdir(), "t3cp-diagnostics-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("a tail is the end of the file, cut at a line start, never longer than asked", () => {
  const file = join(root, "long.log");
  writeFileSync(file, Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const t = tailText(file, 100);
  assert.ok(Buffer.byteLength(t.text) <= 100);
  assert.ok(t.text.startsWith("line "), t.text.slice(0, 20));
  assert.ok(t.text.endsWith("line 999\n"));
  assert.equal(t.truncated, true);
  assert.ok(t.bytes > 100);
  const short = join(root, "short.log");
  writeFileSync(short, "only\n");
  assert.deepEqual(tailText(short, 100), { bytes: 5, truncated: false, text: "only\n" });
  assert.equal(tailText(join(root, "missing.log"), 100), null);
});

test("scrubbing removes private patterns, the host name and secret shapes", () => {
  const scrub = scrubber({ patterns: [/secret-vm-[0-9]+/giu], hostname: "build-host-7.test" });
  const text = [
    "connected to secret-vm-42 from build-host-7.test",
    "token=abc123 password: hunter2 Authorization: Bearer eyJhbGciOi",
    `key ${"ghp_"}${"A".repeat(30)} end`,
  ].join("\n");
  const out = scrub(text);
  assert.ok(!out.includes("secret-vm-42") && out.includes("[private]"), out);
  assert.ok(!out.includes("build-host-7") && out.includes("[host]"), out);
  assert.ok(!out.includes("abc123") && !out.includes("hunter2") && !out.includes("eyJhbGciOi"), out);
  assert.ok(!out.includes("A".repeat(30)) && out.includes("[secret]"), out);
});

/** A raw attempt dir: run.ts runs 1..n with run.json, driver.log and server.log, plus run.log and attempt-meta.json. */
function failedRaw(name, { runs = 3, logLines = 50 } = {}) {
  const raw = join(root, name);
  for (let k = 1; k <= runs; k++) {
    const run = join(raw, "work", "runs", "release", `attempt-${k}`);
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "run.json"), JSON.stringify({ valid: false, problems: ["driver_failed"], driver: { failure_code: "sessions_starved", error: `run ${k}: 31 of 50 sessions served` } }));
    writeFileSync(join(run, "driver.log"), Array.from({ length: logLines }, (_, i) => `[driver] step ${i}`).join("\n") + `\n[driver] fatal: exit cause ${k}\n`);
    writeFileSync(join(run, "server.log"), Array.from({ length: logLines }, (_, i) => `[server] warn ${i}`).join("\n") + "\n");
  }
  writeFileSync(join(raw, "run.log"), "release attempt 1: INVALID (driver_failed)\n");
  // attempt-meta as merge-tries writes it: valid_run names the run whose window was used (the last when none was valid).
  const meta = { record_id: "2026-11-15.linux-x64.nightly", cell: "50", n: 1, run_ts_exit: 1, valid_run: runs, contaminated: false, maintenance_in_window: null, tries: [{ window: { valid: false, run: runs } }] };
  writeFileSync(join(raw, "attempt-meta.json"), JSON.stringify(meta));
  return { raw, meta };
}

test("an attempt is diagnosed when run.ts failed, no run was valid, or the export was refused; a clean one is not", () => {
  // Whether a run was valid is the last try's window (valid_run names a run even when none was valid).
  const tries = (valid) => [{ window: { valid, run: 3 } }];
  assert.deepEqual(attemptReasons({ run_ts_exit: 1, valid_run: 3, tries: tries(false) }, 0), ["run_ts_exit_1", "no_valid_run"]);
  assert.deepEqual(attemptReasons({ run_ts_exit: 0, valid_run: null, tries: [] }, 0), ["no_valid_run"]);
  assert.deepEqual(attemptReasons({ run_ts_exit: 0, valid_run: 1, tries: tries(true) }, 2), ["export_refused"]);
  assert.deepEqual(attemptReasons({ run_ts_exit: 0, valid_run: 1, tries: tries(true) }, 0), []);
});

test("an attempt's diagnostics carry every run's problems and driver detail and the log tails, scrubbed", () => {
  const { raw, meta } = failedRaw("raw-failed");
  const d = attemptDiagnostics(raw, meta, { reasons: ["run_ts_exit_1", "no_valid_run"], scrub: scrubber({ patterns: [], hostname: "h0st.test" }), tailBytes: 4096 });
  assert.equal(d.schema, "t3cp/diagnostics/1");
  assert.equal(d.kind, "attempt");
  assert.deepEqual([d.record_id, d.cell, d.n], ["2026-11-15.linux-x64.nightly", "50", 1]);
  assert.deepEqual(d.reasons, ["run_ts_exit_1", "no_valid_run"]);
  assert.deepEqual(d.runs.map((r) => r.run), [1, 2, 3]);
  assert.deepEqual(d.runs[2].problems, ["driver_failed"]);
  assert.equal(d.runs[2].driver.failure_code, "sessions_starved");
  assert.ok(d.runs[2].logs["driver.log"].text.includes("fatal: exit cause 3"));
  assert.ok(d.runs[2].logs["server.log"].text.includes("[server] warn 49"));
  assert.ok(d.logs["run.log"].text.includes("INVALID (driver_failed)"));
});

test("an attempt's diagnostics stay under the size cap, however long its logs are", () => {
  const { raw, meta } = failedRaw("raw-huge", { runs: 3, logLines: 200_000 });
  const d = attemptDiagnostics(raw, meta, { reasons: ["run_ts_exit_1"], scrub: scrubber({ patterns: [], hostname: "h0st.test" }), tailBytes: 65_536, totalBytes: 100_000 });
  assert.ok(Buffer.byteLength(JSON.stringify(d)) <= 100_000, String(Buffer.byteLength(JSON.stringify(d))));
  assert.equal(d.truncated, true);
  // The end of each driver log, where a failure says why, survives the cut.
  for (const r of d.runs) assert.ok(r.logs["driver.log"].text.includes(`fatal: exit cause ${r.run}`), `run ${r.run}`);
});

test("a runner failure's diagnostics carry the reason, the detail and the runner log's tail, scrubbed", () => {
  const work = join(root, "work-failed");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "runner.log"), "[t] record r: ...\n[t] FAILED migration_failed: on host h0st.test\n");
  mkdirSync(join(work, "fixture"), { recursive: true });
  writeFileSync(join(work, "fixture", "server.log"), "migrate: server exited 1\n");
  const d = runnerDiagnostics(work, { record_id: "r", reason: "migration_failed", detail: "server exited" }, { scrub: scrubber({ patterns: [], hostname: "h0st.test" }) });
  assert.equal(d.kind, "runner");
  assert.deepEqual(d.reasons, ["migration_failed"]);
  assert.equal(d.detail, "server exited");
  assert.ok(d.logs["runner.log"].text.includes("FAILED migration_failed: on host [host]"));
  assert.ok(d.logs["fixture/server.log"].text.includes("server exited 1"), "the migration server's own log");
});

test("an attempt's diagnostics carry the harness's driver_failure and stop records, and problems in either form", () => {
  const { raw, meta } = failedRaw("raw-harness-2", { runs: 1 });
  const run = join(raw, "work", "runs", "release", "attempt-1", "run.json");
  writeFileSync(run, JSON.stringify({
    valid: false,
    problems: [{ code: "driver_failed", kind: "defect" }],
    driver_failure: { phase: "post_window", code: "distribution_mismatch", reason: "p50 ratio 1.531", exit_code: 1, signal: null, result_file: "driver/driver.json" },
    server: { exit_before_stop: { code: null, signal: null }, stop: { forced: false, signal_to_exit_ms: 812, exited_before_stop: false } },
  }));
  const d = attemptDiagnostics(raw, meta, { reasons: ["run_ts_exit_1"], scrub: scrubber({ patterns: [], hostname: "h0st.test" }) });
  assert.deepEqual(d.runs[0].problems, [{ code: "driver_failed", kind: "defect" }]);
  assert.equal(d.runs[0].driver_failure.code, "distribution_mismatch");
  assert.equal(d.runs[0].driver_failure.phase, "post_window");
  assert.equal(d.runs[0].server.stop.signal_to_exit_ms, 812);
});

test("scrubbing removes whole token bodies, not just their prefixes", () => {
  const scrub = scrubber({ patterns: [], hostname: "h0st.test" });
  // Built at run time, so this file itself carries no secret-shaped literal.
  const bodies = [["ya29", "q".repeat(24)].join("."), ["xox", "b-", "w".repeat(24)].join(""), "z".repeat(40)];
  const keyLine = (edge) => `-----${edge} ${["PRIVATE", "KEY"].join(" ")}-----`;
  const text = [
    `google ${bodies[0]} end`,
    `slack ${bodies[1]} end`,
    keyLine("BEGIN"),
    bodies[2],
    keyLine("END"),
    "after the key",
  ].join("\n");
  const out = scrub(text);
  for (const body of bodies) assert.ok(!out.includes(body.slice(6)), `${body} gone: ${out}`);
  assert.ok(out.includes("after the key"), out);
});

test("a secret inside a JSON string is scrubbed without losing the bundle", () => {
  const { raw, meta } = failedRaw("raw-json-secret", { runs: 1 });
  writeFileSync(join(raw, "work", "runs", "release", "attempt-1", "run.json"), JSON.stringify({ valid: false, problems: ["driver_failed"], driver: { failure_code: "x", error: 'login failed password=hunter2 "quoted" token: abc123' } }));
  const d = attemptDiagnostics(raw, meta, { reasons: ["run_ts_exit_1"], scrub: scrubber({ patterns: [], hostname: "h0st.test" }) });
  assert.equal(d.runs[0].driver.failure_code, "x");
  assert.ok(!d.runs[0].driver.error.includes("hunter2") && !d.runs[0].driver.error.includes("abc123"), d.runs[0].driver.error);
  assert.ok(d.runs[0].driver.error.startsWith("login failed"), d.runs[0].driver.error);
});

test("attempts invalidated by contamination, an unavailable guard or maintenance are diagnosed too", () => {
  const ok = { run_ts_exit: 0, valid_run: 1, tries: [{ window: { valid: true, run: 1 } }] };
  assert.deepEqual(attemptReasons({ ...ok, contaminated: true }, 0), ["contaminated"]);
  assert.deepEqual(attemptReasons({ ...ok, contaminated: null }, 0), ["host_guard_unavailable"]);
  assert.deepEqual(attemptReasons({ ...ok, contaminated: false, maintenance_in_window: 2 }, 0), ["maintenance_in_window"]);
  assert.deepEqual(attemptReasons({ ...ok, contaminated: false, maintenance_in_window: null }, 0), ["maintenance_unverified"]);
  assert.deepEqual(attemptReasons({ ...ok, contaminated: false, maintenance_in_window: "unscheduled_pre_marker" }, 0), []);
  assert.deepEqual(attemptReasons({ ...ok, contaminated: false, maintenance_in_window: 0 }, 0), []);
});

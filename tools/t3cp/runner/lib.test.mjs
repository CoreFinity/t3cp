// The runner's JSON side: the interleaved order, the spec schema and the host guard's verdict.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { attemptOrder, guardSummary, typedObject, validate } from "./lib.mjs";

const schema = JSON.parse(readFileSync(new URL("../../../schema/record-spec-1.json", import.meta.url), "utf8"));
const spec = () => ({
  schema: "t3cp/record-spec/1",
  record_id: "2026-11-15.linux-x64.nightly",
  kind: "nightly",
  release: {
    tag: "v0.1.10-nightly.20261115.4749",
    sha: "a".repeat(40),
    version: "0.1.10-nightly.20261115.4749",
    archive_name: "t3-0.1.10-nightly.20261115.4749-linux-x64.tar.gz",
    archive_sha256: "b".repeat(64),
    archive_path: "/x/t3.tar.gz",
  },
  fixture: { id: "large-76", path: "/x/large-76.sqlite", sha256: "c".repeat(64), migration: 76 },
  suite: { id: "ladder-1", profile: "real3", levels: [1, 50, 100, 150, 200, 250], attempts_per_level: 3, empty_cell: true, warmup_s: 60, window_s: 300 },
  now: "2026-11-16T00:00:00Z",
  seed: "1",
});

test("the published suite interleaves levels and the empty cell, 21 attempts", () => {
  const order = attemptOrder(spec().suite).map((a) => a.cell);
  assert.equal(order.length, 21);
  assert.deepEqual(order.slice(0, 8), ["1-1", "50-1", "100-1", "150-1", "200-1", "250-1", "1e-1", "1-2"]);
  assert.equal(order.at(-1), "1e-3");
});

test("the spec schema accepts a nightly and refuses what it should", () => {
  assert.deepEqual(validate(spec(), schema), []);
  const none = spec();
  none.fixture = { id: "none" };
  assert.deepEqual(validate(none, schema), []);
  const extra = spec();
  extra.region = "x";
  assert.ok(validate(extra, schema).some((e) => e.includes("unknown key region")));
  const badSha = spec();
  badSha.release.archive_sha256 = "XYZ";
  assert.ok(validate(badSha, schema).length > 0);
  const fork = spec();
  fork.kind = "fork";
  fork.record_id = "0.1.9-perf.8.linux-x64.fork";
  assert.ok(validate(fork, schema).some((e) => e.includes("missing base")));
  fork.base = { tag: "v0.1.10-nightly.20261114.4709", date: "2026-11-14", sha: "d".repeat(40) };
  fork.release.date = "2026-11-15";
  fork.release.tag = "v0.1.9-perf.8";
  fork.release.version = "0.1.9-perf.8";
  fork.release.archive_name = "t3-0.1.9-perf.8-linux-x64.tar.gz";
  assert.deepEqual(validate(fork, schema), []);
  const base = spec();
  base.kind = "base";
  base.record_id = "295a0a7332aa.linux-x64.base";
  base.release.tag = "v0.1.10";
  base.release.version = "0.1.10";
  base.release.archive_name = "t3-0.1.10-linux-x64.tar.gz";
  assert.ok(validate(base, schema).some((e) => e.includes("missing date")));
  base.release.date = "2026-11-14";
  assert.deepEqual(validate(base, schema), []);
  const mixed = spec();
  mixed.kind = "base";
  mixed.release.date = "2026-11-15";
  assert.ok(validate(mixed, schema).some((e) => e.includes("record_id")), "a base spec with a nightly record id");
});

test("new files never replace an existing one", async (t) => {
  const { mkdtempSync, readdirSync, readFileSync: read, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeNew, newest } = await import("./lib.mjs");
  const dir = mkdtempSync(join(tmpdir(), "t3cp-new-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = Array.from({ length: 5 }, (_, i) => writeNew(dir, { i }));
  assert.equal(new Set(files).size, 5);
  assert.equal(readdirSync(dir).length, 5);
  assert.deepEqual(JSON.parse(read(newest(dir), "utf8")), { i: 4 });
});

const rows = (foreign, steal = 0, t0 = 1000) => [
  { meta: { cgroup: true } },
  ...foreign.map((f, i) => ({ t: t0 + i * 1000, busy_pct: 60 + f, steal_pct: steal, iowait_pct: 0.1, own_pct: 60, foreign_pct: f })),
];

test("the host guard passes a quiet window and flags foreign CPU or steal", () => {
  const quiet = guardSummary(rows([0.2, 0.4, 0.3]), 500, 2600);
  assert.equal(quiet.contaminated, false);
  assert.equal(quiet.host_guard.samples, 3);
  assert.equal(quiet.host_guard.busy_pct_max, 60.4);
  const busy = guardSummary(rows([25, 26, 24]), 500, 2600);
  assert.equal(busy.contaminated, true);
  assert.deepEqual(busy.contamination_reasons, ["foreign_cpu"]);
  const steal = guardSummary(rows([0.1, 0.1], 5), 500, 1600);
  assert.deepEqual(steal.contamination_reasons, ["steal"]);
});

test("samples outside the window do not count", () => {
  const r = rows([50, 0.1, 0.1, 50]);
  const inside = guardSummary(r, 1500, 3000);
  assert.equal(inside.contaminated, false);
  assert.equal(inside.host_guard.samples, 2);
});

test("a guard that could not judge fails closed: contaminated is null, never false", () => {
  const none = guardSummary([], null, null);
  assert.equal(none.contaminated, null);
  assert.deepEqual(none.contamination_reasons, []);
  assert.deepEqual(none.notes, ["host_guard_unavailable"]);
  assert.equal(none.host_guard.busy_pct_max, null);
  // Samples, but none in the window.
  const outside = guardSummary(rows([0.1, 0.1]), 10_000, 20_000);
  assert.equal(outside.contaminated, null);
  // In the window, but without a cgroup: no foreign CPU can be told apart from the runner's own.
  const plain = guardSummary([{ meta: { cgroup: false } }, { t: 1000, busy_pct: 1, steal_pct: 0, iowait_pct: 0, own_pct: null, foreign_pct: null }], 0, 2000);
  assert.equal(plain.contaminated, null);
  assert.deepEqual(plain.notes, ["host_guard_unavailable"]);
  // Judged: false, and no note.
  const quiet = guardSummary(rows([0.2]), 500, 1600);
  assert.equal(quiet.contaminated, false);
  assert.deepEqual(quiet.notes, []);
});

test("typed pairs build nested objects and refuse non-numbers", () => {
  assert.deepEqual(typedObject(["s:a.b=x", "i:a.c=3", "f:d=1.5e0", "b:e=true", "n:f=", "j:g=[1]"]), {
    a: { b: "x", c: 3 },
    d: 1.5,
    e: true,
    f: null,
    g: [1],
  });
  assert.throws(() => typedObject(["i:a=x"]));
});

test("the spec takes a built release's source repository and build script hash", () => {
  const built = spec();
  built.release.build = { source_repo: "github.com/navidnadali/t3code", script_sha256: "f".repeat(64) };
  assert.deepEqual(validate(built, schema), []);
  built.release.build.source_repo = "github.com/someone/else";
  assert.ok(validate(built, schema).length > 0);
});

test("the host guard names its method in the exporter's form (lower case, digits, hyphens)", () => {
  const form = /^[a-z][a-z0-9-]{0,31}$/;
  const cgroup = guardSummary([{ meta: { cgroup: true } }, { t: 1000, busy_pct: 1, steal_pct: 0, iowait_pct: 0, own_pct: 1, foreign_pct: 0 }], 0, 2000);
  const plain = guardSummary([{ meta: { cgroup: false } }, { t: 1000, busy_pct: 1, steal_pct: 0, iowait_pct: 0, own_pct: null, foreign_pct: null }], 0, 2000);
  const none = guardSummary([], null, null);
  for (const g of [cgroup, plain, none]) assert.match(g.host_guard.method, form);
});

test("the valid run is the run.ts attempt number, an integer, in the window and in try.json", async (ctx) => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync: read, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { attemptWindow } = await import("./lib.mjs");
  const raw = mkdtempSync(join(tmpdir(), "t3cp-window-"));
  ctx.after(() => rmSync(raw, { recursive: true, force: true }));
  for (const [k, valid] of [[1, false], [2, true], [3, false]]) {
    const dir = join(raw, "work", "runs", "release", `attempt-${k}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify({ valid, window: { start: "2026-11-16T00:00:00Z", end: "2026-11-16T00:05:00Z" } }));
  }
  assert.equal(attemptWindow(raw).run, 2);
  const lib = new URL("./lib.mjs", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [lib, "finish-try", raw, "1", "a", "b", "1000", "0"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const t = JSON.parse(read(join(raw, "try.json"), "utf8"));
  assert.equal(t.valid_run, 2);
  assert.equal(t.window.run, 2);
});

test("a heartbeat is named for the moment its state was read, so a late write of an older state never sorts last", async (t) => {
  const { mkdtempSync, readFileSync: read, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { newest } = await import("./lib.mjs");
  const out = mkdtempSync(join(tmpdir(), "t3cp-hb-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const lib = new URL("./lib.mjs", import.meta.url).pathname;
  const beat = (state, atMs) =>
    spawnSync(process.execPath, [lib, "heartbeat", out, "-", "r", "1", state, "-", "21", String(atMs)], { encoding: "utf8" });
  // The loop read "exporting" first but its write lands after the runner's final "done".
  assert.equal(beat("done", 1_800_000_002_000).status, 0);
  assert.equal(beat("exporting", 1_800_000_001_000).status, 0);
  assert.equal(JSON.parse(read(newest(join(out, "heartbeats")), "utf8")).state, "done");
});

test("a version is at least the minimum only with the same name and a version not below it", async () => {
  const { versionAtLeast } = await import("./lib.mjs");
  assert.equal(versionAtLeast("t3cp-harness/2.0.0", "t3cp-harness/2.0.0"), true);
  assert.equal(versionAtLeast("t3cp-harness/2.0.10", "t3cp-harness/2.0.9"), true);
  assert.equal(versionAtLeast("t3cp-harness/10.0.0", "t3cp-harness/2.0.0"), true);
  assert.equal(versionAtLeast("t3cp-harness/1.9.9", "t3cp-harness/2.0.0"), false);
  assert.equal(versionAtLeast("other/3.0.0", "t3cp-harness/2.0.0"), false);
  assert.equal(versionAtLeast("t3cp-harness/2.0", "t3cp-harness/2.0.0"), false);
  assert.equal(versionAtLeast(undefined, "t3cp-harness/2.0.0"), false);
});

test("stamp-runner gives an exported extra this runner's identity where the exporter left it null, and keeps the rest", async () => {
  const { mkdtempSync, writeFileSync, readFileSync: read, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "t3cp-stamp-"));
  try {
    const lib = new URL("./lib.mjs", import.meta.url).pathname;
    const runner = join(dir, "runner.json");
    writeFileSync(runner, JSON.stringify({ version: "t3cp-runner/1.0.0", files_sha256: "a".repeat(64) }));
    const doc = join(dir, "migration.json");
    const pipeline = { exported_at: "2026-11-17T00:00:00Z", exporter_version: "1.0.0", exporter_files_sha256: "b".repeat(64), runner_version: null, runner_files_sha256: null };
    writeFileSync(doc, JSON.stringify({ schema: "t3cp/extras/1", record_id: "x", fixture: null, empty: null, migration: null, pipeline }));
    const r = spawnSync(process.execPath, [lib, "stamp-runner", doc, runner], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const stamped = JSON.parse(read(doc, "utf8"));
    assert.deepEqual(stamped.pipeline, { ...pipeline, runner_version: "t3cp-runner/1.0.0", runner_files_sha256: "a".repeat(64) });
    assert.equal(stamped.record_id, "x");
    // A doc that already names another runner is not restamped: refused, unchanged.
    writeFileSync(doc, JSON.stringify({ schema: "t3cp/extras/1", pipeline: { ...pipeline, runner_version: "t3cp-runner/1.0.0", runner_files_sha256: "c".repeat(64) } }));
    const again = spawnSync(process.execPath, [lib, "stamp-runner", doc, runner], { encoding: "utf8" });
    assert.notEqual(again.status, 0);
    assert.equal(JSON.parse(read(doc, "utf8")).pipeline.runner_files_sha256, "c".repeat(64));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The record extras carry WHY a value is missing, publicly, where the runner gave a public reason: extra_timeout (the
// extra ran out of its time budget, or was never started for lack of it) and no_setup_span (the release writes no
// database setup span, so it cannot give db_ready). A stat carries the reason only when every one of its values is
// null; with both reasons among its starts, no_setup_span wins (the release cannot give the value at all). The
// runner's other codes (server_exited, not_reached_within_budget, no_fixture, ...) stay internal: no reason. When
// startup.json says timed_out, a planned start pair with no row at all (the runner stopped startup.mjs) is published
// as null stats with extra_timeout, so the timeout shows instead of the metrics disappearing. Inputs are hand-made
// synthetic raw extras (tools/t3cp/lib/fake-raw.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exportExtras } from "./export.mjs";
import { fakeSpec, writeRawExtras } from "./lib/fake-raw.mjs";
import { STAT_REASONS } from "./lib/schemas.mjs";
import { loadSchema } from "./lib/repo.mjs";
import { validate } from "./lib/validate.mjs";

const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function extrasOf(edit, spec = fakeSpec()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-extras-reasons-"));
  temps.push(root);
  const docs = exportExtras(writeRawExtras(path.join(root, "raw"), edit), spec, { privatePatterns: [] });
  for (const [name, doc] of Object.entries(docs)) assert.deepEqual(validate(loadSchema("extras-1.json"), doc), [], name);
  return docs;
}
/** Sets one mark of the starts of one fixture and phase: values per n (null = missing) and reasons per n. */
function setStarts(files, fixture, phase, mark, values, reasons = []) {
  for (const s of files.startup.starts.filter((x) => x.fixture === fixture && x.phase === phase)) {
    s[`${mark}_ms`] = values[s.n - 1];
    if (reasons[s.n - 1] !== undefined) s.reasons[`${mark}_ms`] = reasons[s.n - 1];
  }
}
const STARTUP_IDS = ["listening_first_ms", "listening_warm_ms", "accept_first_ms", "accept_warm_ms", "db_ready_first_ms", "db_ready_warm_ms"];
const NULL3 = (reason) => ({ median: null, min: null, max: null, n: 0, values: [null, null, null], ...(reason ? { reason } : {}) });

test("the public stat reasons include extra_timeout and no_setup_span", () => {
  assert.ok(STAT_REASONS.includes("extra_timeout"));
  assert.ok(STAT_REASONS.includes("no_setup_span"));
  for (const internal of ["server_exited", "not_reached_within_budget", "no_fixture", "record_timeout"]) assert.ok(!STAT_REASONS.includes(internal), internal);
});

test("startup: every value null with no_setup_span gives the stat that reason, on the era and the empty part", () => {
  const docs = extrasOf((f) => {
    setStarts(f, "era", "cold", "db_ready", [null, null, null], ["no_setup_span", "no_setup_span", "no_setup_span"]);
    setStarts(f, "empty", "warm", "db_ready", [null, null, null], ["no_setup_span", "no_setup_span", "no_setup_span"]);
  });
  assert.deepEqual(docs.startup.fixture.metrics.db_ready_first_ms, NULL3("no_setup_span"));
  assert.deepEqual(docs.startup.empty.metrics.db_ready_warm_ms, NULL3("no_setup_span"));
  // The marks that were reached keep their values and carry no reason.
  assert.equal(docs.startup.fixture.metrics.listening_first_ms.reason, undefined);
  assert.equal(docs.startup.fixture.metrics.listening_first_ms.n, 3);
});

test("startup: no_setup_span wins over extra_timeout among the starts of one stat", () => {
  const docs = extrasOf((f) => setStarts(f, "era", "warm", "db_ready", [null, null, null], ["extra_timeout", "no_setup_span", "extra_timeout"]));
  assert.equal(docs.startup.fixture.metrics.db_ready_warm_ms.reason, "no_setup_span");
  const only = extrasOf((f) => setStarts(f, "era", "warm", "accept", [null, null, null], ["extra_timeout", "extra_timeout", "not_reached_within_budget"]));
  assert.equal(only.startup.fixture.metrics.accept_warm_ms.reason, "extra_timeout");
});

test("startup: internal codes alone give no reason; a stat with any value carries none", () => {
  const internal = extrasOf((f) => setStarts(f, "empty", "cold", "listening", [null, null, null], ["server_exited", "not_reached_within_budget", "server_exited"]));
  assert.deepEqual(internal.startup.empty.metrics.listening_first_ms, NULL3(null));
  const some = extrasOf((f) => setStarts(f, "era", "cold", "accept", [6010, null, null], [undefined, "extra_timeout", "extra_timeout"]));
  const s = some.startup.fixture.metrics.accept_first_ms;
  assert.equal(s.n, 1);
  assert.equal(s.median, 6010);
  assert.equal(s.reason, undefined);
});

test("startup timed_out: a planned pair with no start row is published null with extra_timeout; the rows that exist keep their values", () => {
  // The runner stopped startup.mjs after the era cold starts: only those rows exist.
  const docs = extrasOf((f) => {
    f.startup.starts = f.startup.starts.filter((s) => s.fixture === "era" && s.phase === "cold");
    f.startup.timed_out = true;
  });
  const fx = docs.startup.fixture.metrics;
  const em = docs.startup.empty.metrics;
  assert.equal(fx.listening_first_ms.n, 3, "era cold measured");
  assert.equal(fx.listening_first_ms.reason, undefined);
  for (const id of ["listening_warm_ms", "accept_warm_ms", "db_ready_warm_ms"]) assert.deepEqual(fx[id], { median: null, min: null, max: null, n: 0, values: [], reason: "extra_timeout" }, `era ${id}`);
  for (const id of STARTUP_IDS) assert.deepEqual(em[id], { median: null, min: null, max: null, n: 0, values: [], reason: "extra_timeout" }, `empty ${id}`);
});

test("startup timed_out with no start at all: every planned pair is null with extra_timeout; with no era fixture only the empty part", () => {
  const docs = extrasOf((f) => {
    f.startup.starts = [];
    f.startup.summary = {};
    f.startup.timed_out = true;
  });
  for (const part of ["fixture", "empty"]) for (const id of STARTUP_IDS) assert.equal(docs.startup[part].metrics[id].reason, "extra_timeout", `${part} ${id}`);
  const spec = fakeSpec();
  spec.fixture = { ...spec.fixture, id: "none" };
  const none = extrasOf((f) => {
    f.startup.starts = [];
    f.startup.timed_out = true;
  }, spec);
  assert.equal(none.startup.fixture, null, "no era fixture planned");
  for (const id of STARTUP_IDS) assert.equal(none.startup.empty.metrics[id].reason, "extra_timeout", id);
});

test("startup without timed_out: a missing pair stays absent, as before", () => {
  const docs = extrasOf((f) => (f.startup.starts = f.startup.starts.filter((s) => s.fixture === "era")));
  assert.equal(docs.startup.empty, null);
  assert.equal(docs.startup.fixture.metrics.db_ready_warm_ms.n, 3);
});

test("snapshot and first turn: extra_timeout reaches every null metric of the file; no_fixture and other codes give none", () => {
  const timed = extrasOf((f) => {
    f.snapshot = { ...f.snapshot, ms: null, wire_bytes: null, body_bytes: null, status: null, reasons: { ms: "extra_timeout" }, timed_out: true };
    f.first_turn = { ...f.first_turn, ms: null, reasons: { ms: "extra_timeout" }, timed_out: true };
  });
  assert.deepEqual(timed.snapshot.fixture.metrics.snapshot_full_get_ms, { median: null, min: null, max: null, n: 0, values: [null], reason: "extra_timeout" });
  assert.deepEqual(timed.snapshot.fixture.metrics.snapshot_full_get_bytes, { median: null, min: null, max: null, n: 0, values: [null], reason: "extra_timeout" });
  assert.equal(timed.first_turn.fixture.metrics.first_turn_after_start_ms.reason, "extra_timeout");
  const noFixture = extrasOf((f) => {
    f.snapshot = { ...f.snapshot, ms: null, wire_bytes: null, body_bytes: null, reasons: { ms: "no_fixture" }, timed_out: true };
  });
  assert.equal(noFixture.snapshot.fixture.metrics.snapshot_full_get_ms.reason, undefined, "no_fixture takes precedence and is internal");
  assert.equal(noFixture.snapshot.fixture.metrics.snapshot_full_get_bytes.reason, undefined);
  // fake-raw's first turn: ms null with an internal code.
  assert.equal(extrasOf().first_turn.fixture.metrics.first_turn_after_start_ms.reason, undefined);
  // A measured snapshot carries no reason even when the run timed out later.
  const measured = extrasOf((f) => (f.snapshot = { ...f.snapshot, timed_out: true, reasons: {} }));
  assert.equal(measured.snapshot.fixture.metrics.snapshot_full_get_ms.reason, undefined);
});

test("malformed reasons or timed_out are refused (fail closed)", () => {
  assert.throws(() => extrasOf((f) => (f.startup.starts[0].reasons = "extra_timeout")), /reasons/);
  assert.throws(() => extrasOf((f) => (f.startup.starts[0].reasons = { db_ready_ms: 7 })), /reasons/);
  assert.throws(() => extrasOf((f) => (f.startup.timed_out = false)), /timed_out/);
  assert.throws(() => extrasOf((f) => (f.snapshot.reasons = ["extra_timeout"])), /reasons/);
  assert.throws(() => extrasOf((f) => (f.first_turn.timed_out = "yes")), /timed_out/);
});

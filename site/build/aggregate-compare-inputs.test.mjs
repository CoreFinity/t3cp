// The compare page judges two records with the aggregator's own rule inputs, so it keeps no policy of its own
// (final review M4): index.json's catalogue publishes, per metric, capability() per platform and level ({threshold,
// note}) and the gate_exempt and throughput flags; records-index.json publishes per record and level the validity
// gates' result ("pass", "client" or "fail"), next to segment and banded. Inputs are hand-made synthetic records.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildOutputs, levelsFor } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from "../../tools/t3cp/lib/fake.mjs";
import { loadCatalogue, loadSchema } from "../../tools/t3cp/lib/repo.mjs";
import { validate } from "../../tools/t3cp/lib/validate.mjs";
import { PLATFORM_IDS } from "../../tools/t3cp/lib/schemas.mjs";

const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function nightly(date) {
  const identity = fakeIdentity({ date });
  const attempts = fakeAttempts(catalogue, identity, { jitter: 0 });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
}
const HEADLINE_BANDS = Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }]));
// turn_p50_ms: a per-level override at 250; turn_p95_ms: a client band of 45 % (context only); elu: 3.4 %.
const BANDS = {
  schema: "t3cp/bands/1",
  method: "test bands",
  platforms: {
    "linux-x64": {
      measured: { from: "2026-11-01", to: "2026-11-02", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" },
      metrics: { ...HEADLINE_BANDS, turn_p50_ms: { band: 10, n: 6, levels: { 250: { band: 20, n: 6 } } }, turn_p95_ms: { band: 45, n: 6 }, elu: { band: 3.4, n: 6 } },
    },
    "darwin-arm64": { pending: true },
  },
};
function writeTree(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-ci-"));
  temps.push(dir);
  for (const r of records) {
    const file = path.join(dir, "records", r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(dir, "bands.json"), `${JSON.stringify(BANDS, null, 2)}\n`);
  return dir;
}
const read = (files, rel) => JSON.parse(files.get(rel).toString("utf8"));
const byId = (index) => Object.fromEntries(index.catalogue.map((m) => [m.id, m]));

test("index.json: every catalogue entry carries cap for every platform at exactly its levels, and validates", () => {
  const files = buildOutputs(writeTree([nightly("2026-11-01"), nightly("2026-11-02")]), { publicRefs: FAKE_PUBLIC_REFS });
  const index = read(files, "index.json");
  assert.deepEqual(validate(loadSchema("index-1.json"), index), []);
  const meta = new Map(catalogue.metrics.map((m) => [m.id, m]));
  for (const entry of index.catalogue) {
    assert.deepEqual(Object.keys(entry.cap), PLATFORM_IDS, `${entry.id}: every platform`);
    for (const p of PLATFORM_IDS) {
      assert.deepEqual(Object.keys(entry.cap[p]), levelsFor(meta.get(entry.id)), `${entry.id} on ${p}: exactly its levels`);
      for (const c of Object.values(entry.cap[p])) assert.deepEqual(Object.keys(c), ["threshold", "note"]);
    }
  }
});

test("index.json cap is capability(): per-level bands, wide client bands, context, counters, missing and pending bands", () => {
  const files = buildOutputs(writeTree([nightly("2026-11-01"), nightly("2026-11-02")]), { publicRefs: FAKE_PUBLIC_REFS });
  const m = byId(read(files, "index.json"));
  const L = m.turn_p50_ms.cap["linux-x64"];
  assert.deepEqual(L["100"], { threshold: 15, note: null }, "the metric-wide band, plus 5 points");
  assert.deepEqual(L["250"], { threshold: 25, note: null }, "the level's own band overrides it");
  assert.deepEqual(m.turn_p95_ms.cap["linux-x64"]["100"], { threshold: 50, note: "wide_band" }, "a client band of 40 % or more is context only");
  assert.deepEqual(m.elu.cap["linux-x64"]["100"], { threshold: 8.4, note: null });
  assert.deepEqual(m.push_p95_ms.cap["linux-x64"]["100"].note, "context");
  assert.deepEqual(m.client_errors.cap["linux-x64"]["100"], { threshold: null, note: null }, "a counter needs no band");
  assert.deepEqual(m.server_warn_lines.cap["darwin-arm64"]["100"], { threshold: null, note: null }, "on a pending platform too");
  assert.deepEqual(m.eld_p99_ms.cap["linux-x64"]["100"], { threshold: null, note: "no_band" }, "no band measured");
  assert.deepEqual(m.turn_p50_ms.cap["darwin-arm64"]["100"], { threshold: null, note: "no_band" }, "a pending platform has no band");
  assert.deepEqual(m.db_ready_warm_ms.cap["linux-x64"], { once: { threshold: 15, note: null }, "1e": { threshold: 15, note: null } }, "a once-per-record metric at once and 1e");
});

test("index.json: gate_exempt is exactly the client-call gate's own metrics, throughput exactly the saturated level's measures", () => {
  const files = buildOutputs(writeTree([nightly("2026-11-01")]), { publicRefs: FAKE_PUBLIC_REFS });
  const index = read(files, "index.json");
  assert.deepEqual(index.catalogue.filter((m) => m.gate_exempt === true).map((m) => m.id).sort(), ["client_errors", "client_unfinished"]);
  assert.deepEqual(index.catalogue.filter((m) => m.throughput === true).map((m) => m.id).sort(), ["agents_served", "turns_completed"]);
  for (const m of index.catalogue) {
    assert.equal(typeof m.gate_exempt, "boolean", m.id);
    assert.equal(typeof m.throughput, "boolean", m.id);
  }
});

const gatesOf = (files, date) => read(files, "records-index.json").records.find((r) => r.date === date).platforms["linux-x64"].gates;

test("records-index.json gates: pass everywhere on a clean record, keyed like segment", () => {
  const files = buildOutputs(writeTree([nightly("2026-11-01")]), { publicRefs: FAKE_PUBLIC_REFS });
  const ri = read(files, "records-index.json");
  assert.deepEqual(validate(loadSchema("records-index-1.json"), ri), []);
  const entry = ri.records[0].platforms["linux-x64"];
  assert.deepEqual(Object.keys(entry.gates), Object.keys(entry.segment));
  assert.ok(Object.values(entry.gates).every((g) => g === "pass"));
});

test("records-index.json gates: client errors give client at that level, a contaminated valid attempt fail, a CPU pin mismatch fail everywhere", () => {
  const clientDay = nightly("2026-11-01");
  clientDay.cells["100"].metrics.client_errors = { median: 2, min: 1, max: 3, n: 3, values: [1, 2, 3] };
  const dirtyDay = nightly("2026-11-02");
  dirtyDay.cells["150"].attempts[0].contaminated = true;
  const pinDay = nightly("2026-11-03");
  pinDay.platform.cpu_model = "Apple M2"; // a valid model, not the platform's pinned one
  const files = buildOutputs(writeTree([clientDay, dirtyDay, pinDay]), { publicRefs: FAKE_PUBLIC_REFS });
  const c = gatesOf(files, "2026-11-01");
  assert.equal(c["100"], "client");
  assert.equal(c["50"], "pass");
  assert.equal(c.once, "pass");
  const d = gatesOf(files, "2026-11-02");
  assert.equal(d["150"], "fail");
  assert.equal(d["100"], "pass");
  const p = gatesOf(files, "2026-11-03");
  assert.ok(Object.values(p).every((g) => g === "fail"), "the pin gates every metric, once included");
  // The published result is the aggregator's own: on the client-errors day the exempt metrics keep a comparison,
  // every other metric there is gated (the day-over-day comparison into it).
  const cmp = read(files, `compare/${clientDay.release.tag}__${dirtyDay.release.tag}.linux-x64.json`);
  const row = (id, L) => cmp.rows.find((r) => r.metric === id && r.level === L);
  assert.equal(row("turns_completed", "100").note, "gated");
  assert.notEqual(row("client_errors", "100").note, "gated");
  assert.equal(row("turns_completed", "150").note, "gated", "contaminated on the other side");
  assert.equal(row("client_errors", "150").note, "gated", "contamination gates the exempt metrics too");
});

test("records-index.json: a record with an empty-server measurement but no 1e cell still publishes 1e (segment and gates)", () => {
  const r = nightly("2026-11-01");
  assert.ok(r.extras.empty, "the fake carries the empty-server part");
  delete r.cells["1e"];
  const files = buildOutputs(writeTree([r]), { publicRefs: FAKE_PUBLIC_REFS });
  const entry = read(files, "records-index.json").records[0].platforms["linux-x64"];
  assert.equal(typeof entry.segment["1e"], "number", "a once-per-record metric is compared at 1e");
  assert.equal(entry.gates["1e"], "fail", "no cell: a per-level metric there fails its gates");
  assert.equal(entry.gates.once, "pass", "a once-per-record metric reads once");
});

test("the schemas say the rule inputs' scope: nightly pairs; fork verdicts come through the aggregator's compare files", async () => {
  const { loadSchema: load } = await import("../../tools/t3cp/lib/repo.mjs");
  const cap = load("index-1.json").properties.catalogue.items.properties.cap.description ?? "";
  const ri = load("records-index-1.json");
  const gates = ri.properties.records.items.properties.platforms.properties["linux-x64"].properties.gates.description ?? "";
  for (const [name, d] of [["cap", cap], ["gates", gates]]) {
    assert.match(d, /nightl/, `${name}: names the nightlies`);
    assert.match(d, /compare files/, `${name}: names where fork verdicts come from`);
  }
});

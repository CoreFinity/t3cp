// Every field the exporter's and the merge's schemas define (attempt-1, extras-1, record-1) is produced by at least
// one positive output here, or sits on the reasoned exemption list below. A field class is a property path with every
// metric id collapsed to <metric> and every level to <level>, so a field counts once however many metrics or levels
// the schema enumerates under it. The positive outputs: the exporter CLI's attempts (valid, saturated, invalid, the
// empty-database cell, a fork and a base release) and extras, the synthetic kit's attempts and extras as
// synth-data.mjs marks them, and merged records (nightly, fork, base, a saturated cell, CPU per served agent with too
// few served levels, synthetic). Every input is hand-made synthetic data.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeSpec, harnessRun, writeRawAttempt, writeRawExtras } from "./lib/fake-raw.mjs";
import { FAKE_PUBLIC_REFS, fakeAttempts, fakeExtras, fakeIdentity } from "./lib/fake.mjs";
import { mergeRecord } from "./merge.mjs";
import { loadCatalogue, loadSchema } from "./lib/repo.mjs";
import { validate } from "./lib/validate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const GEN = "2026-11-15T18:00:00Z";

/**
 * Field classes no positive output carries, each with its reason. A class on this list must be defined by its schema
 * and must stay unproduced: the test fails on a stale entry as on an uncovered field.
 */
const EXEMPT = {
  "attempt-1.json": {
    "$.workload.cells": "never carried by an attempt; schema tightened after launch",
    "$.workload.cells.<level>": "never carried by an attempt; schema tightened after launch",
    "$.workload.cells.<level>.distribution_tolerance": "never carried by an attempt; schema tightened after launch",
    "$.workload.cells.<level>.fixture": "never carried by an attempt; schema tightened after launch",
    "$.workload.cells.<level>.mode": "never carried by an attempt; schema tightened after launch",
    "$.workload.cells.<level>.poll_interval_s": "never carried by an attempt; schema tightened after launch",
    "$.workload.cells.<level>.pollers": "never carried by an attempt; schema tightened after launch",
    "$.workload.cells.<level>.sessions": "never carried by an attempt; schema tightened after launch",
    "$.workload.cells.<level>.subscribers": "never carried by an attempt; schema tightened after launch",
    "$.workload.cells.<level>.switch_interval_s": "never carried by an attempt; schema tightened after launch",
    "$.workload.cells.<level>.turn_gap_s": "never carried by an attempt; schema tightened after launch",
    "$.profile.distribution_tolerance":
      "the driver's ratio tolerance from before the binomial distribution check: profiles.json carries none, so no current run sets it; schema tightened after launch",
  },
  "record-1.json": {
    "$.workload.cells.<level>.distribution_tolerance":
      "the driver's ratio tolerance from before the binomial distribution check: profiles.json carries none, so no current run sets it; schema tightened after launch",
  },
};

// ---------------------------------------------------------------------------------------------------------
// the positive outputs

function exportOne(cell, { edit, spec = fakeSpec() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-coverage-"));
  temps.push(root);
  spec = structuredClone(spec);
  spec.fixture.path = path.join(root, "fixture.sqlite");
  spec.release.archive_path = path.join(root, "archive.tar.gz");
  fs.writeFileSync(spec.fixture.path, Buffer.alloc(4096));
  fs.writeFileSync(spec.release.archive_path, Buffer.alloc(2048));
  const raw = writeRawAttempt(path.join(root, "raw"), { cell, n: 1, edit, spec });
  fs.writeFileSync(path.join(root, "spec.json"), JSON.stringify(spec));
  const out = path.join(root, "out");
  const r = spawnSync(process.execPath, [path.join(here, "export.mjs"), raw, "--out", out, "--spec", path.join(root, "spec.json"), "--no-private-patterns"], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(fs.readFileSync(path.join(out, "attempt.json"), "utf8"));
}

function exportExtras(edit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-coverage-extras-"));
  temps.push(root);
  const raw = writeRawExtras(path.join(root, "raw"), edit);
  fs.writeFileSync(path.join(root, "spec.json"), JSON.stringify(fakeSpec()));
  const out = path.join(root, "out");
  const r = spawnSync(process.execPath, [path.join(here, "export.mjs"), "--extras", raw, "--out", out, "--spec", path.join(root, "spec.json"), "--no-private-patterns"], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" } });
  assert.equal(r.status, 0, r.stderr);
  return fs.readdirSync(out).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(out, f), "utf8")));
}

const forkSpec = fakeSpec({
  record_id: "0.1.9-perf.8.linux-x64.fork",
  kind: "fork",
  release: { tag: "v0.1.9-perf.8", version: "0.1.9-perf.8", archive_name: "t3-0.1.9-perf.8-linux-x64.tar.gz", date: "2026-11-16" },
  base: { tag: "v0.1.10-nightly.20261115.4749", date: "2026-11-15", sha: "a".repeat(40) },
});

const headSpec = fakeSpec({
  record_id: "2026-11-17.linux-x64.fork",
  kind: "fork",
  release: { tag: "v0.1.9-perf.9", version: "0.1.9-perf.9", archive_name: "t3-0.1.9-perf.9-linux-x64.tar.gz", date: "2026-11-16" },
  base: { tag: "v0.1.10-nightly.20261115.4749", date: "2026-11-15", sha: "a".repeat(40) },
  paired_nightly: { tag: "v0.1.10-nightly.20261117.4800", date: "2026-11-17" },
  now: "2026-11-18T00:00:00Z",
});

/** A valid attempt as the exporter writes a saturated one (agents served below the cell's agents, turns not measured). */
function saturate(a, served) {
  a.attempt.saturated = true;
  a.attempt.saturated_by = ["sessions_starved"];
  a.attempt.problems = ["sessions_starved"];
  a.metrics.agents_served = served;
  a.metrics.turns_completed = null;
  a.attempt.metric_reasons = { turns_completed: "not_measured_saturated" };
}

function outputs() {
  const exported = [
    exportOne("100"),
    exportOne("250", { edit: harnessRun({ codes: ["sessions_starved"], elu: 0.99, served: 147, total: 250 }) }),
    exportOne("100", { edit: harnessRun({ codes: ["server_exited"] }) }),
    exportOne("1e"),
    exportOne("100", { spec: forkSpec }),
    // A nightly fork-head record's attempt: the latest release measured on night 2026-11-17, beside that nightly.
    exportOne("100", { spec: headSpec }),
  ];
  const extras = exportExtras();
  // Extras that timed out (the runner stopped startup after its era cold starts; the snapshot ran out of time) and a
  // release without the database setup span: stats with their public reasons, on both parts.
  const timedOut = exportExtras((f) => {
    f.startup.starts = f.startup.starts.filter((s) => s.fixture === "era" && s.phase === "cold");
    for (const s of f.startup.starts) {
      s.db_ready_ms = null;
      s.reasons.db_ready_ms = "no_setup_span";
    }
    f.startup.timed_out = true;
    f.snapshot = { ...f.snapshot, ms: null, wire_bytes: null, body_bytes: null, reasons: { ms: "extra_timeout" }, timed_out: true };
  });
  // The synthetic kit's attempts and extras as synth-data.mjs marks them (development data only).
  const nightly = fakeIdentity({ date: "2026-11-15" });
  const marked = fakeAttempts(catalogue, nightly).map((a) => ({ ...a, synthetic: true }));
  const markedExtras = { ...fakeExtras(catalogue, nightly), synthetic: true };
  const records = [];
  const merge = (attempts, extrasList = []) => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: extrasList, catalogue, generatedAt: GEN });
  for (const identity of [
    nightly,
    fakeIdentity({ date: "2026-11-16", kind: "fork", tag: "v0.1.9-perf.8", base: { tag: "v0.1.10-nightly.20261115.4749", date: "2026-11-15", sha: "a".repeat(40) } }),
    fakeIdentity({ date: "2026-11-14", kind: "base", sha: "b".repeat(40), tag: "v0.1.10" }),
  ]) {
    records.push(merge(fakeAttempts(catalogue, identity), [fakeExtras(catalogue, identity)]));
  }
  records.push(merge(marked, [markedExtras]));
  // A nightly fork-head record (paired_nightly).
  const head = fakeIdentity({ date: "2026-11-16", kind: "fork", tag: "v0.1.9-perf.9", base: { tag: "v0.1.10-nightly.20261115.4749", date: "2026-11-15", sha: "a".repeat(40) } });
  head.record_id = "2026-11-17.linux-x64.fork";
  head.paired_nightly = { tag: "v0.1.10-nightly.20261117.4800", date: "2026-11-17" };
  records.push(merge(fakeAttempts(catalogue, head), [fakeExtras(catalogue, head)]));
  // A saturated cell, and CPU per served agent with one served level (every level from 50 up serves 50).
  const sat = fakeAttempts(catalogue, nightly);
  for (const a of sat) if (a.cell === "250") saturate(a, 147);
  records.push(merge(sat, [fakeExtras(catalogue, nightly)]));
  const flat = fakeAttempts(catalogue, nightly);
  for (const a of flat) {
    if (a.cell === "1" || a.cell === "1e") continue;
    if (a.cell === "50") a.metrics.agents_served = 50;
    else saturate(a, 50);
  }
  records.push(merge(flat, [fakeExtras(catalogue, nightly)]));
  // A record whose extras carry their public reasons (no setup span, an extra that timed out on the empty part).
  const reasoned = fakeExtras(catalogue, nightly);
  reasoned.fixture.metrics.db_ready_first_ms = { median: null, min: null, max: null, n: 0, values: [null, null, null], reason: "no_setup_span" };
  reasoned.empty.metrics.db_ready_warm_ms = { median: null, min: null, max: null, n: 0, values: [], reason: "extra_timeout" };
  records.push(merge(fakeAttempts(catalogue, nightly), [reasoned]));
  return { attempts: [...exported, ...marked], extras: [...extras, ...timedOut, markedExtras], records };
}

// ---------------------------------------------------------------------------------------------------------
// field classes

/** Keywords that hold or shape fields the walker below does not follow: a schema using one is refused, not half-read. */
const UNHANDLED = ["allOf", "if", "then", "else", "patternProperties", "prefixItems", "dependentSchemas", "not"];

/** Property paths a schema defines: .key per property, [] per array, .* per map, refs resolved. */
function schemaPaths(schema) {
  const out = new Set();
  const defs = schema.$defs ?? {};
  const walk = (node, at, depth) => {
    if (!node || typeof node !== "object" || depth > 16) return;
    for (const k of UNHANDLED) if (node[k] !== undefined) throw new Error(`${at}: unhandled schema keyword ${k}`);
    if (node.additionalProperties && typeof node.additionalProperties === "object" && !node.propertyNames) throw new Error(`${at}: unhandled map without propertyNames`);
    if (node.$ref) return walk(defs[node.$ref.split("/").pop()], at, depth + 1);
    for (const alt of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) walk(alt, at, depth + 1);
    if (node.properties) {
      for (const [k, v] of Object.entries(node.properties)) {
        out.add(`${at}.${k}`);
        walk(v, `${at}.${k}`, depth + 1);
      }
    }
    if (node.propertyNames && node.additionalProperties && typeof node.additionalProperties === "object") {
      out.add(`${at}.*`);
      walk(node.additionalProperties, `${at}.*`, depth + 1);
    }
    if (node.items) walk(node.items, `${at}[]`, depth + 1);
  };
  walk(schema, "$", 0);
  return out;
}

/** The paths a document carries, read against its schema's paths (a map's key becomes *). */
function documentPaths(doc, defined) {
  const out = new Set();
  const walk = (v, at) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, `${at}[]`));
    if (v === null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      const p = defined.has(`${at}.${k}`) ? `${at}.${k}` : defined.has(`${at}.*`) ? `${at}.*` : `${at}.${k}`;
      out.add(p);
      walk(x, p);
    }
  };
  walk(doc, "$");
  return out;
}

const IDS = new Set(catalogue.metrics.map((m) => m.id));
const LEVELS = new Set(["1", "50", "100", "150", "200", "250", "1e", "once"]);
const fieldClass = (p) =>
  p
    .split(".")
    .map((seg) => {
      const base = seg.replace(/\[\]$/, "");
      const arr = seg.endsWith("[]") ? "[]" : "";
      return (IDS.has(base) ? "<metric>" : LEVELS.has(base) ? "<level>" : base) + arr;
    })
    .join(".");

test("the field walker refuses a schema keyword it does not handle, so a field it cannot see never passes unnoticed", () => {
  for (const [what, schema] of [
    ["allOf", { allOf: [{ type: "object", properties: { a: { type: "string" } } }] }],
    ["if/then/else", { type: "object", if: { properties: { a: { const: 1 } } }, then: { properties: { b: { type: "string" } } } }],
    ["patternProperties", { type: "object", patternProperties: { "^x": { type: "string" } } }],
    ["prefixItems", { type: "array", prefixItems: [{ type: "string" }] }],
    ["dependentSchemas", { type: "object", dependentSchemas: { a: { properties: { b: { type: "string" } } } } }],
    ["not", { not: { type: "string" } }],
    ["a map without propertyNames", { type: "object", additionalProperties: { type: "string" } }],
  ]) {
    assert.throws(() => schemaPaths(schema), /unhandled/, what);
  }
});

const built = outputs();

for (const [name, docs] of [
  ["attempt-1.json", built.attempts],
  ["extras-1.json", built.extras],
  ["record-1.json", built.records],
]) {
  test(`${name}: every field class is produced by a positive output or exempted with its reason`, () => {
    const schema = loadSchema(name);
    for (const d of docs) assert.deepEqual(validate(schema, d), [], `${name}: every positive output validates`);
    const paths = schemaPaths(schema);
    const defined = new Set([...paths].map(fieldClass));
    const produced = new Set(docs.flatMap((d) => [...documentPaths(d, paths)].map(fieldClass)));
    const exempt = EXEMPT[name] ?? {};
    const uncovered = [...defined].filter((c) => !produced.has(c) && !(c in exempt)).sort();
    assert.deepEqual(uncovered, [], `${name}: produced by no positive output and not exempted`);
    for (const [c, reason] of Object.entries(exempt)) {
      assert.ok(reason.length > 0, `${name}: ${c} has a reason`);
      assert.ok(defined.has(c), `${name}: the exemption ${c} names no field of the schema (stale)`);
      assert.ok(!produced.has(c), `${name}: ${c} is produced now; drop its exemption`);
    }
  });
}

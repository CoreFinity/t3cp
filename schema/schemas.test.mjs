// data's schemas are generated from tools/t3cp/lib/schemas.mjs, the site-output fields of
// tools/t3cp/lib/schemas-site.mjs and the catalogue; the committed files must match.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { buildSchemas, serialise } from "../tools/t3cp/lib/schemas.mjs";
import { buildAllSchemas, SITE_EXTENDED } from "../tools/t3cp/lib/schemas-site.mjs";
import { EXPORTER_FILES } from "../tools/t3cp/export.mjs";
import { validate } from "../tools/t3cp/lib/validate.mjs";

const read = (name) => fs.readFileSync(new URL(name, import.meta.url), "utf8");
const catalogue = JSON.parse(read("../catalogue/catalogue.json"));
const built = buildAllSchemas(catalogue);

test("schemas: the site-output fields live outside the VM's exporter closure and touch only the site-output schemas", () => {
  assert.ok(!EXPORTER_FILES.includes("tools/t3cp/lib/schemas-site.mjs"), "the VM never runs it, so its changes move no image pin");
  assert.deepEqual(SITE_EXTENDED, ["index-1.json", "records-index-1.json", "series-1.json", "compare-1.json"]);
  const base = buildSchemas(catalogue);
  assert.deepEqual(Object.keys(built), Object.keys(base), "the same files");
  for (const name of Object.keys(base)) {
    if (SITE_EXTENDED.includes(name)) assert.notDeepEqual(built[name], base[name], `${name} gains the site fields`);
    else assert.deepEqual(built[name], base[name], `${name} is exactly lib/schemas.mjs's`);
  }
});

test("schemas: every committed data schema equals the generator's output", () => {
  for (const [name, schema] of Object.entries(built)) {
    assert.equal(read(name), serialise(schema), `schema/${name} is stale: run node tools/t3cp/dev/build-schemas.mjs`);
  }
});

test("schemas: additionalProperties is false on every object schema", () => {
  const walk = (node, at) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}[${i}]`));
    if (node === null || typeof node !== "object") return;
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes("object") && node.propertyNames === undefined) {
      assert.equal(node.additionalProperties, false, `${at}: object without additionalProperties: false`);
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`);
  };
  for (const [name, schema] of Object.entries(built)) walk(schema, name);
});

test("schemas: the validator accepts every keyword the schemas use", () => {
  for (const schema of Object.values(built)) {
    // Validating anything walks the root; unknown keywords throw.
    assert.doesNotThrow(() => validate(schema, {}));
  }
});

test("schemas: metric id enumerations equal the catalogue", () => {
  const ids = catalogue.metrics.map((m) => m.id);
  assert.deepEqual(built["series-1.json"].$defs.metric_id.enum, ids);
  const daily = catalogue.metrics.filter((m) => m.scope === "level" && m.lane === "daily" && m.source.file !== "merge").map((m) => m.id);
  assert.deepEqual(Object.keys(built["record-1.json"].$defs.level_stats.properties), daily);
  assert.deepEqual(built["attempt-1.json"].$defs.level_values.required, daily);
});

test("schemas: the record has no region or zone field anywhere", () => {
  for (const [name, schema] of Object.entries(built)) {
    const text = JSON.stringify(schema);
    assert.ok(!/"(region|zone|project|vm_name|hostname)"/.test(text), `${name} names a region-like field`);
  }
});

test("schemas: tag, sha and record id patterns accept the real shapes and refuse paths", () => {
  const defs = built["record-1.json"].$defs;
  const ok = (def, value) => assert.deepEqual(validate(defs[def], value, built["record-1.json"]), [], `${def} ${value}`);
  const bad = (def, value) => assert.notDeepEqual(validate(defs[def], value, built["record-1.json"]), [], `${def} ${value}`);
  ok("tag", "v0.1.10-nightly.20261115.4749");
  ok("tag", "v0.1.9-perf.7");
  bad("tag", "v0.1.9-perf.7/../x");
  bad("tag", "main");
  ok("record_id", "2026-11-15.linux-x64.nightly");
  ok("record_id", "0.1.9-perf.8.linux-x64.fork");
  ok("record_id", "2026-11-15.linux-x64.fork"); // the nightly fork-head record, keyed by its night
  bad("record_id", "2026-11-15.linux-x64.forks");
  bad("record_id", "0.1.9-perf.8.linux-x64.nightly");
  ok("sha", "295a0a7332aa1b0cc2f737dae71bd5e607a6ebb9");
  bad("sha", "295a0a7");
  ok("problem", "server_exited");
  bad("problem", ["trace at ", "/mn", "t/bench/x missing"].join(""));
});

test("schemas: a record names no t3cp commit (the repository is recreated from one squashed root at go-live)", () => {
  const record = built["record-1.json"];
  assert.deepEqual(Object.keys(record.properties.pipeline.properties).sort(), ["exporter_files_sha256", "exporter_version", "generated_at", "lease", "run_id", "runner_files_sha256", "runner_version"]);
  // The only commit SHAs a record carries are public ones: the release (upstream or fork), the fork's base and the harness branch.
  const shaFields = [];
  const walk = (node, at) => {
    if (!node || typeof node !== "object") return;
    if (node.$ref === "#/$defs/sha") shaFields.push(at);
    for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`);
  };
  walk(record.properties, "");
  for (const def of ["release", "base", "harness"]) walk(record.$defs[def], `$defs.${def}`);
  assert.deepEqual(shaFields.sort(), ["$defs.base.properties.sha", "$defs.harness.properties.sha", "$defs.release.properties.sha"]);
});

test("m1: seed is digits only; suite, profile and mode are enumerations", () => {
  const defs = built["record-1.json"].$defs;
  const root = built["record-1.json"];
  const bad = (def, value) => assert.notDeepEqual(validate(defs[def], value, root), [], `${def} ${JSON.stringify(value)}`);
  const ok = (def, value) => assert.deepEqual(validate(defs[def], value, root), [], `${def} ${JSON.stringify(value)}`);
  const workload = { profile: "real3", suite: "ladder-1", warmup_s: 60, window_s: 300, levels: [1, 50], empty_cell: true, attempts_per_level: 3, seed: "1", now: "2026-11-16T00:00:00Z" };
  ok("workload", workload);
  bad("workload", { ...workload, seed: "abc" });
  bad("workload", { ...workload, profile: "made-up" });
  bad("workload", { ...workload, suite: "made-up" });
  ok("workload", { ...workload, suite: "bands-1" });
  ok("workload", { ...workload, suite: "val-smoke" });
  bad("cell_profile", { sessions: 1, subscribers: 1, pollers: 0, mode: "history", fixture: "era" });
  ok("cell_profile", { sessions: 1, subscribers: 1, pollers: 0, mode: "fresh", fixture: "era" });
});

test("1, 7: record-scope stats are non-negative (the CPU-per-agent slope aside) and every value has a sane bound per unit", () => {
  const record = built["record-1.json"];
  const statFor = (id, where) => {
    const props = record.$defs[where].properties[id];
    return props.$ref ? record.$defs[props.$ref.slice("#/$defs/".length)] : props;
  };
  assert.equal(statFor("db_ready_warm_ms", "record_stats").properties.median.minimum, 0);
  assert.equal(statFor("snapshot_full_get_ms", "record_stats").properties.min.minimum, 0);
  assert.equal(statFor("cpu_per_session_pct", "record_stats").properties.median.minimum, -100000);
  assert.ok(statFor("rss_peak_mib", "level_stats").properties.max.maximum <= 1e7);
  assert.ok(statFor("elu", "level_stats").properties.max.maximum <= 1);
  assert.deepEqual(statFor("turns_completed", "level_stats").properties.values.items.type, ["integer", "null"]);
  const attempt = built["attempt-1.json"].$defs.level_values.properties;
  assert.deepEqual(attempt.turns_completed.type, ["integer", "null"]);
  assert.ok(attempt.turn_p50_ms.maximum <= 1e8);
  const cell = built["record-1.json"].$defs.cell_profile.properties.distribution_tolerance;
  assert.equal(cell.maximum, 5);
});

test("status reason codes: migration_failed and build_failed are public codes, each with a plain-words description", () => {
  const status = built["status-1.json"];
  const platform = status.properties.platforms.properties["linux-x64"];
  const failure = platform.properties.last_failure.properties.reason;
  for (const code of ["migration_failed", "build_failed", "runner_offline", "preempted"]) assert.ok(failure.enum.includes(code), code);
  assert.match(failure.description, /migration_failed: the nightly could not migrate the fixture/);
  assert.match(failure.description, /build_failed: a fork release or base tree could not be built from source/);
});

// The metric catalogue is the single source of metric ids, names, units, direction, lanes and eras.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const catalogue = JSON.parse(readFileSync(new URL("./catalogue.json", import.meta.url), "utf8"));
const metrics = catalogue.metrics;

const ENUMS = {
  better: ["lower", "higher", "context"],
  lane: ["daily", "record", "weekly", "release", "later", "scenario"],
  scope: ["level", "record"],
  form: ["ts", "ladder", "bars", "slope"],
  upstream: ["yes", "yes L", "pre", "fork"],
};
const PLATFORMS = ["linux-x64", "darwin-arm64"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z][a-z0-9_]*$/;
const FIELDS = [
  "id", "name", "short", "group", "unit", "better", "definition", "lane", "scope", "form", "era",
  "era_start", "upstream", "platforms", "na_on", "empty_cell", "gate", "counter", "headline", "source",
];

test("catalogue: top-level shape", () => {
  assert.equal(catalogue.schema, "t3cp/catalogue/1");
  assert.deepEqual(catalogue.levels, [1, 50, 100, 150, 200, 250]);
  assert.equal(catalogue.empty_cell, "1e");
  assert.deepEqual(catalogue.headline_levels, [1, 50, 100, 250]);
  assert.equal(catalogue.default_headline_level, 50);
  assert.ok(catalogue.headline_levels.every((L) => catalogue.levels.includes(L)), "headline levels are ladder levels");
  assert.ok(catalogue.headline_levels.includes(catalogue.default_headline_level), "the default is a headline level");
  assert.ok(!/"[a-z_]*lead[a-z_]*":/.test(JSON.stringify(catalogue)), "no field named after a role");
  assert.deepEqual(catalogue.platforms.map((p) => p.id), PLATFORMS);
  assert.match(catalogue.window_start, DATE);
  for (const era of catalogue.fixture_eras) assert.match(era.id, /^large-\d+$/);
  for (const era of catalogue.feature_eras) assert.match(era.from, DATE);
});

test("catalogue: ids are unique and well-formed", () => {
  const ids = metrics.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate metric id");
  for (const id of ids) assert.match(id, ID);
});

test("catalogue: every metric has exactly the known fields with valid values", () => {
  const groups = new Set(catalogue.groups.map((g) => g.id));
  const eras = new Set(catalogue.feature_eras.map((e) => e.id));
  for (const m of metrics) {
    assert.deepEqual(Object.keys(m), FIELDS, `${m.id}: field set`);
    for (const [field, values] of Object.entries(ENUMS)) {
      assert.ok(values.includes(m[field]), `${m.id}: ${field} = ${m[field]}`);
    }
    assert.ok(groups.has(m.group), `${m.id}: group ${m.group}`);
    for (const text of ["name", "short", "unit", "definition"]) {
      assert.equal(typeof m[text], "string", `${m.id}: ${text}`);
      assert.ok(m[text].length > 0, `${m.id}: empty ${text}`);
    }
    assert.ok(m.era === null || eras.has(m.era), `${m.id}: era ${m.era}`);
    assert.ok(m.era_start === null || DATE.test(m.era_start), `${m.id}: era_start`);
    if (m.era !== null) {
      const era = catalogue.feature_eras.find((e) => e.id === m.era);
      assert.ok(m.era_start >= era.from, `${m.id}: era_start before its feature era`);
    }
    assert.deepEqual(m.platforms, PLATFORMS, `${m.id}: platforms`);
    for (const p of m.na_on) assert.ok(PLATFORMS.includes(p), `${m.id}: na_on ${p}`);
    if (m.upstream === "yes L") assert.deepEqual(m.na_on, ["darwin-arm64"], `${m.id}: Linux-only row`);
    assert.equal(typeof m.empty_cell, "boolean");
    assert.equal(typeof m.gate, "boolean");
    assert.ok([null, "absolute", "rise"].includes(m.counter), `${m.id}: counter`);
    if (m.counter) assert.equal(m.better, "lower", `${m.id}: a counter is lower-is-better`);
    assert.ok(m.headline === null || (Number.isInteger(m.headline) && m.headline >= 1 && m.headline <= 8));
    assert.equal(typeof m.source.file, "string");
    assert.equal(typeof m.source.field, "string");
    assert.deepEqual(Object.keys(m.source), ["file", "field"]);
    if (m.scope === "record") assert.ok(["daily", "record", "scenario"].includes(m.lane), `${m.id}: record scope lane`);
    if (m.lane === "scenario") assert.equal(m.scope, "record", `${m.id}: a scenario metric is measured per scenario cell, never per ladder level`);
    if (m.empty_cell) assert.ok(["daily", "record"].includes(m.lane), `${m.id}: empty cell on ${m.lane}`);
    if (m.upstream === "fork") assert.equal(m.era_start, null, `${m.id}: fork-only rows have no upstream era`);
  }
});

test("catalogue: exactly eight headline metrics, ordered 1..8, matching the per-platform lists", () => {
  const heads = metrics.filter((m) => m.headline !== null).sort((a, b) => a.headline - b.headline);
  assert.equal(heads.length, 8);
  assert.deepEqual(heads.map((m) => m.headline), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(catalogue.headlines["linux-x64"], heads.map((m) => m.id));
  assert.deepEqual(
    catalogue.headlines["darwin-arm64"],
    heads.map((m) => (m.id === "main_busy_pct" ? "proc_cpu_pct" : m.id)),
  );
  for (const platform of PLATFORMS) {
    for (const id of catalogue.headlines[platform]) {
      const m = metrics.find((x) => x.id === id);
      assert.ok(!m.na_on.includes(platform), `${id} is a headline on ${platform} but n/a there`);
      assert.notEqual(m.better, "context", `${id}: a headline needs a direction`);
    }
  }
});

test("catalogue: the empty-database cell carries the design's list", () => {
  const empty = metrics.filter((m) => m.empty_cell).map((m) => m.id).sort();
  assert.deepEqual(empty, [
    "accept_first_ms", "accept_warm_ms", "db_ready_first_ms", "db_ready_warm_ms", "dispatch_p50_ms",
    "dispatch_p95_ms", "first_item_p50_ms", "first_turn_after_start_ms", "get_thread_shell_p95_ms",
    "heap_floor_mib", "heap_peak_mib", "listening_first_ms", "listening_warm_ms", "proc_cpu_pct",
    "rss_peak_mib", "shutdown_s", "turn_p50_ms", "wal_max_mib",
  ]);
});

test("catalogue: absolute counters (any value above zero flags) and rise counters (log lines: a rise above the reference flags)", () => {
  assert.deepEqual(metrics.filter((m) => m.counter === "absolute").map((m) => m.id).sort(), ["client_errors", "client_unfinished"]);
  assert.deepEqual(metrics.filter((m) => m.counter === "rise").map((m) => m.id).sort(), [
    "buffer_full_warnings", "server_error_lines", "server_warn_lines", "stream_resyncs", "trace_dropped",
  ]);
});

test("catalogue: agents_served is a daily, per-level count, higher is better", () => {
  const m = metrics.find((x) => x.id === "agents_served");
  assert.ok(m);
  assert.equal(m.better, "higher");
  assert.equal(m.unit, "n");
  assert.equal(m.lane, "daily");
  assert.equal(m.scope, "level");
  assert.equal(m.counter, null);
});

test("catalogue: the event loop delay rows name their source: eld_* is the preload histogram, server_eld_max_ms the server's gauge", () => {
  const byId = (id) => metrics.find((m) => m.id === id);
  for (const id of ["eld_p50_ms", "eld_p99_ms", "eld_max_ms"]) {
    assert.match(byId(id).name, /preload histogram/, id);
    assert.equal(byId(id).upstream, "pre", id);
  }
  const gauge = byId("server_eld_max_ms");
  assert.match(gauge.name, /server gauge/);
  assert.equal(gauge.era, "gauges");
  assert.equal(gauge.source.field, "metrics.otlp.event_loop_delay_max_ms");
});

// The scenario metrics (lane scenario): measured by a scenario row of scenarios.json, per row cell, never on the
// ladder. No ladder path reads this lane, so adding them moves no ladder series, compare file or index entry.
const SCENARIO_METRICS = {
  turn_start_history_gap_ms: { era: "turn_start_span", era_start: "2026-10-20", unit: "ms" },
  turn_start_long_thread_ms: { era: "turn_start_span", era_start: "2026-10-20", unit: "ms" },
  get_thread_shell_long_thread_ms: { era: "thread_shell_span", era_start: "2026-10-26", unit: "ms" },
  event_log_unpruned_days: { era: "event_prune", era_start: "2026-11-04", unit: "days" },
};

test("catalogue: the scenario metrics, their feature eras, and no other metric on the scenario lane", () => {
  assert.deepEqual(metrics.filter((m) => m.lane === "scenario").map((m) => m.id).sort(), Object.keys(SCENARIO_METRICS).sort());
  for (const [id, want] of Object.entries(SCENARIO_METRICS)) {
    const m = metrics.find((x) => x.id === id);
    assert.equal(m.era, want.era, id);
    assert.equal(m.era_start, want.era_start, id);
    assert.equal(m.unit, want.unit, id);
    assert.equal(m.form, "ts", id);
    assert.equal(m.better, "lower", id);
    assert.equal(m.upstream, "yes", id);
    assert.deepEqual([m.empty_cell, m.gate, m.counter, m.headline], [false, false, null, null], id);
    assert.ok(!Object.values(catalogue.headlines).flat().includes(id), `${id} is no headline`);
  }
  const eras = Object.fromEntries(catalogue.feature_eras.map((e) => [e.id, e.from]));
  assert.deepEqual(
    { turn_start_span: eras.turn_start_span, thread_shell_span: eras.thread_shell_span, event_prune: eras.event_prune },
    { turn_start_span: "2026-10-20", thread_shell_span: "2026-10-26", event_prune: "2026-11-04" },
  );
  // Appended after every ladder metric: the synthetic kit draws its values in catalogue order.
  const firstScenario = metrics.findIndex((m) => m.lane === "scenario");
  assert.ok(metrics.slice(firstScenario).every((m) => m.lane === "scenario"), "the scenario metrics come last");
});

test("catalogue: targets and mappings name catalogue metrics and say what they mean in plain words", () => {
  const ids = new Set(metrics.map((m) => m.id));
  assert.deepEqual(catalogue.targets, [
    { metric: "turn_start_history_gap_ms", below: 1000, unit: "ms", text: catalogue.targets[0].text },
  ]);
  assert.deepEqual(catalogue.mappings.map((x) => x.metric), ["turn_start_history_gap_ms", "get_thread_shell_p95_ms", "shutdown_s", "finalize_subagent_p50_ms"]);
  for (const entry of [...catalogue.targets, ...catalogue.mappings]) {
    assert.ok(ids.has(entry.metric), entry.metric);
    assert.equal(typeof entry.text, "string");
    assert.ok(entry.text.length > 40 && entry.text.length < 1200, `${entry.metric}: text length`);
    assert.doesNotMatch(entry.text, /perf\.\d|nightly\.\d{8}/, `${entry.metric}: no release names`);
  }
  for (const x of catalogue.mappings) assert.deepEqual(Object.keys(x), ["metric", "text"]);
});

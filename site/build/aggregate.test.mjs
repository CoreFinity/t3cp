// The aggregator: series shards with verdicts (design §4), changes feed, compare files, index, downloads,
// size budgets and determinism. Inputs are hand-made synthetic records built by tools/t3cp/lib/fake.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { aggregate, buildOutputs, checkBudgets, forkRelease, releaseBundle, BuildError, BUDGETS } from "./aggregate.mjs";
import { mergeRecord } from "../../tools/t3cp/merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, nightlyTag, FAKE_PUBLIC_REFS } from "../../tools/t3cp/lib/fake.mjs";
import { loadCatalogue, loadSchema } from "../../tools/t3cp/lib/repo.mjs";
import { validate } from "../../tools/t3cp/lib/validate.mjs";

/** Temporary directories this file made; removed when the file's tests end. */
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const catalogue = loadCatalogue();
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** A nightly record whose planted values come from `values(metricId, cell, date)` (undefined keeps the default). */
function nightly(date, values = () => undefined, extra = {}) {
  const identity = fakeIdentity({ date, ...extra });
  const attempts = fakeAttempts(catalogue, identity, { value: (id, cell) => values(id, cell, date), jitter: 0 });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
}

function fork(date, perf, base, values = () => undefined) {
  const tag = `v0.1.9-perf.${perf}`;
  const identity = fakeIdentity({ date, kind: "fork", tag, base: { tag: base.release.tag, date: base.release.date, sha: base.release.sha } });
  const attempts = fakeAttempts(catalogue, identity, { value: (id, cell) => values(id, cell), jitter: 0 });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T20:00:00Z` });
}

const BANDS = {
  schema: "t3cp/bands/1",
  method: "test bands",
  platforms: {
    "linux-x64": {
      measured: { from: "2026-11-01", to: "2026-11-02", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" },
      metrics: {
        turns_completed: { band: 4.6, n: 6 },
        turn_p50_ms: { band: 17.5, n: 6 },
        push_p95_ms: { band: 98, n: 6 },
        dispatch_p95_ms: { band: 18.7, n: 6 },
        main_busy_pct: { band: 7.2, n: 6 },
        elu: { band: 9.8, n: 6 },
        reader_tx_wait_p95_ms: { band: 17.7, n: 6 },
        rss_peak_mib: { band: 12.5, n: 6 },
        db_ready_warm_ms: { band: 10, n: 6 },
      },
    },
  },
};

function writeTree(records, { forks = [], bands = BANDS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-in-"));
  temps.push(dir);
  for (const r of records) {
    const file = path.join(dir, "records", r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  for (const r of forks) {
    const file = path.join(dir, "fork", `${r.release.tag}.${r.platform.id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  if (bands) fs.writeFileSync(path.join(dir, "bands.json"), `${JSON.stringify(bands, null, 2)}\n`);
  return dir;
}

/** Base records at each fork's merge-base SHA, valued like the default nightlies (300 turns at 100 agents). */
const basesFor = (forks) =>
  [...new Map(forks.map((f) => [f.base.sha, f])).values()].map((f) => baseRecordAt(f.base.date, f.base.sha, (id, cell) => (id === "turns_completed" && cell === "100" ? 300 : undefined)));
function baseRecordAt(date, sha, values) {
  const identity = fakeIdentity({ date, kind: "base", sha, tag: "v0.1.9" });
  const attempts = fakeAttempts(catalogue, identity, { value: (id, cell) => values(id, cell), jitter: 0 });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T19:00:00Z` });
}
function writeBaseFiles(dir, bases) {
  for (const r of bases) {
    const file = path.join(dir, "base", `${r.release.sha.slice(0, 12)}.${r.platform.id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  return dir;
}

const series = (files, metric, shard = "latest") => JSON.parse(files.get(`series/linux-x64/${metric}.${shard}.json`).toString("utf8"));
const lastIndex = (s) => s.dates.length - 1;

/** Ten nightlies 11-01..11-10 on one fixture era, with the last value planted. */
function ladder(planted) {
  const turns = 300;
  return Array.from({ length: 10 }, (_, i) => {
    const date = addDays("2026-11-01", i);
    return nightly(date, (id, cell) => {
      if (cell !== "100") return undefined;
      if (i === 9 && planted[id] !== undefined) return planted[id];
      if (id === "turns_completed") return turns;
      if (id === "push_p95_ms") return 200;
      return undefined;
    });
  });
}

test("aggregate (1): a planted 30 % change in the worse direction on turns_completed (band 4.6 %) is regressed", () => {
  // turns_completed is higher-is-better: 300 -> 210 is a 30 % fall, d = +30 % after the sign adjustment.
  const files = buildOutputs(writeTree(ladder({ turns_completed: 210 })), { publicRefs: FAKE_PUBLIC_REFS });
  const s = series(files, "turns_completed");
  const i = lastIndex(s);
  assert.equal(s.levels["100"].median[i], 210);
  assert.equal(s.levels["100"].ref[i], 300);
  assert.equal(s.levels["100"].delta[i], -30);
  assert.equal(s.levels["100"].threshold, 9.6);
  assert.equal(s.levels["100"].verdict[i], "regressed");
  // The same size of change the other way is an improvement.
  const up = series(buildOutputs(writeTree(ladder({ turns_completed: 390 })), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  assert.equal(up.levels["100"].verdict[lastIndex(up)], "improved");
});

test("aggregate (2): an 8 % change is within noise", () => {
  const s = series(buildOutputs(writeTree(ladder({ turns_completed: 276 })), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  assert.equal(s.levels["100"].delta[lastIndex(s)], -8);
  assert.equal(s.levels["100"].verdict[lastIndex(s)], "within");
});

test("aggregate (3): a 60 % change on push_p95_ms (context) gets no verdict", () => {
  const s = series(buildOutputs(writeTree(ladder({ push_p95_ms: 320 })), { publicRefs: FAKE_PUBLIC_REFS }), "push_p95_ms");
  const i = lastIndex(s);
  assert.equal(s.levels["100"].delta[i], 60);
  assert.equal(s.levels["100"].verdict[i], null);
  assert.equal(s.levels["100"].note[i], "context");
});

test("aggregate (4): the first record across a fixture-era boundary gets no verdict and no reference from the old era", () => {
  const records = Array.from({ length: 10 }, (_, i) => {
    const date = addDays("2026-10-24", i); // 10-24..10-30 on large-63, 10-31..11-02 on large-76
    return nightly(date, (id, cell) => (cell === "100" && id === "turns_completed" ? (date >= "2026-10-31" ? 150 : 300) : undefined));
  });
  const s = series(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  const first = s.dates.indexOf("2026-10-31");
  assert.equal(s.levels["100"].verdict[first], null);
  assert.equal(s.levels["100"].note[first], "no_reference");
  assert.equal(s.levels["100"].ref[first], null);
  // The next record in the new era has a thin reference from the new era only: within noise.
  assert.equal(s.levels["100"].verdict[first + 1], "within");
  assert.equal(s.levels["100"].thin[first + 1], true);
  assert.ok(s.eras.some((e) => e.kind === "fixture" && e.date === "2026-10-31"));
});

test("aggregate (5): a shard over 64 KB gzipped fails the build", () => {
  const big = Buffer.from(JSON.stringify({ x: randomBytes(80 * 1024).toString("base64") }));
  assert.throws(() => checkBudgets(new Map([["series/linux-x64/turns_completed.latest.json", big]])), (e) => e instanceof BuildError && /series\/linux-x64\/turns_completed\.latest\.json.*over budget/.test(e.message));
  assert.equal(BUDGETS.find((b) => b.prefix === "series/").limit, 64 * 1024);
  // The whole build fails the same way when a budget is exceeded.
  assert.doesNotThrow(() => buildOutputs(writeTree(ladder({})), { publicRefs: FAKE_PUBLIC_REFS }));
  assert.throws(() => buildOutputs(writeTree(ladder({})), { publicRefs: FAKE_PUBLIC_REFS, budgets: [{ prefix: "series/", limit: 200 }] }), /over budget/);
});

test("aggregate: changes.json lists a day only when the 7-day and day-over-day verdicts agree", () => {
  // 11-01..11-12: 300 turns; 11-09 drops to 200 and stays there.
  const records = Array.from({ length: 12 }, (_, i) => {
    const date = addDays("2026-11-01", i);
    return nightly(date, (id, cell) => (cell === "100" && id === "turns_completed" ? (date >= "2026-11-09" ? 200 : 300) : undefined));
  });
  const files = buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS });
  const s = series(files, "turns_completed");
  const d9 = s.dates.indexOf("2026-11-09");
  const d10 = s.dates.indexOf("2026-11-10");
  assert.equal(s.levels["100"].verdict[d9], "regressed");
  assert.equal(s.levels["100"].dod_verdict[d9], "regressed");
  assert.equal(s.levels["100"].verdict[d10], "regressed", "the 7-day reference still sees the old level");
  assert.equal(s.levels["100"].dod_verdict[d10], "within", "day over day it is flat");
  const changes = JSON.parse(files.get("changes.json").toString("utf8"));
  const rows = changes.items.filter((c) => c.metric === "turns_completed" && c.level === "100");
  assert.deepEqual(rows.map((c) => c.date), ["2026-11-09"]);
  assert.equal(rows[0].verdict, "regressed");
});

test("aggregate: validity gates, hollow values and missing bands give no verdict", () => {
  const records = ladder({ turns_completed: 210 });
  const last = records.at(-1);
  last.cells["100"].metrics.client_errors = { median: 2, min: 1, max: 3, n: 3, values: [1, 2, 3] };
  let s = series(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  assert.equal(s.levels["100"].verdict[lastIndex(s)], null);
  assert.equal(s.levels["100"].note[lastIndex(s)], "gated");
  const hollow = ladder({});
  hollow.at(-1).cells["100"].metrics.turns_completed = { median: 210, min: 210, max: 210, n: 1, values: [210, null, null] };
  s = series(buildOutputs(writeTree(hollow), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  assert.equal(s.levels["100"].note[lastIndex(s)], "hollow");
  const pending = { schema: "t3cp/bands/1", method: "noise-band run pending", platforms: { "linux-x64": { pending: true } } };
  s = series(buildOutputs(writeTree(ladder({ turns_completed: 210 }), { bands: pending }), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  assert.equal(s.levels["100"].verdict[lastIndex(s)], null);
  assert.equal(s.levels["100"].note[lastIndex(s)], "no_band");
  assert.equal(s.levels["100"].threshold, null);
});

test("aggregate: a metric before its era start is a gap (null), never 0", () => {
  const records = Array.from({ length: 6 }, (_, i) => nightly(addDays("2026-10-17", i)));
  const s = series(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "elu");
  for (let i = 0; i < s.dates.length; i++) {
    if (s.dates[i] < "2026-10-20") assert.equal(s.levels["100"].median[i], null, s.dates[i]);
    else assert.ok(s.levels["100"].median[i] > 0, s.dates[i]);
  }
  const first = s.dates.indexOf("2026-10-20");
  assert.equal(s.levels["100"].verdict[first], null);
});

test("aggregate: every output validates against its schema and passes the internal-name scan", () => {
  const records = ladder({ turns_completed: 210 });
  const forks = [fork("2026-11-08", 6, records[6]), fork("2026-11-10", 7, records[8], (id, cell) => (id === "turns_completed" && cell === "100" ? 400 : undefined))];
  const files = buildOutputs(writeBaseFiles(writeTree(records, { forks }), basesFor(forks)), { publicRefs: FAKE_PUBLIC_REFS });
  const schemaFor = (rel) =>
    rel === "index.json" ? "index-1.json" : rel === "changes.json" ? "changes-1.json" : rel === "status.json" ? "status-1.json" : rel === "bands.json" ? "bands-1.json" : rel.startsWith("series/") ? "series-1.json" : rel.startsWith("compare/") ? "compare-1.json" : rel.startsWith("records/") || rel.startsWith("fork/") || rel.startsWith("base/") ? "record-1.json" : null;
  let checked = 0;
  for (const [rel, bytes] of files) {
    const name = schemaFor(rel);
    if (name === null) continue;
    assert.deepEqual(validate(loadSchema(name), JSON.parse(bytes.toString("utf8"))), [], rel);
    checked++;
  }
  assert.ok(checked > 100);
  assert.ok(files.has("downloads/records.ndjson.gz"));
  assert.ok(files.has("downloads/series.csv.gz"));
  assert.ok(files.has(`compare/base-${records[6].release.sha.slice(0, 12)}__v0.1.9-perf.6.linux-x64.json`));
  assert.ok(files.has(`compare/v0.1.9-perf.6__v0.1.9-perf.7.linux-x64.json`));
  assert.ok(files.has(`compare/${records[8].release.tag}__${records[9].release.tag}.linux-x64.json`));
  const index = JSON.parse(files.get("index.json").toString("utf8"));
  assert.equal(JSON.parse(files.get("records-index.json").toString("utf8")).records.length, 10);
  assert.equal(index.fork.length, 2);
  assert.equal(index.fork[1].prev_tag, "v0.1.9-perf.6");
  assert.ok(!Object.keys(index.series).includes("darwin-arm64") || Object.keys(index.series["darwin-arm64"]).length === 0);
  assert.ok(![...files.keys()].some((rel) => rel.includes("darwin-arm64")), "no darwin files without darwin records");
});

test("aggregate: the fork step series holds each release until the next, with verdicts vs base and vs previous", () => {
  const records = ladder({});
  const forks = [
    fork("2026-11-05", 6, records[3], (id, cell) => (id === "turns_completed" && cell === "100" ? 300 : undefined)),
    fork("2026-11-08", 7, records[6], (id, cell) => (id === "turns_completed" && cell === "100" ? 400 : undefined)),
  ];
  const s = series(buildOutputs(writeBaseFiles(writeTree(records, { forks }), basesFor(forks)), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  const f = s.fork;
  assert.deepEqual(f.tags, ["v0.1.9-perf.6", "v0.1.9-perf.7"]);
  assert.deepEqual(f.prev_tags, [null, "v0.1.9-perf.6"]);
  const L = f.levels["100"];
  assert.deepEqual(L.value, [300, 400]);
  assert.equal(L.vs_prev_verdict[0], null);
  assert.equal(L.vs_prev_note[0], "no_reference");
  assert.equal(L.vs_prev_verdict[1], "improved");
  assert.equal(L.vs_base_verdict[1], "improved");
  assert.equal(L.vs_base[1], 33.33);
  const d4 = s.dates.indexOf("2026-11-04");
  const d5 = s.dates.indexOf("2026-11-05");
  const d9 = s.dates.indexOf("2026-11-09");
  assert.equal(L.step[d4], null);
  assert.equal(L.step[d5], 300);
  assert.equal(L.step[d9], 400);
  assert.equal(f.step_tags[d9], "v0.1.9-perf.7");
});

test("aggregate: forkRelease and releaseBundle give the fork's deltas vs base and vs previous at 1, 50, 100 and 250 agents", () => {
  const records = ladder({});
  const forks = [fork("2026-11-05", 6, records[3]), fork("2026-11-08", 7, records[6], (id, cell) => (id === "turns_completed" && cell === "100" ? 400 : undefined))];
  const dir = writeBaseFiles(writeTree(records, { forks }), basesFor(forks));
  const rel = forkRelease({ dataDir: dir, tag: "v0.1.9-perf.7", platform: "linux-x64", publicRefs: FAKE_PUBLIC_REFS });
  assert.equal(rel.base.tag, records[6].release.tag);
  assert.equal(rel.prev.tag, "v0.1.9-perf.6");
  const row = rel.rows.find((r) => r.metric === "turns_completed" && r.level === "100");
  assert.equal(row.verdict, "improved");
  assert.ok(Math.abs(row.delta - -1 / 3) < 1e-9, "sign-adjusted fraction: negative = better");
  const bundle = releaseBundle({ dataDir: dir, tag: "v0.1.9-perf.7", publicRefs: FAKE_PUBLIC_REFS });
  assert.deepEqual(validate(loadSchema("release-bundle-1.json"), bundle), []);
  assert.deepEqual(bundle.levels, ["1", "50", "100", "250"]);
  // The 50-agent level carries the fork's deltas like the others: every headline metric of the level has its row.
  const at50 = bundle.metrics.filter((m) => m.level === "50");
  assert.ok(at50.some((m) => m.id === "turns_completed" && m.base !== null && m.prev !== null), "turns_completed at 50 vs base and vs previous");
  for (const id of catalogue.headlines["linux-x64"].filter((x) => catalogue.metrics.find((m) => m.id === x).scope === "level")) {
    assert.ok(at50.some((m) => m.id === id), `${id} at 50`);
  }
  const b = bundle.metrics.find((m) => m.id === "turns_completed" && m.level === "100");
  assert.equal(b.text.fork, "400");
  assert.equal(b.text.delta_pct, "+33.3 %");
  assert.ok(bundle.allowed_numbers.includes("+33.3 %"));
  assert.ok(bundle.allowed_metric_names.includes("Turns completed in the window"));
});

test("aggregate: a record with an unknown metric id fails the build, naming the file and the id", () => {
  const records = ladder({});
  records[2].cells["100"].metrics.made_up_ms = { median: 1, min: 1, max: 1, n: 3, values: [1, 1, 1] };
  const dir = writeTree(records);
  assert.throws(() => buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && e.message.includes(`records/linux-x64/2026-11-03.${records[2].release.tag}.json`) && e.message.includes("made_up_ms"));
});

test("aggregate: synthetic files are refused unless building development data, and never from data/", () => {
  const records = ladder({});
  records[0].synthetic = true;
  const dir = writeTree(records);
  assert.throws(() => buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS }), /synthetic/);
  assert.doesNotThrow(() => buildOutputs(dir, { dev: true }));
});

test("aggregate: building twice from the same data gives byte-identical output trees", () => {
  const records = ladder({ turns_completed: 210 });
  const forks = [fork("2026-11-08", 6, records[6])];
  const dir = writeTree(records, { forks });
  const outA = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-a-"));
  temps.push(outA);
  const outB = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-b-"));
  temps.push(outB);
  aggregate({ publicRefs: FAKE_PUBLIC_REFS, inDir: dir, outDir: outA });
  aggregate({ publicRefs: FAKE_PUBLIC_REFS, inDir: dir, outDir: outB });
  const tree = (root) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(`${path.relative(root, p)} ${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
      }
    };
    walk(root);
    return out.join("\n");
  };
  assert.equal(tree(outA), tree(outB));
  assert.ok(fs.existsSync(path.join(outA, "series", "linux-x64", "turns_completed.latest.json")));
});

test("aggregate: the output directory is never the input, data/, or a non-empty foreign directory", () => {
  const dir = writeTree(ladder({}));
  assert.throws(() => aggregate({ publicRefs: FAKE_PUBLIC_REFS, inDir: dir, outDir: dir }), /output/);
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-agg-foreign-"));
  temps.push(foreign);
  fs.writeFileSync(path.join(foreign, "keep.txt"), "x");
  assert.throws(() => aggregate({ publicRefs: FAKE_PUBLIC_REFS, inDir: dir, outDir: foreign }), /not empty/);
  assert.ok(fs.existsSync(path.join(foreign, "keep.txt")));
});

test("aggregate: nightlyTag in the fake kit gives one tag per date (test sanity)", () => {
  assert.notEqual(nightlyTag("2026-11-01"), nightlyTag("2026-11-02"));
});

// ---------------------------------------------------------------------------------------------------------
// Contract changes from the plan review: base records, profile segments, inputs only under data/v1.

/** A source-built upstream base record at a fork's merge-base SHA (kind "base"). */
function baseRecord(date, sha, values = () => undefined) {
  const identity = fakeIdentity({ date, kind: "base", sha, tag: "v0.1.9" });
  const attempts = fakeAttempts(catalogue, identity, { value: (id, cell) => values(id, cell), jitter: 0 });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T19:00:00Z` });
}

function forkAt(date, perf, nightlyBase, mergeBase, values = () => undefined) {
  const tag = `v0.1.9-perf.${perf}`;
  const identity = fakeIdentity({ date, kind: "fork", tag, base: { tag: nightlyBase.release.tag, date: nightlyBase.release.date, sha: mergeBase } });
  const attempts = fakeAttempts(catalogue, identity, { value: (id, cell) => values(id, cell), jitter: 0 });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts, extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T20:00:00Z` });
}

function writeBases(dir, bases) {
  for (const r of bases) {
    const file = path.join(dir, "base", `${r.release.sha.slice(0, 12)}.${r.platform.id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  return dir;
}

test("aggregate: fork vs base compares with the base record at the fork's merge-base SHA, not the nightly", () => {
  const records = ladder({}); // nightlies: 300 turns at 100 agents
  const mergeBase = "e".repeat(40);
  const base = baseRecord("2026-11-07", mergeBase, (id, cell) => (id === "turns_completed" && cell === "100" ? 200 : undefined));
  const forks = [forkAt("2026-11-08", 7, records[6], mergeBase, (id, cell) => (id === "turns_completed" && cell === "100" ? 300 : undefined))];
  const dir = writeBases(writeTree(records, { forks }), [base]);
  const files = buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS });
  const s = series(files, "turns_completed");
  assert.equal(s.fork.levels["100"].vs_base[0], 50, "300 against the base record's 200, not the nightly's 300");
  assert.equal(s.fork.levels["100"].vs_base_verdict[0], "improved");
  assert.deepEqual(s.fork.base_shas, [mergeBase]);
  assert.ok(files.has(`compare/base-${mergeBase.slice(0, 12)}__v0.1.9-perf.7.linux-x64.json`));
  assert.ok(files.has(`base/${mergeBase.slice(0, 12)}.linux-x64.json`), "base records are copied to the output");
  const index = JSON.parse(files.get("index.json").toString("utf8"));
  assert.equal(index.fork[0].base_sha, mergeBase);
  assert.equal(index.fork[0].base_record, `base/${mergeBase.slice(0, 12)}.linux-x64.json`);
  const rel = forkRelease({ dataDir: dir, tag: "v0.1.9-perf.7", platform: "linux-x64", publicRefs: FAKE_PUBLIC_REFS });
  assert.equal(rel.rows.find((r) => r.metric === "turns_completed" && r.level === "100").verdict, "improved");
  assert.equal(rel.base.sha, mergeBase);
});

test("aggregate: a fork without a base record at its merge-base SHA gets no verdict vs base, with the reason", () => {
  const records = ladder({});
  const forks = [forkAt("2026-11-08", 7, records[6], "f".repeat(40), (id, cell) => (id === "turns_completed" && cell === "100" ? 400 : undefined))];
  const files = buildOutputs(writeTree(records, { forks }), { publicRefs: FAKE_PUBLIC_REFS });
  const s = series(files, "turns_completed");
  assert.equal(s.fork.levels["100"].vs_base_verdict[0], null);
  assert.equal(s.fork.levels["100"].vs_base_note[0], "no_base");
  const index = JSON.parse(files.get("index.json").toString("utf8"));
  assert.equal(index.fork[0].base_record, null);
});

test("aggregate: a load-profile change starts a new reference window, like a harness change", () => {
  // 11-01..11-10; from 11-06 the 100-agent cell runs 25 subscribers instead of 100.
  const records = Array.from({ length: 10 }, (_, i) => {
    const date = addDays("2026-11-01", i);
    const r = nightly(date, (id, cell) => (cell === "100" && id === "turns_completed" ? (date >= "2026-11-06" ? 150 : 300) : undefined));
    if (date >= "2026-11-06") r.workload.cells["100"].subscribers = 25;
    return r;
  });
  const s = series(buildOutputs(writeTree(records), { publicRefs: FAKE_PUBLIC_REFS }), "turns_completed");
  const first = s.dates.indexOf("2026-11-06");
  assert.equal(s.levels["100"].verdict[first], null);
  assert.equal(s.levels["100"].note[first], "no_reference");
  assert.equal(s.levels["100"].verdict[first + 1], "within", "the new window holds only the new profile");
  // Other levels kept their profile, so their window continues.
  assert.notEqual(s.levels["50"].note[first], "no_reference");
  assert.ok(s.eras.some((e) => e.kind === "profile" && e.date === "2026-11-06"));
});

test("aggregate: the input tree holds only records, fork, base, bands.json and status.json; derived files there fail", () => {
  const dir = writeTree(ladder({}));
  fs.writeFileSync(path.join(dir, "status.json"), `${JSON.stringify({ schema: "t3cp/status/1", generated_at: "2026-11-10T06:00:00Z", platforms: {} })}\n`);
  const files = buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS });
  assert.equal(files.get("status.json").toString("utf8"), fs.readFileSync(path.join(dir, "status.json"), "utf8"), "status.json is published (re-serialised, here identical)");
  for (const derived of ["index.json", "changes.json", "mrs.json", "series/linux-x64/x.latest.json", "releases/v0.1.9-perf.7.json", "downloads/records.ndjson.gz"]) {
    const bad = writeTree(ladder({}));
    fs.mkdirSync(path.dirname(path.join(bad, derived)), { recursive: true });
    fs.writeFileSync(path.join(bad, derived), "{}\n");
    assert.throws(() => buildOutputs(bad, { publicRefs: FAKE_PUBLIC_REFS }), (e) => e instanceof BuildError && e.message.includes(derived), derived);
  }
  const none = buildOutputs(writeTree(ladder({})), { publicRefs: FAKE_PUBLIC_REFS });
  assert.ok(!none.has("status.json"), "the aggregator never writes status.json itself");
});

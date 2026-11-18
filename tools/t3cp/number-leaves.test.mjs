// Private patterns never apply to the JSON number leaves of pipeline data: a number measured on a public release
// cannot leak a private figure, and a private value pattern must not fail a publish because a measurement happens to
// equal it. Keys and string leaves stay scanned with every pattern; non-JSON text (pages, scripts) is scanned whole.
// The private list here is synthetic: it names a number taken from the synthetic data at run time and a made-up word.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanValue } from "./lib/scan.mjs";
import { mergeRecord } from "./merge.mjs";
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from "./lib/fake.mjs";
import { loadCatalogue } from "./lib/repo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogue = loadCatalogue();
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `t3cp-${name}-`));
  temps.push(d);
  return d;
};
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const records = Array.from({ length: 3 }, (_, i) => {
  const identity = fakeIdentity({ date: addDays("2026-11-01", i) });
  return mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0 }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${identity.release.date}T18:00:00Z` });
});
// A number every record carries (an integer, so it appears as plain digits) and a made-up private word.
const NUMBER = String(Math.round(records[0].cells["150"].metrics.turns_completed.median));
const WORD = ["quok", "kaname"].join("");
function privateList() {
  const file = path.join(tmp("private"), "patterns.txt");
  fs.writeFileSync(file, `\\b${NUMBER}\\b\n${WORD}\n`);
  return file;
}
/** The merge CLI's public references: the fakes' (the pinned file names the real harness). */
const mergeArgs = () => {
  const file = path.join(tmp("refs"), "public-refs.json");
  fs.writeFileSync(file, JSON.stringify(FAKE_PUBLIC_REFS));
  return ["--public-refs", file];
};
const re = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((s) => new RegExp(s, "giu"));

test("scanValue: a number leaf equal to a private value passes; the same digits in a string leaf or a private word in a key are hits", () => {
  const patterns = re(privateList());
  assert.ok(records[0].cells["150"].metrics.turns_completed.median > 0);
  assert.deepEqual(scanValue({ a: Number(NUMBER), b: [Number(NUMBER), 1.5] }, { privatePatterns: patterns }), [], "number leaves");
  assert.ok(scanValue({ note: `${NUMBER} faults` }, { privatePatterns: patterns }).length > 0, "a string leaf");
  assert.ok(scanValue({ [WORD]: 1 }, { privatePatterns: patterns }).length > 0, "a key");
  // The public list still sees numbers (and finds nothing in plain measurements).
  assert.deepEqual(scanValue({ a: 10.5 }, { privatePatterns: [] }), []);
});

function writeTree(extra = {}) {
  const dir = tmp("agg-in");
  for (const r of records) {
    const file = path.join(dir, "records", r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  }
  const bands = {
    schema: "t3cp/bands/1",
    method: "test bands",
    platforms: { "linux-x64": { measured: { from: "2026-11-01", to: "2026-11-02", attempts: 42, machines: 3, tag: "v0.1.10-nightly.20261115.4749" }, metrics: Object.fromEntries(catalogue.headlines["linux-x64"].map((id) => [id, { band: 10, n: 6 }])) } },
    ...extra.bands,
  };
  fs.writeFileSync(path.join(dir, "bands.json"), `${JSON.stringify(bands, null, 2)}\n`);
  for (const [rel, text] of Object.entries(extra.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const aggregate = (inDir, outDir, patterns) =>
  spawnSync(process.execPath, [path.join(here, "../../site/build/aggregate.mjs"), "--in", inDir, "--out", outDir, ...mergeArgs()], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: patterns } });

test("aggregate: records whose measurements equal a private value build; the derived series, compare files and downloads too", () => {
  const out = path.join(tmp("agg-out"), "v1");
  const r = aggregate(writeTree(), out, privateList());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(out, "records-index.json")));
});

test("aggregate: the same digits in a string leaf, or a private word in a key, still fail the build; a non-JSON input is still refused", () => {
  const patterns = privateList();
  const prose = aggregate(writeTree({ bands: { method: `${NUMBER} faults` } }), path.join(tmp("agg-out"), "v1"), patterns);
  assert.equal(prose.status, 2);
  assert.match(prose.stderr, /bands\.json: forbidden pattern/);
  const keyed = writeTree();
  const file = path.join(keyed, "records", records[1].platform.id, `${records[1].release.date}.${records[1].release.tag}.json`);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.cells["100"][WORD] = 1;
  fs.writeFileSync(file, JSON.stringify(value));
  const k = aggregate(keyed, path.join(tmp("agg-out"), "v1"), patterns);
  assert.equal(k.status, 2);
  assert.match(k.stderr, /forbidden pattern/);
  const text = aggregate(writeTree({ files: { "notes.txt": "anything\n" } }), path.join(tmp("agg-out"), "v1"), patterns);
  assert.equal(text.status, 2);
  assert.match(text.stderr, /unexpected file/);
});

test("merge: a record whose measurements equal a private value merges (the CLI's record scan)", () => {
  const identity = fakeIdentity({ date: "2026-11-05" });
  const dir = tmp("merge-in");
  for (const a of fakeAttempts(catalogue, identity, { jitter: 0 })) {
    fs.mkdirSync(path.join(dir, "attempts", `${a.cell}-${a.n}`), { recursive: true });
    fs.writeFileSync(path.join(dir, "attempts", `${a.cell}-${a.n}`, "attempt.json"), JSON.stringify(a));
  }
  const out = path.join(dir, "record.json");
  const r = spawnSync(process.execPath, [path.join(here, "merge.mjs"), dir, "--out", out, "--generated-at", "2026-11-05T18:00:00Z", ...mergeArgs()], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: privateList() } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(out, "utf8"), new RegExp(`\\b${NUMBER}\\b`), "the value is in the record");
});

test("scan-tree: JSON (plain or gzipped) and the CSV download exempt number leaves; pages, scripts and string leaves are scanned whole", () => {
  const patterns = privateList();
  const run = (dir) => spawnSync(process.execPath, [path.join(here, "scan-tree.mjs"), dir], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: patterns } });
  const clean = tmp("dist");
  fs.mkdirSync(path.join(clean, "v1", "downloads"), { recursive: true });
  fs.writeFileSync(path.join(clean, "v1", "series.json"), JSON.stringify({ median: [Number(NUMBER), 2] }));
  fs.writeFileSync(path.join(clean, "v1", "downloads", "records.ndjson.gz"), zlib.gzipSync(`${JSON.stringify({ v: Number(NUMBER) })}\n${JSON.stringify({ v: 3 })}\n`));
  fs.writeFileSync(path.join(clean, "v1", "downloads", "series.csv.gz"), zlib.gzipSync(`date,metric,median\n2026-11-01,turns_completed,${NUMBER}\n`));
  fs.writeFileSync(path.join(clean, "v1", "index.json.gz"), zlib.gzipSync(JSON.stringify({ n: Number(NUMBER) })));
  const ok = run(clean);
  assert.equal(ok.status, 0, ok.stderr);
  for (const [rel, bytes] of [
    ["page.html", `<p>${NUMBER} faults</p>`],
    ["app.js", `const x = ${NUMBER};`],
    ["v1/note.json", JSON.stringify({ note: `${NUMBER} faults` })],
    ["v1/keyed.json", JSON.stringify({ [WORD]: 1 })],
    ["v1/downloads/text.csv.gz", zlib.gzipSync(`date,label\n2026-11-01,${WORD}\n`)],
  ]) {
    const dir = tmp("dist-hit");
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), bytes);
    const r = run(dir);
    assert.equal(r.status, 2, `${rel}: ${r.stderr}`);
  }
});

test("export: an attempt whose measurements equal a private value exports; a private word in a scanned string is still refused", async () => {
  const { fakeSpec, writeRawAttempt } = await import("./lib/fake-raw.mjs");
  const root = tmp("export");
  const spec = structuredClone(fakeSpec());
  spec.fixture.path = path.join(root, "fixture.sqlite");
  spec.release.archive_path = path.join(root, "archive.tar.gz");
  fs.writeFileSync(spec.fixture.path, Buffer.alloc(4096));
  fs.writeFileSync(spec.release.archive_path, Buffer.alloc(2048));
  const specFile = path.join(root, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const exportTo = (raw, out, patterns) => spawnSync(process.execPath, [path.join(here, "export.mjs"), raw, "--out", out, "--spec", specFile], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: patterns } });
  const once = path.join(root, "first");
  const first = spawnSync(process.execPath, [path.join(here, "export.mjs"), writeRawAttempt(path.join(root, "raw1"), { spec }), "--out", once, "--spec", specFile, "--no-private-patterns"], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" } });
  assert.equal(first.status, 0, first.stderr);
  const value = JSON.parse(fs.readFileSync(path.join(once, "attempt.json"), "utf8")).metrics.turns_completed;
  assert.ok(Number.isInteger(value));
  const file = path.join(tmp("private"), "patterns.txt");
  fs.writeFileSync(file, `\\b${value}\\b\n${WORD}\n`);
  const ok = exportTo(writeRawAttempt(path.join(root, "raw2"), { spec }), path.join(root, "second"), file);
  assert.equal(ok.status, 0, ok.stderr);
  const named = writeRawAttempt(path.join(root, "raw3"), { spec, edit: (f) => (f.result.identity.server_version = `${f.result.identity.server_version}-${WORD}`) });
  assert.equal(exportTo(named, path.join(root, "third"), file).status, 2, "a private word in the identity strings");
});

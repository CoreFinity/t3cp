// The private list is split at source: names, paths and other patterns (T3CP_PRIVATE_PATTERNS, applied everywhere) and
// value patterns, which often carry a unit ("N ms", "N.N %") and apply only to authored text. Content generated from
// measured data (the aggregator, scan-tree over the built site, the release text) never receives the value list. Also:
// the sponsor credit's exact HTML form, strict JSON in scan-tree, quoted CSV cells and figure token boundaries. Every
// list, figure and name here is synthetic.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanCsvText, scanText } from "./lib/scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `t3cp-${name}-`));
  temps.push(d);
  return d;
};
const WORD = ["quok", "kaname"].join("");
const list = (lines) => {
  const file = path.join(tmp("list"), "patterns.txt");
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
};
const scanTree = (dir, env) => spawnSync(process.execPath, [path.join(here, "scan-tree.mjs"), dir], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "", ...env } });

test("the value list never reaches generated content: only T3CP_PRIVATE_PATTERNS is read, so a unit-bearing value pattern given any other way is not applied", () => {
  const names = list([WORD]);
  const values = list(["\\b45\\.3 ms\\b", "\\b8\\.5 ?%"]);
  const dist = tmp("dist");
  fs.mkdirSync(path.join(dist, "v1", "releases"), { recursive: true });
  fs.writeFileSync(path.join(dist, "v1", "releases", "perf.json"), JSON.stringify({ rows: [{ text: { fork: "45.3 ms", delta_pct: "8.5 %" } }] }));
  fs.writeFileSync(path.join(dist, "releases.html"), "<p>Dispatch p95 fell to 45.3 ms, 8.5 % faster.</p>");
  const env = { T3CP_PRIVATE_PATTERNS: names, T3CP_PRIVATE_VALUE_PATTERNS: values, T3CP_PRIVATE_VALUES: values, T3CP_VALUE_PATTERNS: values };
  const r = scanTree(dist, env);
  assert.equal(r.status, 0, r.stderr);
  // The names list still applies to the same generated content.
  fs.writeFileSync(path.join(dist, "named.html"), `<p>${WORD}</p>`);
  assert.equal(scanTree(dist, env).status, 2);
  // No tool of ours reads any other private list variable.
  for (const dir of ["tools/t3cp", "site/build"]) {
    for (const f of fs.readdirSync(path.join(root, dir), { recursive: true })) {
      if (!/\.(m?js|sh)$/.test(f) || /\.test\.mjs$/.test(f)) continue;
      const src = fs.readFileSync(path.join(root, dir, f), "utf8");
      for (const m of src.matchAll(/T3CP_PRIVATE_[A-Z_]+/g)) assert.equal(m[0], "T3CP_PRIVATE_PATTERNS", `${dir}/${f}`);
    }
  }
});

test("the sponsor credit's exact HTML form passes; the sponsor's name anywhere else is still a hit", () => {
  const sponsor = ["Core", "finity"].join("");
  const patterns = [new RegExp(sponsor, "giu")];
  const anchor = `Run and funded by <a href="https://${sponsor.toLowerCase()}.com">${sponsor}</a>`;
  assert.deepEqual(scanText(`<footer><p>${anchor}</p></footer>`, { privatePatterns: patterns, env: false }), []);
  for (const other of [`Sponsored by ${sponsor}.`, `Run and funded by <a href="https://${sponsor.toLowerCase()}.com" class="x">${sponsor}</a>`, `<a href="https://${sponsor.toLowerCase()}.com/x">${sponsor}</a>`]) {
    assert.ok(scanText(other, { privatePatterns: patterns, env: false }).length > 0, other);
  }
});

test("scan-tree's JSON mode parses strictly (a duplicate key is a hit) and scans the raw text with the public list too", () => {
  const dist = tmp("dist-dup");
  const home = ["", "ho" + "me", "someone", "x"].join("/");
  fs.writeFileSync(path.join(dist, "a.json"), `{"path": "${home}", "path": "clean"}`);
  const r = scanTree(dist, {});
  assert.equal(r.status, 2, r.stderr);
  const gz = tmp("dist-dup-gz");
  fs.writeFileSync(path.join(gz, "a.json.gz"), zlib.gzipSync(`{"a": 1, "a": 2}`));
  assert.equal(scanTree(gz, {}).status, 2, "gzipped too");
});

test("CSV: a quoted cell is one cell (its commas and doubled quotes included), and only a bare number is a numeric cell", () => {
  const patterns = [/\b8,513\b/gu, new RegExp(WORD, "giu")];
  assert.ok(scanCsvText(`date,label\n2026-11-01,"8,513"\n`, { privatePatterns: patterns, env: false }).length > 0, "a quoted string cell is scanned whole");
  assert.ok(scanCsvText(`date,label\n2026-11-01,"say ""${WORD}"", ok"\n`, { privatePatterns: patterns, env: false }).length > 0, "doubled quotes inside");
  assert.deepEqual(scanCsvText(`date,median\n2026-11-01,8513\n`, { privatePatterns: [/\b8513\b/gu], env: false }), [], "a bare numeric cell");
});

test("figure tokens: digits followed by - / ? # : or preceded by = ? & # : are not figures", () => {
  const dist = (page) => {
    const d = tmp("dist-fig");
    fs.mkdirSync(path.join(d, "v1"), { recursive: true });
    fs.writeFileSync(path.join(d, "v1", "s.json"), JSON.stringify({ v: [4321] }));
    fs.writeFileSync(path.join(d, "p.html"), page);
    return d;
  };
  // A value list (--values): the only list the figure masking applies to.
  const values = list(["\\b4321\\b"]);
  const scanValues = (dir) => spawnSync(process.execPath, [path.join(here, "scan-tree.mjs"), dir, "--values", values], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" } });
  assert.equal(scanValues(dist("<p>4321 turns</p>")).status, 0, "a published figure");
  for (const page of ["<p>4321-x</p>", "<p>4321/7</p>", '<a href="?id=4321">x</a>', '<a href="/r?a=1&b=4321">x</a>', "<p>4321?</p>", '<a href="#4321">x</a>', "<p>4321:1</p>", "<p>x:4321</p>"]) {
    assert.equal(scanValues(dist(page)).status, 2, page);
  }
});

test("CSV: text after a closing quote, up to the separator, stays in the cell and is scanned", () => {
  const patterns = [new RegExp(WORD, "giu")];
  assert.ok(scanCsvText(`id,label\n1,"x"${WORD}\n`, { privatePatterns: patterns, env: false }).length > 0, "trailing text after a quoted cell");
  assert.ok(scanCsvText(`id,label\n1,"x"${WORD},2\n`, { privatePatterns: patterns, env: false }).length > 0, "before a further cell");
  assert.deepEqual(scanCsvText(`id,label\n1,"x",2\n`, { privatePatterns: patterns, env: false }), []);
});

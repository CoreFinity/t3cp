// scan-tree over pages, scripts, feeds and plain text: a numeric token that shows a number the published data carries
// (as the site or the posts print it: plain, grouped "1,234", with fixed decimals, signed) is a measured figure, not a
// private one, so the private list does not see it. The same digits with no matching data number are still a hit, and
// name and path patterns are never affected. The private list is synthetic: numbers taken from the test's own data.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `t3cp-${name}-`));
  temps.push(d);
  return d;
};
const WORD = ["quok", "kaname"].join("");
/** A dist with published data carrying these numbers, and these extra files. */
function dist(numbers, files) {
  const dir = tmp("dist");
  fs.mkdirSync(path.join(dir, "v1", "series", "linux-x64"), { recursive: true });
  fs.writeFileSync(path.join(dir, "v1", "series", "linux-x64", "m.latest.json"), JSON.stringify({ median: numbers }));
  fs.writeFileSync(path.join(dir, "v1", "downloads.ndjson.gz"), zlib.gzipSync(`${JSON.stringify({ v: 1 })}\n`));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
function privateList(lines) {
  const file = path.join(tmp("private"), "patterns.txt");
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}
// The figure masking applies only to a values list passed explicitly (--values): value patterns, for authored text.
const run = (dir, list) => spawnSync(process.execPath, [path.join(here, "scan-tree.mjs"), dir, "--values", list], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" } });
const runNames = (dir, list) => spawnSync(process.execPath, [path.join(here, "scan-tree.mjs"), dir], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: list } });

test("a page, script, feed or text file that prints a published figure passes: plain, grouped, fixed decimals or signed", () => {
  const list = privateList(["\\b4321\\b", "4,321", "\\b45\\.3\\b", "\\b0\\.042\\b", WORD]);
  const data = [4321, 45.25, 0.0417, -4321];
  for (const [rel, text] of [
    ["releases/perf-9/index.html", "<p>Turns rose to 4321 at 250 agents, from 45.3 ms; 0.042 of the window.</p>"],
    ["records/index.html", "<td>4,321</td><td>−4,321</td>"],
    ["app.js", "const sample = '4321.0';"],
    ["feed.xml", "<item><title>Turns: 4,321.00</title></item>"],
    ["notes.txt", "measured 4321 and 45.25"],
  ]) {
    const r = run(dist(data, { [rel]: text }), list);
    assert.equal(r.status, 0, `${rel}: ${r.stderr}`);
  }
});

test("the same digits with no matching published number are still a hit; names and paths are never masked", () => {
  const list = privateList(["\\b4321\\b", "\\b45\\.2\\b", WORD, `/${["opt", "secret"].join("/")}/\\d+`]);
  const hit = (data, rel, text) => {
    const r = run(dist(data, { [rel]: text }), list);
    assert.equal(r.status, 2, `${rel}: ${text}: ${r.stderr}`);
  };
  hit([12, 45.31], "page.html", "<p>4321 faults</p>"); // no data number shows as 4321
  hit([4321.6], "page.html", "<p>4321 faults</p>"); // 4321.6 shows as 4,322, never 4321
  hit([45.25], "page.html", "<p>45.2 ms</p>"); // 45.25 shows as 45.3 at one decimal, 45.25 at two, never 45.2
  hit([4321], "page.html", `<p>${WORD}4321</p>`); // a name with digits attached is not a figure
  hit([4321], "page.html", `<p>/${["opt", "secret"].join("/")}/4321</p>`); // a path keeps its digits
});

test("public patterns still see the unmasked text (an address made of figures stays a hit)", () => {
  const list = privateList([WORD]);
  const r = run(dist([10, 0.1, 1.2], { "page.html": `<p>${["10", "0", "1", "2"].join(".")}</p>` }), list);
  assert.equal(r.status, 2, r.stderr);
});

test("names list: a name pattern whose match is a published number still hits on a page; masking never applies to names", () => {
  // A name-class pattern can match just digits (here only after a word); masking published numbers must not neutralise it.
  const names = privateList(["(?<=zone )4321", WORD]);
  const r = runNames(dist([4321], { "page.html": "<p>zone 4321 runs</p>" }), names);
  assert.equal(r.status, 2, r.stderr);
  // The same list as --values (value patterns) masks the published figure.
  assert.equal(run(dist([4321], { "page.html": "<p>zone 4321 runs</p>" }), names).status, 0);
  // And a name pattern on a page with no published number hits either way.
  assert.equal(runNames(dist([12], { "page.html": `<p>${WORD}</p>` }), names).status, 2);
});

// scan-tree, the built site's last check (final review minors): a text file holding a NUL byte is still scanned (only
// image types are skipped as binary), every file and directory name passes the scan (a finding names the path with
// the hit segment withheld, never the matched text), and an empty tree is refused. Plus: package.json's engines
// name the Node major the code needs. The host token is built from fragments.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanTree } from "./scan-tree.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const HOST = ["w", "s9"].join("");
function dist(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-stm-"));
  temps.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}
const cli = (dir) => spawnSync(process.execPath, [path.join(here, "scan-tree.mjs"), dir], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "" } });

test("a page with a NUL byte is scanned, not skipped as binary", () => {
  const dir = dist({ "index.html": Buffer.concat([Buffer.from("<p>a"), Buffer.from([0]), Buffer.from(`b ${HOST} c</p>`)]) });
  assert.deepEqual(scanTree(dir), [{ file: "index.html", pattern: "host_ws" }]);
});

test("image types are skipped as binary, NUL or not", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), Buffer.from(` ${HOST} `)]);
  assert.deepEqual(scanTree(dist({ "img/a.png": png, "index.html": "<p>clean</p>" })), []);
});

test("file and directory names are scanned; the finding withholds the hit segment", () => {
  const dir = dist({ [`notes-${HOST}/page.html`]: `<p>${HOST}</p>`, [`report-${HOST}.txt`]: "clean", "ok/page.html": "<p>clean</p>" });
  const findings = scanTree(dir);
  assert.deepEqual(findings, [
    { file: "[name withheld]", pattern: "name_host_ws" },
    { file: "[name withheld]", pattern: "name_host_ws" },
    { file: "[name withheld]/page.html", pattern: "host_ws" },
  ]);
  const r = cli(dir);
  assert.equal(r.status, 2);
  assert.ok(!r.stderr.includes(HOST), "the output never prints the matched text, in a path either");
});

test("an empty tree is refused: a build that wrote nothing never passes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-stm-empty-"));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, "assets"));
  assert.deepEqual(scanTree(dir), [{ file: ".", pattern: "empty_tree" }]);
  assert.equal(cli(dir).status, 2);
});

test("package.json engines: Node 26, the major the code and CI run on", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "../../package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(here, "../../package-lock.json"), "utf8"));
  assert.equal(pkg.engines.node, ">=26");
  assert.equal(lock.packages[""].engines.node, ">=26", "the lock's root entry agrees");
  assert.equal(fs.readFileSync(path.join(here, "../../.node-version"), "utf8").trim().split(".")[0], "26");
});

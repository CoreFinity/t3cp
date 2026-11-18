// scan-tree.mjs: the publish build's last check over the whole output directory (dist), gzip files included.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "scan-tree.mjs");
const j = (...parts) => parts.join("");
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const run = (dir, env = {}) => spawnSync(process.execPath, [cli, dir], { encoding: "utf8", env: { ...process.env, T3CP_PRIVATE_PATTERNS: "", ...env } });

test("scan-tree: a clean tree passes; a forbidden string in any file or inside a gzip file fails, naming file and pattern only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-scan-tree-"));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, "data/v1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<p>T3 Code, 9,257 ms</p>\n");
  fs.writeFileSync(path.join(dir, "data/v1/a.json"), '{"ok":1}\n');
  fs.writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  assert.equal(run(dir).status, 0);
  const home = j("/ho", "me/x");
  fs.writeFileSync(path.join(dir, "data/v1/records.ndjson.gz"), zlib.gzipSync(`{"p":"${home}"}\n`));
  const r = run(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /records\.ndjson\.gz.*path_home/);
  assert.ok(!r.stderr.includes(home));
  fs.rmSync(path.join(dir, "data/v1/records.ndjson.gz"));
  const list = path.join(dir, "..", `${path.basename(dir)}-private.txt`);
  temps.push(list);
  fs.writeFileSync(list, `${j("secret", "-proj")}\n`);
  fs.writeFileSync(path.join(dir, "about.html"), `<p>${j("secret", "-proj")}</p>`);
  assert.equal(run(dir, { T3CP_PRIVATE_PATTERNS: list }).status, 2);
});

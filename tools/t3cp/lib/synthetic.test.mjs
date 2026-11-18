// The deploy gate: no file carrying "synthetic": true may be published.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findSynthetic } from "./synthetic.mjs";

/** Temporary directories this file made; removed when the file's tests end. */
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "synthetic.mjs");

test("synthetic: finds marked JSON, NDJSON lines and gzipped NDJSON; the CLI exits 2 on any", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-syn-"));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, "a/b"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a/ok.json"), JSON.stringify({ schema: "x" }));
  assert.deepEqual(findSynthetic(dir), []);
  assert.equal(spawnSync(process.execPath, [cli, "check", dir]).status, 0);
  fs.writeFileSync(path.join(dir, "a/b/s.json"), JSON.stringify({ schema: "x", synthetic: true }));
  fs.writeFileSync(path.join(dir, "r.ndjson.gz"), zlib.gzipSync('{"a":1}\n{"synthetic":true}\n'));
  assert.deepEqual(findSynthetic(dir), ["a/b/s.json", "r.ndjson.gz"]);
  assert.equal(spawnSync(process.execPath, [cli, "check", dir]).status, 2);
});

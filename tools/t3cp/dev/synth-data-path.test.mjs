// synth-data.mjs can be imported (and run) from a checkout whose path holds a space: its main-module check must
// not feed a percent-encoded URL path to the file system.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../lib/repo.mjs";

const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test("synth-data: a script under a path with a space can import it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp synth path "));
  temps.push(root);
  for (const rel of ["catalogue", "schema", "tools/t3cp", "site/build"]) fs.cpSync(path.join(REPO_ROOT, rel), path.join(root, rel), { recursive: true });
  // A script file (so process.argv[1] is set, as in a test run) that imports the module.
  const importer = path.join(root, "importer.mjs");
  fs.writeFileSync(importer, 'import "./tools/t3cp/dev/synth-data.mjs";\n');
  const r = spawnSync(process.execPath, [importer], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr.split("\n").find((l) => /Error/.test(l)) ?? r.stderr);
});

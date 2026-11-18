// exporter_files_sha256, which every attempt and record publishes, must name exactly what runs on the runner VM during
// export and merge: the static import closure of export.mjs and merge.mjs, plus the data files that code reads (the
// catalogue, the load profiles, the schemas it validates against, and any JSON it opens beside itself), plus the record
// spec schema run-record.sh validates its input against (the runner identity covers run-record.sh and runner/* only,
// so without it no pin would cover that contract). A file the VM runs but the hash leaves out makes the published hash
// unreproducible; a CI-only file in it would force images for nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPORTER_FILES } from "./export.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rel = (abs) => path.relative(root, abs).split(path.sep).join("/");

function closure() {
  const code = new Set();
  const data = new Set();
  const walk = (abs) => {
    const r = rel(abs);
    if (code.has(r)) return;
    code.add(r);
    const src = fs.readFileSync(abs, "utf8");
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+"(\.[^"]+)"|^\s*import\s+"(\.[^"]+)"|import\("(\.[^"]+)"\)/gm)) {
      walk(path.join(path.dirname(abs), m[1] ?? m[2] ?? m[3]));
    }
    // Data the code opens: schemas by name, the catalogue, JSON beside the module.
    for (const m of src.matchAll(/\b(?:loadSchema|schemaOrFail|readValidated)\([^)]*?"([a-z][a-z-]*-1\.json)"/g)) data.add(`schema/${m[1]}`);
    if (/loadCatalogue\b/.test(src)) data.add("catalogue/catalogue.json");
    for (const m of src.matchAll(/new URL\("(\.[^"]+\.json)", import\.meta\.url\)/g)) {
      const target = path.join(path.dirname(abs), m[1]);
      if (fs.existsSync(target)) data.add(rel(target));
    }
  };
  walk(path.join(root, "tools/t3cp/export.mjs"));
  walk(path.join(root, "tools/t3cp/merge.mjs"));
  // The runner's input contract: run-record.sh validates the spec against it on the VM.
  data.add("schema/record-spec-1.json");
  return [...code, ...data].sort();
}

test("EXPORTER_FILES is exactly the VM's export and merge closure: their imports and the data they read", () => {
  assert.deepEqual([...EXPORTER_FILES].sort(), closure());
});

test("the closure covers the record spec run-record.sh validates against, which the runner identity does not", () => {
  assert.ok(EXPORTER_FILES.includes("schema/record-spec-1.json"));
  const sh = fs.readFileSync(path.join(root, "tools/t3cp/run-record.sh"), "utf8");
  assert.match(sh, /schema\/record-spec-1\.json/, "run-record.sh reads the spec schema");
});

test("image-pin.json pins the closure hash: a commit that changes what the VM runs updates the pin with it, so a new image is built", async () => {
  const { exporterFilesSha256 } = await import("./export.mjs");
  const pin = JSON.parse(fs.readFileSync(path.join(root, "tools/t3cp/image-pin.json"), "utf8"));
  assert.equal(pin.schema, "t3cp/image-pin/1");
  assert.ok(!EXPORTER_FILES.includes("tools/t3cp/image-pin.json"), "the pin is outside what it pins");
  assert.equal(pin.exporter_files_sha256, exporterFilesSha256(), "VM-side files changed: update tools/t3cp/image-pin.json (and build an image from this commit)");
});

test("image-pin.mjs: --print prints the tree's closure hash; --check exits 0 when the pin matches, 2 when it does not", async () => {
  const { spawnSync } = await import("node:child_process");
  const { exporterFilesSha256 } = await import("./export.mjs");
  const cli = path.join(root, "tools/t3cp/image-pin.mjs");
  const printed = spawnSync(process.execPath, [cli, "--print"], { encoding: "utf8" });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, `${exporterFilesSha256()}\n`);
  const check = spawnSync(process.execPath, [cli, "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const os = await import("node:os");
  const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-pin-")), "image-pin.json");
  fs.writeFileSync(other, JSON.stringify({ schema: "t3cp/image-pin/1", exporter_files_sha256: "0".repeat(64) }));
  const stale = spawnSync(process.execPath, [cli, "--check", "--pin", other], { encoding: "utf8" });
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /differs/);
  fs.writeFileSync(other, "{}");
  assert.equal(spawnSync(process.execPath, [cli, "--check", "--pin", other], { encoding: "utf8" }).status, 2, "a malformed pin");
  fs.rmSync(path.dirname(other), { recursive: true, force: true });
});

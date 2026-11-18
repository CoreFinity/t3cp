// Every quick runner test file cleans up what it creates under $TMPDIR. Each runs in its own process with TMPDIR
// pointing at a fresh, empty directory, which must be empty again when the file ends. (run-record.test.mjs and
// contract.test.mjs remove their own roots in their teardown; the refused --work case checks its stand-in scratch.)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !["run-record.test.mjs", "contract.test.mjs", "tmp-hygiene.test.mjs"].includes(f))
  .sort();

for (const file of files) {
  test(`${file} leaves nothing under $TMPDIR`, { timeout: 600_000 }, () => {
    const tmp = mkdtempSync(join(tmpdir(), "t3cp-hygiene-"));
    roots.push(tmp);
    const env = { ...process.env, TMPDIR: tmp };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [join(here, file)], { env, encoding: "utf8", timeout: 600_000, killSignal: "SIGKILL" });
    assert.equal(result.status, 0, `${file}: ${result.stdout.slice(-2000)}${result.stderr.slice(-2000)}`);
    assert.deepEqual(readdirSync(tmp), [], `${file} left these behind`);
  });
}

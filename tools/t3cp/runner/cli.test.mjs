// The runner's node scripts run their command line however they are reached: through a symlinked directory (a VM's
// /t3cp pointing at its NVMe mount) or a path with a space. Started some other way they used to do nothing and exit
// 0, so the runner read empty values.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "t3cp-cli-"));
after(() => rmSync(root, { recursive: true, force: true }));

const spec = join(root, "spec.json");
writeFileSync(
  spec,
  JSON.stringify({
    schema: "t3cp/record-spec/1",
    record_id: "2026-11-16.linux-x64.nightly",
    kind: "nightly",
    release: { tag: "v0.1.10-nightly.20261116.4761", sha: "a".repeat(40), version: "0.1.10-nightly.20261116.4761", archive_name: "t3.tar.gz", archive_sha256: "b".repeat(64), archive_path: "/nowhere/t3.tar.gz" },
    fixture: { id: "none" },
    suite: { id: "val-cli", levels: [1], attempts_per_level: 1, empty_cell: false, warmup_s: 0, window_s: 10, extras: false },
    now: "2026-11-17T00:00:00Z",
    seed: "1",
  }),
);
const log = join(root, "server.log");
writeFileSync(log, "[10:00:00.000] INFO (#1): Migrations ran successfully\n");

for (const [what, link] of [
  ["a symlinked directory", "linked"],
  ["a path with a space", "with space"],
]) {
  test(`lib.mjs, profiles.mjs and migration-log.mjs run their command line when reached through ${what}`, () => {
    const dir = join(root, link);
    symlinkSync(here, dir);
    const lib = spawnSync(process.execPath, [join(dir, "lib.mjs"), "spec-sh", spec], { encoding: "utf8" });
    assert.equal(lib.status, 0, lib.stderr);
    assert.match(lib.stdout, /^RECORD_ID='2026-11-16\.linux-x64\.nightly'$/m);
    const profiles = spawnSync(process.execPath, [join(dir, "profiles.mjs"), "default"], { encoding: "utf8" });
    assert.equal(profiles.status, 0, profiles.stderr);
    assert.equal(profiles.stdout.trim(), "real3");
    const migrations = spawnSync(process.execPath, [join(dir, "migration-log.mjs"), log], { encoding: "utf8" });
    assert.equal(migrations.status, 0, migrations.stderr);
    assert.equal(JSON.parse(migrations.stdout).finished, true);
  });
}

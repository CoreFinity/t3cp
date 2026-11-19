// procmon.py, the Linux /proc sidecar of each run.ts invocation: when the bench server is gone it writes
// server-exit.json and deletes the run's database copy (its page cache would crowd out the fixture's), unless the
// cell reads that database after the try (--keep-db: the compaction row's prune-mark post step).
// Everything here ends by itself: a stand-in server (argv[0] "t3", "serve --base-dir <run>/base") and a stand-in
// parent sleep a few seconds, and procmon leaves when its parent is gone. No test signals anything.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skip = process.platform !== "linux" ? "procmon reads /proc (Linux only)" : false;
const root = mkdtempSync(join(tmpdir(), "t3cp-procmon-"));
after(() => rmSync(root, { recursive: true, force: true }));

const exited = (child) => new Promise((resolve) => child.on("exit", (code) => resolve(code)));

/** One run.ts work dir with a run's database and its WAL and SHM; procmon over a server that lives ~2 s. */
async function monitor(name, extra) {
  const work = join(root, name, "work");
  const run = join(work, "runs", "release", "attempt-1");
  const userdata = join(run, "base", "userdata");
  mkdirSync(userdata, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) writeFileSync(join(userdata, `statev2.sqlite${suffix}`), "x");
  const parent = spawn("sleep", ["6"], { stdio: "ignore" });
  const parentExit = exited(parent);
  const procmon = spawn(
    "python3",
    ["-I", join(here, "procmon.py"), "--work", work, "--parent-pid", String(parent.pid), "--log", join(root, `${name}.log`), ...extra],
    { stdio: "ignore" },
  );
  // Listened for at once: a procmon that refuses its arguments exits before anything else happens.
  const procmonExit = exited(procmon);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const server = spawn("bash", ["-c", 'exec -a t3 python3 -c "import time; time.sleep(2)" serve --base-dir "$1"', "server", join(run, "base")], { stdio: "ignore" });
  await exited(server);
  await parentExit;
  assert.equal(await procmonExit, 0);
  return { run, userdata };
}

test("when the server is gone, procmon writes server-exit.json and deletes the run's database copy", { skip, timeout: 60_000 }, async () => {
  const { run, userdata } = await monitor("default", []);
  assert.ok(existsSync(join(run, "server-exit.json")));
  for (const suffix of ["", "-wal", "-shm"]) assert.ok(!existsSync(join(userdata, `statev2.sqlite${suffix}`)), suffix || "db");
});

test("with --keep-db it keeps the database (and its WAL) for the cell's post step", { skip, timeout: 60_000 }, async () => {
  const { run, userdata } = await monitor("keep", ["--keep-db"]);
  assert.ok(existsSync(join(run, "server-exit.json")));
  for (const suffix of ["", "-wal", "-shm"]) assert.ok(existsSync(join(userdata, `statev2.sqlite${suffix}`)), suffix || "db");
});

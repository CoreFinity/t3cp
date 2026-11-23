// procmon.py, the Linux /proc sidecar of each run.ts invocation: when the bench server is gone it writes
// server-exit.json and deletes the run's database copy (its page cache would crowd out the fixture's), unless the
// cell reads that database after the try (--keep-db: the compaction row's prune-mark post step).
// Each step waits for what procmon did, never for a time: a stand-in server (argv[0] "t3", "serve --base-dir
// <run>/base") and a stand-in parent each live until the test closes their stdin, the server once procmon has sampled
// it, the parent once the server is gone; procmon leaves when its parent is gone. (Fixed sleeps - a parent of 6 s, a
// server of 2 s started 1.5 s in - assumed procmon starts and scans within them; a loaded host broke that.) No test
// signals anything. Every wait ends when the test is cancelled (its timeout aborts t.signal), so a failing or timed-out
// test still closes both stdins: the stand-ins then end, procmon with its parent, and none keeps the test process up.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skip = process.platform !== "linux" ? "procmon reads /proc (Linux only)" : false;
const root = mkdtempSync(join(tmpdir(), "t3cp-procmon-"));
after(() => rmSync(root, { recursive: true, force: true }));

const exited = (child) => new Promise((resolve) => child.on("exit", (code) => resolve(code)));
/** Rejects when the test is cancelled: no wait in a test outlives it. */
const cancelled = (signal) =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
/** The promise's value, unless the test is cancelled first. */
const settle = (promise, signal) => Promise.race([promise, cancelled(signal)]);
/** Resolves once fn() is true, looking every 50 ms; rejects when the test is cancelled. */
const until = async (fn, signal) => {
  while (!fn()) await delay(50, undefined, { signal });
};
/** The lines of a file so far (none before it exists). */
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

/** One run.ts work dir with a run's database and its WAL and SHM; procmon over a server that lives until it is seen. */
async function monitor(name, extra, signal) {
  const work = join(root, name, "work");
  const run = join(work, "runs", "release", "attempt-1");
  const userdata = join(run, "base", "userdata");
  mkdirSync(userdata, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) writeFileSync(join(userdata, `statev2.sqlite${suffix}`), "x");
  // Each lives until its stdin is closed.
  const parent = spawn("sh", ["-c", "read _"], { stdio: ["pipe", "ignore", "ignore"] });
  const parentExit = exited(parent);
  const server = spawn("bash", ["-c", 'exec -a t3 python3 -c "import sys; sys.stdin.read()" serve --base-dir "$1"', "server", join(run, "base")], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const serverExit = exited(server);
  const children = [parent, server];
  try {
    const procmon = spawn(
      "python3",
      ["-I", join(here, "procmon.py"), "--work", work, "--parent-pid", String(parent.pid), "--log", join(root, `${name}.log`), ...extra],
      { stdio: "ignore" },
    );
    children.push(procmon);
    // Listened for at once: a procmon that refuses its arguments exits before anything else happens.
    let procmonCode;
    const procmonExit = exited(procmon).then((code) => (procmonCode = code));
    // Followed: its meta line and a first sample of the live server.
    const samples = join(run, "proc-1hz.ndjson");
    await until(() => lines(samples).length >= 2 || procmonCode !== undefined, signal);
    assert.ok(lines(samples).length >= 2, `procmon exited ${procmonCode} before it sampled the server`);
    server.stdin.end();
    await settle(serverExit, signal);
    parent.stdin.end();
    await settle(parentExit, signal);
    assert.equal(await settle(procmonExit, signal), 0);
    return { run, userdata };
  } finally {
    // Closed stdins end the stand-ins, and procmon leaves once its parent is gone: none may hold the test process.
    server.stdin.end();
    parent.stdin.end();
    for (const child of children) child.unref();
  }
}

test("when the server is gone, procmon writes server-exit.json and deletes the run's database copy", { skip, timeout: 300_000 }, async (t) => {
  const { run, userdata } = await monitor("default", [], t.signal);
  assert.ok(existsSync(join(run, "server-exit.json")));
  for (const suffix of ["", "-wal", "-shm"]) assert.ok(!existsSync(join(userdata, `statev2.sqlite${suffix}`)), suffix || "db");
});

test("with --keep-db it keeps the database (and its WAL) for the cell's post step", { skip, timeout: 300_000 }, async (t) => {
  const { run, userdata } = await monitor("keep", ["--keep-db"], t.signal);
  assert.ok(existsSync(join(run, "server-exit.json")));
  for (const suffix of ["", "-wal", "-shm"]) assert.ok(existsSync(join(userdata, `statev2.sqlite${suffix}`)), suffix || "db");
});

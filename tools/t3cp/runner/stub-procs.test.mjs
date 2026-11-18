// The runner tests' teardown: it stops the groups and pids a test started, and nothing else.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { carrying, owner, spawnInGroup, teardown } from "./stub-procs.mjs";

const exited = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve));
/** Resolves true when fn() is, false after ms. */
async function eventually(fn, ms) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

test("the teardown stops a started group and a recorded pid that carry the root, then removes the root", { timeout: 600_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "t3cp-procs-"));
  const o = owner(root, join(root, "work"));
  // A runner-like group (the shell carries the root in its arguments) and a stub that recorded its own pid.
  const group = spawnInGroup(o, "sh", ["-c", "sleep 600 & wait", root], { stdio: "ignore" });
  const stub = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", root], { stdio: "ignore", detached: true });
  writeFileSync(join(o.stubPids, String(stub.pid)), "");
  // What the runner records under <work>/pids.
  const tracked = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", root], { stdio: "ignore", detached: true });
  mkdirSync(o.tracked, { recursive: true });
  writeFileSync(join(o.tracked, "run-1-1.pid"), `${tracked.pid}\n`);
  try {
    // A child shows the root only once it has exec'd (before that, ps shows its parent's command line): wait for all
    // three, as a test's end always comes long after what it started is running.
    assert.ok(await eventually(() => carrying(o).length >= 3, 300_000), carrying(o).join("\n"));
    await teardown(o);
    const all = Promise.all([exited(group), exited(stub), exited(tracked)]).then(() => true);
    assert.ok(await Promise.race([all, new Promise((resolve) => setTimeout(() => resolve(false), 60_000))]), "each one stopped");
    assert.deepEqual(carrying(o), []);
    assert.ok(!existsSync(root));
  } finally {
    for (const child of [group, stub, tracked]) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("the teardown never signals a recorded pid that no longer carries the test's root", { timeout: 600_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "t3cp-procs-"));
  const o = owner(root, join(root, "work"));
  // Stands in for a recycled pid: recorded by the test, but now running something that is not the test's.
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  try {
    o.groups.add(other.pid);
    writeFileSync(join(o.stubPids, String(other.pid)), "");
    await teardown(o, { waitMs: 1000 });
    assert.equal(other.exitCode, null);
    assert.equal(other.signalCode, null);
    process.kill(other.pid, 0); // still running
  } finally {
    other.kill("SIGKILL");
    await exited(other);
    rmSync(root, { recursive: true, force: true });
  }
});

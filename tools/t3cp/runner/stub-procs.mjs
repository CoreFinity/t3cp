// The processes a runner test starts, and the teardown that stops them (used by the runner's tests only).
//
// A test owns a temp root. Every runner it starts leads its own process group, every stub run.ts writes its pid
// under <root>/stub-pids when it starts, and the runner itself records the groups it launches under
// <work>/pids/*.pid. The teardown signals exactly those groups and pids, each only while a process in it still
// carries the root on its command line (so a recycled pid is never touched), waits for them to be gone, then
// removes the root. Nothing is ever chosen by matching a command line: the ids are the ones the test started.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The owner of a test's processes: its root (as given and resolved), the stubs' pid dir, its runners' groups. */
export function owner(root, work) {
  const stubPids = join(root, "stub-pids");
  mkdirSync(stubPids, { recursive: true });
  return { root, real: realpathSync(root), stubPids, tracked: join(work, "pids"), groups: new Set() };
}

/** Env for the stubs: where a stub records its pid, and the test process it must not outlive. */
export const stubEnv = (o) => ({ STUB_PIDS: o.stubPids, STUB_TEST_PID: String(process.pid) });

/**
 * The first lines of a stub run.ts (node:fs as fs, node:path as path): it records its pid, and it ends once the
 * test process is gone, so not even a test file that is itself killed leaves a stub behind.
 */
export const STUB_PRELUDE = `if (process.env.STUB_PIDS) fs.writeFileSync(path.join(process.env.STUB_PIDS, String(process.pid)), "");
if (process.env.STUB_TEST_PID) {
  setInterval(() => {
    try {
      process.kill(Number(process.env.STUB_TEST_PID), 0);
    } catch (error) {
      if (error.code === "ESRCH") process.exit(5);
    }
  }, 1000).unref();
}
`;

/** pid, process group, command line of every running process (zombies left out). */
function processes() {
  const out = spawnSync("ps", ["-ww", "-A", "-o", "pid=,pgid=,stat=,command="], { encoding: "utf8" }).stdout ?? "";
  const rows = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m && !m[3].startsWith("Z")) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), command: m[4] });
  }
  return rows;
}

const carries = (o, command) => command.includes(o.root) || command.includes(o.real);

/** Processes whose command line carries the owner's root: a check only, never a reason to signal anything. */
export function carrying(o) {
  return processes()
    .filter((p) => carries(o, p.command))
    .map((p) => `${p.pid} ${p.command.slice(0, 160)}`);
}

/** Runs a command to its end in a process group of its own, bounded by options.timeout. */
export function runInGroup(o, file, args, options) {
  const result = spawnSync(file, args, { ...options, detached: true });
  if (result.pid) o.groups.add(result.pid);
  return result;
}

/** Starts a command in a process group of its own. */
export function spawnInGroup(o, file, args, options) {
  const child = spawn(file, args, { ...options, detached: true });
  if (child.pid) o.groups.add(child.pid);
  return child;
}

/** Every group or pid the test started: its runners, its stubs, and what its runners recorded launching. */
function started(o) {
  const ids = new Set(o.groups);
  if (existsSync(o.stubPids)) for (const f of readdirSync(o.stubPids)) if (/^\d+$/.test(f)) ids.add(Number(f));
  if (existsSync(o.tracked)) {
    for (const f of readdirSync(o.tracked)) {
      if (!f.endsWith(".pid")) continue;
      const pid = readFileSync(join(o.tracked, f), "utf8").trim();
      if (/^\d+$/.test(pid)) ids.add(Number(pid));
    }
  }
  return ids;
}

const signal = (id) => {
  try {
    process.kill(id, "SIGKILL");
  } catch {
    // already gone
  }
};

/** SIGKILLs each group and pid the test started that still runs something carrying its root. */
export function stopStarted(o) {
  const ids = started(o);
  const running = processes();
  for (const id of ids) {
    if (running.some((p) => p.pgid === id && carries(o, p.command))) signal(-id);
    const self = running.find((p) => p.pid === id);
    if (self && carries(o, self.command)) signal(id);
  }
}

/** The end of a test: stop what it started, wait (at most waitMs) until nothing carrying its root runs, remove it. */
export async function teardown(o, { waitMs = 60_000 } = {}) {
  stopStarted(o);
  const deadline = Date.now() + waitMs;
  while (carrying(o).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stopStarted(o);
  }
  rmSync(o.root, { recursive: true, force: true });
}

// t3cp record extras: start the release's server directly, as a user's launcher does (no bootstrap descriptor,
// no preload, no Node options from the environment), on a scratch base dir, and stop it again.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/** A free TCP port on the loopback interface. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Copy a file sharing its blocks where the filesystem can (XFS reflink, APFS clone); says which it did. The copy is
 * made writable (0644): a server opens it read-write, and a published fixture is read-only (0444).
 */
export function cloneFile(src, dst) {
  const attempts =
    process.platform === "darwin"
      ? [["clone", ["-c", src, dst]], ["copy", [src, dst]]]
      : [["reflink", ["--reflink=always", src, dst]], ["copy", [src, dst]]];
  for (const [how, argv] of attempts) {
    if (spawnSync("cp", argv, { stdio: "ignore" }).status === 0) {
      chmodSync(dst, 0o644);
      return how;
    }
  }
  throw new Error("copy failed");
}

/**
 * Starts `<t3> serve --mode web --base-dir <base> --port <port> --host 127.0.0.1` in its own process group, with a
 * clean environment (PATH only, plus `env`), HOME and cwd under <dir>. Output goes to <dir>/server.log and to the
 * returned `output()` (the text so far).
 */
export function startServer({ t3, dir, base, port, env = {} }) {
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "cwd"), { recursive: true });
  const log = createWriteStream(join(dir, "server.log"));
  let text = "";
  const child = spawn(t3, ["serve", "--mode", "web", "--base-dir", base, "--port", String(port), "--host", "127.0.0.1"], {
    cwd: join(dir, "cwd"),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(dir, "home"),
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      ...env,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onData = (chunk) => {
    text += chunk.toString("utf8");
    log.write(chunk);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  // The runner tracks every server a helper starts (T3CP_TRACK_DIR, its pids directory): a runner killed while the
  // server runs leaves it to the restart, which stops its group before anything else (run-record.sh reap_leftovers).
  const tracked = process.env.T3CP_TRACK_DIR && child.pid ? join(process.env.T3CP_TRACK_DIR, `server-${child.pid}.pid`) : null;
  if (tracked) writeFileSync(tracked, `${child.pid}\n`);
  let gone = false;
  exited.then(() => {
    gone = true;
    if (tracked) rmSync(tracked, { force: true });
  });
  return {
    child,
    exited,
    isGone: () => gone,
    output: () => text,
    closeLog: () => new Promise((resolve) => log.end(resolve)),
  };
}

/** SIGTERM to the process group, SIGKILL after graceMs; resolves {killed, ms}. */
export async function stopServer(server, graceMs) {
  const t0 = Date.now();
  if (server.isGone()) return { killed: false, ms: 0 };
  try {
    process.kill(-server.child.pid, "SIGTERM");
  } catch {
    // already gone
  }
  const timer = new Promise((resolve) => setTimeout(() => resolve("timeout"), graceMs));
  const outcome = await Promise.race([server.exited.then(() => "exited"), timer]);
  let killed = false;
  if (outcome === "timeout") {
    killed = true;
    try {
      process.kill(-server.child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await server.exited;
  } else {
    // children of the server that outlived it
    try {
      process.kill(-server.child.pid, "SIGKILL");
    } catch {
      // the group is empty
    }
  }
  return { killed, ms: Date.now() - t0 };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

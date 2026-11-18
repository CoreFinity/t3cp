#!/usr/bin/env node
// t3cp record extras: startup as a user's launcher starts the server (`t3 serve`, no Node options, no bootstrap,
// Info log level), timed in milliseconds from process start:
//   listening_ms   to the "Listening on" log line
//   accept_ms      to the port accepting a TCP connection (polled every 20 ms)
//   db_ready_ms    to the Sqlite.setup span in the trace (database set up and migrated)
// For each fixture (the era fixture as published, when there is one, and an empty database) and each of --runs
// copies: phase "cold" is the first start on a fresh copy (the release's own migrations from the fixture's head,
// or from nothing, as a user sees once after an upgrade or an install), phase "warm" the next start on the same,
// now-migrated copy. Fixtures alternate copy by copy. After each start the server's process group is stopped
// (SIGTERM, SIGKILL after 5 s: "killed"). A start that misses a mark within --budget-s records null for it with a
// reason, never 0. A release that writes no database setup span (every nightly before 11-01 .4035) cannot give
// db_ready: once the server listens and accepts, a start waits DB_READY_GRACE_MS more for the span (it is written
// before the server listens), then records db_ready null with no_setup_span. --total-budget-s caps all starts
// together: a start cut short by it, or one it leaves no time for, records extra_timeout and startup.json says
// timed_out. startup.json is rewritten after every start, so a stopped run keeps the starts that finished.
// usage: startup.mjs --t3 <release>/t3 --work <dir> --out <startup.json> [--fixture <era sqlite>] [--runs 3]
//                    [--budget-s 900] [--total-budget-s <s>]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { writeJsonAtomic } from "./lib.mjs";
import { cloneFile, freePort, sleep, startServer, stopServer } from "./server.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const t3 = flag("--t3");
const work = flag("--work");
const out = flag("--out");
const fixture = flag("--fixture");
const runs = Number(flag("--runs", "3"));
const budgetMs = Number(flag("--budget-s", "900")) * 1000;
const totalBudgetMs = flag("--total-budget-s") === undefined ? Infinity : Number(flag("--total-budget-s")) * 1000;
const DB_READY_GRACE_MS = 10_000;
const began = performance.now();
if (!t3 || !work || !out) {
  process.stderr.write("startup.mjs: --t3, --work and --out are required\n");
  process.exit(2);
}

function setupSpans(base) {
  const logs = join(base, "userdata", "logs");
  if (!existsSync(logs)) return 0;
  let n = 0;
  for (const name of readdirSync(logs)) {
    if (!name.startsWith("server.trace.ndjson")) continue;
    try {
      n += readFileSync(join(logs, name), "utf8").split('"Sqlite.setup"').length - 1;
    } catch {
      // rotated away mid-read
    }
  }
  return n;
}

const accepts = (port) =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

const MARKS = ["listening_ms", "accept_ms", "db_ready_ms"];
/** A start the total budget left no time for: never begun, every mark null with extra_timeout. */
const notStarted = (label, phase, n) => ({
  fixture: label,
  phase,
  n,
  listening_ms: null,
  accept_ms: null,
  db_ready_ms: null,
  killed: false,
  reasons: Object.fromEntries(MARKS.map((key) => [key, "extra_timeout"])),
});

async function oneStart(label, phase, n, dir, base, startBudgetMs, cutByTotal) {
  const spans0 = setupSpans(base);
  const port = await freePort();
  const t0 = performance.now();
  const server = startServer({ t3, dir, base, port, env: { T3CODE_LOG_LEVEL: "Info" } });
  let listening = null;
  let accept = null;
  let dbReady = null;
  let lastPoll = 0;
  let noSpan = false;
  while (performance.now() - t0 < startBudgetMs && !server.isGone()) {
    const at = () => Math.round(performance.now() - t0);
    if (accept === null && (await accepts(port))) accept = at();
    if (listening === null && server.output().includes("Listening on")) listening = at();
    // The trace is read at most every 100 ms; the poll itself costs a file read per trace file.
    if (dbReady === null && performance.now() - lastPoll >= 100) {
      lastPoll = performance.now();
      if (setupSpans(base) > spans0) dbReady = at();
    }
    if (accept !== null && listening !== null && dbReady !== null) break;
    if (accept !== null && listening !== null && performance.now() - t0 - Math.max(accept, listening) >= DB_READY_GRACE_MS) {
      noSpan = true;
      break;
    }
    await sleep(20);
  }
  const gone = server.isGone();
  const stopped = await stopServer(server, 5000);
  await server.closeLog();
  const why = gone ? "server_exited" : cutByTotal ? "extra_timeout" : "not_reached_within_budget";
  const reasons = {};
  if (listening === null) reasons.listening_ms = why;
  if (accept === null) reasons.accept_ms = why;
  if (dbReady === null) reasons.db_ready_ms = noSpan ? "no_setup_span" : why;
  return { fixture: label, phase, n, listening_ms: listening, accept_ms: accept, db_ready_ms: dbReady, killed: stopped.killed, reasons };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const fixtures = fixture ? ["era", "empty"] : ["empty"];
const starts = [];
rmSync(work, { recursive: true, force: true });
for (let n = 1; n <= runs; n++) {
  for (const label of n % 2 === 1 ? fixtures : [...fixtures].reverse()) {
    const dir = join(work, `${label}-${n}`);
    const base = join(dir, "base");
    for (const phase of ["cold", "warm"]) {
      const left = totalBudgetMs - (performance.now() - began);
      let row;
      if (left <= 0) {
        row = notStarted(label, phase, n);
      } else {
        if (phase === "cold") {
          mkdirSync(join(base, "userdata"), { recursive: true });
          if (label === "era") cloneFile(fixture, join(base, "userdata", "statev2.sqlite"));
        }
        row = await oneStart(label, phase, n, join(dir, phase), base, Math.min(budgetMs, left), left < budgetMs);
      }
      starts.push(row);
      process.stdout.write(`${JSON.stringify(row)}\n`);
      writeJsonAtomic(out, document());
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** startup.json as it stands: the starts so far, their summary, and timed_out when the total budget cut any. */
function document() {
  const summary = {};
  for (const label of fixtures) {
    summary[label] = {};
    for (const phase of ["cold", "warm"]) {
      const rows = starts.filter((r) => r.fixture === label && r.phase === phase);
      summary[label][phase] = {};
      for (const key of ["listening_ms", "accept_ms", "db_ready_ms"]) {
        const values = rows.map((r) => r[key]).filter((v) => typeof v === "number");
        summary[label][phase][key] = {
          median: median(values),
          min: values.length ? Math.min(...values) : null,
          max: values.length ? Math.max(...values) : null,
          n: values.length,
          of: rows.length,
        };
      }
    }
  }
  const timedOut = starts.some((r) => Object.values(r.reasons).includes("extra_timeout"));
  return { schema: "t3cp/extras-startup/1", runs, budget_s: budgetMs / 1000, starts, summary, ...(timedOut ? { timed_out: true } : {}) };
}
writeJsonAtomic(out, document());
const missing = starts.filter((r) => Object.keys(r.reasons).length > 0).length;
process.exit(missing === 0 ? 0 : 1);

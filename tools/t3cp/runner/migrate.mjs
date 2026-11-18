#!/usr/bin/env node
// t3cp record runner, step 2 and the migration extra: migrate the era fixture once with the release.
// usage: migrate.mjs --t3 <release>/t3 --fixture <era statev2.sqlite> --dest <dir> --out <migration.json>
//                    --sampler <migration-sampler.tsv> --fixture-id <id> [--fixture-migration <n>] [--budget-s 3600]
// A reflink copy of the fixture goes to <dest>/base/userdata/statev2.sqlite; the server starts on it (Info log
// level, its own HOME, cwd and SQLite temp directory) until /.well-known/t3/environment answers 200, then stops.
// A 1 Hz sampler records db, -wal and -shm sizes, temp files, free space and RSS (<sampler>, TSV). The per-migration
// seconds and the chain come from the server's own log lines (migration-log.mjs); releases whose log has no chain
// lines take the chain from the trace's runMigrations span. The migrated file is checkpointed (no -wal left) and is
// the source of every attempt's restore. Exit 0 when the server became ready and the database is usable.
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./lib.mjs";
import { parseMigrationLog } from "./migration-log.mjs";
import { cloneFile, freePort, sleep, startServer, stopServer } from "./server.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const t3 = flag("--t3");
const fixture = flag("--fixture");
const dest = flag("--dest");
const out = flag("--out");
const samplerFile = flag("--sampler");
const fixtureId = flag("--fixture-id", "unknown");
const fixtureMigration = flag("--fixture-migration") ? Number(flag("--fixture-migration")) : null;
const budgetMs = Number(flag("--budget-s", "3600")) * 1000;
if (!t3 || !fixture || !dest || !out || !samplerFile) {
  process.stderr.write("migrate.mjs: --t3, --fixture, --dest, --out and --sampler are required\n");
  process.exit(2);
}

const base = join(dest, "base");
const userdata = join(base, "userdata");
const tmp = join(dest, "tmp");
const db = join(userdata, "statev2.sqlite");
rmSync(dest, { recursive: true, force: true });
mkdirSync(userdata, { recursive: true });
mkdirSync(tmp, { recursive: true });
const copy = cloneFile(fixture, db);
const size = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
};
const freeBytes = () => {
  const s = statfsSync(dest);
  return s.bavail * s.bsize;
};
const dbInitial = size(db);
const fsInitial = freeBytes();

const port = await freePort();
const server = startServer({
  t3,
  dir: dest,
  base,
  port,
  env: { T3CODE_LOG_LEVEL: "Info", SQLITE_TMPDIR: tmp, TMPDIR: tmp },
});
const t0 = Date.now();

function tempBytes(pid) {
  // Linux: temp files the server holds open (under the temp dir, SQLite's etilqs_ names, or deleted).
  let bytes = 0;
  for (const entry of readdirSync(tmp, { withFileTypes: true })) if (entry.isFile()) bytes += size(join(tmp, entry.name));
  if (process.platform !== "linux") return bytes;
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      let target;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (target.includes(db)) continue;
      if (target.includes("etilqs_") || (target.endsWith(" (deleted)") && target.startsWith("/") && !target.startsWith(tmp))) {
        bytes += size(`/proc/${pid}/fd/${fd}`);
      }
    }
  } catch {
    // the process is gone
  }
  return bytes;
}
function rss(pid) {
  if (process.platform !== "linux") return -1;
  try {
    const m = /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) * 1024 : -1;
  } catch {
    return -1;
  }
}

const rows = [];
let ready = false;
const sampler = setInterval(() => {
  const row = {
    t: Date.now(),
    db: size(db),
    wal: size(`${db}-wal`),
    shm: size(`${db}-shm`),
    temp: tempBytes(server.child.pid),
    fs_free: freeBytes(),
    rss: rss(server.child.pid),
    ready: ready ? 1 : 0,
  };
  rows.push(row);
}, 1000);

let readyAt = null;
while (Date.now() - t0 < budgetMs && !server.isGone()) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, { signal: AbortSignal.timeout(2000) });
    await res.arrayBuffer();
    if (res.status === 200) {
      readyAt = Date.now();
      ready = true;
      break;
    }
  } catch {
    // not listening yet
  }
  await sleep(250);
}
const reasons = {};
if (readyAt === null) reasons.start_to_ready_ms = server.isGone() ? "server_exited" : "not_ready_within_budget";
const stopAt = Date.now();
const stopped = await stopServer(server, 300_000);
await sleep(1000);
clearInterval(sampler);
await server.closeLog();

const header = ["t", "db", "wal", "shm", "temp", "fs_free", "rss", "ready"];
writeFileSync(samplerFile, `${header.join("\t")}\n${rows.map((r) => header.map((k) => r[k]).join("\t")).join("\n")}\n`);

// The chain from the log; the runMigrations span from the trace (every era has it).
const parsed = parseMigrationLog(server.output());
let spanMs = null;
const logs = join(userdata, "logs");
if (existsSync(logs)) {
  for (const name of readdirSync(logs).filter((n) => n.startsWith("server.trace.ndjson")).sort()) {
    for (const line of readFileSync(join(logs, name), "utf8").split("\n")) {
      if (!line.includes('"runMigrations"')) continue;
      try {
        const span = JSON.parse(line);
        if (span.name === "runMigrations" && typeof span.durationMs === "number") {
          spanMs = spanMs === null ? span.durationMs : spanMs;
        }
      } catch {
        // a partial line
      }
    }
  }
}
if (spanMs === null) reasons.run_migrations_span_ms = "no_run_migrations_span";

// The migrated file: checkpointed and closed, and its head.
let toMigration = null;
try {
  const { DatabaseSync } = await import("node:sqlite");
  const handle = new DatabaseSync(db);
  handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  toMigration = handle.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()?.id ?? null;
  handle.close();
} catch (error) {
  reasons.to_migration = "database_unreadable";
  process.stderr.write(`migrate.mjs: ${error?.message ?? error}\n`);
}
if (size(`${db}-wal`) > 0) reasons.wal = "wal_not_checkpointed";

const extra = (r) => Math.max(0, r.db) + Math.max(0, r.wal) + Math.max(0, r.shm) + Math.max(0, r.temp) - dbInitial;
const during = rows.filter((r) => r.t <= (readyAt ?? stopAt) + 1000);
const peak = (f) => (during.length ? Math.max(...during.map(f)) : null);
const noPending = readyAt !== null && fixtureMigration !== null && toMigration !== null && toMigration === fixtureMigration;
let chainS = parsed.chain_s;
let chainSource = chainS === null ? null : "log";
if (chainS === null && spanMs !== null && !noPending) {
  chainS = Math.round(spanMs) / 1000;
  chainSource = "run_migrations_span";
}
const result = {
  schema: "t3cp/extras-migration/1",
  fixture_id: fixtureId,
  from_migration: fixtureMigration ?? parsed.from_migration,
  to_migration: toMigration ?? parsed.to_migration,
  // Numbered migrations only (the exporter keys them by id); a progress line without "<id>_<name>" is kept apart.
  migrations: parsed.migrations.filter((m) => m.id !== null),
  unnumbered_migrations: parsed.migrations.filter((m) => m.id === null),
  chain_s: chainS,
  chain_source: chainSource,
  run_migrations_span_ms: spanMs === null ? null : Math.round(spanMs * 10) / 10,
  start_to_ready_ms: readyAt === null ? null : readyAt - t0,
  peak_extra_disk_bytes: peak(extra),
  peak_wal_bytes: peak((r) => Math.max(0, r.wal)),
  peak_temp_bytes: peak((r) => Math.max(0, r.temp)),
  fs_used_delta_peak_bytes: peak((r) => fsInitial - r.fs_free),
  rss_peak_bytes: process.platform === "linux" ? peak((r) => r.rss) : null,
  db_initial_bytes: dbInitial,
  db_final_bytes: size(db),
  shutdown_s: stopped.killed ? null : Math.round(stopped.ms) / 1000,
  killed: stopped.killed,
  copy,
  samples: rows.length,
  reasons: { ...parsed.reasons, ...reasons },
};
if (noPending) {
  result.reasons.chain_s = "no_pending_migrations";
  result.reasons.migrations = "no_pending_migrations";
}
if (process.platform !== "linux") result.reasons.rss_peak_bytes = "not_measured_on_this_platform";
if (stopped.killed) result.reasons.shutdown_s = "killed_after_grace";
if (during.length === 0) result.reasons.peak_extra_disk_bytes = "no_samples";
writeJsonAtomic(out, result);
process.stdout.write(
  `migration: ${result.migrations.length} migrations, chain ${result.chain_s} s (${result.chain_source}), ready ${result.start_to_ready_ms} ms, peak extra ${result.peak_extra_disk_bytes} B\n`,
);
process.exit(readyAt !== null && toMigration !== null && !reasons.wal ? 0 : 1);

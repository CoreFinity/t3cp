// The migration chain from the server's own log (record extras). The server's console logger prints
//   [HH:MM:SS.mmm] INFO (#fiber): Running database migrations
//   [HH:MM:SS.mmm] INFO (#fiber): Upgrading database
//     migration: 77_RepairBooleanSettledOverride
//     progress: 1 of 19
//   ...
//   [HH:MM:SS.mmm] INFO (#fiber): Migrations ran successfully
//     migrations: [ '77_…', … ]
// at Info level. A migration lasts from its "Upgrading database" line to the next one, the last until
// "Migrations ran successfully"; the chain from "Running database migrations" to that line. Releases
// before the progress lines existed log only the start and the finish: the chain total is still known,
// the per-migration list is empty with a reason. Nothing unmeasured is ever 0: it is null, with a reason.
import { isMain } from "./is-main.mjs";

const ANSI = /\x1b\[[0-9;]*m/g;
const HEADER = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\] ([A-Z]+) \(#\d+\)[^:]*: ?(.*)$/;
const STARTED = "Running database migrations";
const PROGRESS = "Upgrading database";
const FINISHED = "Migrations ran successfully";

const round3 = (seconds) => Math.round(seconds * 1000) / 1000;

/** id and name of "77_RepairBooleanSettledOverride"; a name without a numeric id keeps id null. */
function splitMigration(text) {
  const match = /^(\d+)_(.+)$/.exec(text);
  return match ? { id: Number(match[1]), name: match[2] } : { id: null, name: text };
}

/**
 * @param {string} text server stdout/stderr
 * @returns {{migrations: Array<{id: number|null, name: string, seconds: number|null}>, chain_s: number|null,
 *   started: boolean, finished: boolean, from_migration: number|null, to_migration: number|null,
 *   reasons: Record<string, string>}}
 */
export function parseMigrationLog(text) {
  const lines = text.replace(ANSI, "").split(/\r?\n/);
  // Times of day in ms, unwrapped across midnight (a chain never runs for 12 h).
  let dayOffset = 0;
  let previous = null;
  const unwrap = (ms) => {
    if (previous !== null && ms + dayOffset < previous - 12 * 3600 * 1000) dayOffset += 24 * 3600 * 1000;
    previous = ms + dayOffset;
    return previous;
  };

  let started = null;
  let finished = null;
  const progress = [];
  const finishedList = [];
  let current = null; // the header the indented annotation lines below belong to
  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header) {
      const ms = ((Number(header[1]) * 60 + Number(header[2])) * 60 + Number(header[3])) * 1000 + Number(header[4]);
      const at = unwrap(ms);
      const message = header[6].trim();
      current = null;
      if (message === STARTED && started === null) started = at;
      else if (message === PROGRESS) {
        current = { kind: "progress", entry: { at, migration: null } };
        progress.push(current.entry);
      } else if (message === FINISHED && finished === null) {
        finished = at;
        current = { kind: "finished" };
      }
      continue;
    }
    if (current === null || !/^\s/.test(line)) continue;
    if (current.kind === "progress" && current.entry.migration === null) {
      const match = /^\s+migration:\s*(\S+)/.exec(line);
      if (match) current.entry.migration = match[1];
    } else if (current.kind === "finished") {
      for (const match of line.matchAll(/'([^']+)'/g)) finishedList.push(match[1]);
    }
  }

  const reasons = {};
  const migrations = progress.map((entry, index) => {
    const end = index + 1 < progress.length ? progress[index + 1].at : finished;
    const { id, name } = splitMigration(entry.migration ?? "");
    return { id, name, seconds: end === null ? null : round3((end - entry.at) / 1000) };
  });
  if (migrations.some((m) => m.seconds === null)) reasons.last_migration = "chain_not_finished";
  if (progress.some((entry) => entry.migration === null)) reasons.migration_names = "progress_line_without_migration";

  let chainS = null;
  const chainStart = started ?? (progress.length > 0 ? progress[0].at : null);
  if (chainStart === null && finished === null) reasons.chain_s = "no_migration_lines";
  else if (finished === null) reasons.chain_s = "chain_not_finished";
  else chainS = round3((finished - (chainStart ?? finished)) / 1000);
  if (migrations.length === 0 && (started !== null || finished !== null)) reasons.migrations = "no_progress_lines";

  const ids = migrations.map((m) => m.id).filter((id) => id !== null);
  const finishedIds = finishedList.map((name) => splitMigration(name).id).filter((id) => id !== null);
  const toMigration = finishedIds.length > 0 ? Math.max(...finishedIds) : ids.length > 0 ? Math.max(...ids) : null;
  const fromMigration = ids.length > 0 ? Math.min(...ids) - 1 : null;
  return {
    migrations,
    chain_s: chainS,
    started: started !== null || progress.length > 0,
    finished: finished !== null,
    from_migration: fromMigration,
    to_migration: toMigration,
    reasons,
  };
}

// CLI: node migration-log.mjs <server.log> -> JSON on stdout.
if (isMain(import.meta.url)) {
  const { readFileSync } = await import("node:fs");
  process.stdout.write(`${JSON.stringify(parseMigrationLog(readFileSync(process.argv[2], "utf8")))}\n`);
}

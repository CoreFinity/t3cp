// t3cp record runner: a scenario record's cells, from the scenario catalogue (scenarios.json, schema
// t3cp/scenarios/1). A spec whose suite names a row (suite.scenario {id, version}) runs that row's cells in place of
// the ladder: its attempts cell by cell, round after round (<cell>-<n>), each with the cell's counts, mode, turn gap,
// warm-up, window, compaction seeding and post step. A row the catalogue does not have, or a retired one, is refused.
//   node scenarios.mjs order <catalogue> <id@version>                 SC_* shell assignments for run-record.sh
//   node scenarios.mjs sh <catalogue> <id@version> <cell> <meta file> P_* shell assignments for one cell, and the
//                                                                     cell's entry (scenario, profile ...) in <file>
// Exit 2, with the reason on stderr, for a row that cannot run (not in the catalogue, retired, malformed).
import { readFileSync, writeFileSync } from "node:fs";

import { isMain } from "./is-main.mjs";
import { loadProfiles } from "./profiles.mjs";

export const CATALOGUE_SCHEMA = "t3cp/scenarios/1";
/** Post steps a cell may name: what the runner reads from the kept run after each try (scenario-post.mjs). */
export const POSTS = ["none", "turn-start-gap", "prune-mark"];
/** Driver modes a cell may name. */
export const MODES = ["fresh", "history", "mixed"];

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const CELL = /^[a-z0-9][a-z0-9-]{0,30}$/;
const REF = /^([a-z0-9][a-z0-9-]{0,40})@([1-9][0-9]{0,5})$/;

const seconds = (duration) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(String(duration));
  if (!m) throw new Error(`not a duration: ${JSON.stringify(duration)}`);
  return Number(m[1]) * (m[2] === "ms" ? 0.001 : m[2] === "m" ? 60 : 1);
};

export function loadCatalogue(file) {
  const catalogue = JSON.parse(readFileSync(file, "utf8"));
  if (catalogue?.schema !== CATALOGUE_SCHEMA || !Array.isArray(catalogue.rows)) {
    throw new Error(`${file} is not a ${CATALOGUE_SCHEMA} catalogue`);
  }
  return catalogue;
}

/** The row named "id@version"; throws for a malformed ref, a row the catalogue does not have, or a retired row. */
export function scenarioRow(catalogue, ref) {
  const m = REF.exec(String(ref));
  if (!m) throw new Error(`scenario ${JSON.stringify(ref)} is not id@version`);
  const [id, version] = [m[1], Number(m[2])];
  const row = catalogue.rows.find((r) => r?.id === id && r?.version === version);
  if (!row) throw new Error(`scenario ${ref} is not in the catalogue`);
  // The ladder row (suite ladder-1) runs by the ladder path (profiles, extras), never as a scenario.
  if (row.suite !== `${id}@${version}`) {
    throw new Error(`scenario ${ref} is not a scenario row: its suite is ${JSON.stringify(row.suite ?? null)}, not ${ref}`);
  }
  if (row.status === "retired") throw new Error(`scenario ${ref} is retired`);
  if (!Number.isInteger(row.attempts) || row.attempts < 1 || row.attempts > 5) throw new Error(`scenario ${ref}: attempts must be 1 to 5`);
  if (typeof row.fixture !== "string" || !(row.fixture === "none" || NAME.test(row.fixture))) throw new Error(`scenario ${ref}: not a fixture id`);
  if (!Array.isArray(row.platforms) || row.platforms.some((p) => p !== "linux-x64" && p !== "darwin-arm64")) {
    throw new Error(`scenario ${ref}: platforms must be linux-x64 or darwin-arm64`);
  }
  if (!Array.isArray(row.cells) || row.cells.length === 0) throw new Error(`scenario ${ref}: no cells`);
  const names = row.cells.map((c) => c?.name);
  if (names.some((n) => typeof n !== "string" || !CELL.test(n)) || new Set(names).size !== names.length) {
    throw new Error(`scenario ${ref}: cell names must be unique, lower-case words`);
  }
  return row;
}

/** The row's attempts, cell by cell, round after round: <cell>-<n>. */
export function scenarioOrder(row) {
  const order = [];
  for (let n = 1; n <= row.attempts; n++) for (const c of row.cells) order.push({ cell: `${c.name}-${n}`, name: c.name, n });
  return order;
}

const count = (value, what) => {
  if (Number.isInteger(value) && value >= 0 && value <= 1000) return value;
  throw new Error(`${what}: not a count: ${JSON.stringify(value)}`);
};

/** The cell keys the runner runs; any other key would be ignored, so a cell carrying one is refused. */
export const CELL_KEYS = new Set([
  "name", "mode", "sessions", "subscribers", "pollers", "turn_gap", "warmup_s", "window_s", "seed_compacted_at", "post",
  "mark_age_days", "switch_interval", "poll_rate", "fixture",
]);

/** One cell of the row as the runner runs it: counts, mode, intervals, compaction seeding, post step, driver args. */
export function scenarioCell(row, name, profiles = loadProfiles()) {
  const ref = `${row.id}@${row.version}`;
  const c = row.cells.find((x) => x.name === name);
  if (!c) throw new Error(`scenario ${ref} has no cell ${name}`);
  const what = (k) => `scenario ${ref} cell ${name} ${k}`;
  const unknown = Object.keys(c).filter((k) => !CELL_KEYS.has(k));
  if (unknown.length > 0) throw new Error(`${what(unknown.join(", "))}: unknown cell key`);
  // Optional driver options (as the ladder's profiles set them) and an empty database for this cell alone.
  const switchInterval = c.switch_interval ?? null;
  if (switchInterval !== null) seconds(switchInterval);
  const pollRate = c.poll_rate ?? null;
  if (pollRate !== null && !(typeof pollRate === "string" && /^\d+(\.\d+)?$/.test(pollRate) && Number.isFinite(Number(pollRate)) && Number(pollRate) > 0)) {
    throw new Error(`${what("poll_rate")}: a positive number string, as "0.01"`);
  }
  if (c.fixture !== undefined && c.fixture !== "none") throw new Error(`${what("fixture")}: only "none" (an empty database)`);
  const emptyDatabase = c.fixture === "none" || row.fixture === "none";
  if (emptyDatabase && c.mode !== "fresh") throw new Error(`${what("mode")}: a cell on an empty database is fresh`);
  if (!MODES.includes(c.mode)) throw new Error(`${what("mode")}: not one of ${MODES.join(", ")}`);
  if (c.sessions < 1) throw new Error(`${what("sessions")}: at least 1`);
  if (!Number.isInteger(c.warmup_s) || c.warmup_s < 0 || c.warmup_s > 3600) throw new Error(`${what("warmup_s")}: 0 to 3600`);
  if (!Number.isInteger(c.window_s) || c.window_s < 10 || c.window_s > 14400) throw new Error(`${what("window_s")}: 10 to 14400`);
  if (typeof c.seed_compacted_at !== "boolean") throw new Error(`${what("seed_compacted_at")}: not a boolean`);
  if (!POSTS.includes(c.post)) throw new Error(`${what("post")}: not one of ${POSTS.join(", ")}`);
  // A prune-mark cell may name the age its fixture's prune mark is set to at each try's start (prune-mark.py
  // --set-age-days on the migrated fixture), so the record reads the row's age whenever it runs.
  const markAge = c.mark_age_days ?? null;
  if (markAge !== null && (!Number.isInteger(markAge) || markAge < 1 || markAge > 30)) {
    throw new Error(`${what("mark_age_days")}: an integer from 1 to 30`);
  }
  if (markAge !== null && c.post !== "prune-mark") throw new Error(`${what("mark_age_days")}: only a prune-mark cell sets the mark`);
  const pollers = count(c.pollers, what("pollers"));
  return {
    scenario: { id: row.id, version: row.version },
    cell: name,
    sessions: count(c.sessions, what("sessions")),
    subscribers: count(c.subscribers, what("subscribers")),
    pollers,
    mode: c.mode,
    turn_gap: c.turn_gap,
    turn_gap_s: seconds(c.turn_gap),
    warmup_s: c.warmup_s,
    window_s: c.window_s,
    seed_compacted_at: c.seed_compacted_at,
    post: c.post,
    mark_age_days: markAge,
    switch_interval: switchInterval,
    poll_rate: pollRate,
    // "none": this cell runs on an empty database; "row": on the row's fixture (itself possibly none).
    fixture: c.fixture === "none" ? "none" : "row",
    // Driver options, each token for its own --driver-arg= (run.ts takes the counts above zero itself), then the
    // driver arguments every cell of every record gets (profiles.json common_driver_args).
    driver_args: [
      "--mode",
      c.mode,
      ...(switchInterval === null ? [] : ["--switch-interval", switchInterval]),
      ...(pollRate === null ? [] : ["--poll-rate", pollRate]),
      "--turn-gap",
      c.turn_gap,
      ...(pollers === 0 ? ["--pollers", "0"] : []),
      ...profiles.common_driver_args,
    ],
  };
}

/** The cell's entry as the runner records it: attempt-meta.json's profile (the exporter's keys) and the scenario. */
export function cellMeta(cell) {
  return {
    scenario: cell.scenario,
    cell: cell.cell,
    warmup_s: cell.warmup_s,
    window_s: cell.window_s,
    seed_compacted_at: cell.seed_compacted_at,
    post: cell.post,
    mark_age_days: cell.mark_age_days,
    profile: {
      sessions: cell.sessions,
      subscribers: cell.subscribers,
      pollers: cell.pollers,
      mode: cell.mode,
      turn_gap_s: cell.turn_gap_s,
      switch_interval_s: cell.switch_interval === null ? null : seconds(cell.switch_interval),
      poll_interval_s: cell.poll_rate === null ? null : Math.round((1 / Number(cell.poll_rate)) * 1000) / 1000,
    },
  };
}

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const shell = (vars) => `${Object.entries(vars).map(([k, v]) => `${k}=${shq(v)}`).join("\n")}\n`;

if (isMain(import.meta.url)) {
  const [command, file, ref, cellName, metaOut] = process.argv.slice(2);
  try {
    if (command !== "order" && command !== "sh") throw new Error(`unknown command ${command}`);
    let catalogue;
    try {
      catalogue = loadCatalogue(file);
    } catch (error) {
      throw new Error(`the scenario catalogue cannot be read: ${error.message}`);
    }
    const row = scenarioRow(catalogue, ref);
    if (command === "order") {
      const order = scenarioOrder(row);
      process.stdout.write(
        shell({
          SC_ID: row.id,
          SC_VERSION: row.version,
          SC_FIXTURE: row.fixture,
          SC_PLATFORMS: row.platforms.join(" "),
          SC_ORDER: order.map((a) => a.cell).join(" "),
          SC_ATTEMPTS_TOTAL: order.length,
          SC_JSON: JSON.stringify({ id: row.id, version: row.version }),
        }),
      );
    } else {
      const cell = scenarioCell(row, cellName);
      process.stdout.write(
        shell({
          P_SESSIONS: cell.sessions,
          P_SUBSCRIBERS: cell.subscribers,
          P_POLLERS: cell.pollers,
          P_MODE: cell.mode,
          P_TURN_GAP: cell.turn_gap,
          P_FIXTURE: row.fixture === "none" || cell.fixture === "none" ? "none" : "era",
          P_DRIVER_ARGS: cell.driver_args.join(" "),
          P_WARMUP_S: cell.warmup_s,
          P_WINDOW_S: cell.window_s,
          P_SEED_COMPACTED: cell.seed_compacted_at ? 1 : 0,
          P_POST: cell.post,
          P_MARK_AGE_DAYS: cell.mark_age_days ?? "",
        }),
      );
      if (metaOut) writeFileSync(metaOut, `${JSON.stringify(cellMeta(cell))}\n`);
    }
  } catch (error) {
    process.stderr.write(`scenarios.mjs: ${error.message}\n`);
    process.exit(2);
  }
}

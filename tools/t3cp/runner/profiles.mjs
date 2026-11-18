// t3cp record runner: the load profile of one cell, from profiles.json (the table a spec's suite.profile names).
//   node profiles.mjs sh <profile> <cell> <fixture id> [<file>]   shell assignments P_* for run-record.sh (and the
//                                                       attempt-meta entry written to <file>)
//   node profiles.mjs json <profile> <cell> <fixture id> the cell's entry as attempt-meta.json records it
//   node profiles.mjs default                            the profile a spec without suite.profile runs
import { readFileSync, writeFileSync } from "node:fs";

import { isMain } from "./is-main.mjs";

const TABLE = new URL("./profiles.json", import.meta.url);

export function loadProfiles(file = TABLE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const seconds = (duration) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(duration));
  if (!m) throw new Error(`not a duration: ${duration}`);
  return Number(m[1]) * (m[2] === "ms" ? 0.001 : m[2] === "m" ? 60 : 1);
};

function count(value, level, what) {
  if (value === "L") return level;
  if (Number.isInteger(value) && value >= 0) return value;
  if (value && Number.isInteger(value.ceil_div) && value.ceil_div > 0) return Math.ceil(level / value.ceil_div);
  throw new Error(`profile ${what}: not a count rule: ${JSON.stringify(value)}`);
}

/**
 * @param profiles the table
 * @param id the profile id
 * @param cell "1", "50" ... or "1e"
 * @param fixtureId the record's fixture id ("none": every cell on an empty database)
 */
export function cellProfile(profiles, id, cell, fixtureId) {
  const profile = profiles.profiles[id];
  if (!profile) throw new Error(`unknown profile ${id}`);
  let entry;
  let level;
  if (cell === "1e") [entry, level] = [profile.empty, 1];
  else if (/^[1-9][0-9]*$/.test(cell)) {
    level = Number(cell);
    entry = level === 1 ? profile.single : profile.ladder;
  } else throw new Error(`not a cell: ${cell}`);
  const counts = cell !== "1e" && level !== 1 ? (profile.levels?.[cell] ?? entry) : entry;
  const fixture = cell === "1e" || fixtureId === "none" ? "none" : "era";
  const mode = fixture === "none" ? "fresh" : entry.mode;
  return {
    profile: id,
    cell,
    fixture,
    sessions: count(counts.sessions, level, "sessions"),
    subscribers: count(counts.subscribers, level, "subscribers"),
    pollers: count(counts.pollers, level, "pollers"),
    mode,
    turn_gap: entry.turn_gap,
    turn_gap_s: seconds(entry.turn_gap),
    // Driver options, each token for its own --driver-arg= (run.ts takes the counts above zero itself).
    driver_args: [
      "--mode",
      mode,
      "--switch-interval",
      entry.switch_interval,
      "--poll-rate",
      String(entry.poll_rate),
      "--turn-gap",
      entry.turn_gap,
      ...(count(counts.pollers, level, "pollers") === 0 ? ["--pollers", "0"] : []),
      ...profiles.common_driver_args,
    ],
  };
}

/** The cell's profile as attempt-meta.json records it (the exporter's allow-list: counts, mode and intervals). */
export function metaProfile(p) {
  const arg = (flag) => p.driver_args[p.driver_args.indexOf(flag) + 1];
  const rate = Number(arg("--poll-rate"));
  return {
    sessions: p.sessions,
    subscribers: p.subscribers,
    pollers: p.pollers,
    mode: p.mode,
    turn_gap_s: p.turn_gap_s,
    switch_interval_s: seconds(arg("--switch-interval")),
    poll_interval_s: rate > 0 ? Math.round((1 / rate) * 1000) / 1000 : null,
  };
}

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

if (isMain(import.meta.url)) {
  const [command, id, cell, fixtureId, jsonOut] = process.argv.slice(2);
  if (command === "default") {
    process.stdout.write(`${loadProfiles().default}\n`);
    process.exit(0);
  }
  try {
    const p = cellProfile(loadProfiles(), id, cell, fixtureId);
    if (command === "sh") {
      const vars = {
        P_SESSIONS: p.sessions,
        P_SUBSCRIBERS: p.subscribers,
        P_POLLERS: p.pollers,
        P_MODE: p.mode,
        P_TURN_GAP: p.turn_gap,
        P_FIXTURE: p.fixture,
        P_DRIVER_ARGS: p.driver_args.join(" "),
      };
      process.stdout.write(`${Object.entries(vars).map(([k, v]) => `${k}=${shq(v)}`).join("\n")}\n`);
      // sh <profile> <cell> <fixture> <file>: also writes the attempt-meta entry there (one process instead of two)
      if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(metaProfile(p))}\n`);
    } else if (command === "json") {
      process.stdout.write(`${JSON.stringify(metaProfile(p))}\n`);
    } else throw new Error(`unknown command ${command}`);
  } catch (error) {
    process.stderr.write(`profiles.mjs: ${error.message}\n`);
    process.exit(2);
  }
}

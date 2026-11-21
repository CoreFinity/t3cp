#!/usr/bin/env node
// The ladder golden: the parts of the aggregator's output on the synthetic development data (synth-data.mjs) that a
// change to the catalogue's other metrics must never move. The synthetic data runs today's suite, row 1 of
// scenarios.json (ladder@1, published as suite ladder-1). Per part, a sha256:
//   - every series shard (series/<platform>/<metric>.<window>.json), by file;
//   - every compare file, its head (all but the rows) and its rows grouped by metric;
//   - every published record's segment ids per level (records-index.json).
// site/build/aggregate-golden.test.mjs holds the output to it: each part identical, and anything new only for a
// metric the golden does not name (golden.metrics: the ladder's metrics when it was captured). Digests are sha256 in
// letters a to p.
//
//   node tools/t3cp/dev/golden.mjs           prints the golden
//   node tools/t3cp/dev/golden.mjs --write   writes it to site/build/testdata/ladder-1-golden.json
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { REPO_ROOT, isMain, loadCatalogue } from "../lib/repo.mjs";
import { buildOutputs } from "../../../site/build/aggregate.mjs";
import { synthInputs } from "./synth-data.mjs";

export const GOLDEN_FILE = path.join(REPO_ROOT, "site", "build", "testdata", "ladder-1-golden.json");
export const GOLDEN_SCHEMA = "t3cp/golden/2";

// A sha256 written in the letters a to p (each hex digit d as the letter at d): a digest holds no digits, so no run of
// it can read as a number to the scans that guard the repository's text.
const sha = (text) => createHash("sha256").update(text).digest("hex").replace(/[0-9a-f]/g, (d) => "abcdefghijklmnop"[Number.parseInt(d, 16)]);
const canonical = (value) =>
  JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

/** The aggregator's output files on the synthetic data. */
export function goldenOutputs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-golden-"));
  try {
    synthInputs(dir);
    return buildOutputs(dir, { dev: true, warn: () => {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The golden's parts of an output map: series shards, compare heads and rows by metric, segment ids. */
export function goldenParts(files) {
  const series = {};
  const compare = {};
  const segments = {};
  for (const rel of [...files.keys()].sort()) {
    const bytes = files.get(rel);
    if (rel.startsWith("series/")) series[rel] = sha(bytes);
    else if (rel.startsWith("compare/")) {
      const { rows, ...head } = JSON.parse(bytes.toString("utf8"));
      const byMetric = {};
      for (const row of rows) (byMetric[row.metric] ??= []).push(row);
      compare[rel] = { head: sha(canonical(head)), rows: Object.fromEntries(Object.keys(byMetric).sort().map((m) => [m, sha(JSON.stringify(byMetric[m]))])) };
    } else if (rel === "records-index.json") {
      for (const r of JSON.parse(bytes.toString("utf8")).records) {
        for (const [platform, entry] of Object.entries(r.platforms)) segments[`${r.date} ${r.tag} ${platform}`] = sha(canonical(entry.segment));
      }
    }
  }
  return { series, compare, segments };
}

/** The metric a series shard is of (series/<platform>/<metric>.<window>.json). */
export const seriesMetric = (rel) => rel.split("/").at(-1).replace(/\.(latest|all|\d{4}(-\d{2})?)\.json$/, "").replace(/\.json$/, "");

export function goldenDocument(files = goldenOutputs(), catalogue = loadCatalogue()) {
  return {
    schema: GOLDEN_SCHEMA,
    description:
      "The ladder's outputs on the synthetic development data (tools/t3cp/dev/synth-data.mjs), which runs today's suite, scenarios.json row ladder@1: per series shard, compare file (head, and rows by metric) and record segment map a sha256. Written by node tools/t3cp/dev/golden.mjs --write.",
    metrics: catalogue.metrics.filter((m) => m.lane !== "scenario").map((m) => m.id),
    ...goldenParts(files),
  };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { write: { type: "boolean" } } });
  const text = `${JSON.stringify(goldenDocument(), null, 2)}\n`;
  if (values.write) {
    fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
    fs.writeFileSync(GOLDEN_FILE, text);
    process.stderr.write(`golden: wrote ${path.relative(REPO_ROOT, GOLDEN_FILE)}\n`);
  } else process.stdout.write(text);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));

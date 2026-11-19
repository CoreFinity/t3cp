#!/usr/bin/env node
// The ladder golden: the aggregator's output on the synthetic development data (synth-data.mjs), one sha256 per output
// file (a .gz file by its decompressed bytes, so a zlib release cannot move it). The synthetic data runs today's suite,
// row 1 of scenarios.json (ladder@1, published as suite ladder-1); site/build/aggregate-golden.test.mjs holds the
// aggregator's output on it byte-identical to the golden captured from main before the scenario catalogue existed.
//
//   node tools/t3cp/dev/golden.mjs           prints the manifest
//   node tools/t3cp/dev/golden.mjs --write   writes it to site/build/testdata/ladder-1-golden.json
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { parseArgs } from "node:util";

import { REPO_ROOT, isMain } from "../lib/repo.mjs";
import { buildOutputs } from "../../../site/build/aggregate.mjs";
import { synthInputs } from "./synth-data.mjs";

export const GOLDEN_FILE = path.join(REPO_ROOT, "site", "build", "testdata", "ladder-1-golden.json");
export const GOLDEN_SCHEMA = "t3cp/golden/1";

/** {relative path: sha256} of every file the aggregator builds from the synthetic data, sorted by path. */
export function goldenFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-golden-"));
  try {
    synthInputs(dir);
    const files = buildOutputs(dir, { dev: true, warn: () => {} });
    const out = {};
    for (const rel of [...files.keys()].sort()) {
      const bytes = files.get(rel);
      out[rel] = createHash("sha256").update(rel.endsWith(".gz") ? zlib.gunzipSync(bytes) : bytes).digest("hex");
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function goldenDocument(files = goldenFiles()) {
  return {
    schema: GOLDEN_SCHEMA,
    description:
      "The aggregator's output on the synthetic development data (tools/t3cp/dev/synth-data.mjs), which runs today's suite, scenarios.json row ladder@1: one sha256 per output file, a .gz file by its decompressed bytes. Written by node tools/t3cp/dev/golden.mjs --write.",
    files,
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

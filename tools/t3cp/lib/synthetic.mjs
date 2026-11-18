#!/usr/bin/env node
// The deploy gate for synthetic data: `node tools/t3cp/lib/synthetic.mjs check <dir>` exits 2 when any .json,
// .ndjson or .ndjson.gz file under <dir> carries "synthetic": true at the top level (development data from
// tools/t3cp/dev/synth-data.mjs), 0 otherwise. Run it on the publish tree before every deploy.
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { isMain } from "./repo.mjs";

const marked = (text) => {
  try {
    return JSON.parse(text)?.synthetic === true;
  } catch {
    return false;
  }
};

/** Relative paths of every synthetic file under dir, sorted. */
export function findSynthetic(dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(r);
      else if (r.endsWith(".json")) {
        if (marked(fs.readFileSync(path.join(dir, r), "utf8"))) out.push(r);
      } else if (r.endsWith(".ndjson") || r.endsWith(".ndjson.gz")) {
        const bytes = fs.readFileSync(path.join(dir, r));
        const text = r.endsWith(".gz") ? zlib.gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
        if (text.split("\n").some((line) => line.trim() !== "" && marked(line))) out.push(r);
      }
    }
  };
  walk("");
  return out.sort();
}

if (isMain(import.meta.url)) {
  const [command, dir] = process.argv.slice(2);
  if (command !== "check" || !dir) {
    process.stderr.write("usage: synthetic.mjs check <dir>\n");
    process.exitCode = 2;
  } else {
    const found = findSynthetic(dir);
    for (const rel of found) process.stderr.write(`synthetic file refused: ${rel}\n`);
    process.exitCode = found.length > 0 ? 2 : 0;
  }
}

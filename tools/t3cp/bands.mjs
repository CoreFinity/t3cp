#!/usr/bin/env node
// Noise bands (schema/bands-1.json) from the noise-band run: merged records (merge.mjs output) of repeated
// identical attempts of one release, one record per machine.
//
//   node tools/t3cp/bands.mjs <record.json>... --out <bands.json> --method "<one line>"
//
// Per platform, metric and cell, the values of every machine's valid attempts are pooled and the band is
// (max - min) / median in percent, rounded to 0.1. A metric's band is its largest cell band (the verdict rule
// uses a cell's own band when it has one). A metric needs at least two values and a non-zero median for a band.
// Record-scope metrics (startup, migrations) get bands at "once" and, for the empty database, "1e".
// Fail closed: unreadable or schema-invalid records, records of different releases, profiles or harnesses,
// or a result that fails bands-1 or the scan: exit 2, nothing written.
import * as fs from "node:fs";
import { parseArgs } from "node:util";
import { validate } from "./lib/validate.mjs";
import { ScanConfigError, scanValue } from "./lib/scan.mjs";
import { parseStrict } from "./lib/json.mjs";
import { isMain, loadCatalogue, loadSchema, median } from "./lib/repo.mjs";

export class BandsError extends Error {}

const sameKey = (r) => JSON.stringify([r.release.tag, r.release.sha, r.workload.profile, r.workload.suite ?? null, r.harness.files_sha256, r.fixture.id]);
const bandOf = (values) => {
  const numbers = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (numbers.length < 2) return null;
  const mid = median(numbers);
  if (!mid) return null;
  return { band: Math.round(((Math.max(...numbers) - Math.min(...numbers)) / Math.abs(mid)) * 1000) / 10, n: numbers.length };
};

/** Computes the bands-1 document from merged noise-band records. */
export function computeBands(records, { method, catalogue = loadCatalogue() }) {
  if (records.length === 0) throw new BandsError("no records");
  const platforms = {};
  for (const platform of [...new Set(records.map((r) => r.platform.id))].sort()) {
    const mine = records.filter((r) => r.platform.id === platform);
    if (new Set(mine.map(sameKey)).size !== 1) throw new BandsError(`${platform}: the records must be the same release, profile, harness and fixture`);
    const metrics = {};
    for (const m of catalogue.metrics) {
      const levels = {};
      const cells = m.scope === "level" ? ["1", "50", "100", "150", "200", "250", "1e"] : ["once", ...(m.empty_cell ? ["1e"] : [])];
      for (const L of cells) {
        const values = mine.flatMap((r) => {
          const stat = m.scope === "level" ? r.cells?.[L]?.metrics?.[m.id] : (L === "once" ? r.extras?.fixture : r.extras?.empty)?.metrics?.[m.id];
          return stat?.values ?? [];
        });
        const b = bandOf(values);
        if (b) levels[L] = b;
      }
      const entries = Object.entries(levels);
      if (entries.length === 0) continue;
      const [, widest] = entries.reduce((best, cur) => (cur[1].band > best[1].band ? cur : best));
      metrics[m.id] = { band: widest.band, n: widest.n, levels };
    }
    const dates = mine.map((r) => r.release.date).sort();
    platforms[platform] = {
      measured: {
        from: dates[0],
        to: dates.at(-1),
        attempts: mine.reduce((sum, r) => sum + Object.values(r.cells).reduce((s, c) => s + c.total, 0), 0),
        machines: mine.length,
        tag: mine[0].release.tag,
      },
      metrics,
    };
  }
  const doc = {
    schema: "t3cp/bands/1",
    ...(records.some((r) => r.synthetic === true) ? { synthetic: true } : {}),
    method,
    platforms,
  };
  const errors = validate(loadSchema("bands-1.json"), doc);
  if (errors.length > 0) throw new BandsError(`bands: ${errors.slice(0, 5).map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const hits = scanValue(doc);
  if (hits.length > 0) throw new BandsError(`bands: forbidden pattern(s) ${[...new Set(hits.map((h) => h.pattern))].join(", ")}`);
  return doc;
}

function main(argv) {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string" }, method: { type: "string" } } });
    if (!values.out || !values.method || positionals.length === 0) throw new BandsError("usage: bands.mjs <record.json>... --out <bands.json> --method <text>");
    const recordSchema = loadSchema("record-1.json");
    const records = positionals.map((file, i) => {
      let record;
      try {
        record = parseStrict(fs.readFileSync(file, "utf8"));
      } catch (error) {
        throw new BandsError(`record ${i + 1}: ${error?.message ?? "not readable JSON"}`);
      }
      const errors = validate(recordSchema, record);
      if (errors.length > 0) throw new BandsError(`record ${i + 1}: ${errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join("; ")}`);
      return record;
    });
    const doc = computeBands(records, { method: values.method });
    const tmp = `${values.out}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
    fs.renameSync(tmp, values.out);
    process.stderr.write(`bands: ${Object.entries(doc.platforms).map(([p, v]) => `${p} ${Object.keys(v.metrics).length} metrics`).join(", ")}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`bands: refused: ${error instanceof BandsError || error instanceof ScanConfigError ? error.message : `internal error (${error?.name ?? "unknown"})`}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));

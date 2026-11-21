// Paths and loaders shared by the exporter, the merge and the aggregator.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const cache = new Map();
const readJson = (file) => {
  if (!cache.has(file)) cache.set(file, JSON.parse(fs.readFileSync(file, "utf8")));
  return cache.get(file);
};

/** catalogue/catalogue.json, parsed once. */
export const loadCatalogue = () => readJson(path.join(REPO_ROOT, "catalogue", "catalogue.json"));

/** scenarios.json, the scenario catalogue (its rows), parsed once. */
export const loadScenarios = () => readJson(path.join(REPO_ROOT, "scenarios.json"));

/** schema/<name>, parsed once (for example "record-1.json"). */
export const loadSchema = (name) => readJson(path.join(REPO_ROOT, "schema", name));

/** The exporter and merge version written into every record's pipeline block. */
export const EXPORTER_VERSION = "1.0.0";

/** Rounds like the harness's report.ts: 3 decimals under 100, 1 decimal above. */
export const roundValue = (value) =>
  value === null || value === undefined ? null : Math.abs(value) < 100 ? Math.round(value * 1000) / 1000 : Math.round(value * 10) / 10;

/** Median of finite numbers (mean of the middle two for an even count); null for none. */
export function median(numbers) {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** True when the module with this import.meta.url is the script Node was started with. */
export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

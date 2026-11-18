#!/usr/bin/env node
// The publish build's last check: every file under a directory (the site's dist) passes the internal-name scan.
//
//   node tools/t3cp/scan-tree.mjs <dir> [--values <value pattern file>]
//
// Every file is text and scanned as it is (a NUL byte or not), but image types, which are skipped as binary; .gz files
// are decompressed first. Every file and directory name is scanned too. The public list always applies; the names
// list applies when T3CP_PRIVATE_PATTERNS names a file, except to the number leaves of JSON and NDJSON files and the
// numeric cells of CSV files. A value list (--values, authored text only; generated content never gets one) applies
// the same way to file contents, and additionally never to a numeric token in other text that prints a number those
// data files carry (a measured figure on a page). A tree with no file is refused.
// Exit 0 when clean, 2 on any hit (each named by file and pattern id, never by the matched text: a path segment that
// itself hits is printed as [name withheld]) or error.
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { parseArgs } from "node:util";
import { ScanConfigError, loadPrivatePatterns, scanCsvText, scanJsonText, scanNdjsonText, scanText } from "./lib/scan.mjs";
import { isMain } from "./lib/repo.mjs";

/** The image types the site ships: skipped as binary. Every other file is text, whatever bytes it holds. */
const IMAGE = /\.(png|jpe?g|webp|gif|ico)$/i;
/** How a finding prints a path segment whose own name hits: the matched text is never printed. */
const WITHHELD = "[name withheld]";

/**
 * The text files under dir, depth first in name order: [{rel, name, text}] (gzip decompressed; rel is the path as a
 * finding prints it, name the real one). Each file and directory name is scanned here; an unreadable file, a name
 * hit or a tree with no file at all is a finding.
 */
function readTree(dir, findings) {
  const files = [];
  let count = 0;
  const walk = (rel, shown) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const nameHits = [...new Set(scanText(entry.name).map((h) => h.pattern))];
      const s = `${shown === "" ? "" : `${shown}/`}${nameHits.length > 0 ? WITHHELD : entry.name}`;
      for (const id of nameHits) findings.push({ file: s, pattern: `name_${id}` });
      if (entry.isDirectory()) {
        walk(r, s);
        continue;
      }
      count++;
      if (!entry.isFile()) {
        findings.push({ file: s, pattern: "not_a_regular_file" });
        continue;
      }
      if (IMAGE.test(entry.name)) continue;
      let bytes = fs.readFileSync(path.join(dir, r));
      if (r.endsWith(".gz")) {
        try {
          bytes = zlib.gunzipSync(bytes);
        } catch {
          findings.push({ file: s, pattern: "unreadable_gzip" });
          continue;
        }
      }
      files.push({ rel: s, name: r.replace(/\.gz$/, ""), text: bytes.toString("utf8") });
    }
  };
  walk("", "");
  if (count === 0) findings.push({ file: ".", pattern: "empty_tree" });
  return files;
}

const dataKind = (name) => (name.endsWith(".json") ? "json" : name.endsWith(".ndjson") ? "ndjson" : name.endsWith(".csv") ? "csv" : null);

/** Every number the data files carry (JSON and NDJSON number leaves, numeric CSV cells), as sorted magnitudes. */
function publishedNumbers(files) {
  const out = [];
  const leaves = (node) => {
    if (typeof node === "number") out.push(Math.abs(node));
    else if (Array.isArray(node)) node.forEach(leaves);
    else if (node !== null && typeof node === "object") Object.values(node).forEach(leaves);
  };
  const json = (text) => {
    try {
      leaves(JSON.parse(text));
    } catch {
      // not JSON: nothing to collect
    }
  };
  for (const { name, text } of files) {
    const kind = dataKind(name);
    if (kind === "json") json(text);
    else if (kind === "ndjson") text.split("\n").filter((l) => l.trim() !== "").forEach(json);
    else if (kind === "csv") for (const cell of text.split(/[\n,]/)) if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(cell.trim())) out.push(Math.abs(Number(cell)));
  }
  return Float64Array.from(out.filter(Number.isFinite)).sort();
}

/**
 * Numeric tokens as pages print figures: optional sign (- or U+2212), thousands grouped with commas or not, decimals.
 * Digits inside a word, a path, a query or a fragment (after or before - / = ? & # :) are never a figure.
 */
const FIGURE = /(?<![\w.,/\-=?&#:])[\u2212-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w]|[.,]\d|[-/?#:])/gu;

/** The spans of figure tokens in text whose value is how some published number prints at the token's decimals. */
function figureSpans(text, numbers) {
  const spans = [];
  const has = (value, decimals) => {
    // Any published magnitude n with n.toFixed(decimals) equal to the token: n lies within half a unit of the token.
    const half = 0.5 * 10 ** -decimals;
    let lo = 0;
    let hi = numbers.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (numbers[mid] < value - half - 1e-9) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < numbers.length && numbers[i] <= value + half + 1e-9; i++) {
      if (Number(numbers[i].toFixed(decimals)) === value) return true;
    }
    return false;
  };
  for (const m of text.matchAll(FIGURE)) {
    const digits = m[0].replace(/^[\u2212-]/, "").replaceAll(",", "");
    const decimals = digits.includes(".") ? digits.length - digits.indexOf(".") - 1 : 0;
    if (has(Number(digits), decimals)) spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/**
 * Findings under dir: [{file, pattern}], sorted. The names list (T3CP_PRIVATE_PATTERNS) applies everywhere but to number
 * leaves and numeric cells, never masked. `valuePatterns` (a value list, for authored text only: generated content never
 * receives one) applies likewise, and in pages, scripts, feeds and text a value hit that lies wholly inside a token
 * printing a published number is that measured figure, not a private one.
 */
export function scanTree(dir, { valuePatterns = [] } = {}) {
  const findings = [];
  const files = readTree(dir, findings);
  const numbers = publishedNumbers(files);
  for (const { rel, name, text } of files) {
    const kind = dataKind(name);
    let hits;
    // Data files: number leaves (JSON, NDJSON) and numeric cells (CSV) with the public list only.
    const values = { privatePatterns: valuePatterns, env: false };
    const asValues = (list) => list.map((h) => ({ ...h, pattern: h.pattern.replace(/^private_/, "value_") }));
    if (kind === "json") hits = [...scanJsonText(text), ...asValues(scanJsonText(text, values).filter((h) => h.pattern.startsWith("private_")))];
    else if (kind === "ndjson") hits = [...scanNdjsonText(text), ...asValues(scanNdjsonText(text, values).filter((h) => h.pattern.startsWith("private_")))];
    else if (kind === "csv") hits = [...scanCsvText(text), ...asValues(scanCsvText(text, values).filter((h) => h.pattern.startsWith("private_")))];
    else {
      // Pages, scripts, feeds and text: the names list and the public list count as they are; a value hit that lies
      // wholly inside a token showing a published figure is that measured figure.
      hits = scanText(text);
      if (valuePatterns.length > 0) {
        const spans = figureSpans(text, numbers);
        const insideFigure = (h) => spans.some(([a, b]) => h.index >= a && h.index + h.match.length <= b);
        hits.push(...asValues(scanText(text, values).filter((h) => h.pattern.startsWith("private_") && !insideFigure(h))));
      }
    }
    for (const id of new Set(hits.map((h) => h.pattern))) findings.push({ file: rel, pattern: id });
  }
  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
}

if (isMain(import.meta.url)) {
  const { values: opts, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { values: { type: "string" } } });
  const [dir] = positionals;
  try {
    if (!dir || positionals.length !== 1) throw new Error("usage: scan-tree.mjs <dir> [--values <value pattern file>]");
    const findings = scanTree(dir, { valuePatterns: opts.values ? loadPrivatePatterns(opts.values) : [] });
    for (const f of findings) process.stderr.write(`scan-tree: ${f.file}: ${f.pattern}\n`);
    process.stderr.write(`scan-tree: ${findings.length === 0 ? "clean" : `${findings.length} finding(s)`}\n`);
    process.exitCode = findings.length === 0 ? 0 : 2;
  } catch (error) {
    process.stderr.write(`scan-tree: refused: ${error?.message?.startsWith("usage") || error instanceof ScanConfigError ? error.message : `internal error (${error?.name ?? "unknown"})`}\n`);
    process.exitCode = 2;
  }
}

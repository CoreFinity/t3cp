// The internal-name scan: forbidden patterns that must never appear in a public t3cp file, record, release
// post or published byte. Two parts, both always applied where available:
//
//  - the public list below: GENERIC SHAPES only (absolute paths, IP addresses, host-name shapes, cloud region
//    and zone shapes, bucket URLs, emails, task / decision / question id shapes, evidence directory shapes,
//    internal knob values, secret token shapes). It names no concrete internal host, project, person, region
//    or VM, so this public file reveals nothing it hides;
//  - the private list of concrete names (project ids, hosts, people, reviewers, regions, VM and registry
//    names), read from the file named by the environment variable T3CP_PRIVATE_PATTERNS: one JavaScript regex
//    per line (case-insensitive), `#` comments and blank lines ignored. It is never committed here; the
//    private ops CI runs it on the same commits.
//
// Patterns are written from fragments so that this file passes its own scan. Callers report pattern ids,
// never the matched text, wherever the output may be logged.

import * as fs from "node:fs";
import { parseStrict } from "./json.mjs";

/** One pattern; `skip(match)` drops a match that is a public, non-identifying use of the shape. */
const P = (id, source, flags = "giu", skip = null) => ({ id, re: new RegExp(source, flags), skip });
/** An absolute path shape: /<top>/ followed by a path character (a bare "/tmp/" ignore rule is no path). */
const absPath = (top) => `${esc(slash("", top, ""))}(?=[A-Za-z0-9._~-])`;
const DOC_DOMAIN = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:test|example|invalid|localhost))$/i;
const slash = (...parts) => parts.join("/");
/** The two slashes after a URL scheme. */
const SCHEME_SLASHES = "/".repeat(2);
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The public list (generic shapes). Order is stable; ids are what callers report. */
export const PUBLIC_PATTERNS = [
  // host-name shapes
  P("host_ws", "(?<![a-z0-9])ws[0-9](?![0-9])"),
  P("host_local", "(?<![.\\w-])[a-z0-9-]+\\.local\\b"),
  // absolute paths of machines (never in a public record or post)
  P("path_users", absPath("Users")),
  P("path_home", absPath("home")),
  P("path_mnt", absPath("mnt")),
  P("path_volumes", absPath("Volumes")),
  P("path_var", absPath("var")),
  P("path_private", absPath("private")),
  P("path_tmp", absPath("tmp")),
  P("path_root", absPath("root")),
  P("path_tilde", `(?<![\\w~])${esc(slash("~", ""))}(?=[A-Za-z0-9._-])`),
  P("creds", `\\b${esc(slash("creds", ""))}`),
  // addresses
  // loopback, the unspecified address and the documentation ranges (RFC 5737) are not identifying
  P("ip_v4", "(?<![\\d.])(?!127\\.|0\\.0\\.0\\.0(?![\\d.])|192\\.0\\.2\\.|198\\.51\\.100\\.|203\\.0\\.113\\.)(?:\\d{1,3}\\.){3}\\d{1,3}(?![\\d.])"),
  P("ip_v6", "\\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\\b"),
  // compressed forms (a double colon standing for zero groups, and IPv4-mapped forms); the loopback alone is not
  P("ip_v6_compressed", "(?<![\\w:])(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![\\w:])|(?<![\\w:])::(?:ffff:)?[0-9a-f]{1,4}(?:[:.][0-9a-f]{1,4}){1,6}(?![\\w:])", "giu", (m) => m.replace(/[^0-9a-f]/giu, "").length < 4),
  // reserved documentation domains (RFC 2606) are not identifying
  P("email", "[a-z0-9._%+-]+@[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,}", "giu", (m) => DOC_DOMAIN.test(m)),
  // cloud: any region or zone shape, bucket URLs
  P("gcp_region", "\\b(?:africa|asia|australia|europe|me|northamerica|southamerica|us)-(?:central|east|west|north|south|northeast|southeast|southwest|northwest)[0-9]{1,2}(?:-[a-f])?\\b"),
  P("bucket_url", `\\bgs:${esc(SCHEME_SLASHES)}|\\bs3:${esc(SCHEME_SLASHES)}`),
  // planning identifier shapes
  P("task_id", "\\bP[0-9]-[0-9]+\\b", "gu"),
  P("fleet_task_id", "\\bW[0-9]+-[0-9]+\\b", "gu"),
  P("decision_id", "\\bA[0-9]{2,3}\\b", "gu"),
  P("question_id", "\\bQ[0-9]{1,2}\\b", "gu"),
  P("evidence_dir", "\\bp[0-9]-[0-9]{3}-evidence\\b|\\binv-[a-z]+"),
  // internal knob values and harness identity fields that carry paths
  P("node_options_value", ["--max", "old", "space", "size"].join("-") + "|--require[= ]\\S"),
  P("harness_ref_field", ["server", "ref"].join("_")),
  // secret token shapes
  P("secret_token", ["\\bghp_[A-Za-z0-9]{20,}", `\\b${["github", "pat", ""].join("_")}[A-Za-z0-9_]{20,}`, `\\b${["sk", "ant", ""].join("-")}[A-Za-z0-9_-]{8,}`, "\\bAKIA[0-9A-Z]{16}\\b", "-----BEGIN [A-Z ]*PRIVATE KEY", "\\bxox[abps]-", "\\bya29\\."].join("|")),
];

/**
 * Public occurrences that are permitted and blanked before both lists run (same length, so indexes still line
 * up): the fork's own URL, the MRs page's author query, and the sponsor credit with its link (BRIEF rule 3).
 */
const FORK_HANDLE = ["navid", "nadali"].join("");
const SPONSOR = ["Core", "finity"].join("");
const ALLOWED = [
  new RegExp(`(?:https?:${esc(SCHEME_SLASHES)})?github\\.com${esc(slash("", FORK_HANDLE, "t3code"))}(?![A-Za-z0-9_-])`, "giu"),
  new RegExp(`\\bauthor(?::|%3A)${FORK_HANDLE}(?![A-Za-z0-9-])`, "giu"),
  // The credit as the site's pages print it, exactly (before the bare URL, which would blank its href first).
  new RegExp(esc(`Run and funded by <a href="https:${SCHEME_SLASHES}${SPONSOR.toLowerCase()}.com">${SPONSOR}</a>`), "gu"),
  new RegExp(`Run and funded by \\[?${SPONSOR}\\]?(?:\\(https:${esc(SCHEME_SLASHES)}${SPONSOR.toLowerCase()}\\.com${esc("/")}?\\))?`, "gu"),
  new RegExp(`https:${esc(SCHEME_SLASHES)}${SPONSOR.toLowerCase()}\\.com${esc("/")}?(?![A-Za-z0-9_/-])`, "gu"),
];

/** A problem with the private pattern list; its message is safe to print (it never holds a pattern). */
export class ScanConfigError extends Error {}

/** Reads a private pattern file: one regex per line, `#` comments. Throws on an unreadable file or a bad regex. */
export function loadPrivatePatterns(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new ScanConfigError("private pattern file: cannot read the file named by T3CP_PRIVATE_PATTERNS");
  }
  const patterns = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const source = line.trim();
    if (source === "" || source.startsWith("#")) return;
    try {
      patterns.push(new RegExp(source, "giu"));
    } catch {
      throw new ScanConfigError(`private pattern file: line ${index + 1} is not a valid regex`);
    }
  });
  if (patterns.length === 0) throw new ScanConfigError("private pattern file: no patterns (a private list must name at least one pattern)");
  return patterns;
}

let envCache;
/** The private list from T3CP_PRIVATE_PATTERNS, or null when the variable is unset. Throws when set but unusable. */
export function privatePatternsFromEnv() {
  const file = process.env.T3CP_PRIVATE_PATTERNS;
  if (file === undefined || file === "") return null;
  if (envCache?.file !== file) envCache = { file, patterns: loadPrivatePatterns(file) };
  return envCache.patterns;
}

const blank = (text) => {
  let out = text;
  for (const re of ALLOWED) out = out.replace(re, (m) => " ".repeat(m.length));
  return out;
};

/**
 * Scans one string. Returns [{pattern, match, index}] (empty when clean). `opts.privatePatterns` (RegExp[])
 * adds a private list; without it the list from T3CP_PRIVATE_PATTERNS applies when that is set
 * (`opts.env: false` turns the environment off).
 */
export function scanText(text, opts = {}) {
  const subject = blank(String(text));
  const found = [];
  for (const { id, re, skip } of PUBLIC_PATTERNS) {
    re.lastIndex = 0;
    for (const m of subject.matchAll(re)) if (!skip?.(m[0])) found.push({ pattern: id, match: m[0], index: m.index });
  }
  const privatePatterns = opts.privatePatterns ?? (opts.env === false ? null : privatePatternsFromEnv()) ?? [];
  privatePatterns.forEach((re, i) => {
    const global = re.flags.includes("g") ? re : new RegExp(re.source, `${re.flags}g`);
    global.lastIndex = 0;
    for (const m of subject.matchAll(global)) found.push({ pattern: `private_${i + 1}`, match: m[0], index: m.index });
  });
  return found.sort((a, b) => a.index - b.index || (a.pattern < b.pattern ? -1 : 1));
}

/**
 * Scans a JSON value leaf by leaf: every key and every string with both lists, every number with the public list only.
 * A number measured on a public release cannot leak a private figure, and a private value pattern must not fail a
 * publish because a measurement happens to equal it. Returns the hits of scanText, each with the leaf's path.
 */
export function scanValue(value, opts = {}) {
  const found = [];
  const publicOnly = { ...opts, privatePatterns: [], env: false };
  const walk = (node, at) => {
    if (typeof node === "string") found.push(...scanText(JSON.stringify(node), opts).map((h) => ({ ...h, path: at })));
    else if (typeof node === "number") found.push(...scanText(String(node), publicOnly).map((h) => ({ ...h, path: at })));
    else if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${at}[${i}]`));
    else if (node !== null && typeof node === "object") {
      for (const [key, inner] of Object.entries(node)) {
        found.push(...scanText(JSON.stringify(key), opts).map((h) => ({ ...h, path: `${at}.${key}` })));
        walk(inner, `${at}.${key}`);
      }
    }
  };
  walk(value, "$");
  return found;
}

/**
 * Scans JSON text: the raw text with the public list, and the strictly parsed value leaf by leaf (scanValue). Text
 * that does not parse strictly (a duplicate or prototype key, or not JSON) is a hit, invalid_json.
 */
export function scanJsonText(text, opts = {}) {
  const raw = scanText(text, { ...opts, privatePatterns: [], env: false });
  let value;
  try {
    value = parseStrict(text);
  } catch {
    return [...raw, { pattern: "invalid_json", match: "", index: 0 }];
  }
  return [...raw, ...scanValue(value, opts)];
}

/** Scans NDJSON text line by line (scanJsonText). */
export function scanNdjsonText(text, opts = {}) {
  return text.split("\n").filter((line) => line.trim() !== "").flatMap((line) => scanJsonText(line, opts));
}

/**
 * The cells of CSV text (RFC 4180 quoting: a quoted cell keeps its commas, line breaks and doubled quotes; text after
 * its closing quote, up to the separator, is kept in the cell too).
 */
export function csvCells(text) {
  const cells = [];
  let i = 0;
  while (i <= text.length) {
    if (text[i] === '"') {
      let cell = "";
      i++;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else if (text[i] === '"') {
          i++;
          break;
        } else cell += text[i++];
      }
      // Anything after the closing quote, up to the separator, stays in the cell (and so is scanned).
      let rest = i;
      while (rest < text.length && text[rest] !== "," && text[rest] !== "\n") rest++;
      cell += text.slice(i, rest).replace(/\r$/, "");
      i = rest;
      cells.push({ cell, quoted: true });
    } else {
      let end = i;
      while (end < text.length && text[end] !== "," && text[end] !== "\n") end++;
      cells.push({ cell: text.slice(i, end).replace(/\r$/, ""), quoted: false });
      i = end;
    }
    i++;
  }
  return cells;
}

/** Scans CSV text cell by cell: a bare numeric cell with the public list only, every other cell with both. */
export function scanCsvText(text, opts = {}) {
  const publicOnly = { ...opts, privatePatterns: [], env: false };
  return csvCells(text).flatMap(({ cell, quoted }) => scanText(cell, !quoted && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(cell.trim()) ? publicOnly : opts));
}

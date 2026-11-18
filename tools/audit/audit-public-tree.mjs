#!/usr/bin/env node
// audit-public-tree: the generic public pattern list over a tree, a diff and commit messages.
//
// usage: node tools/audit/audit-public-tree.mjs [--repo <dir>] [--json <out.json>]
//          (--repo-files | --rev <rev> | --tree <dir> | --diff <a>..<b> | --diff <a>...<b> | --messages <range>
//           | --each <range>)...
//
//   --rev       every file of a git revision (path names, refusals, full text)
//   --tree      every file under a directory (skips .git and node_modules)
//   --repo-files every file git tracks in --repo, as it is on disk (the self-scan)
//   --diff      the paths a range adds and the lines it adds (a...b diffs from the merge base)
//   --messages  every commit message in a git log range (a single rev means its whole history)
//   --each      every commit of a git log range, each read as its own diff against its first parent (a root
//               commit: every file), so a value one commit adds and a later one removes is still found;
//               a single rev means its whole history
//
// Patterns, exact-string exceptions and file refusals live in patterns.json beside this file.
// Prints `path:line: <id>` for a text hit, `path: <id>` for a path or file refusal and
// `commit <sha12>:<line>: <id>` for a message; never the matched text. Exit 0 clean, 2 on any
// hit, 1 on an error (fail closed).
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EXIT, isMain, parseArgs, runCli } from "./lib/cli.mjs";

const PATTERNS_FILE = new URL("./patterns.json", import.meta.url);
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

// JSON and shell escapes and colour codes read as spaces, so a token right after one is found.
const ESCAPES = /\\+u001[bB]\[[0-9;?]*[A-Za-z]|\x1b\[[0-9;?]*[A-Za-z]|\\+(?:u[0-9a-fA-F]{4}|[^\\])/g;
// A URL escape splits a random run, so URL-encoded ids read as their parts.
const URL_ESCAPE = /%(?:25)*[0-9A-Fa-f]{2}/g;
const SRI_DIGEST = /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
const PLACEHOLDER = /^(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|<[^>]*>|\{[^}]*\})$/;

const blank = (text, pattern) => (text.includes("\\") || text.includes("\x1b") || text.includes("%")
  ? text.replace(pattern, (escape) => " ".repeat(escape.length))
  : text);

const entropyBits = (text) => {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};

/** Mixed case and digits with the entropy of noise, and no seven-letter lower-case word. */
export const looksRandom = (token) =>
  /[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token) && !/[a-z]{7}/.test(token) && entropyBits(token) >= 3.5;

// A path whose segments are words or upper-case names (`SRC/apps/server/dist-exe/t3`).
const PATH_SEGMENT = /^(?:[A-Za-z]?[a-z0-9]*(?:[-_.][a-z0-9]+)*|[A-Z0-9_]+)$/;
// An identifier made of capitalised words, acronyms and numbers (`88_TurnItemTypeStatusIndex`).
// Each part ends where the next must begin (a digit run before a non-digit, an acronym before a capitalised word,
// a non-letter or the end), so a failing match is linear, not exponential, in the run's length.
const IDENTIFIER = /^(?:[a-z]{2,}(?![a-z])|[0-9]+(?![0-9]))?(?:[_-]?(?:[A-Z][a-z]{2,}(?![a-z])|[A-Z]{2,}(?=[A-Z][a-z]|[^A-Za-z]|$)|[0-9]+(?![0-9])))+$/;

/**
 * Source text adds three shapes the data scanner did not meet: an `=` inside a run is an
 * assignment, not base64 padding (`NAME_OF_FLAG=value` splits there); a run whose
 * slash-separated segments are all words or upper-case names is a path; and a run made of
 * capitalised words, acronyms and numbers is an identifier. Every other piece of 24 or more
 * characters is judged by looksRandom.
 */
const randomPieces = (run) =>
  run.split(/=+(?=[^=])/).some((piece) => {
    if (piece.length < 24) return false;
    const segments = piece.split("/");
    if (segments.length >= 2 && segments.every((segment) => PATH_SEGMENT.test(segment))) return false;
    if (IDENTIFIER.test(piece)) return false;
    return looksRandom(piece);
  });

const DOC_RANGES = [[192, 0, 2], [198, 51, 100], [203, 0, 113]];

/** A value shaped like a host name (a description such as "a cloud VM" names no machine). */
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A host value that names no machine: empty, loopback, the reserved example and test domains, a placeholder or template. */
const PLACEHOLDER_HOST =
  /^(?:|localhost|127\.0\.0\.1|::1|0\.0\.0\.0|(?:[A-Za-z0-9-]+\.)*example(?:\.[A-Za-z]+)?|(?:[A-Za-z0-9-]+\.)+(?:test|invalid|example|localhost)|<[^>]*>|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\{\{[^}]*\}\})$/i;

const CONFIRM = {
  "reportable-ipv4": (match) => {
    const octets = match[0].split(".").map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    if (octets[0] === 127) return false;
    if (octets.every((octet) => octet === 0) || octets.every((octet) => octet === 255)) return false;
    return !DOC_RANGES.some((range) => range.every((octet, index) => octets[index] === octet));
  },
  "ipv6-not-tiny": (match) => match[0].replace(/[^0-9a-f]/giu, "").length >= 4,
  "real-host": (match) => HOST_NAME.test(match[2] ?? "") && !PLACEHOLDER_HOST.test(match[2] ?? ""),
  "basic-credentials": (match) =>
    /^[\x20-\x7e]+:[\x20-\x7e]+$/.test(Buffer.from(match[1] ?? "", "base64").toString("latin1")),
  "url-password": (match) => /[^*]/.test(match[1] ?? "") && !PLACEHOLDER.test(match[1] ?? ""),
  "looks-random": (match) => !SRI_DIGEST.test(match[0]) && randomPieces(match[0]),
};

/** The pattern file, compiled. */
export const loadPatterns = (file = PATTERNS_FILE) => {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const patterns = raw.patterns.map((pattern) => {
    if (pattern.confirm !== undefined && !(pattern.confirm in CONFIRM)) throw new Error(`unknown confirm ${pattern.confirm}`);
    if (!["raw", "decoded", "split"].includes(pattern.target)) throw new Error(`unknown target ${pattern.target}`);
    return { ...pattern, regex: new RegExp(pattern.source, `${pattern.flags}g`) };
  });
  const ids = new Set(patterns.map((pattern) => pattern.id));
  if (ids.size !== patterns.length) throw new Error("duplicate pattern id");
  for (const exception of raw.exceptions) {
    if (typeof exception.string !== "string" || exception.string === "") throw new Error("an exception needs a string");
    if (exception.path !== undefined && (typeof exception.path !== "string" || !/^[^/][^\0]*$/.test(exception.path) || exception.scope === "messages")) {
      throw new Error(`a path-bound exception needs a relative file path and the files scope: ${exception.path}`);
    }
    for (const id of exception.applies_to ?? []) if (!ids.has(id)) throw new Error(`exception names unknown pattern ${id}`);
  }
  return { patterns, exceptions: raw.exceptions, refusals: raw.refusals, binaryAllow: new Set(raw.binary_allow) };
};

let defaultConfig;
const config = () => (defaultConfig ??= loadPatterns());

const ANY = "*";

/**
 * Spans of the exceptions present in `line` for this scope, per pattern id (`*` for an exception
 * that names no pattern, which permits any match lying wholly inside its exact string). An exception
 * with a `path` holds in that one file only.
 */
const exceptionSpans = (line, scope, exceptions, path) => {
  const spans = new Map();
  for (const exception of exceptions) {
    if ((exception.scope ?? "files") !== scope) continue;
    if (exception.path !== undefined && exception.path !== path) continue;
    for (let at = line.indexOf(exception.string); at >= 0; at = line.indexOf(exception.string, at + 1)) {
      for (const id of exception.applies_to ?? [ANY]) {
        if (!spans.has(id)) spans.set(id, []);
        spans.get(id).push([at, at + exception.string.length]);
      }
    }
  }
  return spans;
};

/**
 * Pattern ids that hit one line (each once). `scope` is "files" (a file's text or a path name)
 * or "messages" (a commit message); exceptions name the scope they apply to.
 */
export const scanLine = (path, line, { scope = "files", cfg = config() } = {}) => {
  const texts = { raw: line, decoded: blank(line, ESCAPES), split: blank(line, URL_ESCAPE) };
  const spans = exceptionSpans(line, scope, cfg.exceptions, path);
  const hits = [];
  for (const pattern of cfg.patterns) {
    const permitted = [...(spans.get(pattern.id) ?? []), ...(spans.get(ANY) ?? [])];
    for (const match of texts[pattern.target].matchAll(pattern.regex)) {
      if (pattern.confirm !== undefined && !CONFIRM[pattern.confirm](match)) continue;
      const start = match.index;
      const end = start + match[0].length;
      if (permitted.some(([from, to]) => from <= start && end <= to)) continue;
      hits.push({ id: pattern.id, column: start + 1 });
      break;
    }
  }
  return hits;
};

const isBinary = (bytes) => bytes.subarray(0, 8000).includes(0);

/** Refusals that a file's path, size and bytes earn on their own. */
export const refusalsFor = (path, size, bytes, cfg = config()) => {
  const { refusals, binaryAllow } = cfg;
  const out = [];
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  for (const [component, id] of Object.entries(refusals.path_components)) {
    if (parts.slice(0, -1).includes(component) || (name === component && bytes === null)) out.push(id);
  }
  if (name === refusals.bench_settings && parts.slice(0, -1).some((dir) => /bench/i.test(dir))) out.push("bench-settings");
  if (refusals.extensions.some((ext) => name.toLowerCase().endsWith(ext))) out.push("file-type");
  if (size > refusals.max_bytes) out.push("file-too-large");
  if (bytes !== null && size <= refusals.max_bytes && isBinary(bytes) && !binaryAllow.has(path)) out.push("binary-not-allowed");
  return out;
};

const linesOf = (text) => text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

/**
 * One file: its path name, its refusals and (when it has none) its text. `onlyLines`, when
 * given, limits the text scan to those 1-based line numbers (a diff's added lines).
 */
export const scanFile = (path, size, bytes, { cfg = config(), onlyLines = null, scanPathName = true } = {}) => {
  const hits = [];
  if (scanPathName) for (const hit of scanLine(path, path, { cfg })) hits.push({ path, line: 0, id: hit.id });
  const refused = refusalsFor(path, size, bytes, cfg);
  for (const id of refused) hits.push({ path, line: 0, id });
  let lines = 0;
  if (refused.length === 0 && bytes !== null) {
    linesOf(bytes.toString("utf8")).forEach((line, index) => {
      if (onlyLines !== null && !onlyLines.has(index + 1)) return;
      lines++;
      for (const hit of scanLine(path, line, { cfg })) hits.push({ path, line: index + 1, id: hit.id });
    });
  }
  return { hits, lines };
};

const git = (repo, args, input) =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: repo,
    input,
    maxBuffer: 1 << 30,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });

const verifyRev = (repo, rev) => {
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_./~^-]*$/.test(rev)) throw new Error(`bad revision ${rev}`);
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).toString().trim();
  } catch {
    throw new Error(`${rev} is not a commit in ${repo}`);
  }
};

/** path -> {mode, type, sha, size} for every entry of a revision. */
const lsTree = (repo, rev) => {
  const entries = new Map();
  for (const record of git(repo, ["ls-tree", "-r", "-l", "-z", "--full-tree", rev]).toString().split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, type, sha, size] = record.slice(0, tab).split(/\s+/);
    entries.set(record.slice(tab + 1), { mode, type, sha, size: size === "-" ? 0 : Number(size) });
  }
  return entries;
};

/** Blob bytes for many object ids, through one `git cat-file --batch`. */
const readBlobs = (repo, shas) => {
  const unique = [...new Set(shas)];
  const blobs = new Map();
  if (unique.length === 0) return blobs;
  const out = git(repo, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
  let at = 0;
  for (const sha of unique) {
    const newline = out.indexOf(0x0a, at);
    const header = out.subarray(at, newline).toString();
    const [got, type, size] = header.split(" ");
    if (got !== sha || type !== "blob") throw new Error(`cat-file: unexpected ${header}`);
    const start = newline + 1;
    blobs.set(sha, out.subarray(start, start + Number(size)));
    at = start + Number(size) + 1;
  }
  return blobs;
};

/** Every file of a git revision. */
export const auditRev = (repo, rev, cfg = config()) => {
  const commit = verifyRev(repo, rev);
  const entries = lsTree(repo, commit);
  const wanted = [...entries.values()].filter((e) => e.type === "blob" && e.size <= cfg.refusals.max_bytes).map((e) => e.sha);
  const blobs = readBlobs(repo, wanted);
  const result = { files: 0, lines: 0, hits: [] };
  for (const [path, entry] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
    result.files++;
    if (entry.type !== "blob") {
      result.hits.push({ path, line: 0, id: entry.type === "commit" ? "submodule" : "unexpected-object" });
      continue;
    }
    const scanned = scanFile(path, entry.size, blobs.get(entry.sha) ?? null, { cfg });
    result.lines += scanned.lines;
    result.hits.push(...scanned.hits);
  }
  return result;
};

const walk = function* (root, dir = "") {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(root, path);
    } else yield path;
  }
};

/** Every file under a directory (.git and node_modules skipped; symlinks read, not followed). */
export const auditTree = (root, cfg = config()) => {
  if (!lstatSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
  const result = { files: 0, lines: 0, hits: [] };
  for (const path of walk(root)) {
    const full = join(root, path);
    const stat = lstatSync(full);
    result.files++;
    let bytes = null;
    if (stat.isSymbolicLink()) bytes = Buffer.from(readlinkSync(full));
    else if (stat.isFile()) bytes = stat.size <= cfg.refusals.max_bytes ? readFileSync(full) : null;
    else {
      result.hits.push({ path, line: 0, id: "unexpected-object" });
      continue;
    }
    const scanned = scanFile(path, stat.isSymbolicLink() ? bytes.length : stat.size, bytes, { cfg });
    result.lines += scanned.lines;
    result.hits.push(...scanned.hits);
  }
  return result;
};

/** Every file git tracks in `repo`, as it is on disk (a tracked file deleted on disk is skipped). */
export const auditRepoFiles = (repo, cfg = config()) => {
  const root = git(repo, ["rev-parse", "--show-toplevel"]).toString().trim();
  const paths = git(root, ["ls-files", "-z", "--cached"]).toString().split("\0").filter((path) => path !== "");
  const result = { files: 0, lines: 0, hits: [] };
  for (const path of [...new Set(paths)].sort()) {
    const full = join(root, path);
    let stat;
    try {
      stat = lstatSync(full);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    result.files++;
    let bytes = null;
    if (stat.isSymbolicLink()) bytes = Buffer.from(readlinkSync(full));
    else if (stat.isFile()) bytes = stat.size <= cfg.refusals.max_bytes ? readFileSync(full) : null;
    else {
      result.hits.push({ path, line: 0, id: stat.isDirectory() ? "submodule" : "unexpected-object" });
      continue;
    }
    const scanned = scanFile(path, stat.isSymbolicLink() ? bytes.length : stat.size, bytes, { cfg });
    result.lines += scanned.lines;
    result.hits.push(...scanned.hits);
  }
  return result;
};

/** Line numbers of `next` that `prev` does not account for (a line-multiset difference). */
export const addedLines = (prev, next) => {
  const counts = new Map();
  for (const line of linesOf(prev)) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added = new Set();
  linesOf(next).forEach((line, index) => {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added.add(index + 1);
  });
  return added;
};

/** The paths a range adds or changes and the lines it adds. */
export const auditDiff = (repo, range, cfg = config()) => {
  const match = /^([^.]+(?:\.[^.]+)*?)(\.\.\.?)([^.].*)$/.exec(range);
  if (!match) throw new Error(`--diff needs <a>..<b> or <a>...<b>, got ${range}`);
  const a = verifyRev(repo, match[1]);
  const b = verifyRev(repo, match[3]);
  const base = match[2] === "..." ? git(repo, ["merge-base", a, b]).toString().trim() : a;
  const fields = git(repo, ["diff", "--no-renames", "--name-status", "-z", base, b]).toString().split("\0");
  const changed = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (fields[index] === "") break;
    changed.push({ status: fields[index][0], path: fields[index + 1] });
  }
  const next = lsTree(repo, b);
  const prev = lsTree(repo, base);
  const kept = changed.filter((c) => c.status !== "D");
  const shas = [];
  for (const c of kept) {
    const entry = next.get(c.path);
    if (entry?.type === "blob" && entry.size <= cfg.refusals.max_bytes) shas.push(entry.sha);
    const old = prev.get(c.path);
    if (c.status !== "A" && old?.type === "blob" && old.size <= cfg.refusals.max_bytes) shas.push(old.sha);
  }
  const blobs = readBlobs(repo, shas);
  const result = { files: 0, lines: 0, hits: [] };
  for (const c of kept) {
    const entry = next.get(c.path);
    result.files++;
    if (entry === undefined || entry.type !== "blob") {
      result.hits.push({ path: c.path, line: 0, id: entry?.type === "commit" ? "submodule" : "unexpected-object" });
      continue;
    }
    const bytes = blobs.get(entry.sha) ?? null;
    const old = c.status === "A" ? undefined : prev.get(c.path);
    const oldBytes = old?.type === "blob" ? blobs.get(old.sha) : undefined;
    const onlyLines = bytes === null ? null : addedLines(oldBytes === undefined ? "" : oldBytes.toString("utf8"), bytes.toString("utf8"));
    const scanned = scanFile(c.path, entry.size, bytes, { cfg, onlyLines, scanPathName: c.status === "A" });
    result.lines += scanned.lines;
    result.hits.push(...scanned.hits);
  }
  return result;
};

/** Every commit message in a log range. */
export const auditMessages = (repo, range, cfg = config()) => {
  for (const part of range.split(/\.\.\.?/)) if (part !== "") verifyRev(repo, part);
  // NUL-separated records: a commit message can hold any character but NUL.
  const out = git(repo, ["log", "-z", "--format=%H%n%B", range, "--"]).toString();
  const result = { files: 0, lines: 0, hits: [] };
  for (const chunk of out.split("\0")) {
    if (chunk === "") continue;
    const newline = chunk.indexOf("\n");
    const sha = newline < 0 ? chunk : chunk.slice(0, newline);
    const body = newline < 0 ? "" : chunk.slice(newline + 1);
    result.files++;
    linesOf(body.replace(/\n+$/, "")).forEach((line, index) => {
      result.lines++;
      for (const hit of scanLine(`commit:${sha}`, line, { scope: "messages", cfg })) {
        result.hits.push({ commit: sha, line: index + 1, id: hit.id });
      }
    });
  }
  return result;
};

/** Every commit of a log range, each as its own diff against its first parent (a root commit: every file). */
export const auditEach = (repo, range, cfg = config()) => {
  for (const part of range.split(/\.\.\.?/)) if (part !== "") verifyRev(repo, part);
  const lines = git(repo, ["rev-list", "--parents", range, "--"]).toString().split("\n").filter((l) => l !== "");
  const result = { files: 0, lines: 0, hits: [] };
  for (const line of lines) {
    const [sha, parent] = line.split(" ");
    const one = parent === undefined ? auditRev(repo, sha, cfg) : auditDiff(repo, `${parent}..${sha}`, cfg);
    result.files += one.files;
    result.lines += one.lines;
    result.hits.push(...one.hits.map((hit) => ({ ...hit, at: sha })));
  }
  return result;
};

const located = (hit) => (hit.line === 0 ? `${hit.path}: ${hit.id}` : `${hit.path}:${hit.line}: ${hit.id}`);

export const formatHit = (hit) =>
  hit.commit !== undefined ? `commit ${hit.commit.slice(0, 12)}:${hit.line}: ${hit.id}` : hit.at !== undefined ? `${hit.at.slice(0, 12)} ${located(hit)}` : located(hit);

if (isMain(import.meta)) {
  runCli("audit-public-tree", () => {
    const argv = process.argv.slice(2);
    const repoFiles = argv.includes("--repo-files");
    const args = parseArgs(argv.filter((arg) => arg !== "--repo-files"), ["--repo", "--rev", "--tree", "--diff", "--messages", "--each", "--json"]);
    const repo = args["--repo"]?.[0] ?? process.cwd();
    const cfg = config();
    const runs = [
      ...(repoFiles ? [["repo-files", repo, () => auditRepoFiles(repo, cfg)]] : []),
      ...(args["--rev"] ?? []).map((rev) => ["rev", rev, () => auditRev(repo, rev, cfg)]),
      ...(args["--tree"] ?? []).map((dir) => ["tree", dir, () => auditTree(dir, cfg)]),
      ...(args["--diff"] ?? []).map((range) => ["diff", range, () => auditDiff(repo, range, cfg)]),
      ...(args["--messages"] ?? []).map((range) => ["messages", range, () => auditMessages(repo, range, cfg)]),
      ...(args["--each"] ?? []).map((range) => ["each", range, () => auditEach(repo, range, cfg)]),
    ];
    if (runs.length === 0) throw new Error("give at least one of --repo-files, --rev, --tree, --diff, --messages, --each");
    const summary = { patterns: cfg.patterns.length, exceptions: cfg.exceptions.length, runs: [] };
    let total = 0;
    for (const [mode, target, audit] of runs) {
      const result = audit();
      for (const hit of result.hits) process.stdout.write(`${formatHit(hit)}\n`);
      total += result.hits.length;
      summary.runs.push({ mode, target, files: result.files, lines: result.lines, hits: result.hits });
      process.stdout.write(
        `audit-public-tree: ${mode} ${target}: ${cfg.patterns.length} patterns, ${result.files} ${mode === "messages" ? "commits" : "files"}, ${result.lines} lines, ${result.hits.length} hits\n`,
      );
    }
    if (args["--json"]) writeFileSync(args["--json"][0], `${JSON.stringify(summary, null, 2)}\n`);
    return total === 0 ? EXIT.clean : EXIT.findings;
  });
}

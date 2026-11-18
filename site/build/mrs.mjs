// The MRs build step: the fork author's pull requests on upstream T3 Code, read from the public GitHub search API
// at build time without a token, written to data/v1/mrs.json (schema/mrs-1.json). Node, no dependencies.
//
//   node site/build/mrs.mjs [--out data/v1/mrs.json] [--previous <file or https URL>]... [--part <file>]
//
// If GitHub cannot be read (an HTTP error, a timeout, a rate limit, bad JSON, an incomplete or inconsistent
// result), the build keeps the previous list, marks it stale and exits 0: the deploy never fails on the API.
// The previous list is the first of the --previous sources that loads and validates (default: the --out file).
// The file is at most 32 KB: if the list would be larger, the oldest pull requests are left out and counted.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { schemaErrorLines } from '../../tools/t3cp/lib/safe-errors.mjs';
import { PUBLIC_PATTERNS, scanText } from '../../tools/t3cp/lib/scan.mjs';

export const UPSTREAM = 'pingdotgg/t3code';
// The fork. Its public owner's pull requests are the list; the login is taken from the fork URL, because
// public files carry it only there and in this author query.
export const FORK_URL = 'https://github.com/navidnadali/t3code';
export const AUTHOR = new URL(FORK_URL).pathname.split('/')[1];
export const DISCUSSION_URL = `https://github.com/${UPSTREAM}/discussions/31002`;
export const SCHEMA_ID = 't3cp/mrs/1';
export const SOURCE_QUERY = `repo:${UPSTREAM} author:${AUTHOR} type:pr`;
export const MAX_BYTES = 32 * 1024;
export const PER_PAGE = 100;
export const SEARCH_CAP = 1000; // the search API returns at most this many results for one query
export const MAX_TITLE_LENGTH = 1024; // characters; equals items.title.maxLength in schema/mrs-1.json
export const API_BASE = 'https://api.github.com';
export const DEFAULT_OUT = fileURLToPath(new URL('../../data/v1/mrs.json', import.meta.url));
const SCHEMA_URL = new URL('../../schema/mrs-1.json', import.meta.url);

export const prUrl = (number) => `https://github.com/${UPSTREAM}/pull/${number}`;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const STATES = new Set(['open', 'closed']);

// A real UTC timestamp as GitHub writes it: the ISO shape, parseable, and naming the instant it parses to
// (Date.parse rolls "02-30" and "24:00" over to another day; those are refused).
export function isUtcTimestamp(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
}

// open | merged | closed. The search API reports a merged pull request as state "closed" with
// pull_request.merged_at set. merged_at must be present: null (the state is item.state) or a real UTC
// timestamp on a closed item (merged). Anything else is a bad response and throws, so the build keeps the
// previous list, marked stale, rather than publishing a guess.
export function mapState(item) {
  if (!item || typeof item !== 'object' || !item.pull_request || typeof item.pull_request !== 'object') {
    throw new Error(`search item ${item?.number ?? '?'} is not a pull request`);
  }
  if (!STATES.has(item.state)) throw new Error(`search item ${item.number ?? '?'} has an unknown state`);
  if (!Object.hasOwn(item.pull_request, 'merged_at')) throw new Error(`search item ${item.number ?? '?'} has no merged_at`);
  const mergedAt = item.pull_request.merged_at;
  if (mergedAt === null) return item.state;
  if (!isUtcTimestamp(mergedAt)) throw new Error(`search item ${item.number ?? '?'} has an invalid merged_at`);
  if (item.state !== 'closed') throw new Error(`search item ${item.number ?? '?'} is open but has merged_at set`);
  return 'merged';
}

// One public row: number, title, state, updated_at, url. Nothing else from the API response is kept.
export function toItem(item) {
  const state = mapState(item);
  const { number, title, updated_at: updatedAt, html_url: url } = item;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('search item has no valid number');
  if (typeof title !== 'string' || title.trim() === '') throw new Error(`search item ${number} has no title`);
  if ([...title].length > MAX_TITLE_LENGTH) throw new Error(`search item ${number} has a title over ${MAX_TITLE_LENGTH} characters`);
  if (!isUtcTimestamp(updatedAt)) throw new Error(`search item ${number} has no valid updated_at`);
  if (url !== prUrl(number)) throw new Error(`search item ${number} has an unexpected url`);
  // The query asks for the fork owner's pull requests; anyone else's is an inconsistent result.
  const login = item.user?.login;
  if (typeof login !== 'string' || login.toLowerCase() !== AUTHOR.toLowerCase()) {
    throw new Error(`search item ${number} is not by the fork's author`);
  }
  return { number, title, state, updated_at: updatedAt, url };
}

// ---- reading the API ----

// A failure to read GitHub (or a previous list over HTTPS). Only these turn into a stale list; anything else
// is a fault in the build and fails it.
export class ApiError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.retryable = retryable;
  }
}

export function searchUrl(page, apiBase = API_BASE) {
  const q = SOURCE_QUERY.replaceAll(' ', '+');
  return `${apiBase}/search/issues?q=${q}&per_page=${PER_PAGE}&sort=updated&order=desc&page=${page}`;
}

const HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 't3cp.io site build (+https://t3cp.io)',
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function getJsonOnce(url, { fetch, timeoutMs }) {
  // A timer of our own rather than AbortSignal.timeout(): that one does not keep the process alive, so a
  // stalled request could let the build exit with the list unwritten. The timeout covers headers and body.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), timeoutMs);
  const { signal } = controller;
  const fail = (e) => (signal.aborted
    ? new ApiError(`timed out after ${timeoutMs} ms`, { retryable: true })
    : new ApiError(`network error (${e?.message ?? e})`, { retryable: true }));
  try {
    let res;
    try {
      res = await fetch(url, { headers: HEADERS, signal });
    } catch (e) {
      throw fail(e);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))) {
        throw new ApiError(`rate limited (HTTP ${res.status})`);
      }
      throw new ApiError(`HTTP ${res.status}`, { retryable: res.status >= 500 });
    }
    let text;
    try {
      text = await res.text();
    } catch (e) {
      throw fail(e);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError('bad JSON in the response');
    }
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, opts) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await getJsonOnce(url, opts);
    } catch (e) {
      if (!(e instanceof ApiError) || !e.retryable || attempt >= opts.retries) throw e;
      await sleep(opts.retryDelayMs * (attempt + 1));
    }
  }
}

// Every pull request the query returns, page by page. Throws ApiError on anything short of a complete,
// consistent result.
export async function fetchPulls(opts) {
  const byNumber = new Map();
  let total = null;
  for (let page = 1; ; page += 1) {
    const body = await getJson(searchUrl(page, opts.apiBase), opts);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isSafeInteger(body.total_count)
      || body.total_count < 0 || !Array.isArray(body.items)) {
      throw new ApiError('the response is not a search result');
    }
    if (body.incomplete_results === true) throw new ApiError('GitHub returned incomplete results');
    if (body.total_count > SEARCH_CAP) {
      throw new ApiError(`${body.total_count} results, more than the ${SEARCH_CAP} the search API returns`);
    }
    if (total === null) total = body.total_count;
    else if (body.total_count !== total) throw new ApiError('total_count changed between pages');
    for (const raw of body.items) {
      let item;
      try {
        item = toItem(raw);
      } catch (e) {
        throw new ApiError(e.message);
      }
      const seen = byNumber.get(item.number);
      if (!seen || Date.parse(item.updated_at) > Date.parse(seen.updated_at)) byNumber.set(item.number, item);
    }
    if (page >= Math.ceil(total / PER_PAGE) || body.items.length === 0) break;
  }
  if (byNumber.size !== total) throw new ApiError(`read ${byNumber.size} pull requests but total_count is ${total}`);
  return [...byNumber.values()];
}

// ---- the document ----

const byUpdatedDesc = (a, b) => (Date.parse(b.updated_at) - Date.parse(a.updated_at)) || (b.number - a.number);
const zeroCounts = () => ({ open: 0, merged: 0, closed: 0 });
export const isoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
export const serialize = (doc) => `${JSON.stringify(canonical(doc))}\n`;
const byteLength = (text) => Buffer.byteLength(text, 'utf8');

// Keys in schema order, so the same list always gives the same bytes.
function canonical(doc) {
  return {
    schema: doc.schema,
    fetched_at: doc.fetched_at,
    stale: doc.stale,
    source_query: doc.source_query,
    counts: { open: doc.counts.open, merged: doc.counts.merged, closed: doc.counts.closed },
    omitted: doc.omitted,
    items: doc.items.map((i) => ({ number: i.number, title: i.title, state: i.state, updated_at: i.updated_at, url: i.url })),
  };
}

export function emptyDoc() {
  return { schema: SCHEMA_ID, fetched_at: null, stale: true, source_query: SOURCE_QUERY, counts: zeroCounts(), omitted: 0, items: [] };
}

// The list as fetched: newest first, counted by state, trimmed to MAX_BYTES by leaving out the oldest.
export function makeDoc(items, fetchedAt) {
  const sorted = [...items].sort(byUpdatedDesc);
  const counts = zeroCounts();
  for (const item of sorted) counts[item.state] += 1;
  const doc = { schema: SCHEMA_ID, fetched_at: fetchedAt, stale: false, source_query: SOURCE_QUERY, counts, omitted: 0, items: sorted };
  if (byteLength(serialize(doc)) <= MAX_BYTES) return doc;
  const keep = (k) => ({ ...doc, items: sorted.slice(0, k), omitted: sorted.length - k });
  let lo = 0, hi = sorted.length; // the largest k whose file fits; k = 0 always fits
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(serialize(keep(mid))) <= MAX_BYTES) lo = mid;
    else hi = mid - 1;
  }
  return keep(lo);
}

// What the schema cannot say.
export function checkInvariants(doc) {
  const errors = [];
  const sum = doc.counts.open + doc.counts.merged + doc.counts.closed;
  if (sum !== doc.items.length + doc.omitted) errors.push(`counts add up to ${sum}, not items + omitted (${doc.items.length + doc.omitted})`);
  const seen = zeroCounts();
  for (const item of doc.items) seen[item.state] += 1;
  for (const state of Object.keys(seen)) if (seen[state] > doc.counts[state]) errors.push(`more ${state} items than counts.${state}`);
  if (new Set(doc.items.map((i) => i.number)).size !== doc.items.length) errors.push('an item number appears twice');
  for (let i = 1; i < doc.items.length; i += 1) {
    if (byUpdatedDesc(doc.items[i - 1], doc.items[i]) > 0) { errors.push('items are not sorted by updated_at descending'); break; }
  }
  if (doc.fetched_at === null && !(doc.stale && sum === 0)) errors.push('fetched_at is null on a list that is not an empty stale one');
  return errors;
}

let schemaCache;
export async function loadSchema() {
  schemaCache ??= JSON.parse(await readFile(SCHEMA_URL, 'utf8'));
  return schemaCache;
}

export function validateDoc(doc, schema) {
  const errors = validateSchema(doc, schema);
  if (errors.length) return errors;
  const bytes = byteLength(serialize(doc));
  return [...checkInvariants(doc), ...(bytes > MAX_BYTES ? [`${bytes} bytes, over ${MAX_BYTES}`] : [])];
}

// The shared validator through its safe door (tools/t3cp/lib/safe-errors.mjs): errors as "path: rule" strings, never
// the value, and paths of the schema's own property names only.
export const validateSchema = (value, schema) => schemaErrorLines(schema, value, ': ');

// ---- the forbidden-pattern scan (tools/t3cp/lib/scan.mjs, plus its private list when one is configured) ----

const PUBLIC_IDS = new Map(PUBLIC_PATTERNS.map((p) => [p.id, p.re]));

export class ForbiddenPatternError extends Error {
  constructor(patterns, field, number) {
    // Named by pattern id (with the expression for a public one), never by the matched text: logs may be public.
    const named = patterns.map((id) => (PUBLIC_IDS.has(id) ? `${id} (/${PUBLIC_IDS.get(id).source}/)` : id)).join(', ');
    const where = number === undefined ? `the ${field} field` : `the ${field} of pull request #${number}`;
    super(`forbidden pattern ${named} in ${where}; fix the source or the scan list before publishing`);
    this.name = 'ForbiddenPatternError';
    this.code = 'T3CP_FORBIDDEN_PATTERN';
    this.pattern = patterns[0];
    this.patterns = patterns;
    this.field = field;
    this.number = number;
  }
}

function scanField(value, field, number) {
  if (typeof value !== 'string') return;
  const hits = scanText(value);
  if (hits.length) throw new ForbiddenPatternError([...new Set(hits.map((h) => h.pattern))], field, number);
}

// Every string of the list it is about to write, fetched or kept: the top-level fields (the author query
// included, which the scan allows) and every item's title and url. The aggregator scans the file again.
export function scanDoc(doc) {
  for (const [field, value] of Object.entries(doc)) scanField(value, field);
  for (const item of doc.items) {
    for (const [field, value] of Object.entries(item)) scanField(value, field, item.number);
  }
}

// ---- the previous list ----

async function loadPrevious(sources, opts, schema) {
  for (const source of sources) {
    let doc;
    try {
      if (/^https:\/\//.test(source)) {
        doc = await getJson(source, { ...opts, retries: 0 });
      } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
        opts.log(`mrs: previous list ${source}: only files and https URLs are read`);
        continue;
      } else {
        doc = JSON.parse(await readFile(source, 'utf8'));
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') opts.log(`mrs: previous list ${display(source)} could not be read (${e.message})`);
      continue;
    }
    const errors = validateDoc(doc, schema);
    if (errors.length) {
      opts.log(`mrs: previous list ${display(source)} is not a valid ${SCHEMA_ID} file (${errors.slice(0, 3).join('; ')}); ignored`);
      continue;
    }
    if (doc.source_query !== SOURCE_QUERY) {
      opts.log(`mrs: previous list ${display(source)} comes from a different query; ignored`);
      continue;
    }
    return { doc, source };
  }
  return null;
}

const display = (source) => {
  if (/^https:\/\//.test(source)) return source;
  const rel = relative(process.cwd(), resolve(source));
  return rel && !rel.startsWith('..') ? rel : resolve(source);
};

async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

// ---- the build step ----

// Returns { doc, stale, reason, source, bytes }. Resolves (writing a stale list) when GitHub cannot be read.
// Rejects, writing nothing, on a forbidden pattern in the list (ForbiddenPatternError, code
// T3CP_FORBIDDEN_PATTERN) or a fault in the build itself.
export async function buildMrs(options = {}) {
  const opts = {
    out: DEFAULT_OUT,
    fetch: globalThis.fetch,
    now: () => new Date(),
    apiBase: API_BASE,
    timeoutMs: 15_000,
    retries: 1,
    retryDelayMs: 2_000,
    log: (line) => process.stderr.write(`${line}\n`),
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  };
  const schema = opts.schema ?? (await loadSchema());
  let doc, reason = null, source = 'github';
  try {
    doc = makeDoc(await fetchPulls(opts), isoSeconds(opts.now()));
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    reason = e.message;
    const previous = await loadPrevious(opts.previous ?? [opts.out], opts, schema);
    if (previous) {
      doc = { ...previous.doc, stale: true };
      source = previous.source;
    } else {
      doc = emptyDoc();
      source = 'none';
    }
  }
  scanDoc(canonical(doc)); // a forbidden pattern fails the build, on a fresh list and on a kept one
  const errors = validateDoc(doc, schema);
  if (errors.length) throw new Error(`the list would not be a valid ${SCHEMA_ID} file: ${errors.join('; ')}`);
  const text = serialize(doc);
  await writeAtomic(opts.out, text);
  return { doc: canonical(doc), stale: doc.stale, reason, source, bytes: byteLength(text) };
}

// ---- command line ----

const USAGE = `usage: node site/build/mrs.mjs [--out <file>] [--previous <file or https URL>]... [--part <file>]
  --out        where to write mrs.json (default data/v1/mrs.json in this repository)
  --previous   where the previous list is, tried in order if GitHub cannot be read (default: the --out file)
  --part       also write the page part (the HTML inside <main>) to this file`;

function apiBaseAllowed(base) {
  if (base === API_BASE) return true;
  try {
    const url = new URL(base);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
    return url.protocol === 'http:' && loopback && url.pathname === '/' && !url.search;
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  const warn = (line) => process.stderr.write(`${annotate ? '::warning title=MRs list::' : ''}${line}\n`);
  const error = (line) => process.stderr.write(`${annotate ? '::error title=MRs list::' : ''}${line}\n`);
  let args;
  try {
    ({ values: args } = parseArgs({
      args: argv,
      options: {
        out: { type: 'string' },
        previous: { type: 'string', multiple: true },
        part: { type: 'string' },
        'api-base': { type: 'string' }, // tests only: a local stand-in for the API
        'timeout-ms': { type: 'string' },
        'retry-delay-ms': { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch (e) {
    error(`mrs: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const apiBase = args['api-base'] ?? API_BASE;
  if (!apiBaseAllowed(apiBase)) {
    error('mrs: --api-base must be the GitHub API or a local test server');
    return 2;
  }
  const number = (name, fallback) => {
    if (args[name] === undefined) return fallback;
    const n = Number(args[name]);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`--${name} must be a whole number`);
    return n;
  };
  let timeoutMs, retryDelayMs;
  try {
    timeoutMs = number('timeout-ms', 15_000);
    retryDelayMs = number('retry-delay-ms', 2_000);
  } catch (e) {
    error(`mrs: ${e.message}`);
    return 2;
  }
  const out = resolve(args.out ?? DEFAULT_OUT);
  try {
    const result = await buildMrs({
      out,
      previous: args.previous?.map((p) => (/^https:\/\//.test(p) ? p : resolve(p))),
      apiBase,
      timeoutMs,
      retryDelayMs,
      log: warn,
    });
    const { counts, items, omitted, fetched_at: fetchedAt } = result.doc;
    const where = `${display(out)} (${result.bytes} bytes)`;
    if (result.stale) {
      warn(fetchedAt
        ? `mrs: GitHub could not be read (${result.reason}); kept the list from ${fetchedAt} (${display(result.source)}), marked stale; wrote ${where}`
        : `mrs: GitHub could not be read (${result.reason}) and there is no previous list; wrote an empty stale list to ${where}`);
    } else {
      process.stderr.write(`mrs: read ${items.length + omitted} pull requests from GitHub (${counts.open} open, ${counts.merged} merged, ${counts.closed} closed${omitted ? `, ${omitted} oldest left out for size` : ''}); wrote ${where}\n`);
    }
    if (args.part) {
      const { renderMrsPart } = await import('./mrs-render.mjs');
      await writeAtomic(resolve(args.part), renderMrsPart(result.doc));
    }
    return 0;
  } catch (e) {
    error(`mrs: ${e.message}`);
    return 1;
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
// Not a top-level await: mrs-render.mjs imports this module, and --part imports it while main() runs.
if (isMain) main().then((code) => { process.exitCode = code; });

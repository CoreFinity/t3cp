// Release texts: checking a written post into news/posts/<tag>.json, and rendering the published file.
//
// runPost() is the writing step. A post ({bundle_sha256, summary, sections} with {claim:<id>} placeholders; the
// title is the template) is written from its bundle only
// (site/build/release-bundle.mjs) and checked by news/check.mjs. Each attempt is recorded in the release's
// source file, news/posts/<tag>.json (`t3cp/post-source/1`, news/post-source-1.json), by its sha256 and findings,
// never its text. Two attempts per bundle: a pass stores the text (status passed); a first failure stores
// nothing but the attempt (status retry); a second failure ends it (status charts_only). A different bundle
// (new data) starts a new count; a post that passed is final for its bundle.
//
// renderRelease() is the build step's core (site/build/release-build.mjs): it re-runs the checker on the stored
// text against the bundle rebuilt from data, renders the placeholders and returns `t3cp/release/1`
// (schema/release-1.json): the rendered text, or the charts-only form with its reason: checker_failed, stale (the
// text no longer passes) or no_text_yet; a pending bundle has no comparison: pending (a record is not complete)
// or no_base (the base is from another era of the benchmark), and runPost() records no post for it.
//
// CLI: node site/build/release-post.mjs --bundle <post-bundle.json> --post <post.json> [--posts <dir>]
//        [--preview <file>]
//      exit 0: passed or charts-only recorded; 1: failed, one retry left; 2: refused or bad input.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CHECKER_VERSION, bundleSha256, check, cleanFinding, loadScanner, readJsonInput, scanJson } from '../../news/check.mjs';
import { fallbackPost, noteOf, titleFor, verdictOf } from '../../news/claims.mjs';
import { isMain } from '../../tools/t3cp/lib/repo.mjs';
import { formatSafeErrors, safePath, schemaErrors, schemaKeys } from '../../tools/t3cp/lib/safe-errors.mjs';

/** Validation errors as 'path message' pairs, the first n of them. */


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// A post source (news/posts/<tag>.json) is committed and read in review: indented. A release file is published data,
// compact like every other data file the aggregator writes; its budget is measured on the bytes written.
export const serialise = (x) => `${JSON.stringify(x, null, 2)}\n`;
export const serialiseRelease = (x) => `${JSON.stringify(x)}\n`;
export { bundleSha256 };

export const BUDGET_BYTES = 48 * 1024;
export const MAX_ATTEMPTS = 2;
// Failed posts seen in this process, by source file and bundle: their hashes are never written.
const FAILED_IN_RUN = new Map();
export { cleanFinding };
const SCHEMAS = {};
const schema = (rel) => (SCHEMAS[rel] ??= readJson(path.join(ROOT, rel)));

/** The charts-only form: charts plus rendered claims, no written sentence (news/claims.mjs fallbackPost). */
export const chartsOnlyPost = (bundle) => fallbackPost(bundle);

const FOOTER = {
  pending: () => 'Comparison pending: the measured records for this release are not complete yet.',
  no_base: () => 'No comparison: the upstream base was measured in another era of the benchmark, and no verdict crosses an era boundary.',
  text: (r) => `Text written from the measured record and checked against it: ${r.numbers_checked} numbers, ${r.charts} charts, 0 findings.`,
  checker_failed: (r) => `Charts only: the written text did not pass the checker (${r.findings.length} findings).`,
  stale: (r) => `Charts only: the text no longer matches the measured record (${r.findings.length} findings).`,
  no_text_yet: () => 'Charts only: no text has been written for this release yet.',
};

/** The pending (and no_base) form: tag, date, changelog and the charts that exist, with no claim (no number). */
function pendingPost(bundle) {
  const seen = new Set();
  const sections = [];
  const charts = bundle.charts.filter((c) => c.kind === 'series' && c.headline != null).sort((a, b) => a.headline - b.headline);
  for (const c of charts) {
    if (seen.has(c.metric) || sections.length >= 8) continue;
    seen.add(c.metric);
    const name = ((bundle.catalogue_names || []).find((m) => m.id === c.metric) || {}).name || c.metric;
    sections.push({ chart_id: c.id, caption: `${name} by nightly, ${bundle.release.short} marked.` });
  }
  return { title: titleFor(bundle), summary: null, sections, quotes: [] };
}

/** An error path of the post-source schema's own property names (tools/t3cp/lib/safe-errors.mjs safePath). */
export const safeSourcePath = (p) => safePath(p, schemaKeys(schema('news/post-source-1.json')));

const provenanceOf = (attempt) => (attempt && attempt.prompt_sha256 ? { prompt_sha256: attempt.prompt_sha256 } : attempt ? { written_in_session: true } : {});

function record(bundle, { post, reason, result, attempts, provenance = {} }) {
  if (reason === 'pending' || reason === 'no_base') {
    return {
      ...record({ ...bundle, metrics: [] }, { reason: 'no_text_yet', result, attempts: 0 }),
      counts: {}, deltas: [], charts_only_reason: reason, post: pendingPost(bundle),
      checker: { passed: false, version: CHECKER_VERSION, numbers_checked: 0, charts: 0, attempts: 0, findings: [], bundle_sha256: bundleSha256(bundle), footer: FOOTER[reason]() },
    };
  }
  // The rows the release page renders (site/build/render-post.mjs): the headline rows at every level, the rows
  // beyond noise against the base at their own level ("Other metrics beyond noise"), and agents_served at a level
  // where the fork or its base is saturated, which the page's saturated line quotes. Each with the fields the page
  // reads. The whole table is in the records; the comparison with the previous release is in the series files.
  const beyond = (r) => ['improved', 'regressed'].includes(verdictOf(r, 'base'));
  const servedLine = (r) => r.id === 'agents_served' && (r.saturated.fork === true || r.saturated.base === true);
  const deltas = bundle.metrics.filter((r) => r.headline != null || beyond(r) || servedLine(r)).map((r) => ({
    metric: r.id, platform: r.platform, level: r.level, headline: r.headline,
    fork: r.value.fork, base: r.value.base, delta_pct: r.value.delta_pct,
    threshold_pct: r.value.threshold_pct, verdict: verdictOf(r, 'base'), note: verdictOf(r, 'base') ? r.note : noteOf(r, 'base'),
    saturated: { fork: r.saturated.fork, base: r.saturated.base },
    text: { fork: r.text.fork, base: r.text.base, delta_pct: r.text.delta_pct },
  }));
  const chartsOnly = reason !== null;
  // A release never carries findings: the footer gives their number only.
  const findingCount = chartsOnly ? (result.findings || []).length : 0;
  const findings = [];
  const r = bundle.release;
  return {
    schema: 't3cp/release/1',
    ...(bundle.synthetic ? { synthetic: true } : {}),
    tag: r.tag,
    short: r.short,
    date: r.date,
    sha: r.sha,
    base: r.base ? { tag: r.base.tag ?? null, date: r.base.date, sha: r.base.sha ?? null, sha7: r.base.sha ? r.base.sha.slice(0, 7) : null } : null,
    prev: r.prev ? { tag: r.prev.tag, date: r.prev.date } : null,
    platforms: bundle.platforms,
    levels: bundle.levels,
    headline_level: bundle.headline_level,
    counts: bundle.counts,
    deltas,
    charts_only: chartsOnly,
    charts_only_reason: reason,
    post: chartsOnly ? chartsOnlyPost(bundle) : { title: post.title, summary: post.summary, sections: post.sections.map((s) => ({ chart_id: s.chart_id, caption: s.caption })), quotes: post.quotes || [] },
    changelog: bundle.changelog,
    checker: {
      passed: !chartsOnly,
      version: CHECKER_VERSION,
      ...provenance,
      numbers_checked: result.numbers_checked,
      charts: result.charts,
      attempts,
      findings,
      bundle_sha256: bundleSha256(bundle),
      footer: FOOTER[chartsOnly ? reason : 'text']({ ...result, findings: { length: findingCount } }),
    },
  };
}

/**
 * Render the published release file from a source (or null) and the bundle rebuilt from data. Re-runs the
 * checker on stored text; validates, scans and sizes the result, throwing on any failure (fail closed).
 * @param {{bundle: object, source: object|null, scanText: Function, budgetBytes?: number}} args
 * @returns {object} a `t3cp/release/1` object
 */
export function renderRelease({ bundle, source = null, scanText, scanValues, budgetBytes = BUDGET_BYTES }) {
  if (typeof scanText !== 'function') throw new Error('release: the internal-name scanner (tools/t3cp/lib/scan.mjs) did not load');
  const empty = { numbers_checked: 0, charts: 0, findings: [] };
  let rec;
  const provenance = provenanceOf(source && source.checker);
  if (bundle.pending) {
    rec = record(bundle, { reason: bundle.pending_reason === 'no_base' ? 'no_base' : 'pending', result: empty, attempts: 0 });
  } else if (!source || source.status === 'retry') {
    rec = record(bundle, { reason: 'no_text_yet', result: empty, attempts: 0 });
  } else if (source.status === 'charts_only' && source.checker.bundle_sha256 !== bundleSha256(bundle)) {
    // Two failures against other data decide nothing about this data: no text for it yet.
    rec = record(bundle, { reason: 'no_text_yet', result: empty, attempts: 0 });
  } else if (source.status === 'charts_only') {
    rec = record(bundle, { reason: 'checker_failed', result: source.checker, attempts: source.checker.n, provenance });
  } else {
    const result = check(source.post, bundle, { scanText, scanValues });
    rec = result.passed
      ? record(bundle, { post: result.rendered, reason: null, result, attempts: source.checker.n, provenance })
      : record(bundle, { reason: 'stale', result, attempts: source.checker.n, provenance });
  }
  const errors = schemaErrors(schema('schema/release-1.json'), rec);
  if (errors.length) throw new Error(`release ${bundle.release.tag}: does not validate against t3cp/release/1: ${formatSafeErrors(errors, schema('schema/release-1.json'), 3)}`);
  const text = serialiseRelease(rec);
  if (Buffer.byteLength(text) > budgetBytes) throw new Error(`release ${bundle.release.tag}: ${Buffer.byteLength(text)} bytes, over the ${budgetBytes}-byte budget`);
  // Keys and string leaves (the bundle's numbers masked only for a values list passed in); number leaves are measured data.
  if (scanJson(rec, scanText, bundle, { scanValues }).length) throw new Error(`release ${bundle.release.tag}: fails the internal-name scan`);
  return rec;
}

function inside(dir, parent) {
  const rel = path.relative(parent, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Resolve symlinks on the longest existing prefix, so a link cannot carry a synthetic write into the repository.
export function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  while (!existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(realpathSync(cur), ...tail);
}

export function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Read and validate a source file; null when there is none. Throws on a file that does not validate. */
export function readSource(file, tag) {
  if (!existsSync(file)) return null;
  // Never the file's text, an unknown key or a value from it: the offset of bad JSON, or the schema rules with paths
  // made of the schema's own property names only.
  const s = readJsonInput(file, path.basename(file));
  const errors = schemaErrors(schema('news/post-source-1.json'), s);
  if (errors.length) throw new Error(`${path.basename(file)}: does not validate against t3cp/post-source/1: ${formatSafeErrors(errors, schema('news/post-source-1.json'), 3)}`);
  if (tag && s.tag !== tag) throw new Error(`${path.basename(file)}: is for ${s.tag}, not ${tag}`);
  if (s.status === 'passed' && !s.post) throw new Error(`${path.basename(file)}: status passed without a post`);
  if (s.status !== 'passed' && s.post) throw new Error(`${path.basename(file)}: a post stored without a pass`);
  return s;
}

/**
 * What news/posts/<tag>.json decided for this bundle: 'passed', 'charts_only' (two failed attempts), or null.
 * @param {{bundle: object, postsDir?: string}} args
 */
export function decision({ bundle, postsDir = path.join(ROOT, 'news', 'posts') }) {
  const src = readSource(path.join(postsDir, `${bundle.release.tag}.json`), bundle.release.tag);
  if (!src) return null;
  const mine = src.attempts.filter((a) => a.bundle_sha256 === bundleSha256(bundle));
  if (mine.some((a) => a.passed)) return 'passed';
  return mine.filter((a) => !a.passed).length >= MAX_ATTEMPTS ? 'charts_only' : null;
}

/**
 * Check one written post and record what the two-attempt rule says in news/posts/<tag>.json.
 * @param {{bundle: object, post: object|null, failure?: {rule: string, detail?: string}|null,
 *   provenance?: {written_in_session: true}|{prompt_sha256: string, model?: string, usage?: object},
 *   postsDir?: string, scanText: Function|null, repoRoot?: string, now?: () => string}} args failure records a
 *   model answer that could not be read as a post (a refusal, an unparseable reply) as a failed attempt.
 * @returns {Promise<{status: 'passed'|'retry'|'charts-only'|'refused', message: string, file?: string, result?: object}>}
 */
export async function runPost({ bundle, post = null, failure = null, provenance = { written_in_session: true }, postsDir = path.join(ROOT, 'news', 'posts'), scanText, scanValues, repoRoot = ROOT, now = () => new Date().toISOString() }) {
  const refuse = (message) => ({ status: 'refused', message });
  if (typeof scanText !== 'function') return refuse('the internal-name scanner (tools/t3cp/lib/scan.mjs) did not load; nothing checked or recorded');
  const bErrors = schemaErrors(schema('news/post-bundle-1.json'), bundle);
  if (bErrors.length) return refuse(`the bundle does not validate against t3cp/post-bundle/1: ${formatSafeErrors(bErrors, schema('news/post-bundle-1.json'), 3)}`);
  if (bundle.pending && bundle.pending_reason === 'no_base') return refuse('the upstream base is from another era of the benchmark, so there is no comparison; no post is recorded');
  if (bundle.pending) return refuse('the comparison is pending (a fork, base or previous record is not complete); no post is recorded');
  const prov = provenance && provenance.prompt_sha256
    ? { prompt_sha256: provenance.prompt_sha256, ...(provenance.model ? { model: provenance.model } : {}), ...(provenance.usage ? { usage: { input_tokens: provenance.usage.input_tokens | 0, output_tokens: provenance.usage.output_tokens | 0 } } : {}) }
    : { written_in_session: true };
  if (bundle.synthetic) {
    const dir = realish(postsDir);
    for (const forbidden of [path.join(repoRoot, 'news', 'posts'), path.join(repoRoot, 'data')]) {
      if (inside(dir, realish(forbidden))) return refuse(`a synthetic bundle is never recorded under ${path.relative(repoRoot, forbidden)}/`);
    }
  }
  const tag = bundle.release.tag;
  const file = path.join(postsDir, `${tag}.json`);
  let src;
  try { src = readSource(file, tag); } catch (e) { return refuse(e.message); }
  const bSha = bundleSha256(bundle);
  const attempts = src ? src.attempts : [];
  const mine = attempts.filter((a) => a.bundle_sha256 === bSha);
  const passed = mine.find((a) => a.passed);
  const failed = mine.filter((a) => !a.passed);
  // A failed answer (a refusal, an unparseable reply) is recorded by its failure and its number, never by text.
  const postSha = failure ? sha256(JSON.stringify({ failure, n: failed.length + 1 })) : post == null ? null : sha256(JSON.stringify(post));

  const save = (next) => {
    const errors = schemaErrors(schema('news/post-source-1.json'), next);
    if (errors.length) return refuse(`the source does not validate against t3cp/post-source/1: ${formatSafeErrors(errors, schema('news/post-source-1.json'), 3)}`);
    const text = serialise(next);
    // Keys and string leaves (the bundle's numbers masked only for a values list passed in); number leaves (token
    // counts) are pipeline data.
    if (scanJson(next, scanText, bundle, { scanValues }).length) return refuse('the source fails the internal-name scan; nothing written');
    writeAtomic(file, text);
    return null;
  };
  const sourceOf = (status, keptPost, deciding, allAttempts) => ({
    schema: 't3cp/post-source/1',
    ...(bundle.synthetic ? { synthetic: true } : {}),
    tag, status, post: keptPost, changelog: bundle.changelog, checker: deciding, attempts: allAttempts,
  });

  if (passed) {
    if (postSha !== passed.post_sha256) return refuse(`${tag} already has a post that passed for this bundle; a correction needs new data or a new build`);
    const result = check(post, bundle, { scanText, scanValues });
    if (!result.passed) return refuse('the post that passed before no longer passes; the checker or the scanner changed');
    return { status: 'passed', message: `${file} is up to date`, file, result };
  }
  if (failed.length >= MAX_ATTEMPTS) {
    const last = failed[failed.length - 1];
    return { status: 'charts-only', message: `two attempts failed for this bundle; ${tag} ships charts only`, file, result: last };
  }
  if (post == null && !failure) return refuse('a post is required');
  // In session, re-running the same failed post is not a new attempt; each answer from the model is one. A failed
  // attempt is committed without the hash of its post (a refused post of the small vocabulary could be confirmed by
  // brute force), so identical failed posts are recognised within this process only.
  const runKey = `${realish(file)}|${bSha}`;
  const sameN = prov.prompt_sha256 || !postSha ? null : FAILED_IN_RUN.get(runKey)?.get(postSha);
  if (sameN) return { status: 'retry', message: `identical to attempt ${sameN}, which failed; not counted`, file, result: failed.find((a) => a.n === sameN) ?? null };

  const result = failure
    ? { passed: false, numbers_checked: 0, charts: 0, findings: [{ rule: String(failure.rule), field: 'post' }] }
    : check(post, bundle, { scanText, scanValues });
  const attempt = {
    n: failed.length + 1, version: CHECKER_VERSION, ...prov, bundle_sha256: bSha, ...(result.passed ? { post_sha256: postSha } : {}),
    passed: result.passed, numbers_checked: result.numbers_checked, charts: result.charts,
    findings: result.findings.map(cleanFinding), checked_at: now(),
  };
  const all = [...attempts, attempt];
  if (!result.passed && postSha && !failure) {
    if (!FAILED_IN_RUN.has(runKey)) FAILED_IN_RUN.set(runKey, new Map());
    FAILED_IN_RUN.get(runKey).set(postSha, attempt.n);
  }
  if (result.passed) {
    return save(sourceOf('passed', post, attempt, all)) || { status: 'passed', message: `passed on attempt ${attempt.n}: wrote ${file}`, file, result };
  }
  if (attempt.n < MAX_ATTEMPTS) {
    return save(sourceOf('retry', null, attempt, all)) || { status: 'retry', message: `attempt ${attempt.n} failed with ${result.findings.length} findings; one retry left`, file, result };
  }
  return save(sourceOf('charts_only', null, attempt, all)) || { status: 'charts-only', message: `attempt ${attempt.n} failed: ${tag} ships charts only`, file, result };
}

async function main(argv) {
  const { values: args } = parseArgs({ args: argv, options: { bundle: { type: 'string' }, post: { type: 'string' }, posts: { type: 'string' }, preview: { type: 'string' } } });
  if (!args.bundle) {
    process.stderr.write('usage: node site/build/release-post.mjs --bundle <post-bundle.json> --post <post.json> [--posts <dir>] [--preview <file>]\n'
      + 'In session: iterate on the draft with node news/check.mjs --bundle <post-bundle.json> --post <post.json> (it records nothing),\n'
      + 'and record with this command once, when the checker passes it: every run here is an attempt, and two failures end in charts only.\n');
    return 2;
  }
  const bundle = readJsonInput(args.bundle, 'bundle');
  const scanText = await loadScanner(ROOT);
  const r = await runPost({ bundle, post: args.post ? readJsonInput(args.post, 'post') : null, postsDir: args.posts, scanText });
  const out = { status: r.status, message: r.message, file: r.file };
  if (r.result) Object.assign(out, { numbers_checked: r.result.numbers_checked, charts: r.result.charts, findings: r.result.findings.map(cleanFinding) });
  if (args.preview && r.status !== 'refused') {
    const rec = renderRelease({ bundle, source: readSource(r.file, bundle.release.tag), scanText });
    writeAtomic(args.preview, serialiseRelease(rec));
    out.preview = args.preview;
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return r.status === 'passed' || r.status === 'charts-only' ? 0 : r.status === 'retry' ? 1 : 2;
}

// Real paths on both sides: reached through a symlink (or /var for /private/var) the script still runs.
if (isMain(import.meta.url)) {
  // An error's message only: the inputs' readers name the input and an offset, never its text.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`release-post: ${String(e?.message ?? 'failed').split('\n')[0].slice(0, 200)}\n`); process.exitCode = 2; });
}

// The build step for release posts: dist/data/v1/releases/<tag>.json for every fork release in the input tree.
//
// For each fork tag in the committed input (data/v1: records/, fork/, bands) it rebuilds the post bundle from
// the aggregator's releaseBundle() and the changelog lines stored in news/posts/<tag>.json, re-runs the checker
// on the stored text through renderRelease(), and writes the published t3cp/release/1 file: the text when it
// still passes, otherwise the charts-only form with its reason (checker_failed, stale, no_text_yet), or no comparison
// at all (pending: a record is not complete; no_base: the base is from another era of the benchmark).
// Deterministic; fails closed (throws, exit 2) on a missing scanner, a source that does not validate, a source
// for a tag with no fork record, a synthetic source outside a dev build or a scan hit. A release over its byte budget
// is built charts-only with its headline rows (over_budget) and the CLI prints a GitHub warning for it.
//
// CLI: node site/build/release-build.mjs --in <input data/v1> --out <dist/data/v1/releases> [--posts news/posts]
//        [--dev]

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadScanner } from '../../news/check.mjs';
import { isMain } from '../../tools/t3cp/lib/repo.mjs';
import { buildPostBundle, loadSource, pendingBundle, pendingWhy, recordSet } from './release-bundle.mjs';
import { BUDGET_BYTES, BudgetError, readSource, renderRelease, serialiseRelease, writeAtomic } from './release-post.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The fork tags with a record on the platform in the input tree, in tag order. */
async function forkTags(inDir, platform, dev) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'site', 'build', 'aggregate.mjs')).href);
  const { forks } = mod.loadInputs(inDir, { dev });
  const perf = (t) => Number(/-perf\.(\d+)$/.exec(t)[1]);
  return [...new Set(forks.filter((f) => f.record.platform.id === platform).map((f) => f.record.release.tag))].sort((a, b) => perf(a) - perf(b) || (a < b ? -1 : 1));
}

/**
 * Build every release file.
 * @param {{inDir: string, outDir: string, postsDir?: string, dev?: boolean, scanText: Function|null,
 *   catalogue?: object, platform?: string, tags?: string[]|null, log?: Function}} args tags builds only those
 * @returns {Promise<Array<{tag: string, file: string, charts_only_reason: string|null}>>}
 */
export async function buildReleases({ inDir, outDir, postsDir = path.join(ROOT, 'news', 'posts'), dev = false, scanText, catalogue, platform = 'linux-x64', tags: only = null, log = () => {}, budgetBytes = BUDGET_BYTES }) {
  if (typeof scanText !== 'function') throw new Error('release-build: the internal-name scanner (tools/t3cp/lib/scan.mjs) did not load');
  const cat = catalogue ?? (await import(pathToFileURL(path.join(ROOT, 'site', 'build', 'aggregate.mjs')).href)).loadCatalogue();
  const all = await forkTags(inDir, platform, dev);
  const known = new Set(all);
  // A subset of the tags (tests, or one release): each must have a fork record.
  if (only) for (const t of only) if (!known.has(t)) throw new Error(`release-build: no fork record for ${t} on ${platform}`);
  const tags = only ? all.filter((t) => only.includes(t)) : all;
  // Sources: an orphan (no fork record) or a synthetic source in a real build stops the build, since the tree is
  // wrong; a source that does not parse or validate fails only its own release (no text for it), named in `error`.
  const sources = new Map();
  const errors = new Map();
  if (existsSync(postsDir)) {
    for (const f of readdirSync(postsDir).filter((x) => x.endsWith('.json')).sort()) {
      const tag = f.slice(0, -'.json'.length);
      let s = null;
      let readError = null;
      try {
        s = readSource(path.join(postsDir, f), tag);
      } catch (e) {
        readError = e;
      }
      // A dev build reads only synthetic sources: a real one (the pipeline's) belongs to the real data, never to a
      // synthetic tree, whose tags it may not even have. The mirror of the rule below.
      if (dev && s && !s.synthetic) {
        log(`release-build: news/posts/${f} is not synthetic; a dev build reads only synthetic sources`);
        continue;
      }
      if (!known.has(tag)) throw new Error(`release-build: news/posts/${f} has no fork record for ${tag} on ${platform}`);
      if (readError) {
        errors.set(tag, `news/posts/${f}: ${readError.message.replace(`${f}: `, '')}`);
        continue;
      }
      if (s.synthetic && !dev) throw new Error(`release-build: news/posts/${f} is synthetic; a synthetic source is read only by a dev build`);
      sources.set(tag, s);
    }
  }
  const out = [];
  for (const tag of tags) {
    const source = sources.get(tag) ?? null;
    const changelog = source ? source.changelog : [];
    let bundle;
    let src = null;
    try {
      src = await loadSource({ dataDir: inDir, tag, dev });
      const set = recordSet({ dataDir: inDir, tag, prevTag: src.prev ? src.prev.tag : null, platform });
      bundle = buildPostBundle(src, { catalogue: cat, changelog, scanText, platform, bundleSha256: set.digest, pending: set.pending, baseRecord: set.baseRecord });
      // Every pending bundle states why: the records' reasons and the bundle's own (a gap in the release chain, a
      // base from another era), from the rule buildPostBundle() applied.
      if (bundle.pending) log(`release-build: ${tag} pending: ${pendingWhy({ release: bundle.release, metrics: bundle.metrics, digest: set.digest, pending: set.pending, why: set.why, baseRecord: set.baseRecord }).why.join('; ')}`);
    } catch (e) {
      // The aggregator could not compare the release (a missing or unreadable base, for one): pending, never a crash.
      const forkRecord = JSON.parse(readFileSync(path.join(inDir, 'fork', `${tag}.${platform}.json`), 'utf8'));
      bundle = pendingBundle({ forkRecord, catalogue: cat, changelog, platform });
      log(`release-build: ${tag} pending: ${e.message}`);
    }
    // A release over its budget never stops the build: it ships charts only with its headline rows, and the CLI
    // warns. Any other failure (schema, scan) still throws. src: the page's saturated line quotes agents_served,
    // which the post bundle may leave out.
    let rec;
    let over = null;
    try {
      rec = renderRelease({ bundle, source, scanText, src, budgetBytes });
    } catch (e) {
      if (!(e instanceof BudgetError)) throw e;
      over = e.bytes;
      log(`release-build: ${tag} over_budget: ${over} bytes`);
      rec = renderRelease({ bundle, source, scanText, src, budgetBytes, overBudget: true });
    }
    const file = path.join(outDir, `${tag}.json`);
    writeAtomic(file, serialiseRelease(rec));
    out.push({ tag, file, charts_only_reason: rec.charts_only_reason, ...(over !== null ? { over_budget_bytes: over } : {}), ...(errors.has(tag) ? { error: errors.get(tag) } : {}) });
  }
  return out;
}

async function main(argv) {
  const { values: args } = parseArgs({ args: argv, options: { in: { type: 'string' }, out: { type: 'string' }, posts: { type: 'string' }, dev: { type: 'boolean' }, platform: { type: 'string' }, 'budget-bytes': { type: 'string' } } });
  const budget = args['budget-bytes'] === undefined ? BUDGET_BYTES : Number(args['budget-bytes']);
  if (!args.in || !args.out || !Number.isSafeInteger(budget) || budget < 1) {
    process.stderr.write('usage: node site/build/release-build.mjs --in <input data/v1> --out <dist/data/v1/releases> [--posts news/posts] [--dev] [--budget-bytes <n>, tests only]\n');
    return 2;
  }
  const res = await buildReleases({
    inDir: args.in, outDir: args.out, postsDir: args.posts ?? path.join(ROOT, 'news', 'posts'), dev: args.dev === true,
    scanText: await loadScanner(ROOT), platform: args.platform ?? 'linux-x64', log: (line) => process.stderr.write(`${line}\n`), budgetBytes: budget,
  });
  for (const r of res) process.stderr.write(`release-build: ${r.tag} ${r.charts_only_reason ? `charts only (${r.charts_only_reason})` : 'text'}${r.error ? `; ${r.error}` : ''}\n`);
  // Report only: a GitHub warning annotation per release over its budget (CI and the deploy show it); exit 0.
  for (const r of res) if (r.over_budget_bytes !== undefined) process.stdout.write(`::warning::release ${r.tag} over budget: ${r.over_budget_bytes} bytes\n`);
  return 0;
}

// Real paths on both sides: reached through a symlink (or /var for /private/var) the script still runs.
if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });
}

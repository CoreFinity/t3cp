// Builds a release post's input bundle (`t3cp/post-bundle/1`, news/post-bundle-1.json) for one fork tag.
//
// Input: `t3cp/release-bundle/1` (site/build/aggregate.mjs releaseBundle(): the release,
// its base nightly, its previous fork release and one row per metric and level with the display strings), the
// catalogue, and the release's lines from the fork's public changelog. Output: what a post may say, and nothing
// else: the rows at 1, 50, 100 and 250 agents (and record-level metrics), the counts per level, the chart ids with
// machine captions and their order key, the claims a post may cite ({claim:<id>}, with the clause each renders
// to), the title, the allowed numbers, literals and metric names, and the verdict words.
//
// CLI: node site/build/release-bundle.mjs --tag <fork tag> [--data <input data/v1>] [--dev] [--platform linux-x64]
//        [--changelog <CHANGELOG-public.md>] [--source <release-bundle.json>] [--out <file>]
//      --dev reads a synthetic input tree; --source reads a saved t3cp/release-bundle/1 instead of the aggregator.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { VERDICT_WORDS, TIME_WORDS, loadScanner } from '../../news/check.mjs';
import { claimIndex, clauseFor, machineCaption, saturatedAt, titleFor } from '../../news/claims.mjs';
import { isMain } from '../../tools/t3cp/lib/repo.mjs';
import { formatSafeErrors, schemaErrors } from '../../tools/t3cp/lib/safe-errors.mjs';



const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

export const HEADLINE_LEVELS = Object.freeze(['1', '50', '100', '250']);
export const DEFAULT_HEADLINE = '50';
const SPELLED = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KIND_ORDER = { ladder: 0, series: 1, prev: 2 };

const unsigned = (s) => s.replace(/^[+−-]/, '');
// A changelog line as kept: NFKC, no default-ignorable code point (format characters, variation selectors, fillers,
// tag characters and the like), whitespace collapsed.
const normaliseLine = (l) => String(l).normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').replace(/\s+/g, ' ').trim();
// Cyrillic and Greek letters that look like Latin ones, and the Latin letter each looks like.
const LOOKALIKE = new Map(Object.entries({
  а: 'a', в: 'b', е: 'e', ё: 'e', і: 'i', ї: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ү: 'y', һ: 'h', ɡ: 'g',
  А: 'A', В: 'B', Е: 'E', Ё: 'E', І: 'I', Ї: 'I', Ј: 'J', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', Ѕ: 'S', Ү: 'Y', Һ: 'H',
  α: 'a', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c', ϳ: 'j',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X', Ϲ: 'C', Ϳ: 'J',
}));
// What the names scan also reads: the kept line decomposed, without combining marks, and with every look-alike
// folded to its Latin letter, so neither a mark nor a homoglyph can hide a name.
const skeleton = (l) => [...normaliseLine(l).normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC')].map((c) => LOOKALIKE.get(c) ?? c).join('');
// A link (any scheme with //, a script, data, mail, file or phone scheme without it, www., or a dotted host followed
// by a path), an HTML tag or comment, or an HTML entity.
const MARKUP_RE = new RegExp([
  '[a-z][a-z0-9+.-]*:\\/\\/',
  '(?<![\\w.+-])(?:javascript|vbscript|data|mailto|file|tel|sms|blob|about|ftp|https?|wss?|ssh|git|irc|news|urn):(?=\\S)',
  '(?<![\\w.])www\\.',
  '<[a-z!\\/?]',
  '&(?:[a-z][a-z0-9]*|#\\d+|#x[0-9a-f]+);',
].join('|'), 'i');
// A dotted host followed by a path (example.invalid/notes); a dotted file or framework name before a slash
// (Node.js/Electron, index.ts/index.test.ts) is prose, not a link.
const FILE_EXT = new Set(['js', 'ts', 'mjs', 'cjs', 'jsx', 'tsx', 'json', 'md', 'yml', 'yaml', 'css', 'html', 'sh', 'py']);
const HOST_WITH_PATH = (l) => [...l.matchAll(/(?<![\w@./-])(?:[a-z0-9-]+\.)+([a-z]{2,})\//gi)].some((m) => !FILE_EXT.has(m[1].toLowerCase()));
// A word that mixes Latin letters with a Cyrillic or Greek look-alike (a homoglyph inside a Latin word). Read on
// the NFC form, so a micro sign stays a sign; a Greek letter like no Latin one (Δt) is not a homoglyph.
const MIXED_SCRIPT = (l) => (String(l).normalize('NFC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').match(/\p{L}+/gu) || [])
  .some((w) => /\p{Script=Latin}/u.test(w) && [...w].some((c) => LOOKALIKE.has(c)));
const levelLabel = (l) => (l === '1' ? '1 agent' : `${l} agents`);
const shortOf = (tag) => (/-(perf\.\d+)$/.exec(tag || '') || [])[1] || null;
const longDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * The release's lines from the fork's public changelog: the section whose heading names the tag, up to the next
 * heading of the same or a higher level; list markers, emphasis, code marks and link targets removed, and the
 * "Upstream base: <sha>." line dropped.
 * @param {string} markdown CHANGELOG-public.md
 * @param {string} tag e.g. v0.1.9-perf.8
 * @returns {string[]}
 */
export function changelogExcerpt(markdown, tag) {
  const lines = String(markdown || '').split(/\r?\n/);
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`(?<![\\w.])${esc}(?![\\w]|\\.\\d)`);
  let depth = 0;
  const out = [];
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (depth && h[1].length <= depth) break;
      if (!depth && named.test(h[2])) depth = h[1].length;
      continue;
    }
    if (!depth) continue;
    const text = line
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|\*|_|`)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // The section's base line is metadata the release page already shows from the record.
    if (text && !/^upstream base:/i.test(text)) out.push(text);
  }
  return out;
}

/** A source row (t3cp/release-bundle/1) as a post bundle row, with the saturation rule applied. */
function bundleRow(r, release) {
  // The source schema requires saturated on every row; the bundle carries it on every row.
  const sat = { saturated: { fork: r.saturated.fork, base: r.saturated.base, prev: release.prev ? r.saturated.prev : null } };
  const row = {
    id: r.id, name: r.name, unit: r.unit, better: r.better, headline: r.headline, platform: r.platform, level: r.level,
    verdict: r.verdict, note: r.note, verdict_vs_prev: release.prev ? r.verdict_vs_prev : null,
    note_vs_prev: release.prev ? r.note_vs_prev : 'no_reference', thin_reference: false,
    text: {
      fork: r.text.fork, base: r.text.base, prev: release.prev ? r.text.prev : null, delta_pct: r.text.delta_pct,
      band_pct: r.text.band_pct, threshold_pct: r.text.threshold_pct, delta_vs_prev_pct: release.prev ? r.text.delta_vs_prev_pct : null,
    },
    value: {
      fork: r.fork ? r.fork.median : null, base: r.base ? r.base.median : null, prev: release.prev && r.prev ? r.prev.median : null,
      delta_pct: r.delta_pct, threshold_pct: r.threshold_pct, delta_vs_prev_pct: release.prev ? r.delta_vs_prev_pct : null,
    },
    _worse: r.worse_pct, _worse_prev: release.prev ? r.worse_vs_prev_pct : null,
    ...sat,
  };
  // A saturated level keeps only turns_completed and agents_served: whatever the source says, every other
  // metric there has no verdict (fail closed), so it counts, sizes and charts as context.
  if (saturatedAt(row, 'base')) Object.assign(row, { verdict: null, note: 'saturated' });
  if (release.prev && saturatedAt(row, 'prev')) Object.assign(row, { verdict_vs_prev: null, note_vs_prev: 'saturated' });
  return row;
}

/**
 * agents_served at each level where the fork or its base is saturated, as bundle rows, whatever its verdict. The
 * release page's saturated line quotes it, and the post bundle leaves out a metric with no verdict at any level.
 * @param {object} src the aggregator's release source (releaseBundle())
 * @param {{platforms?: string[]}} opts the bundle's platforms
 */
export function servedRows(src, { platforms = ['linux-x64'] } = {}) {
  const release = { prev: src.prev ?? null };
  return src.metrics
    .filter((m) => m.id === 'agents_served' && platforms.includes(m.platform) && HEADLINE_LEVELS.includes(m.level) && m.saturated && (m.saturated.fork === true || m.saturated.base === true))
    .map((m) => bundleRow(m, release));
}

/**
 * Build the post bundle.
 * @param {object} src a `t3cp/release-bundle/1` object (validated here against schema/release-bundle-1.json)
 * @param {{catalogue: object, changelog?: string[], scanText?: Function|null, platform?: string, headline?: string,
 *   pending?: boolean, bundleSha256?: string|null, baseRecord?: boolean}} opts scanText is required when the changelog is not empty: every line is scanned, and a hit
 *   fails closed. pending: a fork, base or previous record is not complete (the bundle is pending in any case when
 *   there is no base, or the previous release on record is not the one before this one).
 * @returns {object} a `t3cp/post-bundle/1` object
 */
export function buildPostBundle(src, { catalogue, changelog = [], scanText = null, platform = 'linux-x64', headline = DEFAULT_HEADLINE, pending = false, bundleSha256, baseRecord = true } = {}) {
  const schema = readJson(path.join(ROOT, 'schema', 'release-bundle-1.json'));
  const errors = schemaErrors(schema, src);
  if (errors.length) throw new Error(`release-bundle: the source does not validate against t3cp/release-bundle/1: ${formatSafeErrors(errors, schema, 5)}`);
  if (!catalogue || !Array.isArray(catalogue.metrics)) throw new Error('release-bundle: a catalogue is required');

  // Every line is scanned as written and normalised (NFKC, format characters removed), and the normalised line is
  // kept; a line with a link, markup or an HTML entity is refused (the excerpt is plain text). Errors name the line
  // number only, never its text.
  const raw = changelog.map((l) => String(l));
  const lines = [];
  if (raw.some((l) => l.trim())) {
    if (typeof scanText !== 'function') throw new Error('release-bundle: the internal-name scanner is required to read a changelog');
    raw.forEach((l, i) => {
      const plain = normaliseLine(l);
      if (!plain) return;
      const hits = [...(scanText(l) || []), ...(scanText(plain) || []), ...(scanText(skeleton(l)) || [])];
      if (hits.length) throw new Error(`release-bundle: changelog line ${i + 1} fails the internal-name scan (${hits.length} hit(s)); fix CHANGELOG-public.md`);
      if (MARKUP_RE.test(l) || MARKUP_RE.test(plain) || HOST_WITH_PATH(l) || HOST_WITH_PATH(plain)) throw new Error(`release-bundle: changelog line ${i + 1} holds a link, markup or an HTML entity; the excerpt is plain text; fix CHANGELOG-public.md`);
      if (MIXED_SCRIPT(l)) throw new Error(`release-bundle: changelog line ${i + 1} has a word mixing Latin with Cyrillic or Greek letters; fix CHANGELOG-public.md`);
      lines.push(plain);
    });
  }

  const release = {
    tag: src.release.tag, short: shortOf(src.release.tag), date: src.release.date, sha: src.release.sha,
    // The base is the upstream tree at the merge-base SHA; its sha is given only once its record exists.
    base: src.base ? { tag: src.base.tag ?? null, date: src.base.date, sha: baseRecord && src.base.sha ? src.base.sha : null } : null,
    prev: src.prev ? { tag: src.prev.tag, ...(shortOf(src.prev.tag) ? { short: shortOf(src.prev.tag) } : {}), date: src.prev.date } : null,
  };
  const keep = new Set([...HEADLINE_LEVELS, 'once']);
  const candidate = src.metrics.filter((m) => m.platform === platform && keep.has(m.level) && m.better !== 'context');
  const byId = new Map();
  for (const m of candidate) {
    if (!byId.has(m.id)) byId.set(m.id, []);
    byId.get(m.id).push(m);
  }
  const included = [...byId.entries()].filter(([, rows]) => rows[0].headline != null || rows.some((r) => r.verdict || r.verdict_vs_prev));
  const levelRank = (l) => (l === 'once' ? 99 : Number(l));
  const metrics = [];
  for (const [, rows] of included) {
    for (const r of rows.slice().sort((a, b) => levelRank(a.level) - levelRank(b.level))) metrics.push(bundleRow(r, release));
  }
  // Headline order first, then the catalogue's order: a stable, readable row order.
  const catOrder = new Map(catalogue.metrics.map((m, i) => [m.id, i]));
  metrics.sort((a, b) => (a.headline ?? 99) - (b.headline ?? 99) || catOrder.get(a.id) - catOrder.get(b.id) || levelRank(a.level) - levelRank(b.level));

  // Counts per headline level over the headline metrics; a record-level headline metric counts at every level.
  const levels = HEADLINE_LEVELS.filter((l) => metrics.some((m) => m.level === l));
  const counts = {};
  for (const l of levels) {
    const c = { improved: 0, regressed: 0, within: 0, no_verdict: 0, total: 0 };
    for (const [id] of included) {
      const rows = metrics.filter((m) => m.id === id);
      if (rows[0].headline == null) continue;
      const r = rows.find((m) => m.level === l) || rows.find((m) => m.level === 'once');
      if (!r) continue;
      c[r.verdict || 'no_verdict'] += 1;
      c.total += 1;
    }
    counts[l] = c;
  }

  // Charts and their order key: the largest |change| / threshold over the levels with a verdict.
  const size = (rows, key) => round3(Math.max(0, ...rows.filter((r) => r[key === 'base' ? 'verdict' : 'verdict_vs_prev'] && r.value.threshold_pct)
    .map((r) => Math.abs(key === 'base' ? r._worse : r._worse_prev) / r.value.threshold_pct)));
  const charts = [];
  for (const [id] of included) {
    const rows = metrics.filter((m) => m.id === id);
    const perLevel = rows.some((r) => r.level !== 'once');
    const headlineRow = rows.find((r) => r.level === headline) || rows.find((r) => r.level === 'once') || rows[0];
    const common = { metric: id, platform, headline: rows[0].headline };
    if (perLevel && headlineRow.text.base) charts.push({ id: `fork-vs-base.${id}.ladder.${platform}`, ...common, kind: 'ladder', comparison: 'base', size: size(rows, 'base'), caption: machineCaption('ladder', headlineRow, 'base', release) });
    charts.push({ id: `series.${id}.${platform}`, ...common, kind: 'series', comparison: 'base', size: size(rows, 'base'), caption: machineCaption('series', headlineRow, 'base', release) });
    if (release.prev && rows.some((r) => r.text.prev)) charts.push({ id: `fork-vs-prev.${id}.${platform}`, ...common, kind: 'prev', comparison: 'prev', size: size(rows, 'prev'), caption: machineCaption('prev', headlineRow, 'prev', release) });
  }
  charts.sort((a, b) => b.size - a.size || (a.headline ?? 99) - (b.headline ?? 99) || catOrder.get(a.metric) - catOrder.get(b.metric) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  for (const c of charts) {
    c.size = Number(c.size.toFixed(3));
    const { id, metric, platform: p, kind, comparison, size: s, headline, caption: cap } = c;
    Object.assign(c, { id, metric, platform: p, kind, comparison, size: s, headline, caption: cap });
  }

  // The closed sets the prose may draw from.
  const allowed = new Set(levels.map(levelLabel));
  for (const m of metrics) {
    for (const s of Object.values(m.text)) if (s && /\d/.test(s)) allowed.add(s);
    for (const s of [m.text.delta_pct, m.text.delta_vs_prev_pct]) if (s && /\d/.test(s)) allowed.add(unsigned(s));
  }
  for (const c of Object.values(counts)) {
    for (const n of Object.values(c)) {
      allowed.add(String(n));
      if (n < SPELLED.length) allowed.add(SPELLED[n]);
    }
  }
  const literals = new Set();
  if (release.base && release.base.sha) literals.add(release.base.sha.slice(0, 7));
  for (const side of [release, release.base, release.prev].filter(Boolean)) {
    if (side.tag) literals.add(side.tag);
    if (shortOf(side.tag)) literals.add(shortOf(side.tag));
    literals.add(side.date);
    literals.add(longDate(side.date));
    literals.add(side.date.slice(0, 4));
  }
  const allowedNames = new Set(metrics.filter((m) => m.verdict || m.verdict_vs_prev).map((m) => m.name));

  // Each claim's size: |change| / threshold, sign-adjusted change as the verdict rule uses it.
  const claimSize = new Map();
  for (const m of metrics) {
    const t = m.value.threshold_pct;
    for (const [cmp, w] of [['base', m._worse], ['prev', m._worse_prev]]) {
      claimSize.set(`${m.id}.${m.platform}.${m.level}.${cmp}`, t && w != null ? round3(Math.abs(w) / t) : 0);
    }
  }
  const rows = metrics.map(({ _worse, _worse_prev, ...m }) => m);
  // Pending: the caller says a record is not complete, there is no base, or the previous release on record is not
  // the one before this one (perf.N needs perf.N-1; perf.1 has none).
  const perf = (t) => Number((/-perf\.(\d+)$/.exec(t || '') || [])[1]);
  const n = perf(release.tag);
  // bundle_sha256: the records digest (recordsDigest()); null means a record is missing, so the bundle is pending.
  // Left out (fixtures, --source), it is the sha256 of the source bundle.
  const digest = bundleSha256 === undefined ? createHash('sha256').update(JSON.stringify(src)).digest('hex') : bundleSha256;
  const recordsPending = Boolean(pending) || !digest || !release.base || !rows.some((m) => m.text.base)
    || (n > 1 && (!release.prev || perf(release.prev.tag) !== n - 1));
  // A base from another era: the records are all there, but the rows compare nothing against it ("no_base" on a
  // base whose record exists). No verdict crosses an era boundary, so the release gets no comparison at all.
  const noBase = !recordsPending && baseRecord && rows.some((m) => m.note === 'no_base');
  const isPending = recordsPending || noBase;
  const pendingReason = noBase ? 'no_base' : recordsPending ? 'records' : null;
  const draft = { release, headline_level: headline, counts, metrics: rows, pending: isPending, pending_reason: pendingReason };
  const claims = [...claimIndex(draft).entries()].map(([id, c]) => ({
    id, metric: c.row.id, platform: c.row.platform, level: c.row.level, comparison: c.comparison, verdict: c.verdict, size: claimSize.get(id) ?? 0,
    clause: clauseFor(c.row, c.comparison, release),
  }));
  const out = {
    schema: 't3cp/post-bundle/1',
    ...(src.synthetic ? { synthetic: true } : {}),
    release,
    bundle_sha256: digest || '0'.repeat(64),
    pending: isPending,
    pending_reason: pendingReason,
    title: titleFor(draft),
    platforms: [platform],
    levels,
    headline_level: headline,
    changelog: lines,
    metrics: rows,
    counts,
    charts,
    claims,
    allowed_numbers: [...allowed].sort(),
    allowed_literals: [...literals].sort(),
    allowed_metric_names: [...allowedNames].sort(),
    catalogue_names: catalogue.metrics.map((m) => ({ id: m.id, name: m.name })),
    verdict_words: {
      improved: { lower: [...VERDICT_WORDS.improved.lower], higher: [...VERDICT_WORDS.improved.higher] },
      regressed: { lower: [...VERDICT_WORDS.regressed.lower], higher: [...VERDICT_WORDS.regressed.higher] },
      within: { lower: [...VERDICT_WORDS.within.lower], higher: [...VERDICT_WORDS.within.higher] },
      time: { improved: TIME_WORDS.improved, regressed: TIME_WORDS.regressed },
    },
  };
  const own = readJson(path.join(ROOT, 'news', 'post-bundle-1.json'));
  const ownErrors = schemaErrors(own, out);
  if (ownErrors.length) throw new Error(`release-bundle: the bundle does not validate against t3cp/post-bundle/1: ${formatSafeErrors(ownErrors, own, 5)}`);
  return out;
}

/**
 * The records a release post compares, read from the input tree: the fork record, its base record
 * (`base/<merge-base sha12>.<platform>.json`, never the nightly of that day) and the previous fork release's
 * record. `digest` identifies exactly those three committed files: the sha256 of the text made of one line per
 * record, `<public path> <sha256 of the record bytes>`, sorted, each line ending in a newline. The scheduler
 * computes the same value when it asks for a post, so a post names the records it was written against. `pending` (and a null digest) when any
 * of them is missing, not `status: complete`, or lacks a complete cell (two valid attempts) at 1, 50, 100 or 250 agents.
 * @param {{dataDir: string, tag: string, prevTag?: string|null, platform?: string}} args
 * @returns {{digest: string|null, pending: boolean, why: string[], baseRecord: boolean}}
 */
export function recordSet({ dataDir, tag, prevTag = null, platform = 'linux-x64' }) {
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const why = [];
  const lines = [];
  let baseRecord = false;
  const take = (rel, label) => {
    const f = path.join(dataDir, rel);
    if (!existsSync(f)) { why.push(`no ${label} record (${rel})`); return null; }
    if (label === 'base') baseRecord = true;
    const bytes = readFileSync(f);
    let rec;
    try { rec = JSON.parse(bytes.toString('utf8')); } catch { why.push(`the ${label} record does not parse (${rel})`); return null; }
    if (rec.status !== 'complete') why.push(`the ${label} record is ${rec.status ?? 'without a status'}`);
    for (const L of HEADLINE_LEVELS) {
      const c = rec.cells && rec.cells[L];
      if (!c || !(Number(c.valid) >= 2)) why.push(`the ${label} record has no complete ${L}-agent cell`);
    }
    lines.push(`data/v1/${rel} ${sha(bytes)}`);
    return rec;
  };
  const fork = take(`fork/${tag}.${platform}.json`, 'fork');
  if (fork) {
    if (fork.base && fork.base.sha) take(`base/${fork.base.sha.slice(0, 12)}.${platform}.json`, 'base');
    else why.push('the fork record names no base');
  }
  if (prevTag) take(`fork/${prevTag}.${platform}.json`, 'previous');
  const digest = why.length ? null : sha(`${lines.sort().join('\n')}\n`);
  return { digest, pending: why.length > 0, why, baseRecord };
}

/** recordSet(...).digest: the records digest, or null while the comparison is pending. */
export const recordsDigest = (args) => recordSet(args).digest;

/**
 * A pending bundle straight from the fork record, for when the aggregator cannot compare the release (a base
 * record that is missing or unreadable): tag, date, changelog and the headline series charts, no claim.
 */
export function pendingBundle({ forkRecord, catalogue, changelog = [], platform = 'linux-x64', headline = DEFAULT_HEADLINE }) {
  const r = forkRecord.release;
  const short = shortOf(r.tag);
  const names = new Map(catalogue.metrics.map((m) => [m.id, m.name]));
  const heads = (catalogue.headlines && catalogue.headlines[platform]) || [];
  const base = forkRecord.base ? { tag: forkRecord.base.tag ?? null, date: forkRecord.base.date, sha: null } : null;
  const literals = new Set([r.tag, short, r.date, longDate(r.date), r.date.slice(0, 4)].filter(Boolean));
  const out = {
    schema: 't3cp/post-bundle/1',
    ...(forkRecord.synthetic ? { synthetic: true } : {}),
    release: { tag: r.tag, short, date: r.date, sha: r.sha, base, prev: null },
    bundle_sha256: '0'.repeat(64),
    pending: true,
    pending_reason: 'records',
    title: `${r.tag}: comparison pending`,
    platforms: [platform],
    levels: [...HEADLINE_LEVELS],
    headline_level: headline,
    changelog: changelog.map((l) => String(l).trim()).filter(Boolean),
    metrics: [],
    counts: {},
    charts: heads.map((id, i) => ({ id: `series.${id}.${platform}`, metric: id, platform, kind: 'series', comparison: 'base', size: 0, headline: i + 1, caption: `${names.get(id) || id} by nightly, ${short} marked.` })),
    claims: [],
    allowed_numbers: [],
    allowed_literals: [...literals].sort(),
    allowed_metric_names: [],
    catalogue_names: catalogue.metrics.map((m) => ({ id: m.id, name: m.name })),
    verdict_words: {
      improved: { lower: [...VERDICT_WORDS.improved.lower], higher: [...VERDICT_WORDS.improved.higher] },
      regressed: { lower: [...VERDICT_WORDS.regressed.lower], higher: [...VERDICT_WORDS.regressed.higher] },
      within: { lower: [...VERDICT_WORDS.within.lower], higher: [...VERDICT_WORDS.within.higher] },
      time: { improved: TIME_WORDS.improved, regressed: TIME_WORDS.regressed },
    },
  };
  const postBundleSchema = readJson(path.join(ROOT, 'news', 'post-bundle-1.json'));
  const errors = schemaErrors(postBundleSchema, out);
  if (errors.length) throw new Error(`release-bundle: the pending bundle does not validate against t3cp/post-bundle/1: ${formatSafeErrors(errors, postBundleSchema)}`);
  return out;
}

// The aggregator rebuilds its whole model on every releaseBundle() call. Within one process the result is reused
// while its inputs are byte for byte the same: the key holds the sha256 of every file in the input tree, of the
// catalogue and of the schemas (never sizes or modification times, which a same-size edit can leave unchanged).
const SOURCE_CACHE = new Map();
const cacheStats = { hits: 0, misses: 0 };
/** How often loadSource() reused a result (for tests). */
export const sourceCacheStats = () => ({ ...cacheStats });

function treeKey(dir) {
  const lines = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else if (e.isFile()) lines.push(`${rel}${e.name} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir, 'data/');
  walk(path.join(ROOT, 'schema'), 'schema/');
  lines.push(`catalogue/catalogue.json ${createHash('sha256').update(readFileSync(path.join(ROOT, 'catalogue', 'catalogue.json'))).digest('hex')}`);
  return createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex');
}

/** The aggregator's releaseBundle() for one tag (site/build/aggregate.mjs); dev reads a synthetic input tree. */
export async function loadSource({ dataDir, tag, dev = false }) {
  const key = `${path.resolve(dataDir)}|${tag}|${dev}|${treeKey(dataDir)}`;
  if (SOURCE_CACHE.has(key)) {
    cacheStats.hits += 1;
    return structuredClone(SOURCE_CACHE.get(key));
  }
  cacheStats.misses += 1;
  const mod = await import(pathToFileURL(path.join(ROOT, 'site', 'build', 'aggregate.mjs')).href);
  if (typeof mod.releaseBundle !== 'function') throw new Error('release-bundle: site/build/aggregate.mjs has no releaseBundle()');
  const src = mod.releaseBundle({ dataDir, tag, levels: [...HEADLINE_LEVELS], dev });
  SOURCE_CACHE.set(key, structuredClone(src));
  return src;
}

async function main(argv) {
  const { values: args } = parseArgs({
    args: argv,
    options: { tag: { type: 'string' }, data: { type: 'string' }, dev: { type: 'boolean' }, platform: { type: 'string' }, changelog: { type: 'string' }, source: { type: 'string' }, out: { type: 'string' } },
  });
  if (!args.tag) {
    process.stderr.write('usage: node site/build/release-bundle.mjs --tag <fork tag> [--data <input data/v1>] [--dev] [--platform linux-x64] [--changelog <CHANGELOG-public.md>] [--source <release-bundle.json>] [--out <file>]\n');
    return 2;
  }
  const platform = args.platform || 'linux-x64';
  const src = args.source ? readJson(args.source) : await loadSource({ dataDir: args.data || path.join(ROOT, 'data', 'v1'), tag: args.tag, dev: args.dev === true });
  if (src.release.tag !== args.tag) throw new Error(`release-bundle: the source is for ${src.release.tag}, not ${args.tag}`);
  const changelog = args.changelog ? changelogExcerpt(readFileSync(args.changelog, 'utf8'), args.tag) : [];
  const scanText = await loadScanner(ROOT);
  const set = args.source ? null : recordSet({ dataDir: args.data || path.join(ROOT, 'data', 'v1'), tag: args.tag, prevTag: src.prev ? src.prev.tag : null, platform });
  if (set && set.pending) process.stderr.write(`release-bundle: ${args.tag} is pending: ${set.why.join('; ')}\n`);
  const bundle = buildPostBundle(src, { catalogue: readJson(path.join(ROOT, 'catalogue', 'catalogue.json')), changelog, scanText, platform, bundleSha256: set ? set.digest : undefined, pending: set ? set.pending : false, baseRecord: set ? set.baseRecord : true });
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  if (args.out) {
    mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    writeFileSync(args.out, text);
    process.stderr.write(`release-bundle: wrote ${args.out} (${bundle.metrics.length} rows, ${bundle.charts.length} charts, ${bundle.allowed_numbers.length} allowed numbers)\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

// Real paths on both sides: reached through a symlink (or /var for /private/var) the script still runs.
if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });
}

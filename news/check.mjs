// The release-post checker. Deterministic and fail-closed: a post passes only
// when every rule finds nothing. It reads a post object ({title, summary, sections[{chart_id, caption}]}) and the
// post bundle it was written from (`t3cp/post-bundle/1`, built by site/build/release-bundle.mjs).
//
// Findings never repeat free text from the post: they name the rule, the field, the sentence and, where the
// offending token comes from a closed vocabulary (a number, a banned word, a verdict word), that token. An
// internal-name hit is reported by its pattern id only.
//
// CLI: node news/check.mjs --bundle <bundle.json> --post <post.json>
//      prints the result as JSON; exit 0 = passed, 1 = findings, 2 = usage or input error.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJsonInput, schemaErrors, formatSafeErrors } from '../tools/t3cp/lib/safe-errors.mjs';
import { isMain } from '../tools/t3cp/lib/repo.mjs';
import { parseArgs } from 'node:util';
import { claimId, claimIndex, renderPost, verdictOf } from './claims.mjs';
import { ALLOWED_WORDS, WORD_CATEGORIES, categoryOf, isQuotable, normalise } from './words.mjs';

export { ALLOWED_WORDS, WORD_CATEGORIES, isQuotable };

export const CHECKER_VERSION = '2';

/**
 * The sha256 a post names: the bundle's bundle_sha256 (the digest of the fork, base and previous records it compares,
 * as tick dispatches it); for a bundle without one (test fixtures), the sha256 of its JSON.
 */
export const bundleSha256 = (bundle) => (typeof bundle?.bundle_sha256 === 'string' ? bundle.bundle_sha256 : createHash('sha256').update(JSON.stringify(bundle)).digest('hex'));

export const LIMITS = Object.freeze({ title: 60, summary: 400, caption: 200, sections: 8, summarySentences: 3 });

// The banned list (the same list news/prompt.v1.txt's rules imply), plus the site's tone words ("fast", "slow",
// "great", "broken": the site never says them).
// Entries are regular-expression fragments matched case-insensitively at word boundaries.
export const BANNED = Object.freeze([
  'excited', 'delighted', 'thrilled', 'dive[sd]?', 'deep[ -]dive', 'robust', 'leverag(?:e|es|ed|ing)',
  'game[ -]changer', 'significant', 'significantly', 'dramatic', 'dramatically', 'massive', 'massively', 'huge',
  'unlock(?:s|ed|ing)?', 'seamless(?:ly)?', 'journey', 'in this post', "let[’']s", "we[’']re", 'notably',
  "it[’']s worth noting", 'worth noting', 'overall', 'in summary', 'as you can see', 'exciting', 'amazing',
  'incredible', 'incredibly', 'impressive', 'blazing', 'lightning', 'supercharged', 'next[ -]level',
  'cutting[ -]edge', 'state[ -]of[ -]the[ -]art', 'best[ -]in[ -]class', 'elevat(?:e|es|ed|ing)',
  'empower(?:s|ed|ing)?', 'revolutionis(?:e|es|ed|ing)', 'revolutioniz(?:e|es|ed|ing)',
  'fast', 'slow', 'great', 'broken',
]);

// The verdict vocabulary (direction-aware: for a higher-is-better metric an improvement is
// "higher"). "faster" and "slower" belong only to time metrics, where lower is better.
export const VERDICT_WORDS = Object.freeze({
  improved: { lower: ['improved', 'beyond noise', 'lower', 'fewer', 'less'], higher: ['improved', 'beyond noise', 'higher', 'more'] },
  regressed: { lower: ['regressed', 'beyond noise', 'higher', 'more'], higher: ['regressed', 'beyond noise', 'lower', 'fewer', 'less'] },
  within: { lower: ['within noise', 'unchanged'], higher: ['within noise', 'unchanged'] },
});
export const TIME_WORDS = Object.freeze({ improved: 'faster', regressed: 'slower' });
const TIME_UNITS = new Set(['ms', 's']);

// Words that describe a direction of change but are not in the verdict vocabulary: never allowed.
const DIRECTION_WORDS = [
  'rose', 'rise', 'rises', 'risen', 'rising', 'fell', 'fall', 'falls', 'fallen', 'falling', 'drop', 'drops',
  'dropped', 'dropping', 'increase', 'increased', 'increases', 'increasing', 'decrease', 'decreased',
  'decreases', 'decreasing', 'reduce', 'reduced', 'reduces', 'reduction', 'grew', 'grow', 'grows', 'growing',
  'shrank', 'shrunk', 'gain', 'gained', 'gains', 'worse', 'worsened', 'better', 'improve', 'improves',
  'improving', 'improvement', 'improvements', 'regress', 'regresses', 'regression', 'regressions', 'climbed',
  'jumped', 'spiked', 'slipped', 'plunged', 'soared', 'cut', 'cuts', 'up', 'down', 'boost', 'boosted', 'sped',
  'speedup', 'speed-up', 'outperform', 'outperforms', 'outperformed',
];

const SPELLED_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
  'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'hundreds', 'thousand', 'thousands', 'million',
  'millions', 'dozen', 'dozens', 'half', 'quarter',
];
const RATIO = /(?<![\p{L}\p{N}])(?:twice|thrice|double[ds]?|doubling|triple[ds]?|tripling|quadruple[ds]?|halve[ds]?|halving|\d+(?:\.\d+)?\s?(?:x|×|times|fold)|(?:two|three|four|five|ten)[ -]?fold)(?![\p{L}\p{N}])/giu;
const CAUSE = /(?<![\p{L}\p{N}])(?:because|due to|thanks to|caused by|as a result|owing to|driven by|attribut\w*|result(?:s|ed|ing)? (?:from|in)|result of|stems? from|comes? from|fixed by|after|so that|therefore|hence|consequently)(?![\p{L}\p{N}])/iu;
const FUTURE = /(?<![\p{L}\p{N}])(?:will|won[’']t|shall|going to|upcoming|soon|plan|plans|planned|planning|expect|expects|expected|should|would|could|might)(?![\p{L}\p{N}])/giu;
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{1F1E6}-\u{1F1FF}\uFE0F\u20E3\u200D]/u;
const MARKUP = /[<>`*_#[\]{}|\\~^]|https?:|www\.|\]\(/iu;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/u;

const PLATFORM_WORDS = [
  [/(?<![\p{L}\p{N}])(?:linux|x64)(?![\p{L}\p{N}])/iu, 'linux-x64'],
  [/(?<![\p{L}\p{N}])(?:mac ?os|macs?|darwin|apple|arm64|mac mini)(?![\p{L}\p{N}])/iu, 'darwin-arm64'],
  [/(?<![\p{L}\p{N}])(?:windows|win32|win64)(?![\p{L}\p{N}])/iu, 'windows'],
];

// Units the tokenizer always recognises, so a number written with a unit the bundle never uses is still read
// with that unit (and fails), not as a bare number.
const BASE_UNITS = ['agents', 'agent', 'ms', 's', 'MiB', 'GiB', 'KiB', 'MB', 'GB', 'KB', '%', '/s', 'ms/s', 'MiB/h',
  'ms/h', 'pages/min', 'bytes', 'B', 'sec', 'secs', 'seconds', 'second', 'min', 'minutes', 'h', 'hours', 'pp',
  'points', 'turns', 'percent', 'per cent'];

const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}_])';
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}_])';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const phraseRe = (p) => escapeRe(p).replace(/\s+/g, '\\s+').replace(/'/g, "['’]");
const blank = (text, start, end) => text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
const unsigned = (s) => (typeof s === 'string' ? s.replace(/^[+\u2212-]/, '') : s);

function wordsRe(list, flags = 'giu') {
  const alts = list.slice().sort((a, b) => b.length - a.length).map(phraseRe);
  return new RegExp(`${BOUNDARY_BEFORE}(?:${alts.join('|')})${BOUNDARY_AFTER}`, flags);
}
const VOCAB_LIST = [...new Set([
  ...Object.values(VERDICT_WORDS).flatMap((c) => [...c.lower, ...c.higher]), ...Object.values(TIME_WORDS),
])];
const VOCAB_RE = wordsRe(VOCAB_LIST);
const DIRECTION_RE = wordsRe(DIRECTION_WORDS);
const SPELLED_RE = wordsRe(SPELLED_WORDS);
const BANNED_RE = new RegExp(`${BOUNDARY_BEFORE}(?:${BANNED.map((b) => b.replace(/ /g, '\\s+')).join('|')})${BOUNDARY_AFTER}`, 'giu');

/** Split a number string into its numeric part and its unit suffix ("9,257 ms" -> ["9,257", "ms"]). */
function splitNumber(s) {
  const m = /^([+\u2212-]?\d[\d,]*(?:\.\d+)?)\s?(.*)$/u.exec(s);
  return m ? [m[1], m[2]] : [s, ''];
}

// A number token: an optional sign that does not follow a letter or digit, digits with thousands commas, an
// optional decimal part, then an optional unit from the list (longest first) ending at a word boundary.
function numberRe(units) {
  const u = [...new Set(units)].filter(Boolean).sort((a, b) => b.length - a.length).map(phraseRe);
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:[+\\u2212]|-(?=\\d))?\\d+(?:,\\d{3})*(?:\\.\\d+)?(?:\\s?(?:${u.join('|')})(?![\\p{L}\\p{N}]))?`,
    'gu',
  );
}

// Sentence ends: '.' (with any closing quote or bracket) before whitespace or the end; or a newline. ';' and '?'
// end nothing (and '?' never reaches a checked text: the written text may not hold it).
function sentenceSpans(text) {
  const spans = [];
  const re = /\.+["”)\]]*(?=\s|$)|\n+/gu;
  let start = 0;
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length;
    if (/[\p{L}\p{N}\uE000]/u.test(text.slice(start, end))) spans.push([start, end]);
    start = end;
  }
  if (/[\p{L}\p{N}\uE000]/u.test(text.slice(start))) spans.push([start, text.length]);
  return spans;
}

/** Load the internal-name scanner from tools/t3cp/lib/scan.mjs. Null when it is missing. */
export async function loadScanner(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const file = path.join(root, 'tools', 't3cp', 'lib', 'scan.mjs');
  if (!existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  return typeof mod.scanText === 'function' ? (text) => mod.scanText(text) : null;
}

/** Prepare everything the per-field checks need from the bundle once. */
function prepare(bundle) {
  const b = bundle && typeof bundle === 'object' ? bundle : {};
  const allowed = new Set((b.allowed_numbers || []).map(String));
  const allowedLower = new Set([...allowed].map((s) => s.toLowerCase()));
  const allowedNumeric = new Map(); // numeric part -> units seen
  for (const s of allowed) {
    const [n, u] = splitNumber(s);
    if (!allowedNumeric.has(n)) allowedNumeric.set(n, new Set());
    allowedNumeric.get(n).add(u);
  }
  const units = [...BASE_UNITS, ...[...allowed].map((s) => splitNumber(s)[1]).filter((u) => u && !/\d/.test(u))];
  const rows = Array.isArray(b.metrics) ? b.metrics : [];
  const metricInfo = new Map(); // id -> {better, unit, name}
  for (const r of rows) if (!metricInfo.has(r.id)) metricInfo.set(r.id, { better: r.better, unit: r.unit, name: r.name });
  const names = new Map(); // lower-case name -> id
  for (const c of b.catalogue_names || []) names.set(String(c.name).toLowerCase(), c.id);
  for (const r of rows) names.set(String(r.name).toLowerCase(), r.id);
  const allowedNames = new Set((b.allowed_metric_names || []).map((n) => String(n).toLowerCase()));
  const ids = new Set([...(b.catalogue_names || []).map((c) => c.id), ...rows.map((r) => r.id)].filter(Boolean));
  const literals = (b.allowed_literals || []).map(String).filter(Boolean);
  const levels = new Set((b.levels || []).map(String));
  const charts = new Map((Array.isArray(b.charts) ? b.charts : []).map((c) => [c.id, c]));
  // A sentence that names the previous release, or says "previous release", takes the vs-previous verdict.
  const prevNames = b.release && b.release.prev ? [b.release.prev.tag, b.release.prev.short].filter(Boolean) : [];
  // A sentence that names the base (its tag, or the word "base") takes the vs-base comparison.
  const baseNames = b.release && b.release.base ? [b.release.base.tag, b.release.base.short_sha].filter(Boolean) : [];
  const baseRe = new RegExp(`(?<![\\p{L}\\p{N}.])(?:${[...baseNames.map(escapeRe), '(?:upstream\\s+)?base'].join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  const prevRe = new RegExp(`(?<![\\p{L}\\p{N}.])(?:${[...prevNames.map(escapeRe), 'previous(?:\\s+fork)?\\s+release'].join('|')})(?![\\p{L}\\p{N}]|\\.\\p{N})`, 'iu');
  return {
    b, allowed, allowedLower, allowedNumeric, rows, metricInfo, names, allowedNames, ids, levels, charts, prevRe, baseRe,
    numRe: numberRe(units),
    nameRe: names.size ? wordsRe([...names.keys()]) : null,
    idRe: ids.size ? new RegExp(`(?<![\\w])(?:${[...ids].sort((x, y) => y.length - x.length).map(escapeRe).join('|')})(?![\\w])`, 'gu') : null,
    literalRe: literals.length
      ? new RegExp(`(?<![\\p{L}\\p{N}.])(?:${literals.sort((x, y) => y.length - x.length).map(escapeRe).join('|')})(?![\\p{L}\\p{N}]|[.,]\\p{N})`, 'gu')
      : null,
    platforms: new Set((b.platforms || []).map(String)),
    primaryPlatform: (b.platforms || [])[0] || 'linux-x64',
    headline: String(b.headline_level ?? '50'),
    counts: b.counts || {},
    changelog: Array.isArray(b.changelog) ? b.changelog.map(String) : typeof b.changelog === 'string' ? [b.changelog] : [],
  };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

// ---- A number taken from the bundle is measured data ----
// A private VALUE-class pattern (a production figure, however worded) must not refuse a measured number. The
// private list is split: the names list (names, paths, other) is opts.scanText and always scans the text as
// written, so a name that contains a bundle number is never masked away; a values list, only when a caller passes
// one deliberately as opts.scanValues, scans the text after every numeric token whose value is a number in the
// bundle is masked. Generated text (release-post) gets no values list. JSON number leaves of pipeline data are
// never scanned. A numeric token stands alone: digits (with thousands groups and decimals) not part of a word, a
// path, a dashed or dotted sequence or a longer number.
const NUM_TOKEN = /(?<![\p{L}\p{N}_.,/\\-])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\p{L}\p{N}_/\\-]|[.,]\d)/gu;
const numberValue = (token) => Number(token.replace(/,/g, ''));
const BUNDLE_NUMBERS = new WeakMap();

/** The numbers a bundle holds: its rows' values and display strings, its counts, its allowed numbers and levels. */
function bundleNumbers(b) {
  if (b && typeof b === 'object' && BUNDLE_NUMBERS.has(b)) return BUNDLE_NUMBERS.get(b);
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'number') { if (Number.isFinite(v)) out.add(v); }
    else if (typeof v === 'string') { for (const m of v.matchAll(NUM_TOKEN)) { const n = numberValue(m[0]); if (Number.isFinite(n)) out.add(n); } }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  if (b && typeof b === 'object') [b.metrics, b.counts, b.allowed_numbers, b.levels].forEach(walk);
  if (b && typeof b === 'object') BUNDLE_NUMBERS.set(b, out);
  return out;
}

/** The text with every numeric token whose value is a bundle number replaced by as many '#' (indices kept). */
export function maskBundleNumbers(text, bundle) {
  const nums = bundleNumbers(bundle);
  if (!nums.size) return String(text);
  return String(text).replace(NUM_TOKEN, (m) => (nums.has(numberValue(m)) ? '#'.repeat(m.length) : m));
}

// What a committed or published finding may keep: never the text the checker refused (no token, no detail, no
// pattern id), only where it was and which rule refused it. The run's own result keeps the full findings (the
// retry sends them back to the writer); nothing writes them to a file.
const RULE_RE = /^[a-z][a-z-]{1,40}$/;
const FIELD_RE = /^(post|title|summary|sections(\[\d{1,2}\](\.(caption|chart_id))?)?)$/;

/** A finding as it may be written: rule id, field, sentence index and position, nothing of the text. */
export function cleanFinding(f) {
  const out = { rule: RULE_RE.test(String(f?.rule)) ? String(f.rule) : 'other', field: FIELD_RE.test(String(f?.field)) ? String(f.field) : 'post' };
  for (const k of ['sentence', 'index']) if (Number.isInteger(f?.[k]) && f[k] >= 0) out[k] = f[k];
  return out;
}

// The safe JSON reader lives with the validator's door (tools/t3cp/lib/safe-errors.mjs); kept here for its importers.
export { readJsonInput };

/** The hits of the names list on the text as written and, when one is passed, of the values list on the masked text. */
export function scanBoth(text, bundle, scanText, scanValues) {
  const hits = [...(scanText(text) || [])];
  if (typeof scanValues === 'function') hits.push(...(scanValues(maskBundleNumbers(text, bundle)) || []));
  return hits;
}

/**
 * The internal-name scan of a JSON value (a source or release file): every key and string leaf with the names list
 * as written (and the values list, when one is passed, with the bundle's numbers masked); number leaves are
 * pipeline data and never scanned. Returns the hits with their JSON path.
 */
export function scanJson(value, scanText, bundle, { scanValues } = {}) {
  const hits = [];
  const walk = (v, p) => {
    if (typeof v === 'string') { for (const h of scanBoth(v, bundle, scanText, scanValues)) hits.push({ ...h, path: p }); }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        for (const h of scanText(k) || []) hits.push({ ...h, path: `${p}.${k}` });
        walk(x, `${p}.${k}`);
      }
    }
  };
  walk(value, '$');
  return hits;
}

/** The words a sentence may use for one metric's verdict. */
function classWords(verdict, info) {
  const cls = VERDICT_WORDS[verdict];
  if (!cls) return new Set();
  const dir = info.better === 'higher' ? 'higher' : 'lower';
  const words = new Set(cls[dir]);
  if (dir === 'lower' && TIME_UNITS.has(info.unit) && TIME_WORDS[verdict]) words.add(TIME_WORDS[verdict]);
  return words;
}

/** The number strings a sentence about one metric may use, at the given levels and comparison. */
function boundStrings(rows, ctx) {
  const out = new Set();
  for (const r of rows) {
    const t = r.text || {};
    const list = ctx === 'prev'
      ? [t.fork, t.prev, t.delta_vs_prev_pct, unsigned(t.delta_vs_prev_pct), t.band_pct, t.threshold_pct]
      : [t.fork, t.base, t.delta_pct, unsigned(t.delta_pct), t.band_pct, t.threshold_pct];
    for (const s of list) if (s) out.add(s);
  }
  return out;
}

function checkField(P, field, text, out, opts) {
  const { findings } = out;
  const add = (rule, extra = {}) => findings.push({ rule, field, ...extra });

  // Whole-field rules on the text as written.
  if (CONTROL.test(text)) add('schema', { detail: 'control character or line break' });
  if (EMOJI.test(text)) add('emoji');
  if (text.includes('!')) add('exclamation');
  for (const m of text.matchAll(BANNED_RE)) add('banned', { token: m[0].toLowerCase() });
  if (typeof opts.scanText === 'function') {
    // The scan runs on the text as written and on its NFKC form with format characters removed.
    const seenHit = new Set();
    for (const t of new Set([text, normalise(text).replace(/\p{Cf}/gu, '')])) {
      let hits;
      try { hits = scanBoth(t, P.b, opts.scanText, opts.scanValues); } catch { hits = [{ pattern: 'scanner-error', index: 0 }]; }
      for (const h of hits || []) {
        const key = `${h.pattern}|${h.index}`;
        if (!seenHit.has(key)) { seenHit.add(key); add('internal-name', { pattern: String(h.pattern), index: h.index }); }
      }
    }
  }

  // Quotations: each must be a verbatim part of the changelog. Their contents are then blanked out.
  let masked = text;
  const quoteSpans = [];
  if (/[‘‚„«»]/u.test(text)) add('quote', { detail: 'only double quotation marks are allowed' });
  const qre = /"([^"]*)"|“([^”]*)”/gu;
  for (const m of text.matchAll(qre)) {
    const inner = norm(m[1] ?? m[2] ?? '');
    const ok = inner.length > 0 && P.changelog.some((line) => norm(line).includes(inner));
    if (!ok) add('quote', { detail: 'a quotation that is not in the changelog' });
    quoteSpans.push([m.index, m.index + m[0].length, ok]);
    masked = blank(masked, m.index, m.index + m[0].length);
  }
  if (/["“”]/u.test(masked)) add('quote', { detail: 'an unbalanced quotation mark' });
  masked = masked.replace(/["“”]/gu, ' ');
  // Markup outside quotations (a quotation is the changelog's own text, checked above).
  if (MARKUP.test(masked)) add('markup', { detail: 'markup, a link or a reserved character' });

  // Tags, dates and the year pass through the literal allow-list.
  if (P.literalRe) masked = masked.replace(P.literalRe, (s) => ' '.repeat(s.length));

  const sentences = sentenceSpans(masked);
  out.sentences[field] = sentences.length;
  sentences.forEach(([start, end], si) => {
    const original = text.slice(start, end);
    let s = masked.slice(start, end);
    const addS = (rule, extra = {}) => add(rule, { sentence: si, ...extra });
    const hasQuote = quoteSpans.some(([qs, qe, ok]) => ok && qs < end && qe > start);

    // Metric names (longest first), then ids.
    const mentioned = [];
    if (P.nameRe) {
      for (const m of s.matchAll(P.nameRe)) mentioned.push(P.names.get(m[0].toLowerCase().replace(/\s+/g, ' ')));
      s = s.replace(P.nameRe, (x) => ' '.repeat(x.length));
    }
    if (P.idRe) {
      for (const m of s.matchAll(P.idRe)) { mentioned.push(m[0]); addS('metric-by-id', { token: m[0] }); }
      s = s.replace(P.idRe, (x) => ' '.repeat(x.length));
    }
    const metrics = [...new Set(mentioned.filter(Boolean))];

    const ctx = P.prevRe && P.prevRe.test(original) ? 'prev' : 'base';
    const mentionsBase = P.baseRe.test(original);

    // Numbers with their units.
    const tokens = [];
    for (const m of s.matchAll(P.numRe)) tokens.push({ text: m[0].replace(/\s+/gu, ' '), index: m.index, end: m.index + m[0].length });
    let s2 = s;
    for (const t of tokens) s2 = blank(s2, t.index, t.end);
    const spelled = [...s2.matchAll(SPELLED_RE)].map((m) => ({ text: m[0].toLowerCase(), index: m.index, end: m.index + m[0].length, spelled: true }));
    out.numbers += tokens.length + spelled.length;

    // Levels named in the sentence.
    const namedAll = [];
    for (const t of tokens) {
      const lm = /^(\d+) agents?$/u.exec(t.text);
      if (lm) { t.level = true; namedAll.push(lm[1]); }
    }
    const named = [...new Set(namedAll)];

    // Count clauses ("2 improved", "3 within noise", "1 of 8 headline metrics moved beyond noise").
    const countLevel = named.length === 1 ? named[0] : P.headline;
    const NUM = '(\\d+|[a-z]+)';
    const countRe = new RegExp(`(?<![\\p{L}\\p{N}])${NUM}(?:\\s+of\\s+${NUM})?(?:\\s+headline)?(?:\\s+metrics?)?(?:\\s+(?:are|were|is|was|have|has))?\\s+(improved|regressed|within\\s+noise|unchanged|moved\\s+beyond\\s+noise)(?:\\s+beyond\\s+noise)?(?![\\p{L}\\p{N}])`, 'giu');
    const toInt = (w) => (/^\d+$/.test(w) ? Number(w) : SPELLED_WORDS.indexOf(w.toLowerCase()));
    let s3 = s;
    let countClauses = 0;
    for (const m of s.matchAll(countRe)) {
      const n = toInt(m[1]);
      if (n < 0 || n > 12 && !/^\d+$/.test(m[1])) continue; // not a number word: not a count clause
      const c = P.counts[countLevel];
      const v = m[3].toLowerCase().replace(/\s+/g, ' ');
      const key = v === 'within noise' || v === 'unchanged' ? 'within' : v === 'moved beyond noise' ? 'moved' : v;
      const want = !c ? null : key === 'moved' ? (c.improved ?? 0) + (c.regressed ?? 0) : c[key];
      if (want !== n) addS('count', { token: m[1].toLowerCase(), detail: `does not match the ${key} count at ${countLevel}` });
      if (m[2] !== undefined && (!c || toInt(m[2]) !== c.total)) addS('count', { token: m[2].toLowerCase(), detail: `does not match the headline total at ${countLevel}` });
      for (const t of [...tokens, ...spelled]) if (t.index >= m.index && t.end <= m.index + m[0].length) t.count = true;
      s3 = blank(s3, m.index, m.index + m[0].length);
      countClauses += 1;
    }

    // Every number must be an allowed string, unit included.
    for (const t of [...tokens, ...spelled]) {
      const ok = t.spelled ? P.allowedLower.has(t.text) : P.allowed.has(t.text);
      if (!ok) {
        const [n, u] = t.spelled ? [t.text, ''] : splitNumber(t.text);
        const units = P.allowedNumeric.get(n);
        if (units && !units.has(u)) addS('number-unit', { token: t.text });
        else addS('number-not-allowed', { token: t.text });
        t.bad = true;
      }
    }
    for (const m of s.matchAll(RATIO)) addS('ratio', { token: m[0].toLowerCase() });

    // Verdict and direction words, outside count clauses.
    const s4 = s3.replace(SPELLED_RE, (x) => ' '.repeat(x.length));
    const vocab = [...s4.matchAll(VOCAB_RE)].map((m) => m[0].toLowerCase().replace(/\s+/g, ' '));
    for (const m of s4.matchAll(DIRECTION_RE)) addS('direction-word', { token: m[0].toLowerCase() });

    // Platform claims.
    const platformsNamed = PLATFORM_WORDS.filter(([re]) => re.test(s)).map(([, p]) => p);
    const platform = platformsNamed.length === 1 ? platformsNamed[0] : P.primaryPlatform;

    if (CAUSE.test(s) && !hasQuote) addS('cause', { detail: 'a cause is stated only by quoting the changelog' });
    for (const m of s.matchAll(FUTURE)) addS('future', { token: m[0].toLowerCase() });

    const free = [...tokens, ...spelled].filter((t) => !t.level && !t.count && !t.bad);
    if (metrics.length > 1) {
      addS('two-metrics');
      return;
    }
    // One claim row per sentence: one metric (or one level's counts), one platform, one level, one comparison.
    const claim = metrics.length > 0 || countClauses > 0 || vocab.length > 0 || free.length > 0;
    if (claim) {
      const why = [];
      if (named.length > 1) why.push('two levels');
      if (platformsNamed.length > 1) why.push('two platforms');
      if (ctx === 'prev' && mentionsBase) why.push('both comparisons');
      if (metrics.length > 0 && countClauses > 0) why.push('a count beside a metric');
      if (why.length) { addS('row-ambiguous', { detail: `binds to more than one row: ${why.join(', ')}` }); return; }
    }
    if (field.endsWith('.caption') && metrics.length === 1 && opts.chart && opts.chart.metric !== metrics[0]) {
      addS('caption-metric');
    }
    if (metrics.length === 0) {
      for (const w of vocab) addS('verdict-without-metric', { token: w });
      for (const t of free) addS('number-unbound', { token: t.text });
      for (const p of platformsNamed) if (!P.rows.some((r) => r.platform === p)) addS('platform', { token: p });
      return;
    }

    const id = metrics[0];
    for (const p of platformsNamed) if (!P.rows.some((r) => r.id === id && r.platform === p)) addS('platform', { token: p });
    const info = P.metricInfo.get(id);
    const rowsAll = P.rows.filter((r) => r.id === id && r.platform === platform);
    const nameKnown = info && P.allowedNames.has(String(info.name).toLowerCase());
    if (!info || rowsAll.length === 0 || !nameKnown) { addS('metric-no-verdict'); return; }
    // The one row: the named level, else the headline level, else the record-level row.
    const level = named.length ? named[0] : rowsAll.some((r) => r.level === P.headline) ? P.headline : rowsAll.length === 1 ? rowsAll[0].level : null;
    const row = level === null ? null : rowsAll.find((r) => String(r.level) === level);
    if (!row) { addS('metric-no-verdict', { detail: level === null ? 'no single row for this metric' : 'no row at the named level' }); return; }
    const verdict = verdictOf(row, ctx === 'prev' ? 'prev' : 'base');
    if (!verdict) { addS('metric-no-verdict'); return; }
    const allowedWords = classWords(verdict, info);
    for (const w of vocab) if (!allowedWords.has(w)) addS('verdict-class', { token: w });
    const bound = boundStrings([row], ctx);
    for (const t of free) if (!t.spelled && !bound.has(t.text)) addS('number-unbound', { token: t.text });
    for (const t of free) if (t.spelled) addS('number-unbound', { token: t.text });
  });
}

/**
 * The sentence rules on finished text ({title, summary, sections}): every number allowed and bound to the one row
 * its sentence names, verdict words of that row's class, and the rest. check() runs it on the rendered post as a
 * self-test of the renderer.
 * @param {unknown} post {title, summary, sections: [{chart_id, caption}]}
 * @param {object} bundle a `t3cp/post-bundle/1` object
 * @param {{scanText?: Function|null, titleLimit?: number}} opts the internal-name scanner (null fails closed)
 * @returns {{passed: boolean, numbers_checked: number, charts: number, findings: object[]}}
 */
export function checkText(post, bundle, opts = {}) {
  const titleLimit = opts.titleLimit ?? LIMITS.title;
  const out = { findings: [], numbers: 0, sentences: {} };
  const add = (rule, extra = {}) => out.findings.push({ rule, ...extra });
  const P = prepare(bundle);
  if (typeof opts.scanText !== 'function') add('scanner-missing', { field: 'post', detail: 'tools/t3cp/lib/scan.mjs did not load' });

  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(post)) {
    add('schema', { field: 'post', detail: 'not an object' });
    return finish(out, 0);
  }
  for (const k of Object.keys(post)) if (!['title', 'summary', 'sections', 'quotes'].includes(k)) add('schema', { field: 'post', detail: 'an unknown key' });
  // A rendered post's quotes block: whole changelog lines, scanned like the rest.
  if ('quotes' in post) {
    if (!Array.isArray(post.quotes) || !post.quotes.every((q) => typeof q === 'string')) add('schema', { field: 'post', detail: 'quotes is a list of lines' });
    else if (typeof opts.scanText === 'function') {
      for (const q of post.quotes) for (const h of opts.scanText(normalise(q)) || []) add('internal-name', { field: 'post', pattern: String(h.pattern), index: h.index });
    }
  }
  for (const k of ['title', 'summary']) if (typeof post[k] !== 'string') add('schema', { field: k, detail: 'missing or not a string' });
  if (!Array.isArray(post.sections)) add('schema', { field: 'sections', detail: 'missing or not an array' });
  const sections = Array.isArray(post.sections) ? post.sections : [];

  if (typeof post.title === 'string') {
    if (post.title.trim().length === 0 || post.title.length > titleLimit) add('length', { field: 'title', detail: `1 to ${titleLimit} characters` });
    checkField(P, 'title', post.title, out, opts);
  }
  if (typeof post.summary === 'string') {
    if (post.summary.trim().length === 0 || post.summary.length > LIMITS.summary) add('length', { field: 'summary', detail: `1 to ${LIMITS.summary} characters` });
    checkField(P, 'summary', post.summary, out, opts);
    const n = out.sentences.summary || 0;
    if (n < 1 || n > LIMITS.summarySentences) add('summary-sentences', { field: 'summary', detail: `1 to ${LIMITS.summarySentences} sentences` });
  }

  if (sections.length > LIMITS.sections) add('sections-max', { field: 'sections', detail: `at most ${LIMITS.sections}` });
  if (Array.isArray(post.sections) && sections.length === 0) add('sections-min', { field: 'sections', detail: 'at least one chart' });
  const seen = new Set();
  let lastSize = Infinity;
  sections.forEach((sec, i) => {
    const f = `sections[${i}]`;
    if (!isObj(sec)) { add('schema', { field: f, detail: 'not an object' }); return; }
    for (const k of Object.keys(sec)) if (!['chart_id', 'caption'].includes(k)) add('schema', { field: f, detail: 'an unknown key' });
    if (typeof sec.chart_id !== 'string') add('schema', { field: `${f}.chart_id`, detail: 'missing or not a string' });
    if (typeof sec.caption !== 'string') add('schema', { field: `${f}.caption`, detail: 'missing or not a string' });
    const chart = typeof sec.chart_id === 'string' ? P.charts.get(sec.chart_id) : undefined;
    if (typeof sec.chart_id === 'string') {
      if (!chart) add('chart-id', { field: `${f}.chart_id` });
      if (seen.has(sec.chart_id)) add('chart-duplicate', { field: `${f}.chart_id` });
      seen.add(sec.chart_id);
    }
    if (chart) {
      const size = Number(chart.size) || 0;
      if (size > lastSize) add('order', { field: `${f}.chart_id`, detail: 'sections go largest change first' });
      lastSize = Math.min(lastSize, size);
    }
    if (typeof sec.caption === 'string') {
      if (sec.caption.trim().length === 0 || sec.caption.length > LIMITS.caption) add('length', { field: `${f}.caption`, detail: `1 to ${LIMITS.caption} characters` });
      checkField(P, `${f}.caption`, sec.caption, out, { ...opts, chart });
    }
  });
  return finish(out, sections.length);
}

// ---- The placeholder form (the written text) ----

const MARK = '';
const PH_RE = /\{(claim|quote):([^{}\s]{1,120})\}/gu;
const UNIT_WORDS = new Set(['ms', 'sec', 'secs', 'second', 'seconds', 'millisecond', 'milliseconds', 'minute', 'minutes',
  'hour', 'hours', 'mib', 'gib', 'kib', 'mb', 'gb', 'kb', 'bytes', 'percent', 'pp', 'points']);
const RULE_OF_CATEGORY = { number: 'free-number', direction: 'free-verdict-word', verdict: 'free-verdict-word', metric: 'free-metric-name', platform: 'platform', cause: 'cause', future: 'future' };
const CHART_KIND_WORDS = new Set(['ladder', 'series']);
const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

// The written text: placeholders (known claims, quotable whole changelog lines), and around them only words from
// ALLOWED_WORDS, spaces and ', . :'. Checked on the NFKC form, after rejecting what NFKC would hide.
function checkFree(P, claims, field, raw, out, opts) {
  const add = (rule, extra = {}) => out.findings.push({ rule, field, ...extra });
  if (CONTROL.test(raw)) add('schema', { detail: 'control character or line break' });
  if (/\p{Cf}/u.test(raw)) add('free-char', { detail: 'an invisible format character' });
  if (EMOJI.test(raw)) add('emoji');
  const text = normalise(raw);
  if (/[!¡！]/u.test(raw) || text.includes('!')) add('exclamation');
  for (const m of text.matchAll(BANNED_RE)) add('banned', { token: m[0].toLowerCase() });
  if (typeof opts.scanText === 'function') {
    const seenHit = new Set();
    for (const t of new Set([raw, text])) {
      let hits;
      try { hits = scanBoth(t, P.b, opts.scanText, opts.scanValues); } catch { hits = [{ pattern: 'scanner-error', index: 0 }]; }
      for (const h of hits || []) {
        const key = `${h.pattern}|${h.index}`;
        if (!seenHit.has(key)) { seenHit.add(key); add('internal-name', { pattern: String(h.pattern), index: h.index }); }
      }
    }
  }

  // Placeholders: known claims (in a caption: the chart's own metric, platform and comparison) and quotable lines.
  let masked = text;
  const spans = [];
  for (const m of text.matchAll(PH_RE)) {
    const [whole, kind, id] = m;
    if (kind === 'claim') {
      const c = claims.get(id);
      if (!c) add('claim-unknown', { detail: 'a placeholder id that is not a claim in the bundle' });
      else if (opts.chart && (c.row.id !== opts.chart.metric || c.comparison !== opts.chart.comparison || c.row.platform !== opts.chart.platform)) {
        add('caption-metric', { detail: 'a claim about another metric, platform or comparison than the chart' });
      }
      spans.push({ start: m.index, end: m.index + whole.length, kind, claim: c || null, id });
    } else {
      // Changelog lines go in the post's quotes list, shown at the end; never by a chart or a claim.
      add('quote', { detail: 'list changelog lines in quotes, not in the text' });
      spans.push({ start: m.index, end: m.index + whole.length, kind });
    }
    masked = masked.slice(0, m.index) + MARK.repeat(whole.length) + masked.slice(m.index + whole.length);
  }

  // Characters outside placeholders: Latin letters, spaces and ', . :' only, both as written and after NFKC (which
  // composes marks and turns an ellipsis into dots); a run of dots is not a sentence end; a character NFKC would
  // change (a superscript or full-width letter) is not plain text; a placeholder stands apart from letters.
  const flagged = new Set();
  const rawMasked = raw.replace(PH_RE, (x) => MARK.repeat(x.length));
  for (const ch of rawMasked) {
    if (ch !== MARK && ch.normalize('NFKC') !== ch && !flagged.has(`nfkc|${ch}`)) {
      flagged.add(`nfkc|${ch}`);
      add('free-char', { token: hex(ch), detail: 'a compatibility character (NFKC changes it)' });
    }
  }
  if (/[\p{L}\p{N}]\uE000|\uE000[\p{L}\p{N}]/u.test(masked)) add('free-char', { detail: 'a placeholder needs a space or punctuation on both sides' });
  if (/[:.]\uE000/u.test(masked)) add('free-char', { detail: 'a space after ":" or "." before a placeholder' });
  if (/ [.,:]/u.test(masked)) add('free-char', { detail: 'no space before ".", "," or ":"' });
  if (/\.\./u.test(masked)) add('free-char', { token: hex('.'), detail: 'a run of dots' });
  for (const ch of `${rawMasked}${masked}`) {
    if (ch === MARK || ch === ' ' || /[,.:]/u.test(ch) || (/\p{L}/u.test(ch) && /\p{Script=Latin}/u.test(ch))) continue;
    let rule = 'free-char';
    let detail = 'a character outside letters, spaces and , . :';
    if (/\p{N}/u.test(ch)) { rule = 'free-number'; detail = 'a number outside a claim'; }
    else if (/["“”'‘’«»„‚]/u.test(ch)) { rule = 'quote'; detail = 'quote the changelog with {quote:<n>}'; }
    else if (/[%‰]/u.test(ch)) { rule = 'free-unit'; detail = 'a unit outside a claim'; }
    else if (/\p{M}/u.test(ch)) detail = 'a combining mark';
    else if (/\p{L}/u.test(ch)) detail = 'a letter outside the Latin script';
    const key = `${rule}|${ch}`;
    if (flagged.has(key)) continue;
    flagged.add(key);
    add(rule, { token: hex(ch), detail });
  }
  if (MARKUP.test(masked.replace(//gu, ' '))) add('markup', { detail: 'markup, a stray brace, a link or a reserved character' });
  if (P.literalRe) masked = masked.replace(P.literalRe, (x) => ' '.repeat(x.length));

  sentenceSpans(masked).forEach(([start, end], si) => {
    const addS = (rule, extra = {}) => add(rule, { sentence: si, ...extra });
    const inside = spans.filter((p) => p.start >= start && p.start < end);
    const claimsHere = inside.filter((p) => p.kind === 'claim');
    const quotesHere = inside.filter((p) => p.kind === 'quote');
    if (claimsHere.length > 1) addS('claim-two', { detail: 'at most one claim per sentence' });
    let s = masked.slice(start, end).replace(//gu, ' ');
    if (quotesHere.length && (quotesHere.length > 1 || claimsHere.length || /\p{L}/u.test(s))) addS('quote', { detail: 'a quotation stands alone in its sentence' });
    if (P.nameRe) {
      for (const m of s.matchAll(P.nameRe)) addS('free-metric-name', { token: m[0].toLowerCase().slice(0, 40) });
      s = s.replace(P.nameRe, (x) => ' '.repeat(x.length));
    }
    if (P.idRe) {
      for (const m of s.matchAll(P.idRe)) addS('free-metric-name', { token: m[0] });
      s = s.replace(P.idRe, (x) => ' '.repeat(x.length));
    }
    const claim = claimsHere.length === 1 ? claimsHere[0].claim : null;
    for (const m of s.matchAll(/\p{L}+/gu)) {
      const w = m[0].toLowerCase();
      // A chart-kind word names only its own chart, in that chart's caption.
      if (CHART_KIND_WORDS.has(w) && !(opts.chart && opts.chart.kind === w)) { addS('free-word', { token: w, detail: 'a chart-kind word outside its own chart' }); continue; }
      if (ALLOWED_WORDS.has(w)) continue;
      const cat = categoryOf(w);
      if (UNIT_WORDS.has(w)) addS('free-unit', { token: w });
      if (cat && RULE_OF_CATEGORY[cat]) {
        if (cat === 'platform') {
          const p = PLATFORM_WORDS.find(([re]) => re.test(w));
          if (!p || (claim ? claim.row.platform !== p[1] : !P.rows.some((r) => r.platform === p[1]))) addS('platform', { token: w });
        } else addS(RULE_OF_CATEGORY[cat], { token: w });
      }
      // A word outside the vocabulary is named only when it is one of the known kinds, never repeated otherwise.
      addS('free-word', cat || UNIT_WORDS.has(w) ? { token: w, detail: `${cat || 'unit'} word outside a claim` } : { detail: 'a word outside the allowed vocabulary' });
    }
  });
}

/**
 * Check one written post in the placeholder form against its bundle, render it, and check the rendered text
 * again with checkText() (the renderer's self-test, which also re-runs the internal-name scan).
 * @param {unknown} post {bundle_sha256, summary, sections: [{chart_id, caption}]}: no title (the title is the
 *   template); bundle_sha256 names the bundle the text was written from
 * @param {object} bundle a `t3cp/post-bundle/1` object
 * @param {{scanText?: Function|null, renderClause?: Function}} opts the internal-name scanner (null fails closed);
 *   renderClause replaces the clause builder (tests only)
 * @returns {{passed: boolean, numbers_checked: number, charts: number, findings: object[], rendered: object|null}}
 *   rendered is the rendered post when it passed, null otherwise.
 */
export function check(post, bundle, opts = {}) {
  const out = { findings: [], numbers: 0, sentences: {} };
  const add = (rule, extra = {}) => out.findings.push({ rule, ...extra });
  const P = prepare(bundle);
  if (typeof opts.scanText !== 'function') add('scanner-missing', { field: 'post', detail: 'tools/t3cp/lib/scan.mjs did not load' });
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(post)) {
    add('schema', { field: 'post', detail: 'not an object' });
    return { ...finish(out, 0), rendered: null };
  }
  for (const k of Object.keys(post)) {
    if (!['bundle_sha256', 'summary', 'sections', 'quotes'].includes(k)) add('schema', { field: 'post', detail: k === 'title' ? 'the title is the template, not written' : 'an unknown key' });
  }
  if ('quotes' in post) {
    if (!Array.isArray(post.quotes) || !post.quotes.every((n) => Number.isInteger(n))) add('schema', { field: 'post', detail: 'quotes is a list of changelog line numbers' });
    else {
      if (new Set(post.quotes).size !== post.quotes.length) add('quote', { field: 'post', detail: 'a changelog line is quoted once' });
      for (const n of post.quotes) {
        const line = P.changelog[n - 1];
        if (line === undefined) add('quote', { field: 'post', detail: 'not a line of the changelog' });
        else if (!isQuotable(line)) add('quote', { field: 'post', detail: 'a changelog line with a number, or a quantity, direction, verdict, quality or effect word' });
      }
    }
  }
  if (typeof post.bundle_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(post.bundle_sha256)) add('schema', { field: 'post', detail: 'bundle_sha256 missing or not a sha256' });
  else if (post.bundle_sha256 !== bundleSha256(bundle)) add('bundle-mismatch', { field: 'post', detail: 'written from another bundle' });
  if (typeof post.summary !== 'string') add('schema', { field: 'summary', detail: 'missing or not a string' });
  if (!Array.isArray(post.sections)) add('schema', { field: 'sections', detail: 'missing or not an array' });
  const sections = Array.isArray(post.sections) ? post.sections : [];
  const claims = claimIndex(P.b);

  if (typeof post.summary === 'string') {
    checkFree(P, claims, 'summary', post.summary, out, opts);
    // While the bundle has movers (improved or regressed), the summary cites only movers.
    const movers = [...claims.values()].some((c) => c.verdict !== 'within');
    const cited = [...normalise(post.summary).matchAll(PH_RE)].filter((m) => m[1] === 'claim').map((m) => claims.get(m[2])).filter(Boolean);
    if (movers && (cited.length === 0 || cited.some((c) => c.verdict === 'within'))) add('summary-binding', { field: 'summary', detail: 'while there are claims beyond noise the summary cites them, and only them' });
    // Complete: the headline metrics that regressed, each by its largest regressed claim; the summary cites the
    // three largest of them (all of them when there are three or fewer). The title's counts state how many.
    const worst = new Map();
    for (const c of claims.values()) {
      if (c.verdict !== 'regressed' || c.row.headline == null) continue;
      if (!worst.has(c.row.id) || c.size > worst.get(c.row.id).size) worst.set(c.row.id, c);
    }
    // Each required claim itself (metric, level and comparison): a smaller regression of the same metric at
    // another level, or in the other comparison, does not stand in for it.
    const required = [...worst.values()].sort((a, b) => b.size - a.size || a.row.headline - b.row.headline || (a.row.id < b.row.id ? -1 : 1)).slice(0, 3).map((c) => claimId(c.row, c.comparison));
    const citedRegressed = new Set(cited.filter((c) => c.verdict === 'regressed').map((c) => claimId(c.row, c.comparison)));
    for (const id of required) if (!citedRegressed.has(id)) add('summary-binding', { field: 'summary', detail: 'the summary cites the largest three headline regressions (all, when fewer)' });
    // Ordered: largest change first.
    for (let i = 1; i < cited.length; i++) if (cited[i].size > cited[i - 1].size) { add('summary-order', { field: 'summary', detail: 'summary claims run largest change first' }); break; }
  }
  if (sections.length > LIMITS.sections) add('sections-max', { field: 'sections', detail: `at most ${LIMITS.sections}` });
  if (Array.isArray(post.sections) && sections.length === 0) add('sections-min', { field: 'sections', detail: 'at least one chart' });
  const seen = new Set();
  let lastSize = Infinity;
  let shapeOk = typeof post.summary === 'string' && Array.isArray(post.sections);
  sections.forEach((sec, i) => {
    const f = `sections[${i}]`;
    if (!isObj(sec)) { add('schema', { field: f, detail: 'not an object' }); shapeOk = false; return; }
    for (const k of Object.keys(sec)) if (!['chart_id', 'caption'].includes(k)) add('schema', { field: f, detail: 'an unknown key' });
    if (typeof sec.chart_id !== 'string') { add('schema', { field: `${f}.chart_id`, detail: 'missing or not a string' }); shapeOk = false; }
    if (typeof sec.caption !== 'string') { add('schema', { field: `${f}.caption`, detail: 'missing or not a string' }); shapeOk = false; }
    const chart = typeof sec.chart_id === 'string' ? P.charts.get(sec.chart_id) : undefined;
    if (typeof sec.chart_id === 'string') {
      if (!chart) add('chart-id', { field: `${f}.chart_id` });
      if (seen.has(sec.chart_id)) add('chart-duplicate', { field: `${f}.chart_id` });
      seen.add(sec.chart_id);
    }
    if (chart) {
      const size = Number(chart.size) || 0;
      if (size > lastSize) add('order', { field: `${f}.chart_id`, detail: 'sections go largest change first' });
      lastSize = Math.min(lastSize, size);
    }
    if (typeof sec.caption === 'string') checkFree(P, claims, `${f}.caption`, sec.caption, out, { ...opts, chart });
  });

  // Render, then the self-test on the rendered text; a rule already reported for a field is not repeated.
  let rendered = null;
  let numbers = 0;
  if (shapeOk) {
    rendered = renderPost(post, P.b, { renderClause: opts.renderClause });
    const self = checkText(rendered, P.b, { scanText: opts.scanText, scanValues: opts.scanValues, titleLimit: 120 });
    numbers = self.numbers_checked;
    const have = new Set(out.findings.map((x) => `${x.rule}|${x.field}`));
    for (const x of self.findings) {
      if (x.rule === 'scanner-missing' || have.has(`${x.rule}|${x.field}`)) continue;
      out.findings.push({ ...x, detail: `rendered${x.detail ? `: ${x.detail}` : ''}`.slice(0, 120) });
    }
  }
  const passed = out.findings.length === 0;
  // The rendered text leaves the checker only when it passed, so a failed text is never carried further.
  return { passed, numbers_checked: numbers, charts: sections.length, findings: out.findings, rendered: passed ? rendered : null };
}

function finish(out, charts) {
  return { passed: out.findings.length === 0, numbers_checked: out.numbers, charts, findings: out.findings };
}

// ---- CLI ----
async function main(argv) {
  const { values: args } = parseArgs({ args: argv, options: { bundle: { type: 'string' }, post: { type: 'string' } } });
  if (!args.bundle || !args.post) {
    process.stderr.write('usage: node news/check.mjs --bundle <bundle.json> --post <post.json>\n');
    return 2;
  }
  let bundle, post;
  try {
    bundle = readJsonInput(args.bundle, 'bundle');
    post = readJsonInput(args.post, 'post');
  } catch (e) {
    process.stderr.write(`check: ${e.message}\n`);
    return 2;
  }
  const schema = JSON.parse(readFileSync(new URL('./post-bundle-1.json', import.meta.url), 'utf8'));
  const errors = schemaErrors(schema, bundle);
  if (errors.length) {
    process.stderr.write(`check: ${args.bundle} is not a t3cp/post-bundle/1: ${formatSafeErrors(errors, schema, 5)}\n`);
    return 2;
  }
  const result = check(post, bundle, { scanText: await loadScanner() });
  // As a finding may be written: never the refused text (the run's own result keeps it in memory only).
  process.stdout.write(`${JSON.stringify({ ...result, findings: result.findings.map(cleanFinding) }, null, 2)}\n`);
  return result.passed ? 0 : 1;
}

// Real paths on both sides: reached through a symlink (or /var for /private/var) the script still runs.
if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

// Claims: the only place a release post states a number or a verdict.
//
// A claim is one bundle row and one comparison: metric, platform, level ("1", "50", "100", "250" or "once") and
// "base" (fork against its upstream base) or "prev" (fork against the previous fork release). Its id is
// `<metric>.<platform>.<level>.<comparison>`, e.g. `turns_completed.linux-x64.100.base`, and the written text
// refers to it as `{claim:<id>}`. The renderer replaces each placeholder with a fixed clause built from the row:
//
//   <name>[ at <level>]: <reference value> on <the upstream base | previous tag>, <fork value> on <tag>, <change>, <verdict>
//
// e.g. "Turns completed in the window at 100 agents: 233 on the upstream base, 290 on perf.8, +24.5 %, improved beyond
// noise". Every value is the bundle's own display string. A claim exists only where its comparison has a verdict.
//
// Two rules hold here whatever the bundle's verdicts say (fail closed). At a saturated level (the fork's record,
// or the compared one, could not serve every agent) only turns_completed and agents_served keep a comparison:
// every other metric there is context, never a claim. A comparison noted "saturated" or "no_base" (a base from
// another era: no verdict crosses an era boundary) is never a claim either.

import { createHash } from 'node:crypto';
import { isQuotable } from './words.mjs';

const bundleSha256 = (bundle) => (typeof bundle?.bundle_sha256 === 'string' ? bundle.bundle_sha256 : createHash('sha256').update(JSON.stringify(bundle)).digest('hex'));

export const PLACEHOLDER_RE = /\{claim:([a-z0-9_.-]{1,120})\}/g;
export const QUOTE_RE = /\{quote:([1-9]\d{0,2})\}/g;
export const VERDICT_PHRASE = Object.freeze({ improved: 'improved beyond noise', regressed: 'regressed beyond noise', within: 'within noise' });

export const claimId = (row, comparison) => `${row.id}.${row.platform}.${row.level}.${comparison}`;

/** The metrics that keep a comparison at a saturated level: how much work the server did, and how many agents it served. */
export const SATURATION_KEEPS = Object.freeze(['turns_completed', 'agents_served']);

/** A row's saturated flags, well formed: {fork: boolean, base: boolean|null, prev: boolean|null}. */
const wellFormed = (s) => Boolean(s) && typeof s === 'object' && !Array.isArray(s) && typeof s.fork === 'boolean'
  && (s.base === null || typeof s.base === 'boolean') && (s.prev === null || typeof s.prev === 'boolean');

/** True when the row's comparison sits at a saturated level (the fork's side, or the compared side) for a metric that loses it there. */
export function saturatedAt(row, comparison) {
  const s = row && row.saturated;
  if (!wellFormed(s) || SATURATION_KEEPS.includes(row.id)) return false;
  return s.fork === true || s[comparison === 'prev' ? 'prev' : 'base'] === true;
}


/**
 * The verdict a comparison may state: the row's verdict, or null at a saturated level, under a saturated or
 * no_base note, or when the row does not say whether it is saturated (saturated is required: fail closed).
 */
export function verdictOf(row, comparison) {
  const [verdict, note] = comparison === 'prev' ? [row.verdict_vs_prev, row.note_vs_prev] : [row.verdict, row.note];
  // Any note means no verdict: the aggregator never pairs them, so a row that does (forged or broken) is refused.
  if (!verdict || (note !== null && note !== undefined) || !wellFormed(row.saturated) || saturatedAt(row, comparison)) return null;
  return verdict;
}

/** The note a comparison shows when it has no verdict: "saturated" at a saturated level, else the row's own note. */
export function noteOf(row, comparison) {
  if (saturatedAt(row, comparison)) return 'saturated';
  return comparison === 'prev' ? row.note_vs_prev : row.note;
}
const levelLabel = (l) => (l === '1' ? '1 agent' : `${l} agents`);

/** The fixed clause for one row and comparison (no final full stop). */
export function clauseFor(row, comparison, release) {
  const t = row.text;
  const at = row.level === 'once' ? '' : ` at ${levelLabel(row.level)}`;
  const tag = release.short || release.tag;
  const verdict = verdictOf(row, comparison);
  const [refValue, refName, change] = comparison === 'prev'
    ? [t.prev, release.prev ? release.prev.short || release.prev.tag : 'the previous release', t.delta_vs_prev_pct]
    : [t.base, 'the upstream base', t.delta_pct];
  return `${row.name}${at}: ${refValue} on ${refName}, ${t.fork} on ${tag}, ${change}, ${VERDICT_PHRASE[verdict]}`;
}

/** Every claim the bundle allows: id -> {row, comparison, verdict}. */
export function claimIndex(bundle) {
  const out = new Map();
  const sizes = new Map((bundle.claims || []).map((c) => [c.id, Number(c.size) || 0]));
  for (const row of bundle.metrics || []) {
    for (const comparison of ['base', 'prev']) {
      const verdict = verdictOf(row, comparison);
      if (!verdict) continue;
      if (comparison === 'base' && !(row.text && row.text.base)) continue;
      if (comparison === 'prev' && !(row.text && row.text.prev && bundle.release && bundle.release.prev)) continue;
      const id = claimId(row, comparison);
      out.set(id, { row, comparison, verdict, size: sizes.get(id) ?? 0 });
    }
  }
  return out;
}

/** The release title: always this template, counts at the headline level (regressed first). */
export function titleFor(bundle) {
  if (bundle.pending && bundle.pending_reason === 'no_base') return `${bundle.release.tag}: no comparable base`;
  if (bundle.pending) return `${bundle.release.tag}: comparison pending`;
  const c = (bundle.counts || {})[bundle.headline_level] || { regressed: 0, improved: 0, within: 0 };
  const b = bundle.release.base;
  // The base is the upstream tree at the merge-base SHA; its nightly tag is context only.
  const base = !b ? 'no base' : b.sha ? `upstream base ${b.sha.slice(0, 7)}` : b.tag || 'no base';
  return `${bundle.release.tag}: ${c.regressed} regressed, ${c.improved} improved, ${c.within} within noise (vs ${base})`;
}

/**
 * Render a placeholder post: the template title, and the summary and captions with every known placeholder
 * replaced by its clause. Unknown placeholders are left as written (the checker reports them).
 * @param {{summary: string, sections: Array<{chart_id: string, caption: string}>}} post
 * @param {object} bundle
 * @param {{renderClause?: (row: object, comparison: string, release: object) => string}} opts
 */
export function renderPost(post, bundle, { renderClause = clauseFor } = {}) {
  const claims = claimIndex(bundle);
  const lines = bundle.changelog || [];
  const fill = (text) => String(text).normalize('NFKC')
    .replace(PLACEHOLDER_RE, (m, id) => {
      const c = claims.get(id);
      return c ? renderClause(c.row, c.comparison, bundle.release) : m;
    })
;
  // Changelog lines stand only in one block at the end of the post, each once, never by a chart or a claim.
  const quotes = [...new Set(Array.isArray(post.quotes) ? post.quotes : [])].map((n) => lines[n - 1]).filter((l) => l !== undefined);
  return {
    title: titleFor(bundle),
    summary: fill(post.summary),
    sections: post.sections.map((s) => ({ chart_id: s.chart_id, caption: fill(s.caption) })),
    quotes,
  };
}

// One phrase per note across the site: exactly site/app.js's NOTE map (news/review-31u.test.mjs reads app.js).
export const NOTE_PHRASE = Object.freeze({
  context: 'shown for context, no verdict', no_band: 'no noise band yet, no verdict', wide_band: 'noise band too wide for a verdict',
  hollow: 'fewer than two valid attempts, no verdict', gated: 'failed a validity check, no verdict', no_reference: 'no reference yet',
  no_data: 'not recorded', not_comparable: 'not comparable, no verdict', no_base: 'no comparable base, no verdict', saturated: 'saturated, context only, no verdict',
  zero_reference: 'zero reference, no verdict',
});

/**
 * A chart's machine caption (the charts-only form and the bundle's chart list): the claim clause for the row
 * and comparison, or the same shape with the reason there is no verdict; then one number-free sentence on what
 * the chart draws.
 */
export function machineCaption(kind, row, comparison, release) {
  const verdict = verdictOf(row, comparison);
  let first;
  if (verdict) {
    first = clauseFor(row, comparison, release);
  } else {
    const t = row.text;
    const at = row.level === 'once' ? '' : ` at ${levelLabel(row.level)}`;
    const tag = release.short || release.tag;
    const note = noteOf(row, comparison);
    const [refValue, refName, change] = comparison === 'prev'
      ? [t.prev, release.prev ? release.prev.short || release.prev.tag : 'the previous release', t.delta_vs_prev_pct]
      : [t.base, 'the upstream base', t.delta_pct];
    first = `${row.name}${at}: ${refValue ?? 'n/a'} on ${refName}, ${t.fork ?? 'n/a'} on ${tag}${change ? `, ${change}` : ''}, ${NOTE_PHRASE[note] || 'no verdict'}`;
  }
  const second = kind === 'ladder' ? ' Fork and upstream base from 1 agent to 250 agents.' : kind === 'series' ? ` By nightly, ${release.short || release.tag} marked.` : '';
  const s = `${first}.${second}`;
  return s.length <= 200 ? s : `${first.slice(0, 199)}.`;
}

/**
 * The fallback form (charts_only): no written sentence, no quotation. The template title; a summary of the headline
 * metrics that regressed (each by its largest regressed claim), then the headline-level improvements, at most three
 * clauses within 400 characters, largest change first (null when nothing moved); and the eight headline charts,
 * largest change first, each with its machine caption.
 */
export function fallbackPost(bundle) {
  const claims = [...claimIndex(bundle).values()].filter((c) => c.row.headline != null);
  // The three largest headline regressions (each by its largest regressed claim); then improvements at the headline level.
  const best = new Map();
  for (const c of claims.filter((x) => x.verdict === 'regressed')) if (!best.has(c.row.id) || c.size > best.get(c.row.id).size) best.set(c.row.id, c);
  const regressed = [...best.values()].sort((a, b) => b.size - a.size || a.row.headline - b.row.headline || (a.row.id < b.row.id ? -1 : 1)).slice(0, 3);
  const improved = claims.filter((c) => c.verdict === 'improved' && c.comparison === 'base' && c.row.level === bundle.headline_level && !best.has(c.row.id))
    .sort((a, b) => b.size - a.size || a.row.headline - b.row.headline);
  const picked = [];
  for (const c of [...regressed, ...improved]) {
    if (picked.length >= 3) break;
    const next = [...picked, c].sort((a, b) => b.size - a.size).map((x) => `${clauseFor(x.row, x.comparison, bundle.release)}.`).join(' ');
    if (next.length > 400) continue;
    picked.push(c);
  }
  const parts = picked.sort((a, b) => b.size - a.size).map((x) => `${clauseFor(x.row, x.comparison, bundle.release)}.`);
  const order = (k) => (k === 'ladder' ? 0 : 1);
  const candidates = bundle.charts.filter((ch) => ch.headline != null && ch.comparison === 'base')
    .sort((a, b) => b.size - a.size || a.headline - b.headline || order(a.kind) - order(b.kind));
  const seen = new Set();
  const sections = [];
  for (const ch of candidates) {
    if (seen.has(ch.metric) || sections.length >= 8) continue;
    seen.add(ch.metric);
    sections.push({ chart_id: ch.id, caption: ch.caption });
  }
  return { title: titleFor(bundle), summary: parts.length ? parts.join(' ') : null, sections, quotes: [] };
}

// ---- The CI path: what the model sees and the structured output it returns. ----

/** The bundle as the model sees it: the claims with the clauses they render to, the charts, the changelog. */
export function modelView(bundle) {
  const headline = new Map((bundle.metrics || []).map((m) => [m.id, m.headline]));
  const r = bundle.release;
  return {
    release: { tag: r.tag, short: r.short, date: r.date, base: r.base, prev: r.prev },
    title: bundle.title,
    headline_level: bundle.headline_level,
    counts: bundle.counts,
    claims: (bundle.claims || []).map((c) => ({ id: c.id, metric: c.metric, headline: headline.get(c.metric) ?? null, level: c.level, comparison: c.comparison, verdict: c.verdict, size: c.size ?? 0, clause: c.clause })),
    charts: (bundle.charts || []).map((c) => ({ id: c.id, metric: c.metric, headline: c.headline, kind: c.kind, comparison: c.comparison, size: c.size })),
    changelog: bundle.changelog || [],
  };
}

/**
 * The JSON schema of the model's answer (structured outputs): sentences of {before, claim, after}, where claim
 * is a claim id from the bundle or null, chart ids from the bundle, and quotes: whole changelog lines from those
 * the post may quote, shown once in a block at the end. Only keywords structured outputs supports; the caps are the
 * checker's.
 */
export function postOutputSchema(bundle) {
  const claimIds = (bundle.claims || []).map((c) => c.id);
  const sentence = {
    type: 'object',
    additionalProperties: false,
    required: ['before', 'claim', 'after'],
    properties: {
      before: { type: 'string' },
      claim: claimIds.length ? { anyOf: [{ type: 'string', enum: claimIds }, { type: 'null' }] } : { type: 'null' },
      after: { type: 'string' },
    },
  };
  const lines = (bundle.changelog || []).filter((l) => isQuotable(l));
  return {
    type: 'object',
    additionalProperties: false,
    required: lines.length ? ['summary', 'sections', 'quotes'] : ['summary', 'sections'],
    properties: {
      summary: { type: 'array', items: sentence },
      ...(lines.length ? { quotes: { type: 'array', items: { type: 'string', enum: lines } } } : {}),
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['chart_id', 'caption'],
          properties: {
            chart_id: { type: 'string', enum: (bundle.charts || []).map((c) => c.id) },
            caption: sentence,
          },
        },
      },
    },
  };
}

/** The model's answer as a placeholder post ({bundle_sha256, summary, sections}); never throws. */
export function postFromOutput(output, bundle) {
  const o = output && typeof output === 'object' ? output : {};
  const sentence = (x) => {
    const s = x && typeof x === 'object' ? x : {};
    const before = typeof s.before === 'string' ? s.before.trim() : '';
    const after = typeof s.after === 'string' ? s.after.trim() : '';
    const mid = typeof s.claim === 'string' && s.claim ? `{claim:${s.claim}}` : '';
    let t = [before, mid].filter(Boolean).join(' ');
    if (after) t = t ? `${t}${/^[,;:.)]/.test(after) ? '' : ' '}${after}` : after;
    return t && !/[.?]$/.test(t) ? `${t}.` : t;
  };
  const summary = (Array.isArray(o.summary) ? o.summary : []).map(sentence).filter(Boolean).join(' ');
  const sections = (Array.isArray(o.sections) ? o.sections : []).map((sec) => {
    const x = sec && typeof sec === 'object' ? sec : {};
    return { chart_id: typeof x.chart_id === 'string' ? x.chart_id : '', caption: sentence(x.caption) };
  });
  const quotes = [...new Set((Array.isArray(o.quotes) ? o.quotes : []).map((q) => (bundle.changelog || []).indexOf(q) + 1).filter((n) => n > 0))];
  return { bundle_sha256: bundleSha256(bundle), summary, sections, ...(quotes.length ? { quotes } : {}) };
}

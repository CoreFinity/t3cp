// Tests for the placeholder form of a post: the free text holds {claim:<id>} placeholders and connecting words
// only; the renderer fills each placeholder with a fixed clause built from its bundle row, and the rendered text
// is checked again by the sentence rules (a self-test of the renderer). Strings the public-repo scan forbids are
// assembled at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from './check.mjs';
import { bundle, goodClaimPost } from './fixtures/bundle.mjs';
import { hostShape } from './fixtures/host-shape.mjs';

const clean = () => [];
const run = (post, b = bundle(), opts = {}) => check(post, b, { scanText: clean, ...opts });
const rules = (r) => r.findings.map((f) => f.rule);
const withSummary = (summary) => ({ ...goodClaimPost(), summary });
const withCaption = (i, caption) => {
  const p = goodClaimPost();
  p.sections[i] = { ...p.sections[i], caption };
  return p;
};
function assertFinding(r, rule) {
  assert.equal(r.passed, false, `expected a failure with ${rule}`);
  assert.ok(rules(r).includes(rule), `expected rule ${rule}, got ${JSON.stringify(r.findings)}`);
}

test('claims: a good placeholder post passes and renders fixed clauses from the bundle rows', () => {
  const r = run(goodClaimPost());
  assert.deepEqual(r.findings, []);
  assert.equal(r.passed, true);
  assert.equal(r.rendered.title, 'v0.1.9-perf.8: 0 regressed, 1 improved, 3 within noise (vs v0.1.9-nightly.20261114.4700)');
  assert.equal(r.rendered.summary,
    'Peak memory at 250 agents: 1,240 MiB on the upstream base, 1,530 MiB on perf.8, +23.4%, regressed beyond noise. '
    + 'Turns completed at 100 agents: 318 on the upstream base, 352 on perf.8, +10.7%, improved beyond noise.');
  assert.equal(r.rendered.sections[4].caption, 'In this chart: Peak memory at 250 agents: 1,250 MiB on perf.7, 1,530 MiB on perf.8, +22.4%, regressed beyond noise.');
  assert.equal(r.rendered.sections[4].chart_id, 'fork-vs-prev.rss_peak_mib.linux-x64');
  assert.equal(r.charts, 6);
  assert.ok(r.numbers_checked >= 20);
});

test('claims: an unknown claim id fails', () => {
  assertFinding(run(withSummary('{claim:turns_completed.linux-x64.50.base}.')), 'claim-unknown');
  assertFinding(run(withSummary('{claim:db_ready_ms.linux-x64.once.base}.')), 'claim-unknown');
});

test('claims: two placeholders in one sentence fail', () => {
  assertFinding(run(withSummary('{claim:turns_completed.linux-x64.100.base} and {claim:rss_peak_mib.linux-x64.250.base}.')), 'claim-two');
});

test('claims: a number or a spelled number outside a placeholder fails', () => {
  assertFinding(run(withSummary('{claim:turns_completed.linux-x64.100.base}, 34 turns more.')), 'free-number');
  assertFinding(run(withSummary('In three releases: {claim:turns_completed.linux-x64.100.base}.')), 'free-number');
});

test('claims: a unit outside a placeholder fails', () => {
  assertFinding(run(withSummary('Measured in ms: {claim:turn_p50_ms.linux-x64.250.base}.')), 'free-unit');
  assertFinding(run(withSummary('A change in %: {claim:turn_p50_ms.linux-x64.250.base}.')), 'free-unit');
});

test('claims: a verdict or direction word outside a placeholder fails', () => {
  for (const w of ['improved', 'faster', 'higher', 'within noise', 'above', 'better']) {
    assertFinding(run(withSummary(`It is ${w}: {claim:turns_completed.linux-x64.100.base}.`)), 'free-verdict-word');
  }
});

test('claims: a metric name or id outside a placeholder fails', () => {
  assertFinding(run(withSummary('Turns completed: {claim:turns_completed.linux-x64.100.base}.')), 'free-metric-name');
  assertFinding(run(withSummary('For turns_completed: {claim:turns_completed.linux-x64.100.base}.')), 'free-metric-name');
});

test('claims: a title is not written; it is the template', () => {
  assertFinding(run({ ...goodClaimPost(), title: 'v0.1.9-perf.8' }), 'schema');
});

test('claims: the kept rules still apply to the free text', () => {
  assertFinding(run(withSummary('A notably good run: {claim:turns_completed.linux-x64.100.base}.')), 'banned');
  assertFinding(run(withSummary('{claim:turns_completed.linux-x64.100.base} \u{1F680}.')), 'emoji');
  assertFinding(run(withSummary('{claim:turns_completed.linux-x64.100.base}!')), 'exclamation');
  assertFinding(run(withCaption(1, '{claim:writer_tx_p95_ms.linux-x64.100.base}. The changelog says "Reads moved to a new pool."')), 'quote');
  const host = ['w', 's4'].join('');
  const scanText = (t) => [...t.matchAll(hostShape('g'))].map((m) => ({ pattern: 'host-name', match: m[0], index: m.index }));
  const r = run(withSummary(`Measured on ${host}: {claim:turns_completed.linux-x64.100.base}.`), bundle(), { scanText });
  assertFinding(r, 'internal-name');
  assert.ok(!JSON.stringify(r).includes(host));
});

test('claims: chart ids, the section cap and duplicates', () => {
  const p = goodClaimPost();
  p.sections[5] = { ...p.sections[5], chart_id: 'fork-vs-base.no_such_metric.ladder.linux-x64' };
  assertFinding(run(p), 'chart-id');
  const b = bundle();
  const ids = b.charts.slice().sort((x, y) => y.size - x.size).slice(0, 9).map((c) => c.id);
  assertFinding(run({ summary: '{claim:turns_completed.linux-x64.100.base}.', sections: ids.map((chart_id) => ({ chart_id, caption: 'Fork and base by agents.' })) }, b), 'sections-max');
  const d = goodClaimPost();
  d.sections[1] = { ...d.sections[0] };
  assertFinding(run(d), 'chart-duplicate');
});

test('claims: lengths and sentence counts apply to the rendered text', () => {
  assertFinding(run(withCaption(1, `${'Here in this chart, '.repeat(5)}here: {claim:writer_tx_p95_ms.linux-x64.100.base}.`)), 'length');
  const four = '{claim:turns_completed.linux-x64.100.base}. {claim:rss_peak_mib.linux-x64.250.base}. {claim:turn_p50_ms.linux-x64.250.base}. {claim:dispatch_p95_ms.linux-x64.100.base}.';
  const r = run(withSummary(four));
  assert.ok(rules(r).includes('summary-sentences') || rules(r).includes('length'), JSON.stringify(r.findings));
});

test('claims: a caption claim must be about its chart\'s metric and comparison', () => {
  assertFinding(run(withCaption(0, '{claim:turn_p50_ms.linux-x64.250.base}.')), 'caption-metric');
  assertFinding(run(withCaption(3, '{claim:rss_peak_mib.linux-x64.250.prev}.')), 'caption-metric');
});

test('claims: a cause needs a changelog quote; no future tense', () => {
  assertFinding(run(withCaption(1, '{claim:writer_tx_p95_ms.linux-x64.100.base}, because reads use the reader pool.')), 'free-word');
  assert.deepEqual(run({ ...goodClaimPost(), quotes: [1] }).findings, []);
  assertFinding(run(withSummary('The next build will show the same. {claim:turns_completed.linux-x64.100.base}.')), 'future');
});

test('claims: a platform word needs a row on that platform', () => {
  assertFinding(run(withSummary('On macOS: {claim:turns_completed.linux-x64.100.base}.')), 'platform');
});

test('claims: a malformed placeholder or a stray brace fails', () => {
  assertFinding(run(withSummary('{claim turns_completed.linux-x64.100.base}.')), 'markup');
  assertFinding(run(withSummary('{claim:turns_completed.linux-x64.100.base.')), 'markup');
});

test('claims: the rendered text is checked again (self-test): both comparisons in one rendered sentence fail', () => {
  assertFinding(run(withCaption(4, 'Against its base: {claim:rss_peak_mib.linux-x64.250.prev}.')), 'row-ambiguous');
});

test('claims: a renderer that writes a wrong number is caught by the self-test', () => {
  const renderClause = () => 'Turns completed at 100 agents: 319 on the base, 352 on perf.8, +10.7%, improved beyond noise';
  const r = run(withSummary('{claim:turns_completed.linux-x64.100.base}.'), bundle(), { renderClause });
  assert.equal(r.passed, false);
  assert.ok(r.findings.some((f) => /^number-/.test(f.rule) && /rendered/.test(f.detail || '')), JSON.stringify(r.findings));
});

test('claims: the post names the bundle it was written from (bundle_sha256)', () => {
  const { bundle_sha256, ...noSha } = goodClaimPost();
  assertFinding(run(noSha), 'schema');
  assertFinding(run({ ...goodClaimPost(), bundle_sha256: 'f'.repeat(64) }), 'bundle-mismatch');
  assertFinding(run({ ...goodClaimPost(), bundle_sha256: 'not-a-hash' }), 'schema');
});

test('claims: the fallback form is charts plus rendered claims, with no written sentence', async () => {
  const { fallbackPost } = await import('./claims.mjs');
  const { checkText } = await import('./check.mjs');
  const b = bundle();
  const f = fallbackPost(b);
  assert.equal(f.title, 'v0.1.9-perf.8: 0 regressed, 1 improved, 3 within noise (vs v0.1.9-nightly.20261114.4700)');
  assert.ok(f.sections.length >= 1 && f.sections.length <= 8);
  const headline = new Set(b.metrics.filter((m) => m.headline != null).map((m) => m.id));
  for (const s of f.sections) assert.ok(headline.has(b.charts.find((c) => c.id === s.chart_id).metric));
  // The summary is the largest headline claims at the headline level, rendered, largest first.
  assert.equal(f.summary, 'Peak memory at 250 agents: 1,240 MiB on the upstream base, 1,530 MiB on perf.8, +23.4%, regressed beyond noise. '
    + 'Turns completed at 100 agents: 318 on the upstream base, 352 on perf.8, +10.7%, improved beyond noise.');
  const self = checkText(f, b, { scanText: () => [], titleLimit: 120 });
  assert.deepEqual(self.findings.filter((x) => x.field === 'summary'), []);
});

// ---- The model's structured output (the CI path) and what the model sees. ----

test('model: the output schema takes claim ids, chart ids and changelog lines only as enums from the bundle', async () => {
  const { postOutputSchema } = await import('./claims.mjs');
  const b = bundle();
  const s = postOutputSchema(b);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['summary', 'sections', 'quotes']);
  const sentence = s.properties.summary.items;
  assert.equal(sentence.additionalProperties, false);
  assert.deepEqual(sentence.required, ['before', 'claim', 'after']);
  assert.deepEqual(sentence.properties.claim.anyOf[0].enum, b.claims.map((c) => c.id));
  const section = s.properties.sections.items;
  assert.deepEqual(section.properties.chart_id.enum, b.charts.map((c) => c.id));
  assert.equal(section.properties.quote, undefined, 'no quote by a chart');
  assert.deepEqual(s.properties.quotes.items.enum, b.changelog);
  assert.ok(!JSON.stringify(s).match(/minItems|maxItems|minLength|maxLength|minimum|maximum/), 'only keywords structured outputs supports');
  const empty = postOutputSchema({ ...b, changelog: [] });
  assert.equal(empty.properties.quotes, undefined);
  assert.deepEqual(empty.required, ['summary', 'sections']);
});

test('model: a structured answer becomes the placeholder post, with the bundle sha256, and passes the checker', async () => {
  const { postFromOutput } = await import('./claims.mjs');
  const b = bundle();
  const output = {
    // The largest regression itself (peak memory at 250 against the base), not the same metric against perf.7.
    summary: [{ before: 'Here,', claim: 'rss_peak_mib.linux-x64.250.base', after: '' }, { before: '', claim: 'turns_completed.linux-x64.100.base', after: '' }],
    sections: [
      { chart_id: 'fork-vs-base.turns_completed.ladder.linux-x64', caption: { before: '', claim: 'turns_completed.linux-x64.250.base', after: '' } },
      { chart_id: 'fork-vs-base.writer_tx_p95_ms.ladder.linux-x64', caption: { before: '', claim: 'writer_tx_p95_ms.linux-x64.100.base', after: '' } },
    ],
    quotes: ['Reads routed to the reader pool by statement class.', 'Reads routed to the reader pool by statement class.'],
  };
  const post = postFromOutput(output, b);
  assert.equal(post.bundle_sha256, goodClaimPost(b).bundle_sha256);
  assert.equal(post.summary, 'Here, {claim:rss_peak_mib.linux-x64.250.base}. {claim:turns_completed.linux-x64.100.base}.');
  assert.equal(post.sections[1].caption, '{claim:writer_tx_p95_ms.linux-x64.100.base}.');
  assert.deepEqual(post.quotes, [1], 'a line once, by its number');
  assert.deepEqual(run(post).findings, []);
  assert.doesNotThrow(() => postFromOutput({ summary: 'x', sections: null }, b));
});

test('model: the model sees the claims with their clauses and the charts, never the raw rows or allowed numbers', async () => {
  const { modelView } = await import('./claims.mjs');
  const v = modelView(bundle());
  assert.deepEqual(Object.keys(v).sort(), ['changelog', 'charts', 'claims', 'counts', 'headline_level', 'release', 'title']);
  assert.ok(v.claims.every((c) => typeof c.clause === 'string' && c.id && 'headline' in c));
  assert.ok(v.charts.every((c) => !('caption' in c)));
});

test('claims: the post must name the bundle\'s own bundle_sha256 when the bundle carries one', () => {
  const b = { ...bundle(), bundle_sha256: 'a'.repeat(64) };
  assert.deepEqual(run({ ...goodClaimPost(b), bundle_sha256: 'a'.repeat(64) }, b).findings, []);
  assertFinding(run({ ...goodClaimPost(b), bundle_sha256: 'b'.repeat(64) }, b), 'bundle-mismatch');
});

// Tests for site/build/release-bundle.mjs against a synthetic t3cp/release-bundle/1 (release-fixtures/source.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPostBundle, changelogExcerpt } from './release-bundle.mjs';
import { source } from './release-fixtures/source.mjs';
import { hostShape } from '../../news/fixtures/host-shape.mjs';
import { checkText } from '../../news/check.mjs';
import { clauseFor } from '../../news/claims.mjs';
import { validate } from '../../tools/t3cp/lib/validate.mjs';

const json = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const catalogue = json('../../catalogue/catalogue.json');
const postBundleSchema = json('../../news/post-bundle-1.json');
const clean = () => [];
// These tests read the 100-agent counts and claims; the default level (50) is covered by news/headline-50.test.mjs.
const build = ({ prev = true, changelog = [] } = {}) => buildPostBundle(source({ prev }), { catalogue, headline: '100', changelog, scanText: clean });

test('the bundle validates against news/post-bundle-1.json', () => {
  assert.deepEqual(validate(postBundleSchema, build()), []);
  assert.deepEqual(validate(postBundleSchema, build({ prev: false })), []);
});

test('rows keep the headline levels and once; context metrics and metrics with no verdict anywhere are dropped', () => {
  const b = build();
  assert.deepEqual([...new Set(b.metrics.map((m) => m.level))].sort(), ['1', '100', '250', '50', 'once']);
  const ids = new Set(b.metrics.map((m) => m.id));
  assert.ok(!ids.has('push_p95_ms'), 'context metric dropped');
  assert.ok(!ids.has('heap_peak_mib'), 'no verdict at any level and not a headline: dropped');
  assert.ok(ids.has('db_ready_warm_ms'), 'headline metrics stay, verdict or not');
  assert.ok(ids.has('writer_tx_p95_ms') && ids.has('stall_share_40ms'));
});

test('counts per level cover the eight headline metrics, the once metric at every level', () => {
  const b = build();
  assert.deepEqual(b.counts['100'], { improved: 3, regressed: 0, within: 4, no_verdict: 1, total: 8 });
  assert.deepEqual(b.counts['250'], { improved: 3, regressed: 1, within: 3, no_verdict: 1, total: 8 });
  assert.deepEqual(b.counts['1'], { improved: 0, regressed: 0, within: 7, no_verdict: 1, total: 8 });
});

test('allowed numbers: every row string, the unsigned changes, the levels and the counts; nothing without a digit', () => {
  const b = build();
  const allowed = new Set(b.allowed_numbers);
  for (const s of ['352', '1,234 ms', '−15.2%', '15.2%', '+10.7%', '10.7%', '61.0%', '0.62', '22.7%', '100 agents', '1 agent', '250 agents', '3', 'three', '8', 'eight']) {
    assert.ok(allowed.has(s), `missing ${s}`);
  }
  assert.ok(b.allowed_numbers.every((s) => /\d/.test(s) || /^[a-z]+$/.test(s)));
  assert.ok(!allowed.has('80.0 ms'), 'a dropped context metric adds no numbers');
});

test('metric names: allowed only with a verdict; the catalogue list covers every metric', () => {
  const b = build();
  assert.ok(b.allowed_metric_names.includes('Turns completed in the window'));
  assert.ok(!b.allowed_metric_names.includes('Start to database ready, warm start'));
  assert.equal(b.catalogue_names.length, catalogue.metrics.length);
});

test('charts: a ladder only for per-level metrics, fork-vs-prev only with a previous release, largest change first', () => {
  const b = build();
  const ids = new Set(b.charts.map((c) => c.id));
  assert.ok(ids.has('fork-vs-base.turns_completed.ladder.linux-x64'));
  assert.ok(ids.has('series.db_ready_warm_ms.linux-x64'));
  assert.ok(!ids.has('fork-vs-base.db_ready_warm_ms.ladder.linux-x64'));
  assert.ok(ids.has('fork-vs-prev.rss_peak_mib.linux-x64'));
  for (let i = 1; i < b.charts.length; i++) assert.ok(b.charts[i - 1].size >= b.charts[i].size, 'sorted by size');
  assert.equal(b.charts[0].metric, 'reader_tx_wait_p95_ms');
  assert.equal(b.charts[0].size, 2.372);
  assert.ok(b.charts.every((c) => c.caption.length <= 200));
  const first = build({ prev: false });
  assert.ok(first.charts.every((c) => c.kind !== 'prev'));
  assert.equal(first.release.prev, null);
});

test('literals: the tags, their short forms, both date forms and the year', () => {
  const b = build();
  for (const s of ['v0.1.9-perf.8', 'perf.8', 'v0.1.9-perf.7', 'perf.7', 'v0.1.9-nightly.20261114.4700', '2026-11-16', '16 Nov 2026', '14 Nov 2026', '9 Nov 2026', '2026']) {
    assert.ok(b.allowed_literals.includes(s), `missing ${s}`);
  }
});

test('every machine caption with a verdict passes the checker as its own chart caption', () => {
  const b = build();
  for (const c of b.charts) {
    const rows = b.metrics.filter((m) => m.id === c.metric);
    const top = rows.find((m) => m.level === b.headline_level) || rows.find((m) => m.level === 'once');
    if (!(c.comparison === 'prev' ? top.verdict_vs_prev : top.verdict)) continue;
    const post = { title: b.release.tag, summary: 'The chart below compares the fork with its base.', sections: [{ chart_id: c.id, caption: c.caption }] };
    const r = checkText(post, b, { scanText: clean });
    assert.deepEqual(r.findings, [], `${c.id}: ${c.caption}`);
  }
});

test('a source that does not validate fails closed', () => {
  assert.throws(() => buildPostBundle({ ...source(), extra: 1 }, { catalogue, changelog: [], scanText: clean }), /release-bundle/);
});

test('a changelog needs the scanner, and a line with an internal name fails closed without repeating it', () => {
  const line = `Reader pool sized from the host on ${['w', 's3'].join('')}.`;
  assert.throws(() => buildPostBundle(source(), { catalogue, changelog: ['Git commands started off the main thread.'] }), /scanner/);
  const scanText = (t) => [...t.matchAll(hostShape('g'))].map((m) => ({ pattern: 'host-name', match: m[0], index: m.index }));
  assert.throws(() => buildPostBundle(source(), { catalogue, changelog: [line], scanText }), (e) => /changelog/.test(e.message) && !e.message.includes(['w', 's3'].join('')));
  const ok = buildPostBundle(source(), { catalogue, changelog: ['Git commands started off the main thread.'], scanText });
  assert.deepEqual(ok.changelog, ['Git commands started off the main thread.']);
});

test('changelogExcerpt takes the tag\'s section only and strips markdown', () => {
  const md = [
    '# Changelog', '',
    '## v0.1.9-perf.8 (2026-11-16)', '',
    '- Reads routed to the **reader pool** by statement class.',
    '- Message ordinals read through an index, not a `scan`.',
    '- See [the tag](https://example.invalid/x) for the source.', '',
    '## v0.1.9-perf.7', '', '- Queued runs start in order after a cancel burst.', '',
  ].join('\n');
  assert.deepEqual(changelogExcerpt(md, 'v0.1.9-perf.8'), [
    'Reads routed to the reader pool by statement class.',
    'Message ordinals read through an index, not a scan.',
    'See the tag for the source.',
  ]);
  assert.deepEqual(changelogExcerpt(md, 'v0.1.9-perf.7'), ['Queued runs start in order after a cancel burst.']);
  assert.deepEqual(changelogExcerpt(md, 'v0.1.9-perf.80'), []);
  assert.deepEqual(changelogExcerpt('', 'v0.1.9-perf.8'), []);
});

test('the synthetic flag passes through, and the same input gives the same bytes', () => {
  assert.equal(build().synthetic, true);
  assert.equal(JSON.stringify(build()), JSON.stringify(build()));
});

test('changelogExcerpt keeps the release title and its bullets, not the upstream base line', () => {
  const md = [
    '# Changelog', '',
    '## v0.1.9-perf.8 (2026-11-15)', '',
    'Reader routing and message ordinals', '',
    'Upstream base: 0123456789ab.', '',
    '- Reads routed to the reader pool by statement class.',
    '- Message ordinals read through an index, not a scan.', '',
    '## v0.1.9-perf.7 (2026-11-14)', '', 'Delivery repair', '', 'Upstream base: ba9876543210.', '', '- Message delivery repaired after a reconnect.',
  ].join('\n');
  assert.deepEqual(changelogExcerpt(md, 'v0.1.9-perf.8'), [
    'Reader routing and message ordinals',
    'Reads routed to the reader pool by statement class.',
    'Message ordinals read through an index, not a scan.',
  ]);
  assert.deepEqual(changelogExcerpt(md, 'v0.1.9-perf.7'), ['Delivery repair', 'Message delivery repaired after a reconnect.']);
});

test('claims: one per row and comparison with a verdict, each with the clause it renders to; the title template', () => {
  const b = build();
  const ids = new Set(b.claims.map((c) => c.id));
  assert.ok(ids.has('turns_completed.linux-x64.100.base') && ids.has('turns_completed.linux-x64.100.prev'));
  assert.ok(!ids.has('db_ready_warm_ms.linux-x64.once.base'), 'no verdict, no claim');
  for (const c of b.claims) {
    const row = b.metrics.find((m) => m.id === c.metric && m.level === c.level && m.platform === c.platform);
    assert.equal(c.clause, clauseFor(row, c.comparison, b.release));
  }
  assert.equal(b.title, 'v0.1.9-perf.8: 0 regressed, 3 improved, 4 within noise (vs v0.1.9-nightly.20261114.4700)');
  assert.ok(build({ prev: false }).claims.every((c) => c.comparison === 'base'));
});

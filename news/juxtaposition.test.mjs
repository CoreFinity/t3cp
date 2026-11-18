// Juxtaposition: changelog lines stand only in one block at the end of the post, never by a chart or a claim; the
// summary cites every regressed headline metric and runs largest change first; chart-kind words stand only in
// their own chart's caption; placeholders sit in normal spacing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, isQuotable } from './check.mjs';
import { fallbackPost } from './claims.mjs';
import { bundle, goodClaimPost } from './fixtures/bundle.mjs';

const clean = () => [];
const run = (post, b = bundle()) => check(post, b, { scanText: clean });
const rules = (r) => r.findings.map((f) => f.rule);
const has = (r, rule) => assert.ok(rules(r).includes(rule), `expected ${rule}, got ${JSON.stringify(r.findings)}`);
const C_IMPROVED = '{claim:turns_completed.linux-x64.100.base}';
const C_REGRESSED = '{claim:rss_peak_mib.linux-x64.250.base}';
const withCaption = (i, caption) => { const p = goodClaimPost(); p.sections[i] = { ...p.sections[i], caption }; return p; };

test('quotes: the post lists changelog lines in quotes[], rendered once at the end; never as a placeholder in a caption or the summary', () => {
  const ok = run({ ...goodClaimPost(), quotes: [1] });
  assert.deepEqual(ok.findings, []);
  assert.deepEqual(ok.rendered.quotes, ['Reads routed to the reader pool by statement class.']);
  assert.ok(ok.rendered.sections.every((s) => !/changelog/i.test(s.caption)));
  has(run(withCaption(1, '{claim:writer_tx_p95_ms.linux-x64.100.base}. {quote:1}')), 'quote');
  has(run({ ...goodClaimPost(), summary: `${C_REGRESSED}. ${C_IMPROVED}. {quote:1}` }), 'quote');
  has(run({ ...goodClaimPost(), quotes: [1, 1] }), 'quote');
  has(run({ ...goodClaimPost(), quotes: [9] }), 'quote');
  has(run({ ...goodClaimPost(), quotes: ['1'] }), 'schema');
});

test('quotes: lines with an effect verb or a quality word are not quotable', () => {
  for (const line of ['Accelerates the reader pool.', 'Speeds up dispatch.', 'Removes a scan from the reader.', 'Stops the poller.',
    'An optimal reader pool.', 'Fixes the reader pool.', 'Eliminates a scan.', 'Avoids a scan.', 'Prevents a stall.', 'Optimises the scan.']) {
    assert.equal(isQuotable(line), false, line);
  }
  assert.equal(isQuotable('Reads routed to the reader pool by statement class.'), true);
});

test('summary: it must cite every headline metric that regressed beyond noise', () => {
  has(run({ ...goodClaimPost(), summary: `${C_IMPROVED}.` }), 'summary-binding');
  assert.deepEqual(run({ ...goodClaimPost(), summary: `${C_REGRESSED}. ${C_IMPROVED}.` }).findings, []);
});

test('summary: claims run in descending order of the size of the change', () => {
  has(run({ ...goodClaimPost(), summary: `${C_IMPROVED}. ${C_REGRESSED}.` }), 'summary-order');
});

test('chart-kind words: "ladder" only in a ladder chart\'s caption, "series" only in a series chart\'s caption', () => {
  assert.deepEqual(run(withCaption(0, `In this ladder: {claim:turns_completed.linux-x64.250.base}.`)).findings, []);
  const p = goodClaimPost();
  p.sections[0] = { chart_id: 'series.turns_completed.linux-x64', caption: 'In this ladder: {claim:turns_completed.linux-x64.250.base}.' };
  p.sections.splice(1, 0);
  has(run(p), 'free-word');
  has(run({ ...goodClaimPost(), summary: `In this series, ${C_REGRESSED}. ${C_IMPROVED}.` }), 'free-word');
});

test('spacing: a space after ":" and "." before a placeholder, none before "." "," or ":"', () => {
  has(run({ ...goodClaimPost(), summary: `Here:${C_REGRESSED}. ${C_IMPROVED}.` }), 'free-char');
  has(run({ ...goodClaimPost(), summary: `Here.${C_REGRESSED}. ${C_IMPROVED}.` }), 'free-char');
  has(run({ ...goodClaimPost(), summary: `${C_REGRESSED} . ${C_IMPROVED}.` }), 'free-char');
});

test('the fallback summary cites the regressed headline metrics first, largest change first', () => {
  const f = fallbackPost(bundle());
  assert.match(f.summary, /^Peak memory at 250 agents: /);
  assert.ok(!('quotes' in f) || f.quotes.length === 0);
});

test('summary with many regressions: it cites the largest three, largest first, and may omit the rest', () => {
  // Five headline metrics regressed: a summary holds at most three clauses, so it cites the three largest.
  const b = bundle();
  const regress = { 'turns_completed.linux-x64.100.base': 1.5, 'turn_p50_ms.linux-x64.250.base': 2.5, 'dispatch_p95_ms.linux-x64.100.base': 1.1,
    'rss_peak_mib.linux-x64.250.base': 2.0, 'writer_tx_p95_ms.linux-x64.100.base': 3.0 };
  b.metrics = b.metrics.map((m) => {
    const id = `${m.id}.${m.platform}.${m.level}.base`;
    return regress[id] ? { ...m, verdict: 'regressed', headline: m.headline ?? 6 } : m;
  });
  b.claims = b.claims.map((c) => (regress[c.id] ? { ...c, verdict: 'regressed', size: regress[c.id] } : c));
  if (!b.claims.some((c) => c.id === 'dispatch_p95_ms.linux-x64.100.base')) b.claims.push({ id: 'dispatch_p95_ms.linux-x64.100.base', metric: 'dispatch_p95_ms', platform: 'linux-x64', level: '100', comparison: 'base', verdict: 'regressed', size: 1.1, clause: 'x' });
  const top3 = '{claim:writer_tx_p95_ms.linux-x64.100.base}. {claim:turn_p50_ms.linux-x64.250.base}. {claim:rss_peak_mib.linux-x64.250.base}.';
  const p = { ...goodClaimPost(b), summary: top3 };
  const r = run(p, b);
  assert.ok(!rules(r).includes('summary-binding') && !rules(r).includes('summary-order'), JSON.stringify(r.findings));
  const missingTop = run({ ...p, summary: '{claim:writer_tx_p95_ms.linux-x64.100.base}. {claim:turn_p50_ms.linux-x64.250.base}. {claim:turns_completed.linux-x64.100.base}.' }, b);
  has(missingTop, 'summary-binding');
  const two = run({ ...p, summary: '{claim:writer_tx_p95_ms.linux-x64.100.base}. {claim:turn_p50_ms.linux-x64.250.base}.' }, b);
  has(two, 'summary-binding');
});

test('quotes: plain adjectives about speed or cost are not quotable', () => {
  for (const line of ['A quick path for the reader.', 'Fast startup for the scheduler.', 'A snappy poller.', 'Instant dispatch.',
    'A cheap scan.', 'Smooth streaming for the subscriber.', 'A responsive server.', 'The slow path is gone.', 'A sluggish worker.',
    'A heavy scan.', 'A light poller.', 'A lean decoder.', 'A swift reader.', 'An expensive scan.']) {
    assert.equal(isQuotable(line), false, line);
  }
});

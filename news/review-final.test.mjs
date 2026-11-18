// The final review's two posts majors. M3: a fork-vs-base row with a zero reference (base 0, fork not) carries
// the note zero_reference, which the aggregator emits; the post bundle and the release must accept it. M7: the
// summary cites the largest regressions as claims (metric, level and comparison), so a smaller regression of the
// same metric at another level, or in the other comparison, does not stand in for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { check } from './check.mjs';
import { bundle, goodClaimPost } from './fixtures/bundle.mjs';
import { buildPostBundle } from '../site/build/release-bundle.mjs';
import { source } from '../site/build/release-fixtures/source.mjs';
import { renderRelease, runPost } from '../site/build/release-post.mjs';
import { validate } from '../tools/t3cp/lib/validate.mjs';

const json = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
const catalogue = json('catalogue/catalogue.json');
const clean = () => [];
const rules = (r) => r.findings.map((f) => f.rule);

test('M3: a row noted zero_reference builds a valid post bundle, records a post and renders a valid release', async () => {
  const src = source();
  // A headline metric whose base is 0 at 100 agents while the fork's is not: no verdict, note zero_reference.
  src.metrics = src.metrics.map((m) => (m.id === 'dispatch_p95_ms' && m.level === '100'
    ? { ...m, base: { median: 0, min: 0, max: 0, n: 3 }, text: { ...m.text, base: '0 ms', delta_pct: null }, delta_pct: null, worse_pct: null, verdict: null, note: 'zero_reference' }
    : m));
  const b = buildPostBundle(src, { catalogue, headline: '100' });
  assert.deepEqual(validate(json('news/post-bundle-1.json'), b), []);
  const row = b.metrics.find((m) => m.id === 'dispatch_p95_ms' && m.level === '100');
  assert.equal(row.note, 'zero_reference');
  const chart = b.charts.find((c) => c.metric === 'dispatch_p95_ms' && c.kind === 'ladder');
  assert.match(chart.caption, /zero reference, no verdict/);
  const root = mkdtempSync(path.join(tmpdir(), 'm3-'));
  const r = await runPost({ bundle: b, post: { bundle_sha256: b.bundle_sha256, summary: `{claim:${b.claims[0].id}}.`, sections: [] }, postsDir: path.join(root, 'posts'), scanText: clean, repoRoot: root });
  assert.notEqual(r.status, 'refused', r.message);
  const rel = renderRelease({ bundle: b, source: null, scanText: clean });
  assert.deepEqual(validate(json('schema/release-1.json'), rel), []);
  assert.equal(rel.deltas.find((d) => d.metric === 'dispatch_p95_ms' && d.level === '100').note, 'zero_reference');
});

// The test bundle with peak memory also regressed at 100 agents, by less than at 250.
function twoLevelRegression() {
  const b = bundle();
  b.metrics = b.metrics.map((m) => (m.id === 'rss_peak_mib' && m.level === '100' ? { ...m, verdict: 'regressed' } : m));
  b.claims = b.claims.filter((c) => c.id !== 'rss_peak_mib.linux-x64.100.base');
  b.claims.push({ id: 'rss_peak_mib.linux-x64.100.base', metric: 'rss_peak_mib', platform: 'linux-x64', level: '100', comparison: 'base', verdict: 'regressed', size: 0.574, clause: 'x' });
  return b;
}

test('M7: the largest regression of a metric is not stood in for by a smaller one at another level', () => {
  const b = twoLevelRegression();
  const good = goodClaimPost(b);
  assert.ok(!rules(check(good, b, { scanText: clean })).includes('summary-binding'), 'the largest regression cited: no finding');
  const swapped = { ...good, summary: good.summary.replace('{claim:rss_peak_mib.linux-x64.250.base}', '{claim:rss_peak_mib.linux-x64.100.base}') };
  assert.notEqual(swapped.summary, good.summary);
  assert.ok(rules(check(swapped, b, { scanText: clean })).includes('summary-binding'), JSON.stringify(check(swapped, b, { scanText: clean }).findings));
});

test('M7: nor by the same metric in the other comparison', () => {
  const b = bundle();
  const good = goodClaimPost(b);
  const swapped = { ...good, summary: good.summary.replace('{claim:rss_peak_mib.linux-x64.250.base}', '{claim:rss_peak_mib.linux-x64.250.prev}') };
  assert.notEqual(swapped.summary, good.summary);
  assert.ok(rules(check(swapped, b, { scanText: clean })).includes('summary-binding'), JSON.stringify(check(swapped, b, { scanText: clean }).findings));
});

// Saturated levels and a base from another era. At a level where a record could not serve every agent, only
// turns_completed and agents_served keep a comparison: every other metric there is context, never a claim, never
// a regression or an improvement, never in the summary. A base measured in another era is no comparison at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from './check.mjs';
import { claimIndex, fallbackPost } from './claims.mjs';
import { bundle, goodClaimPost } from './fixtures/bundle.mjs';

const clean = () => [];
const rules = (r) => r.findings.map((f) => f.rule);

// The test bundle with 250 agents saturated on the fork side, every verdict left as it was (as if a producer
// forgot to null them): the posts tooling must still refuse them.
function saturatedBundle() {
  const b = bundle();
  b.metrics = b.metrics.map((m) => (m.level === '250' ? { ...m, saturated: { fork: true, base: false, prev: false } } : m));
  return b;
}

test('saturated: a latency comparison at a saturated level is not a claim; turns_completed there still is', () => {
  const claims = claimIndex(saturatedBundle());
  assert.ok(!claims.has('turn_p50_ms.linux-x64.250.base'));
  assert.ok(!claims.has('rss_peak_mib.linux-x64.250.base'));
  assert.ok(!claims.has('rss_peak_mib.linux-x64.250.prev'));
  assert.ok(claims.has('turns_completed.linux-x64.250.base'));
  assert.ok(claims.has('turn_p50_ms.linux-x64.100.base') || !bundle().metrics.some((m) => m.id === 'turn_p50_ms' && m.level === '100' && m.verdict));
});

test('saturated: citing a saturated comparison fails, and it is not a regression the summary must cite', () => {
  const b = saturatedBundle();
  const p = { ...goodClaimPost(b), summary: '{claim:rss_peak_mib.linux-x64.250.base}. {claim:turns_completed.linux-x64.100.base}.' };
  assert.ok(rules(check(p, b, { scanText: clean })).includes('claim-unknown'));
  const q = { ...goodClaimPost(b), summary: '{claim:turns_completed.linux-x64.100.base}.' };
  q.sections = q.sections.filter((s) => !/rss_peak_mib|turn_p50/.test(s.chart_id + s.caption));
  const r = check(q, b, { scanText: clean });
  assert.ok(!rules(r).includes('summary-binding'), JSON.stringify(r.findings));
});

test('saturated: the fallback summary never cites a saturated comparison', () => {
  const f = fallbackPost(saturatedBundle());
  assert.ok(!/Peak memory at 250 agents|Turn time p50 at 250 agents/.test(f.summary || ''), f.summary);
});

test('no comparable base: a bundle pending for no_base renders the no_base fallback, and no post is recorded', async () => {
  const { renderRelease, runPost } = await import('../site/build/release-post.mjs');
  const { buildPostBundle } = await import('../site/build/release-bundle.mjs');
  const { source } = await import('../site/build/release-fixtures/source.mjs');
  const { readFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const catalogue = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
  const src = source();
  src.metrics = src.metrics.map((m) => ({ ...m, verdict: null, note: 'no_base' }));
  const b = buildPostBundle(src, { catalogue });
  assert.equal(b.pending, true);
  assert.equal(b.pending_reason, 'no_base');
  const rel = renderRelease({ bundle: b, source: null, scanText: clean });
  assert.equal(rel.charts_only_reason, 'no_base');
  assert.match(rel.post.title, /no comparable base/);
  assert.deepEqual(rel.deltas, []);
  const root = mkdtempSync(path.join(tmpdir(), 'nobase-'));
  const r = await runPost({ bundle: b, post: { bundle_sha256: b.bundle_sha256, summary: 'Here.', sections: [] }, postsDir: path.join(root, 'posts'), scanText: clean, repoRoot: root });
  assert.equal(r.status, 'refused');
});

test('saturated, from the source: the bundle builder nulls every comparison at a saturated level but turns_completed, whatever the source says', async () => {
  const { buildPostBundle } = await import('../site/build/release-bundle.mjs');
  const { renderRelease } = await import('../site/build/release-post.mjs');
  const { source } = await import('../site/build/release-fixtures/source.mjs');
  const { readFileSync } = await import('node:fs');
  const catalogue = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
  const src = source();
  // The fork's 250-agent cell is saturated; the source left every verdict in place (a producer that forgot).
  src.metrics = src.metrics.map((m) => (m.level === '250' ? { ...m, saturated: { fork: true, base: false, prev: false } } : m));
  const b = buildPostBundle(src, { catalogue });
  const at250 = b.metrics.filter((m) => m.level === '250');
  assert.ok(at250.length > 1);
  for (const m of at250) {
    assert.deepEqual(m.saturated, { fork: true, base: false, prev: false });
    if (m.id === 'turns_completed') { assert.equal(m.verdict, 'improved'); continue; }
    assert.equal(m.verdict, null, m.id);
    assert.equal(m.note, 'saturated', m.id);
    assert.equal(m.verdict_vs_prev, null, m.id);
    assert.equal(m.note_vs_prev, 'saturated', m.id);
  }
  const claims250 = b.claims.filter((c) => c.level === '250');
  assert.ok(claims250.length > 0 && claims250.every((c) => c.metric === 'turns_completed'), JSON.stringify(claims250.map((c) => c.id)));
  assert.equal(b.counts['250'].regressed, 0);
  const rel = renderRelease({ bundle: b, source: null, scanText: clean });
  const rss = rel.deltas.find((d) => d.metric === 'rss_peak_mib' && d.level === '250');
  assert.equal(rss.verdict, null);
  assert.equal(rss.note, 'saturated');
  assert.deepEqual(rss.saturated, { fork: true, base: false });
  assert.ok(!/at 250 agents/.test((rel.post.summary || '').replace(/Turns completed in the window at 250 agents[^.]*\./g, '')), rel.post.summary);
});

test('saturated is required: a row without it, or with a malformed one, is never a claim (fail closed)', () => {
  const b = bundle();
  const id = 'rss_peak_mib.linux-x64.250.base';
  assert.ok(claimIndex(b).has(id));
  for (const bad of [undefined, null, {}, { fork: 'no', base: false, prev: false }, { fork: false, base: false }]) {
    const c = bundle();
    c.metrics = c.metrics.map((m) => {
      if (m.id !== 'rss_peak_mib' || m.level !== '250') return m;
      const { saturated, ...rest } = m;
      return bad === undefined ? rest : { ...rest, saturated: bad };
    });
    assert.ok(!claimIndex(c).has(id), JSON.stringify(bad));
    assert.ok(!claimIndex(c).has('rss_peak_mib.linux-x64.250.prev'), JSON.stringify(bad));
  }
});

test('saturated is required in the source: a release bundle row without it does not validate, so no bundle is built', async () => {
  const { buildPostBundle } = await import('../site/build/release-bundle.mjs');
  const { source } = await import('../site/build/release-fixtures/source.mjs');
  const { readFileSync } = await import('node:fs');
  const catalogue = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
  const src = source();
  src.metrics = src.metrics.map((m) => {
    if (m.id !== 'rss_peak_mib' || m.level !== '250') return m;
    const { saturated, ...rest } = m;
    return rest;
  });
  assert.throws(() => buildPostBundle(src, { catalogue }), /does not validate against t3cp\/release-bundle\/1.*saturated/);
  const b = buildPostBundle(source(), { catalogue });
  assert.ok(b.metrics.every((m) => m.saturated && typeof m.saturated.fork === 'boolean'));
});

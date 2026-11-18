// Option (a): the headline levels are 1, 50, 100 and 250 agents, the default 50. The bundle keeps the 50-agent
// rows and counts, the checker accepts claims at 50 and the renderer writes their clauses, and a release renders
// at each of the four levels, with or without a written post.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { check } from './check.mjs';
import { DEFAULT_HEADLINE, HEADLINE_LEVELS, buildPostBundle } from '../site/build/release-bundle.mjs';
import { source } from '../site/build/release-fixtures/source.mjs';
import { readSource, renderRelease, runPost } from '../site/build/release-post.mjs';
import { validate } from '../tools/t3cp/lib/validate.mjs';

const json = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
const catalogue = json('catalogue/catalogue.json');
const clean = () => [];
const LEVELS = ['1', '50', '100', '250'];

test('the headline levels are 1, 50, 100 and 250 agents, and the default is 50', () => {
  assert.deepEqual([...HEADLINE_LEVELS], LEVELS);
  assert.equal(DEFAULT_HEADLINE, '50');
  for (const rel of ['news/post-bundle-1.json', 'schema/release-1.json']) {
    const s = json(rel);
    const levelEnum = rel.startsWith('news') ? s.properties.headline_level.enum : s.$defs.headline_level.enum;
    assert.deepEqual(levelEnum, LEVELS, rel);
  }
});

test('the bundle keeps the 50-agent rows, counts and claims, and validates', () => {
  const b = buildPostBundle(source(), { catalogue });
  assert.equal(b.headline_level, '50');
  assert.deepEqual(b.levels, LEVELS);
  assert.ok(b.metrics.some((m) => m.level === '50'));
  assert.ok(b.counts['50'] && b.counts['50'].total > 0);
  assert.ok(b.claims.some((c) => c.level === '50'));
  assert.deepEqual(validate(json('news/post-bundle-1.json'), b), []);
});

// A written post the checker passes, for a bundle: the summary cites the headline regressions the binding rule
// asks for (or the largest movers at the headline level), largest first; one caption on the first's own chart.
function writtenPost(b) {
  const at = (c) => c.level === b.headline_level || c.level === 'once';
  const regressed = new Map();
  for (const c of b.claims.filter((x) => x.verdict === 'regressed')) if (!regressed.has(c.metric) || c.size > regressed.get(c.metric).size) regressed.set(c.metric, c);
  const head = new Set(b.metrics.filter((m) => m.headline != null).map((m) => m.id));
  let cited = [...regressed.values()].filter((c) => head.has(c.metric)).sort((x, y) => y.size - x.size).slice(0, 3);
  if (!cited.length) cited = b.claims.filter((c) => at(c) && c.comparison === 'base' && c.verdict !== 'within').sort((x, y) => y.size - x.size).slice(0, 1);
  const first = cited[0];
  const chart = b.charts.find((c) => c.metric === first.metric && c.comparison === first.comparison && c.kind !== 'series');
  return {
    bundle_sha256: b.bundle_sha256,
    summary: cited.map((c) => `{claim:${c.id}}.`).join(' '),
    sections: chart ? [{ chart_id: chart.id, caption: `{claim:${first.id}}.` }] : [],
  };
}

// The fixture's 50-agent rows are all within noise: here turns completed at 50 agents improved (240 against 190).
function sourceWith50Mover() {
  const src = source();
  src.metrics = src.metrics.map((m) => (m.id === 'turns_completed' && m.level === '50'
    ? { ...m, fork: { ...m.fork, median: 240 }, delta_pct: 26.316, worse_pct: -26.316, verdict: 'improved', note: null, text: { ...m.text, fork: '240', delta_pct: '+26.3%' } }
    : m));
  return src;
}

test('the checker accepts a claim at 50 agents and the renderer writes its clause', () => {
  const b = buildPostBundle(sourceWith50Mover(), { catalogue, headline: '50' });
  const c50 = b.claims.find((c) => c.id === 'turns_completed.linux-x64.50.base');
  assert.equal(c50.verdict, 'improved');
  const rss = b.claims.find((c) => c.id === 'rss_peak_mib.linux-x64.250.base');
  const ordered = [c50, rss].sort((x, y) => y.size - x.size);
  const chart = b.charts.find((c) => c.id === 'fork-vs-base.turns_completed.ladder.linux-x64');
  const post = { bundle_sha256: b.bundle_sha256, summary: ordered.map((c) => `{claim:${c.id}}.`).join(' '), sections: [{ chart_id: chart.id, caption: `{claim:${c50.id}}.` }] };
  const r = check(post, b, { scanText: clean });
  assert.equal(r.passed, true, JSON.stringify(r.findings));
  assert.match(r.rendered.summary, /at 50 agents: 190 on the upstream base, 240 on perf\.8, \+26\.3%, improved beyond noise\./);
});

test('a release renders at each of the four headline levels, with no text and with a written post', async () => {
  for (const h of LEVELS) {
    const b = buildPostBundle(source(), { catalogue, headline: h });
    const bare = renderRelease({ bundle: b, source: null, scanText: clean });
    assert.equal(bare.headline_level, h);
    assert.ok(bare.counts[h], h);
    assert.deepEqual(validate(json('schema/release-1.json'), bare), [], h);
    const root = mkdtempSync(path.join(tmpdir(), `headline-${h}-`));
    const r = await runPost({ bundle: b, post: writtenPost(b), postsDir: path.join(root, 'posts'), scanText: clean, repoRoot: root });
    assert.equal(r.status, 'passed', `${h}: ${r.message}`);
    const rel = renderRelease({ bundle: b, source: readSource(r.file, b.release.tag), scanText: clean });
    assert.equal(rel.charts_only, false, h);
    assert.equal(rel.headline_level, h);
    assert.deepEqual(validate(json('schema/release-1.json'), rel), [], h);
  }
});

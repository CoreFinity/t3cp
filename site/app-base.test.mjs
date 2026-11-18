// Red first: a fork release compared with its source-built upstream base says so everywhere: the release's
// sub-line, the deltas table and the fork-vs-base ladder name "upstream base, built from source at <sha7>", never
// "nightly".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApp } from './build/lib/app-vm.mjs';
import { releaseHTML } from './build/render-post.mjs';

const T = loadApp();
const cat = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
const ctx = { catalogue: cat.metrics, headlines: cat.headlines['linux-x64'], platform: 'linux-x64', level: '100', platName: 'Linux x64' };
const SHA = 'd57a42a124b20ff921464048656b11a6f215ceda';

const rel = () => ({
  tag: 'v0.1.9-perf.8', date: '2026-11-15', base: { tag: 'v0.1.10-nightly.20261114.5628', date: '2026-11-14', sha: SHA }, prev: { tag: 'v0.1.9-perf.7', date: '2026-11-14' },
  deltas: [{ metric: 'turn_p50_ms', platform: 'linux-x64', level: '100', headline: 2, fork: 186, base: 312, delta_pct: -40.5, threshold_pct: 22.5, verdict: 'improved', note: null }],
  charts_only: true, charts_only_reason: 'no_text_yet', post: null, changelog: [], checker: { passed: false, footer: 'Charts only: no text was written for this release.' },
});

test('the release names its source-built base by its commit, not as a nightly', () => {
  const { html } = releaseHTML(T, rel(), ctx);
  assert.match(html, /upstream base, built from source at d57a42a/);
  assert.match(html, /Upstream base d57a42a/, 'the table column names the base by its commit');
  assert.doesNotMatch(html, /[Nn]ightly 14 Nov|Base 14 Nov/, 'the base is never called a nightly');
});

test('a release without a base sha keeps the nightly wording', () => {
  const r = rel(); delete r.base.sha;
  assert.match(releaseHTML(T, r, ctx).html, /nightly 14 Nov/);
});

test('the fork-vs-base ladder draws the base record from the comparison, labelled by its commit', () => {
  const m = cat.metrics.find(x => x.id === 'turn_p50_ms');
  const cf = { rows: ['1', '50', '100', '150', '200', '250'].map((level, i) => ({ metric: 'turn_p50_ms', level, a: 100 + i * 50, b: 80 + i * 30, delta: -20, band: 17.5, threshold: 22.5, verdict: 'improved', note: null })) };
  const c = T.baseLadderChart(m, cf, { tag: 'v0.1.9-perf.8', base_sha: SHA }, { plat: 'Linux x64' });
  assert.deepEqual(c.series[0].vals, [100, 150, 200, 250, 300, 350], 'the base record at each level');
  assert.deepEqual(c.series[1].vals, [80, 110, 140, 170, 200, 230], 'the fork at each level');
  const sides = c.marks.filter(k => k.side).map(k => k.side);
  assert.ok(sides.includes('Upstream base d57a42a'), sides.join(' | '));
  assert.ok(!sides.some(s => /Nightly/.test(s)));
});

// Red first: the fork's second line. Where the series carries fork-head nights (fork.head_tags), the fork line is the
// value measured on each night, drawn as a line beside the upstream nightly's, and the tooltip names the release
// measured that night and calls the nightly row "Upstream nightly"; a fork-head night without a value says why, with
// the measured-failure wording (failed: no valid attempt; saturated: N of L agents served, not measured). Without
// fork-head nights everything is as before: the held release step, "Nightly", no "same night".
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, forkOf, level, shard } from './build/lib/test-data.mjs';

const T = loadApp();
const strip = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/ ([.,;:)])/g, '$1').trim();
const meta = { ...META.elu, era_start: '2026-10-17' };
const TAG = 'v0.1.9-perf.1';
// Ten nights, 17 to 26 Oct, at 100 agents; the release (18 Oct, 90) is held until fork-head nights start on 23 Oct:
// 23 Oct 80, 24 Oct no valid attempt, 25 Oct saturated (61 of 100 served), 26 Oct 95.
function fork(heads) {
  const f = forkOf(10, [{ i: 1, tag: TAG, v: 90 }]);
  if (!heads) return f;
  f.head_tags = f.step_tags.map((t, i) => (i >= 6 ? TAG : null));
  const lv = f.levels['100'];
  lv.step = lv.step.map((v, i) => (i < 6 ? v : [80, null, null, 95][i - 6]));
  lv.head_note = lv.step.map((_, i) => (i === 7 ? 'hollow' : i === 8 ? 'saturated' : null));
  return f;
}
function model(heads) {
  const sf = forkOf(10, [{ i: 1, tag: TAG, v: 100 }]);
  if (heads) { sf.head_tags = fork(true).head_tags; sf.levels['100'].step = sf.levels['100'].step.map((v, i) => (i === 8 ? 61 : v)); }
  const served = shard('agents_served', { 100: level(Array(10).fill(100)) }, { n: 10, fork: sf });
  return T.model(shard('elu', { 100: level(Array(10).fill(100)) }, { n: 10, fork: fork(heads) }), meta, '100', 0, served);
}

test('fork-head nights: the fork line is drawn as a line through the measured values', () => {
  const M = model(true), f = T.tsChart(M, { w: 960 }).series.find(s => s.cls === 'ln-f');
  assert.equal(!!f.step, false, 'a line, not the held step');
  assert.deepEqual(f.vals, [null, 90, 90, 90, 90, 90, 80, null, null, 95]);
});

test('the tooltip names the release measured that night, beside the upstream nightly', () => {
  const tip = strip(T.tipHTML(model(true), 6));
  assert.match(tip, /100 Upstream nightly/);
  assert.match(tip, new RegExp(`80 Fork ${T.short(TAG)}, measured the same night`));
  assert.doesNotMatch(strip(T.tipHTML(model(true), 3)), /same night/, 'a held night is the release, not a measurement');
});

test('a fork-head night without a value says why, as the nightly does', () => {
  const M = model(true);
  assert.match(strip(T.tipHTML(M, 7)), new RegExp(`Fork ${T.short(TAG)}: failed: no valid attempt`));
  assert.match(strip(T.tipHTML(M, 8)), new RegExp(`Fork ${T.short(TAG)}: saturated: 61 of 100 agents served, not measured`));
  for (const j of [7, 8]) assert.doesNotMatch(T.tipHTML(M, j), /crash|driver/i);
});

test('without fork-head nights nothing changes: the held step, "Nightly", no "same night"', () => {
  const M = model(false), f = T.tsChart(M, { w: 960 }).series.find(s => s.cls === 'ln-f');
  assert.equal(f.step, true);
  const tip = strip(T.tipHTML(M, 6));
  assert.match(tip, /100 Nightly/);
  assert.doesNotMatch(tip, /Upstream nightly|same night/);
});

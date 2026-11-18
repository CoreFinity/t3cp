// Red first: the renderer findings of the final review that need no new data.
// - The chart draws a noise band only where the aggregator publishes a reference: no reference is backfilled, and
//   the band breaks where references are missing (so it never spans an era boundary or an unbanded run).
// - The note zero_reference is worded as the release posts word it.
// - A counter's release-to-release change is a rise when it regressed, though its percentage is null by design:
//   its marker points up, and its tooltip is not "First release" (only a release with no previous one is).
// - A counter metric's page says how counters are judged, never that no band means no verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApp } from './build/lib/app-vm.mjs';
import { dates, forkOf, level, shard } from './build/lib/test-data.mjs';
import { build } from './build/build.mjs';

const T = loadApp();
const cat = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
const metric = id => cat.metrics.find(m => m.id === id);

test('the noise band is drawn only where the aggregator publishes a reference, and breaks across gaps', () => {
  const lv = level([100, 101, 102, 103, 104, 105, 106, 107]);
  lv.ref = [null, null, 100, 101, null, 102, 103, 104];
  const M = T.model(shard('turn_p50_ms', { 100: lv }, { n: 8 }), metric('turn_p50_ms'), '100', 0, null);
  const c = T.tsChart(M, { w: 960 });
  assert.deepEqual(c.band.lo.map(v => v == null), [true, true, false, false, true, false, false, false], 'no backfilled reference');
  const svg = T.tsSVG(M, 960, 320).html;
  assert.equal((svg.match(/<path class="bd"/g) || []).length, 2, 'one band piece per unbroken run of references');
});

test('zero_reference is worded as the release posts word it', () => {
  assert.equal(T.say('none', 'zero_reference'), 'zero reference, no verdict');
});

test('a regressed counter between fork releases points up and is not called the first release', () => {
  const n = 6, m = metric('server_warn_lines');
  const fk = forkOf(n, [{ tag: 'v0.1.9-perf.7', i: 2, v: 0, vp: null, vpv: null }, { tag: 'v0.1.9-perf.8', i: 4, v: 3, vp: null, vpv: 'regressed' }]);
  const S = shard('server_warn_lines', { 100: level(dates(n).map(() => 0)) }, { n, fork: fk });
  const fc = T.forkChart(m, S, '100', 'v0.1.9-perf.8', {});
  assert.equal(fc.marks[1].kind, 'bad');
  assert.equal(fc.marks[1].up, true, 'release chart: the rise points up');
  assert.doesNotMatch(fc.tip(1), /First release/);
  assert.match(fc.tip(0), /First release/, 'the release with no previous one is the first');
  const M = T.model(S, m, '100', 0, null), ts = T.tsChart(M, { w: 960 });
  const mk = ts.marks.find(x => x.href && /perf\.8/.test(x.href));
  assert.equal(mk.up, true, 'time series: the rise points up');
  assert.doesNotMatch(T.tipHTML(M, 4), /First release/);
});

test('a counter metric page says how counters are judged, never that no band means no verdict', async () => {
  const out = mkdtempSync(join(tmpdir(), 't3cp-counter-'));
  try {
    await build({ out: join(out, 'dist'), in: join(out, 'no-data-yet'), posts: 'news/posts' });
    const rise = readFileSync(join(out, 'dist/metrics/server_warn_lines/index.html'), 'utf8');
    const abs = readFileSync(join(out, 'dist/metrics/client_errors/index.html'), 'utf8');
    for (const html of [rise, abs]) assert.doesNotMatch(html, /so no verdict|no verdict<\/dd>|none measured yet: no verdict/);
    assert.match(rise, /a rise above the reference/);
    assert.match(abs, /any value above zero/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

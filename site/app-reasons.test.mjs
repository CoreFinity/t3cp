// Red first: a value the aggregator notes no_data names its public reason where the series gives one
// (levels.<L>.reason, parallel to note: extra_timeout, no_setup_span or timeout), and the reference is worded as the
// aggregator computes it (the median of up to seven previous complete nightlies, from three; fewer gives a thin
// reference).
// - The records table lists such a date with the reason's phrase; a no_data date with no reason, or with a value
//   that is not a public reason, is not listed.
// - The chart's tooltip there says the phrase, not "No record at this level".
// - The phrases are one literal map in app.js, `const REASON = { key: 'phrase', ... };`, so other surfaces can pin it.
// - A reason only counts beside no_data; a shard without the reason key still renders.
// - The tooltip, the readout, the table header and the Methodology page say "up to 7" / "up to seven".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, level, shard } from './build/lib/test-data.mjs';

const T = loadApp();
const SRC = readFileSync(fileURLToPath(new URL('./app.js', import.meta.url)), 'utf8');
const strip = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const PHRASE = { extra_timeout: 'the measurement ran out of time', no_setup_span: 'this build has no setup timing', timeout: 'the record did not finish in time' };

// Eight nightlies at 100 agents, 17 to 24 Oct: 18 Oct an extra that timed out, 20 Oct a build with no setup span,
// 21 Oct a record that did not finish in time, 22 Oct no_data with no reason, 23 Oct a value that is no public reason.
function lv8() {
  const lv = level([100, null, 102, null, null, null, null, 107]);
  lv.reason = [null, 'extra_timeout', null, 'no_setup_span', 'timeout', null, 'constructor', null];
  return lv;
}
const meta = { ...META.elu, era_start: '2026-10-17' };
const model = (lv, range = 0) => T.model(shard('elu', { 100: lv }, { n: 8 }), meta, '100', range, null);

test('the records table lists a value missing for a public reason, with its phrase', () => {
  const t = strip(T.recordsTable(model(lv8())));
  assert.match(t, /18 Oct 2026 [^]*?the measurement ran out of time/);
  assert.match(t, /20 Oct 2026 [^]*?this build has no setup timing/);
  assert.match(t, /21 Oct 2026 [^]*?the record did not finish in time/);
  assert.doesNotMatch(t, /22 Oct 2026/, 'no_data with no reason is not listed');
  assert.doesNotMatch(t, /23 Oct 2026/, 'a value that is not a public reason is not listed');
});

test('the tooltip says the phrase where a value is missing for a public reason', () => {
  const M = model(lv8());
  [[1, 'extra_timeout'], [3, 'no_setup_span'], [4, 'timeout']].forEach(([j, r]) => {
    const tip = strip(T.tipHTML(M, j));
    assert.ok(tip.includes(PHRASE[r]), `${r} at ${j}: ${tip}`);
    assert.doesNotMatch(tip, /No record at this level/);
  });
  assert.match(strip(T.tipHTML(M, 5)), /No record at this level/, 'no reason: unchanged');
  const odd = strip(T.tipHTML(M, 6));
  assert.match(odd, /No record at this level/, 'a value that is no public reason: unchanged');
  assert.doesNotMatch(odd, /function|native code/);
});

test('the reasons follow the chart\'s range', () => {
  assert.match(strip(T.tipHTML(model(lv8(), 4), 0)), /the record did not finish in time/, '21 Oct is the first of the last four');
});

test('a reason counts only beside no_data, and a shard without reasons still renders', () => {
  const lv = lv8();
  lv.note[1] = 'hollow';
  const tip = strip(T.tipHTML(model(lv), 1));
  assert.match(tip, /failed: no valid attempt/);
  assert.doesNotMatch(tip, /ran out of time/);
  const old = lv8();
  delete old.reason;
  const M = model(old);
  assert.match(strip(T.tipHTML(M, 1)), /No record at this level/);
  assert.doesNotMatch(strip(T.recordsTable(M)), /18 Oct 2026/);
});

test('the phrases are one literal REASON map in app.js', () => {
  const m = /const REASON = \{([^}]*)\};/.exec(SRC);
  assert.ok(m, 'app.js has a literal REASON map');
  const map = Object.fromEntries([...m[1].matchAll(/(\w+): '([^']*)'/g)].map(x => [x[1], x[2]]));
  assert.deepEqual(map, PHRASE);
});

test('the reference is worded as computed: the median of up to 7 previous complete nightlies', () => {
  const lv = level([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
  lv.dod_delta[9] = 0.9; lv.dod_verdict[9] = 'within';
  const M = T.model(shard('elu', { 100: lv }, { n: 10 }), meta, '100', 0, null);
  const tip = strip(T.tipHTML(M, 9));
  assert.match(tip, /vs the median of up to 7 previous complete nightlies/);
  assert.doesNotMatch(tip, /the previous 7/);
  const ro = strip(T.readoutHTML(M.meta, M));
  assert.match(ro, /vs the median of up to 7 previous complete nightlies/);
  assert.doesNotMatch(ro, /the previous 7/);
  assert.match(T.recordsTable(M), /<th class="n">vs up to 7 previous<\/th>/);
  const meth = readFileSync(fileURLToPath(new URL('./pages/methodology.html', import.meta.url)), 'utf8');
  assert.match(meth, /median of up to seven previous complete records/);
  assert.doesNotMatch(meth, /median of the previous seven/);
});

// Red first: a level that ran with no valid attempt (the aggregator's note hollow at a null value) is shown as a
// gap with its reason, a value with no neighbour is still drawn, and the reference is worded as the aggregator
// computes it (the median of up to seven previous complete nightlies; partial records are skipped).
// - B1: the records table lists that date with "fewer than two valid attempts, no verdict", never drops it.
// - B2: the chart's tooltip there says the same, not "No record at this level" (which stays for a level not run).
// - B3: a valid value between two gaps, or first next to one, gets a dot on the chart and on the small multiple.
// - The tooltip, the readout and the table say "up to 7 previous complete nightlies" / "the previous complete nightly".
// - app.js's gzip budget is 21 KB for these (the budget decision recorded with this change).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, level, shard } from './build/lib/test-data.mjs';
import { BUDGETS } from './build/budgets.mjs';

const T = loadApp();
const strip = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// Six nightlies at 100 agents: 2 Nov first and alone, 3 Nov ran with no valid attempt, 4 Nov alone, 5 Nov not run,
// then 6 and 7 Nov together.
function model() {
  const lv = level([100, null, 102, null, 104, 105]);
  lv.note[1] = 'hollow'; lv.note[3] = 'no_data';
  return T.model(shard('elu', { 100: lv }, { n: 6 }), { ...META.elu, era_start: '2026-10-17' }, '100', 0, null);
}

test('B1: the records table lists a level run with no valid attempt, with its reason', () => {
  const t = strip(T.recordsTable(model()));
  assert.match(t, /18 Oct 2026 [^]*?fewer than two valid attempts, no verdict/, 'the hollow date is a row with its reason');
  assert.doesNotMatch(t, /20 Oct 2026/, 'a level not run is not listed');
});

test('B2: the tooltip names the reason at a level run with no valid attempt', () => {
  const M = model();
  assert.match(strip(T.tipHTML(M, 1)), /fewer than two valid attempts, no verdict/);
  assert.doesNotMatch(strip(T.tipHTML(M, 1)), /No record at this level/);
  assert.match(strip(T.tipHTML(M, 3)), /No record at this level/, 'a level not run says so');
});

test('B3: a value with no neighbour gets a dot', () => {
  const marks = T.tsChart(model(), { w: 960 }).marks.filter(k => k.kind === 'last').map(k => k.i).sort();
  assert.deepEqual(marks, [0, 2, 5], 'the first and the lone value, and the latest');
});

test('the reference is worded as computed: up to 7 previous complete nightlies, or the previous complete nightly', () => {
  const lv = level([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
  lv.dod_delta[9] = 0.9; lv.dod_verdict[9] = 'within';
  const M = T.model(shard('elu', { 100: lv }, { n: 10 }), { ...META.elu, era_start: '2026-10-17' }, '100', 0, null);
  const tip = strip(T.tipHTML(M, 9));
  assert.match(tip, /vs the median of up to 7 previous complete nightlies/);
  assert.match(tip, /vs the previous complete nightly/);
  assert.doesNotMatch(tip, /7-day|previous record/);
  assert.match(strip(T.readoutHTML(M.meta, M)), /vs the median of up to 7 previous complete nightlies/);
  assert.doesNotMatch(T.recordsTable(M), /7-day/);
  const thin = T.model(shard('elu', { 100: level([100, 101, 102]) }, { n: 3 }), { ...META.elu, era_start: '2026-10-17' }, '100', 0, null);
  assert.match(strip(T.tipHTML(thin, 1)), /vs the previous complete nightly/, 'a thin reference is the previous complete nightly');
});

test('app.js\'s gzip budget is 21 KB', () => {
  assert.equal(BUDGETS.js, 21 * 1024);
});

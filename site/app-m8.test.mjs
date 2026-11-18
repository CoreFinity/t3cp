// Red first (M8): compare judges two records only by the aggregator's published comparability: the records' segment
// (equal exactly when the aggregator would compare them) and banded. The browser keeps no era rules of its own, so a
// new era kind can never make it judge what the aggregator refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, passing, published, record } from './build/lib/test-data.mjs';

const T = loadApp();
const P50 = { ...META.elu, id: 'turn_p50_ms', name: 'Turn end to end p50', unit: 'ms', bands: { 'linux-x64': { band: 17.5, threshold: 22.5, n: 6 } } };
const ERR = { id: 'client_errors', name: 'Failed calls', unit: 'n', better: 'lower', counter: 'absolute', scope: 'level', era_start: '2026-10-17', na_on: [], empty_cell: false, bands: {} };
const pair = (sch, p50s, errs) => [record({ date: '2026-11-05', values: { turn_p50_ms: p50s[0], client_errors: errs[0] } }), record({ date: '2026-11-06', values: { turn_p50_ms: p50s[1], client_errors: errs[1] } })].map((r, i) => Object.assign(r, { compaction_schedule: sch[i] }));
// The published inputs: cap and the flags (index.json), every gate passing (records-index.json).
const run = (a, b, seg) => T.compare(a, b, { catalogue: [P50, ERR].map(m => published(m)), level: '100', seg: seg && { a: passing(seg.a), b: passing(seg.b) } });
const none = r => r.rows.every(x => x.verdict === null);

test('the unknown run (5 to 7 Nov): each record is its own segment, so no verdict at all', () => {
  const [a, b] = pair([null, null], [400, 900], [0, 2]);
  assert.ok(none(run(a, b, { a: { segment: { 100: 382 }, banded: true }, b: { segment: { 100: 297 }, banded: true } })));
});

test('an unknown record against a known one (7 vs 8 Nov at 250): no verdict', () => {
  const [a, b] = pair([null, 'scheduled'], [400, 900], [0, 2]);
  assert.ok(none(run(a, b, { a: { segment: { 100: 783 }, banded: true }, b: { segment: { 100: 909 }, banded: true } })));
});

test('the M7 cases: across the compaction era no verdict; inside the early era no band, counters keep their rule', () => {
  const [a, b] = pair(['unscheduled', 'scheduled'], [400, 900], [0, 2]);
  assert.ok(none(run(a, b, { a: { segment: { 100: 760 }, banded: false }, b: { segment: { 100: 850 }, banded: true } })));
  const [c, d] = pair(['unscheduled', 'unscheduled'], [400, 900], [0, 2]);
  const by = Object.fromEntries(run(c, d, { a: { segment: { 100: 760 }, banded: false }, b: { segment: { 100: 760 }, banded: false } }).rows.map(x => [x.id, x]));
  assert.equal(by.turn_p50_ms.verdict, null);
  assert.equal(by.turn_p50_ms.note, 'no_band');
  assert.equal(by.client_errors.verdict, 'regressed');
});

test('missing comparability fails closed: no verdict', () => {
  const [a, b] = pair(['scheduled', 'scheduled'], [400, 900], [0, 2]);
  assert.ok(none(run(a, b, undefined)));
  assert.ok(none(run(a, b, { a: { segment: { 100: 801 }, banded: true }, b: {} })));
});

test('the browser trusts the published segment, not its own reading of the records', () => {
  const [a, b] = pair(['unscheduled', 'scheduled'], [400, 900], [0, 2]);
  const by = Object.fromEntries(run(a, b, { a: { segment: { 100: 960 }, banded: true }, b: { segment: { 100: 960 }, banded: true } }).rows.map(x => [x.id, x]));
  assert.equal(by.turn_p50_ms.verdict, 'regressed', 'one banded segment: the noise-band rule decides');
});

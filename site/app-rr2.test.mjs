// Red first: the delta re-review. Compare never judges across the compaction schedule era (or a load-profile
// change), and gives an early-era record no band (counters excepted), as the aggregator does; chart tooltips name
// the saturation symptoms; era labels are unambiguous and never cross a boundary line; no_base reads as "no
// comparable base".
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, level, passing, published, shard, record } from './build/lib/test-data.mjs';

const T = loadApp();
// turn_p50_ms is recorded from 17 Oct, as the catalogue has it (not from elu's 20 Oct): Compare now reads the era.
const P50 = { ...META.elu, id: 'turn_p50_ms', name: 'Turn end to end p50', unit: 'ms', era_start: '2026-10-17', bands: { 'linux-x64': { band: 17.5, threshold: 22.5, n: 6 } } };
const ERR = { id: 'client_errors', name: 'Failed calls', unit: 'n', better: 'lower', counter: 'absolute', scope: 'level', era_start: '2026-10-17', na_on: [], empty_cell: false, bands: {} };
const ctx = { catalogue: [P50, ERR].map(m => published(m)), level: '100' };
// The aggregator's published comparability for each pair below (segment ids per level, banded).
const S = (sa, sb, ba = true, bb = true) => ({ ...ctx, seg: { a: passing({ segment: { 100: sa }, banded: ba }), b: passing({ segment: { 100: sb }, banded: bb }) } });
const rec = (date, schedule, p50, errs, cells) => Object.assign(record({ date, values: { turn_p50_ms: p50, client_errors: errs } }), { compaction_schedule: schedule, workload: { profile: 'real3', suite: 'ladder-1', cells: cells || { 100: { sessions: 100, subscribers: 3, pollers: 25 } } } });

test('compare refuses a verdict across the compaction schedule era', () => {
  const r = T.compare(rec('2026-10-19', 'unscheduled', 400, 0), rec('2026-10-20', 'scheduled', 900, 0), S(1, 2, false, true));
  assert.equal(r.mode, 'ratio');
  for (const row of r.rows) assert.equal(row.verdict, null, row.id);
  assert.match(T.compareHTML(r, 'A', 'B'), /different eras of the benchmark/);
});

test('compare refuses a verdict across a change of load profile or load arguments', () => {
  const r = T.compare(rec('2026-11-01', 'scheduled', 400, 0), rec('2026-11-02', 'scheduled', 900, 0, { 100: { sessions: 100, subscribers: 100, pollers: 20 } }), S(3, 4));
  for (const row of r.rows) assert.equal(row.verdict, null, row.id);
});

test('two early-era records: no band, so no verdict, but a counter keeps its rule', () => {
  const r = T.compare(rec('2026-10-17', 'unscheduled', 400, 0), rec('2026-10-18', 'unscheduled', 900, 2), S(1, 1, false, false));
  const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
  assert.equal(by.turn_p50_ms.verdict, null);
  assert.equal(by.turn_p50_ms.note, 'no_band');
  assert.equal(by.client_errors.verdict, 'regressed', 'an absolute counter regresses at any value above 0');
});

test('a base from another era reads as no comparable base', () => {
  assert.equal(T.say('none', 'no_base'), 'no comparable base, no verdict');
});

test('the chart tooltip names the saturation symptoms', () => {
  const L = level([400, 400, 400, 400, 400, 400, 400, 400, 900, 400], {}, 22.5);
  L.saturated = L.median.map((_, i) => i === 8); L.saturated_by = L.median.map((_, i) => (i === 8 ? ['call_timeouts', 'driver_saturated'] : null));
  L.verdict[8] = null; L.note[8] = 'saturated';
  const M = T.model(shard('turn_p50_ms', { 250: L }), P50, '250', 30);
  assert.match(T.tipHTML(M, 8), /\(calls timed out\)/);
  assert.doesNotMatch(T.tipHTML(M, 8), /driver/, 'the driver falling behind is a defect, not a symptom (Q30a)');
});

test('era labels: the early compaction era is named as such, and no label crosses a boundary line', () => {
  const S = shard('turn_p50_ms', { 100: level(Array.from({ length: 30 }, () => 400), {}, 22.5) }, { n: 30 });
  S.eras = [{ date: '2026-10-20', kind: 'compaction', label: 'compaction schedule era' }, { date: '2026-10-31', kind: 'fixture', label: 'large-76' }];
  for (const W of [390, 640, 1200]) {
    const { html } = T.tsSVG(T.model(S, P50, '100', 30), W, 320);
    const lines = [...html.matchAll(/<line class="era" x1="([\d.]+)"/g)].map(m => +m[1]);
    const labels = [...html.matchAll(/<text class="ax era-l" x="([\d.]+)" y="[\d.]+" text-anchor="(\w+)">([^<]*)<\/text>/g)].map(m => {
      const x = +m[1], w = m[3].length * 6.2; return { text: m[3], x0: m[2] === 'end' ? x - w : x, x1: m[2] === 'end' ? x : x + w };
    });
    for (const l of labels) for (const X of lines) assert.ok(!(l.x0 < X - 1 && X + 1 < l.x1), `width ${W}: "${l.text}" crosses the boundary at ${X}`);
    for (const l of labels) assert.notEqual(l.text, 'compaction schedule era', 'the early era is named unambiguously');
    if (W === 1200) assert.ok(labels.some(l => l.text === 'early compaction'), 'shown where it fits inside its three-nightly era');
  }
});

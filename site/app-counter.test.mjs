// Red first: a counter (catalogue `counter` "absolute" or "rise") has no delta and no band; when it regressed it
// rose, so its arrow and its marker point up, never the two-way arrow of a figure legend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './build/lib/app-vm.mjs';
import { level, shard } from './build/lib/test-data.mjs';

const T = loadApp();
const m = { id: 'client_errors', name: 'Failed calls', short: 'Failed calls', unit: 'n', better: 'lower', counter: 'absolute', scope: 'level', era_start: '2026-10-17', na_on: [], empty_cell: false };

function counterShard() {
  const L = level([0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
  L.delta = L.delta.map(() => null); L.ref = L.ref.map(() => null);
  L.verdict = L.verdict.map((v, i) => (i === 9 ? 'regressed' : 'within')); L.note = L.note.map(() => null);
  return shard('client_errors', { 100: L });
}

test('a regressed counter shows an up arrow and an up triangle', () => {
  const M = T.model(counterShard(), m, '100', 30);
  const ro = T.readoutHTML(m, M);
  assert.match(ro, /▲/);
  assert.doesNotMatch(ro, /▲▼/);
  const { html, y } = T.tsSVG(M, 640, 320);
  const at = /<path class="mk mk-bad" d="M[\d.]+ ([\d.]+)l/.exec(html);
  assert.ok(at && +at[1] < y(2), 'the red triangle points up');
  const row = T.deltasHTML([T.drow(m, 0, 2, null, 'regressed', null, null)], 'A', 'B');
  assert.match(row, /▲/);
  assert.doesNotMatch(row, /▲▼/);
});

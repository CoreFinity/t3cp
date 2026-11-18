// Red first: a release marker can be clicked. The transparent hover rectangle must be painted before the marks,
// so the marker, not the rectangle, is what the browser hit-tests at the marker's centre.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, eluShard, forkOf } from './build/lib/test-data.mjs';

const T = loadApp();

test('the hover rectangle comes before every release marker in paint order', () => {
  const S = eluShard();
  S.fork = forkOf(10, [{ tag: 'v0.1.9-perf.7', i: 5, v: 0.79, vb: -1, vbv: 'within' }, { tag: 'v0.1.9-perf.8', i: 8, v: 0.7, vb: -12, vbv: 'within', vp: -11, vpv: 'within' }]);
  const { html } = T.tsSVG(T.model(S, META.elu, '100', 30), 640, 320);
  const hit = html.indexOf('<rect class="hit"');
  const marks = [...html.matchAll(/<a class="mk-a"/g)].map(m => m.index);
  assert.ok(hit >= 0, 'the hover rectangle is drawn');
  assert.equal(marks.length, 2, 'both releases are links');
  for (const at of marks) assert.ok(at > hit, 'a release marker is painted above the hover rectangle');
});

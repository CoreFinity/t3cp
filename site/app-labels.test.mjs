// Red first: chart labels never overprint. Release labels and era labels are spaced by their estimated width; a
// label that a forced one (the latest release) would overlap is dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, eluShard, forkOf, level, shard } from './build/lib/test-data.mjs';

const T = loadApp();
const CHAR = 6.2; // an independent estimate of an 11 px label's mean character width

function boxes(html) {
  return [...html.matchAll(/<text class="(lb|ax era-l)" x="([\d.-]+)" y="([\d.-]+)"([^>]*)>([^<]*)<\/text>/g)].map(m => {
    const x = +m[2], y = +m[3], a = /text-anchor="(\w+)"/.exec(m[4]), dx = /dx="([\d.-]+)"/.exec(m[4]), w = m[5].length * CHAR, X = x + (dx ? +dx[1] : 0);
    const anchor = a ? a[1] : 'start';
    return { text: m[5], y, x0: anchor === 'middle' ? X - w / 2 : anchor === 'end' ? X - w : X, x1: anchor === 'middle' ? X + w / 2 : anchor === 'end' ? X : X + w };
  });
}
function overlaps(bs) {
  const out = [];
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i], b = bs[j];
    if (Math.abs(a.y - b.y) < 12 && a.x0 < b.x1 && b.x0 < a.x1) out.push(`${a.text} / ${b.text}`);
  }
  return out;
}

test('release labels on adjacent dates do not overprint, the latest one kept', () => {
  // Thirty nightlies with releases on the last four dates: the reviewed case ("perf.perf.8").
  const S = shard('elu', { 100: level(Array.from({ length: 30 }, () => 0.8)) }, { n: 30 });
  S.fork = forkOf(30, [26, 27, 28, 29].map((i, k) => ({ tag: `v0.1.9-perf.${k + 5}`, i, v: 0.8, vb: 0, vbv: 'within', vp: k ? 0 : null, vpv: k ? 'within' : null })));
  for (const W of [390, 640, 1200]) {
    const { html } = T.tsSVG(T.model(S, META.elu, '100', 30), W, 320);
    const bs = boxes(html);
    assert.deepEqual(overlaps(bs), [], `width ${W}`);
    assert.ok(bs.some(b => b.text === 'perf.8'), `width ${W}: the latest release keeps its label`);
  }
});

test('era labels close together do not overprint at phone width', () => {
  const S = eluShard();
  S.eras = [{ date: '2026-10-20', kind: 'metric', label: 'event loop and heap gauges' }, { date: '2026-10-22', kind: 'fixture', label: 'large-76' }];
  for (const W of [390, 640]) {
    const { html } = T.tsSVG(T.model(S, META.elu, '100', 30), W, 320);
    assert.deepEqual(overlaps(boxes(html)), [], `width ${W}`);
  }
});

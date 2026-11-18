// Red first: no label is drawn over a marker, and no release marker sits on another, at 390, 640 and 1200 px; each
// release marker is its own click target.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, forkOf, level, shard } from './build/lib/test-data.mjs';

const T = loadApp();
const CHAR = 6.2, RING = 2;

// Marker boxes from the markup: circles and the verdict triangles (ring included).
function markers(html) {
  const out = [];
  for (const m of html.matchAll(/<circle class="mk[^"]*" cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.]+)"/g)) { const x = +m[1], y = +m[2], r = +m[3] + RING; out.push({ x0: x - r, x1: x + r, y0: y - r, y1: y + r }); }
  for (const m of html.matchAll(/<path class="mk[^"]*" d="M([\d.-]+) ([\d.-]+)l([\d.-]+) ([\d.-]+)h/g)) { const x = +m[1], y = +m[2], a = +m[3] + RING, b = +m[4]; out.push({ x0: x - a, x1: x + a, y0: Math.min(y, y + b) - RING, y1: Math.max(y, y + b) + RING }); }
  return out;
}
function labels(html) {
  return [...html.matchAll(/<text class="lb" x="([\d.-]+)" y="([\d.-]+)"([^>]*)>([^<]*)<\/text>/g)].map(m => {
    const x = +m[1], y = +m[2], a = /text-anchor="(\w+)"/.exec(m[3]), dx = /dx="([\d.-]+)"/.exec(m[3]), w = m[4].length * CHAR, X = x + (dx ? +dx[1] : 0), an = a ? a[1] : 'start';
    return { text: m[4], x0: an === 'middle' ? X - w / 2 : an === 'end' ? X - w : X, x1: an === 'middle' ? X + w / 2 : an === 'end' ? X : X + w, y0: y - 9, y1: y + 3 };
  });
}
const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

// Thirty nightlies, a step down near the end (flagged), and eight releases bunched on neighbouring dates, two on one.
function busy() {
  const v = Array.from({ length: 30 }, (_, i) => (i < 25 ? 300 + (i % 3) : 230));
  const S = shard('turns_completed', { 100: level(v, { 25: ['regressed', -24, 301], 26: ['regressed', -24, 301], 27: ['regressed', -23, 300] }, 9.6) }, { n: 30 });
  const R = [[15, 313], [16, 312], [17, 311], [18, 319], [22, 321], [22, 320], [27, 238], [29, 290]];
  S.fork = forkOf(30, R.map(([i, v], k) => ({ tag: `v0.1.9-perf.${k + 1}`, i, v, vb: 0, vbv: 'within', vp: k ? (v - R[k - 1][1]) / R[k - 1][1] * 100 : null, vpv: k ? (Math.abs(v - R[k - 1][1]) / R[k - 1][1] > 0.15 ? (v > R[k - 1][1] ? 'improved' : 'regressed') : 'within') : null })));
  return S;
}

test('no label box intersects a marker box', () => {
  for (const W of [390, 640, 1200]) {
    const { html } = T.tsSVG(T.model(busy(), META.turns_completed, '100', 30), W, 320);
    const mk = markers(html), lb = labels(html);
    assert.ok(mk.length >= 10, `width ${W}: markers drawn`);
    const bad = lb.filter(l => mk.some(m => hit(l, m))).map(l => l.text);
    assert.deepEqual(bad, [], `width ${W}: labels over markers`);
  }
});

test('release markers do not overlap one another, so each is its own click target', () => {
  for (const W of [390, 640, 1200]) {
    const { html } = T.tsSVG(T.model(busy(), META.turns_completed, '100', 30), W, 320);
    const rel = [...html.matchAll(/<a class="mk-a"[^>]*>(?:<title>[^<]*<\/title>)?(<(?:circle|path) [^>]*>)/g)].map(m => markers(m[1])[0]);
    assert.equal(rel.length, 8, `width ${W}: eight release markers`);
    for (let i = 0; i < rel.length; i++) for (let j = i + 1; j < rel.length; j++) assert.ok(!hit(rel[i], rel[j]), `width ${W}: releases ${i + 1} and ${j + 1} overlap`);
  }
});

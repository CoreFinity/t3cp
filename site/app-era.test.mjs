// Red first: a series with null before its era draws no segment there, and a flagged point carries the
// verdict word in its tooltip and in its table row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, eluShard } from './build/lib/test-data.mjs';

const T = loadApp();

function nightlyPath(html) {
  const m = html.match(/<path class="ln ln-n"[^>]*\sd="([^"]+)"/);
  assert.ok(m, 'the nightly line is drawn as <path class="ln ln-n">');
  return m[1];
}

test('no segment is drawn before the metric era', () => {
  const M = T.model(eluShard(), META.elu, '100', 30);
  const { html, x } = T.tsSVG(M, 640, 320);
  const d = nightlyPath(html);
  const cmds = d.match(/[MLHV][^MLHV]*/g);
  assert.equal(cmds.filter(c => c[0] === 'M').length, 1, 'one unbroken run after the era');
  assert.equal(Number(cmds[0].slice(1).trim().split(/[ ,]/)[0]), x(3), 'the line starts at the first recorded point');
  for (const c of cmds) {
    if (c[0] === 'M' || c[0] === 'L') assert.ok(Number(c.slice(1).trim().split(/[ ,]/)[0]) >= x(3), `no x before the era: ${c}`);
  }
  assert.doesNotMatch(T.tipHTML(M, 1), /class="tip-r"/, 'no value row is shown for a date before the era');
  assert.match(T.tipHTML(M, 1), /Not recorded before 20 Oct/);
});

test('a flagged point carries its verdict word in the tooltip and the table row', () => {
  const M = T.model(eluShard(), META.elu, '100', 30);
  const tip = T.tipHTML(M, 7);
  assert.match(tip, /regressed beyond noise/);
  assert.match(tip, /▲/, 'the arrow points the way the value moved (up)');
  const rows = T.recordsTable(M).split('<tr').filter(r => r.includes('24 Oct 2026'));
  assert.equal(rows.length, 1, 'one table row for 24 Oct 2026');
  assert.match(rows[0], /regressed beyond noise/);
  assert.match(rows[0], /v-bad/, 'the row carries the regressed colour class with its glyph');
});

test('the flagged point gets a triangle marker coloured by its verdict', () => {
  const M = T.model(eluShard(), META.elu, '100', 30);
  const { html } = T.tsSVG(M, 640, 320);
  assert.match(html, /class="mk mk-bad"/);
});

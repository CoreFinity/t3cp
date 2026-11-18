// Red first: every metric name above a lead number carries "(lower is better)" or "(higher is better)"
// with the direction word in bold, taken from the catalogue's `better`; the test fails if the word disagrees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, eluShard } from './build/lib/test-data.mjs';

const T = loadApp();
const catalogue = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
const OPP = { lower: 'higher', higher: 'lower' };

// The direction bracket that follows the metric name in a rendered lead block.
function directionAfterName(html, name) {
  const at = html.indexOf(T.esc(name));
  assert.ok(at >= 0, `the name "${name}" is rendered`);
  const m = html.slice(at).match(/\(<b>(lower|higher|context)<\/b>[^)]*\)/);
  assert.ok(m, `a direction bracket follows "${name}"`);
  return m[1];
}

test('T.dir puts the catalogue direction in bold inside brackets', () => {
  assert.match(T.dir({ better: 'lower' }), /\(<b>lower<\/b> is better\)/);
  assert.match(T.dir({ better: 'higher' }), /\(<b>higher<\/b> is better\)/);
  assert.doesNotMatch(T.dir({ better: 'lower' }), /higher/);
  assert.doesNotMatch(T.dir({ better: 'higher' }), /lower/);
});

test('every catalogue metric: the readout and the card carry the word from `better`', () => {
  for (const m of catalogue.metrics) {
    for (const html of [T.readoutHTML(m, null), T.cardHTML(m, null, '/metrics/' + m.id + '/')]) {
      const word = directionAfterName(html, m.name);
      if (m.better === 'context') { assert.equal(word, 'context', m.id); continue; }
      assert.equal(word, m.better, `${m.id}: the bracket says ${word}, the catalogue says ${m.better}`);
      assert.doesNotMatch(html, new RegExp(`<b>${OPP[m.better]}</b> is better`), `${m.id} never shows the opposite word`);
    }
  }
});

test('the readout with data still carries the direction of the metric it shows', () => {
  const M = T.model(eluShard(), META.elu, '100', 30);
  assert.equal(directionAfterName(T.readoutHTML(META.elu, M), META.elu.name), 'lower');
  const flipped = { ...META.elu, better: 'higher' };
  assert.equal(directionAfterName(T.readoutHTML(flipped, M), flipped.name), 'higher', 'the word follows `better`, not a fixed string');
});

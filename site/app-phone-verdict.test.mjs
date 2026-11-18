// Red first: the verdict word survives on phones and in the headline table. The arrow shows the direction; the word
// shows the verdict, so neither the phone list (which hides the Verdict column) nor the table may drop it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, eluShard } from './build/lib/test-data.mjs';

const T = loadApp();
const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

test('the change cell of the delta table carries the short verdict word', () => {
  const html = T.deltasHTML([T.drow(META.elu, 0.8, 0.99, 23.75, 'regressed', null, 17), T.drow(META.turns_completed, 300, 340, 13.3, 'improved', null, 9.6)], 'A', 'B');
  const cells = [...html.matchAll(/<td class="n">([\s\S]*?)<\/td><td class="hs mut">/g)].map(m => m[1]);
  assert.equal(cells.length, 2);
  assert.match(cells.join(' '), /<span class="vw">regressed<\/span>/);
  assert.match(cells.join(' '), /<span class="vw">improved<\/span>/);
});

test('the phone list shows that word (the Verdict column is hidden there)', () => {
  const phone = css.slice(css.indexOf('@media (max-width:560px)'));
  assert.match(phone, /\.dt \.vw\{display:inline\}/);
});

test('a flagged cell in the headline table carries its verdict word', () => {
  const M = T.model(eluShard(), META.elu, '100', 30);
  const html = T.headTable([M]);
  const row = html.split('<tr').find(r => r.includes('24 Oct 2026'));
  assert.match(row, /regressed/);
});

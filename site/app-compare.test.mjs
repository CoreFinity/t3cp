// Red first: the compare page refuses a verdict across platforms (ratio only) and across fixture eras.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, passing, published, record } from './build/lib/test-data.mjs';

const T = loadApp();
const catalogue = [META.elu, META.turns_completed].map(m => published(m));
const values = (elu, turns) => ({ elu, turns_completed: turns });
// The aggregator's published comparability (records-index.json): segment ids per level, and banded.
const one = passing({ segment: { 100: 1 }, banded: true }), other = passing({ segment: { 100: 2 }, banded: true });
const ctx = { catalogue, level: '100', seg: { a: one, b: one } };
const apart = { catalogue, level: '100', seg: { a: one, b: other } };

test('same platform, same fixture era: verdicts by the noise-band rule', () => {
  const a = record({ values: values(0.8, 300) }), b = record({ date: '2026-11-15', values: values(0.99, 340) });
  const r = T.compare(a, b, ctx);
  assert.equal(r.mode, 'verdict');
  assert.equal(r.refused, null);
  const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
  assert.equal(by.elu.verdict, 'regressed', '+23.75 % on a lower-is-better metric beyond 17 %');
  assert.equal(by.turns_completed.verdict, 'improved', '+13.3 % on a higher-is-better metric beyond 9.6 %');
});

test('Linux against macOS: ratio only, no verdict on any row', () => {
  const a = record({ platform: 'linux-x64', values: values(0.8, 300) }), b = record({ platform: 'darwin-arm64', values: values(0.4, 600) });
  const r = T.compare(a, b, ctx);
  assert.equal(r.mode, 'ratio');
  assert.equal(r.refused, 'platform');
  for (const row of r.rows) {
    assert.equal(row.verdict, null, `${row.id} has no verdict across platforms`);
    assert.equal(row.note, 'not_comparable');
  }
  const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
  assert.equal(by.elu.ratio, 0.5);
  assert.equal(by.turns_completed.ratio, 2);
  const html = T.compareHTML(r, 'Linux x64', 'macOS arm64');
  assert.doesNotMatch(html, /beyond noise/, 'the table never prints a verdict word across platforms');
  assert.match(html, /×/, 'the table shows the ratio');
});

test('two fixture eras: values shown, no verdict', () => {
  const a = record({ fixture: 'large-63', date: '2026-10-29', values: values(0.8, 300) });
  const b = record({ fixture: 'large-76', date: '2026-11-01', values: values(0.99, 340) });
  const r = T.compare(a, b, apart);
  assert.equal(r.refused, 'era');
  for (const row of r.rows) assert.equal(row.verdict, null, `${row.id} has no verdict across fixture eras`);
  assert.doesNotMatch(T.compareHTML(r, 'A', 'B'), /beyond noise/);
  assert.match(T.compareHTML(r, 'A', 'B'), /large-63/, 'the refusal names the two fixtures');
});

test('a harness change (a different published segment) also refuses a verdict', () => {
  const a = record({ harness: 'a'.repeat(64), values: values(0.8, 300) }), b = record({ harness: 'b'.repeat(64), values: values(0.99, 340) });
  const r = T.compare(a, b, apart);
  assert.equal(r.refused, 'era');
  for (const row of r.rows) assert.equal(row.verdict, null);
});

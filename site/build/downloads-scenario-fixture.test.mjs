// Downloads lists a scenario fixture (fixtures.json entry without a nightly era) by the scenarios.json rows that run on
// it, never as a fixture era serving nightlies; the era fixtures read as before. Synthetic inputs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './lib/app-vm.mjs';
import * as P from './pages.mjs';

const T = loadApp();
const SHA = 'a'.repeat(64);
const era = { id: 'large-76', version: 1, era_from: '2026-10-31', era_to: null, migration: 76, sqlite: { name: 'large-76-v1.sqlite', bytes: 2, sha256: SHA }, zst: { name: 'large-76-v1.sqlite.zst', bytes: 1, sha256: SHA }, recipe: 'node build' };
const scenario = { id: 'long-thread-1', version: 1, era_from: null, era_to: null, migration: 63, sqlite: { name: 'long-thread-1-v1.sqlite', bytes: 2, sha256: SHA }, zst: { name: 'long-thread-1-v1.sqlite.zst', bytes: 1, sha256: SHA }, recipe: 'node build', input: { path: 'fixture/long-thread-1.shape.json', bytes: 10, sha256: 'b'.repeat(64) } };
const rows = [
  { id: 'ladder', version: 1, suite: 'ladder-1', fixture: 'era' },
  { id: 'long-thread-turn-start', version: 1, suite: 'long-thread-turn-start@1', fixture: 'long-thread-1' },
];

test('a scenario fixture is listed by the scenario rows that run on it, not as a nightly era', () => {
  const c = { T, downloads: [], fixtures: [era, scenario], eras: [], shapeFile: { path: 'fixture/public-large.shape.json', bytes: 4447, sha256: 'c'.repeat(64) }, harness: [], records: [], scenarios: { rows } };
  const html = P.downloads(c).body;
  const section = html.slice(html.indexOf('<h2>long-thread-1.</h2>'));
  assert.ok(section.length > 0);
  const own = section.slice(0, section.indexOf('</section>'));
  assert.match(own, /Used by the scenario <code>long-thread-turn-start@1<\/code>, migration head 63\./);
  assert.doesNotMatch(own, /Serves nightlies/);
  assert.match(own, /t3cp-fixture\/long-thread-1-v1/);
  // Its own input shape, not the era fixtures' public-large shape.
  assert.match(own, /fixture\/long-thread-1\.shape\.json/);
  assert.doesNotMatch(own, /public-large/);
  // The era fixture reads as before.
  assert.match(html, /<h2>large-76\.<\/h2><p>Serves nightlies from/);
});

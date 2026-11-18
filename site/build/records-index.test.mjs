// Red first: the records list lives in records-index.json (named by index.json's records_index), off the overview's
// path. The build reads it once; an index without it fails the build (no fallback to index.json); a build with no
// data tree at all (before the first record) still builds its empty states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './lib/app-vm.mjs';
import { loadRecords } from './build.mjs';
import * as P from './pages.mjs';

const T = loadApp();
const rec = { date: '2026-11-15', tag: 'v0.1.10-nightly.20261115.5665', sha: '0'.repeat(40), platforms: { 'linux-x64': { record_id: '2026-11-15.linux-x64.nightly', status: 'complete', path: 'records/linux-x64/2026-11-15.v0.1.10-nightly.20261115.5665.json' } } };

test('the build reads the records list from the file index.json names', () => {
  const files = { 'records-index.json': { schema: 't3cp/records-index/1', generated_at: '2026-11-15T20:00:00Z', records: [rec] } };
  assert.deepEqual(loadRecords(p => files[p] || null, { records_index: 'records-index.json' }), [rec]);
});

test('an index without its records file fails the build', () => {
  assert.throws(() => loadRecords(() => null, { records_index: 'records-index.json' }), /records-index\.json/);
  assert.throws(() => loadRecords(() => null, {}), /records-index\.json/, 'an index that names no records file fails too');
});

test('no data tree at all: no records, the empty-state build', () => {
  assert.deepEqual(loadRecords(() => null, null), []);
});

test('the Records page lists the records the build loaded', () => {
  const c = { T, plat: 'linux-x64', platName: 'Linux x64', forks: [], read: () => null, ix: {}, records: [rec] };
  assert.match(P.records(c).body, /v0\.1\.10-nightly\.20261115\.5665/);
});

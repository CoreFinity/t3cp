// Red first: Downloads links each harness version and each fixture to its public tag on the fork
// (https://github.com/navidnadali/t3code/tree/<tag>), beside its version and sha256; Methodology no longer explains
// thread sizes or a per-profile tolerance (Records still shows each record's recorded tolerance).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApp } from './lib/app-vm.mjs';
import * as P from './pages.mjs';
import { build } from './build.mjs';

const T = loadApp();
const fixtures = JSON.parse(readFileSync(new URL('../../fixture/fixtures.json', import.meta.url), 'utf8'));
const TREE = 'https://github.com/navidnadali/t3code/tree/';

test('each harness version and each fixture links its tag on the fork', () => {
  const c = {
    T, downloads: [], fixtures, eras: [], shapeFile: null,
    harness: [{ version: 't3cp-harness/2.0.1', files_sha256: 'a'.repeat(64), from: '2026-10-17', to: '2026-11-15' }],
  };
  const html = P.downloads(c).body;
  assert.match(html, new RegExp(`href="${TREE}t3cp-harness/2\\.0\\.1"`));
  for (const f of fixtures) assert.match(html, new RegExp(`href="${TREE}t3cp-fixture/${f.id}-v${f.version}"`), f.id);
});

test('Methodology says nothing about thread sizes or a per-profile tolerance', async () => {
  const out = mkdtempSync(join(tmpdir(), 't3cp-method-'));
  try {
    await build({ out, in: join(out, 'no-data-yet'), posts: 'news/posts' });
    const html = readFileSync(join(out, 'methodology/index.html'), 'utf8');
    assert.doesNotMatch(html, /idle root threads|three times larger|tolerance/i);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

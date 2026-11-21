// fixture/fixtures.json lists the scenario fixture long-thread-1 (version 1): no nightly era, built at migration 63 from
// its own input shape on the builder tag t3cp-fixture/long-thread-1-v1; every file it names is in SHA256SUMS and SIZES
// with the same sha256 and size, and the shape files it names are committed beside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixtures } from './build.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel));
const sums = Object.fromEntries(read('fixture/SHA256SUMS').toString('utf8').trim().split('\n').map((l) => l.split(/\s+/)).map(([sha, name]) => [name.replace(/^\*/, ''), sha]));
const sizes = Object.fromEntries(read('fixture/SIZES').toString('utf8').trim().split('\n').map((l) => l.split(/\s+/)).map(([bytes, name]) => [name, Number(bytes)]));

test('fixtures.json lists the scenario fixture long-thread-1 v1, with no nightly era', () => {
  const list = JSON.parse(read('fixture/fixtures.json'));
  const f = list.find((x) => x.id === 'long-thread-1');
  assert.ok(f, 'long-thread-1 is listed');
  assert.equal(f.version, 1);
  assert.equal(f.era_from, null);
  assert.equal(f.era_to, null);
  assert.equal(f.migration, 63);
  assert.deepEqual([f.sqlite.name, f.sqlite.bytes, f.sqlite.sha256], ['long-thread-1-v1.sqlite', 623276032, 'c6360a21eb36e9a00231b22b74fd1e58536dc546121bf948cd98cc03744201be']);
  assert.equal(f.zst.name, 'long-thread-1-v1.sqlite.zst');
  assert.equal(f.zst.compression, 'zstd -19 --long=31');
  assert.deepEqual([f.shape.path, f.shape.sha256], ['fixture/long-thread-1.shape.json', '16f821e3340d3fa1bb220fc8f296591d5876e50433099a02a741f308601b60e0']);
  assert.equal(f.shape_measured, 'fixture/long-thread-1-v1.shape.json');
  assert.equal(f.builder.repository, 'https://github.com/navidnadali/t3code');
  assert.equal(f.builder.tag, 't3cp-fixture/long-thread-1-v1');
  assert.match(f.builder.commit, /^[0-9a-f]{40}$/);
  assert.equal(f.builder.upstream_base, '13aa882c22d584de5388dfce3b3ca413387ba059');
  assert.match(f.recipe, /--like fixture\/long-thread-1\.shape\.json .* long-thread-1-v1\.sqlite/);
});

test('every file the long-thread-1 entry names is in SHA256SUMS and SIZES, and the committed shapes hash to them', () => {
  const f = JSON.parse(read('fixture/fixtures.json')).find((x) => x.id === 'long-thread-1');
  for (const part of [f.sqlite, f.zst]) {
    assert.equal(sums[part.name], part.sha256, part.name);
    assert.equal(sizes[part.name], part.bytes, part.name);
  }
  for (const rel of [f.shape.path, f.shape_measured]) {
    const name = rel.replace(/^fixture\//, '');
    const sha = createHash('sha256').update(read(rel)).digest('hex');
    assert.equal(sums[name], sha, `${name} in SHA256SUMS`);
    assert.equal(sizes[name], statSync(join(ROOT, rel)).size, `${name} in SIZES`);
  }
  assert.equal(createHash('sha256').update(read(f.shape.path)).digest('hex'), f.shape.sha256);
  const { fixtures } = loadFixtures(ROOT);
  const loaded = fixtures.find((x) => x.id === 'long-thread-1');
  assert.equal(loaded.input.path, 'fixture/long-thread-1.shape.json');
  assert.equal(loaded.measured.path, 'fixture/long-thread-1-v1.shape.json');
});

// Every schema-validation error printed from news/ and site/build/ names only the schema's own property names and
// array indices: an unknown or bracketed key from the checked document reads <key>, at any depth, and no value
// appears. A static guard fails when a new call site prints a raw validator path. Every name here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPostBundle } from '../site/build/release-bundle.mjs';
import { source } from '../site/build/release-fixtures/source.mjs';
import { runPost } from '../site/build/release-post.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogue = JSON.parse(readFileSync(path.join(ROOT, 'catalogue', 'catalogue.json'), 'utf8'));
const ODD = ['zorblax host 4321', 'zorblax-host', '4321', 'tag[4321]', 'zorblax4321'];
const leaks = (s) => /zorblax|4321/i.test(String(s));

test('runPost refuses a hand-made bundle with an unknown key without naming it', async () => {
  const b = buildPostBundle(source(), { catalogue });
  for (const k of ODD) {
    for (const bad of [{ ...b, [k]: 1 }, { ...b, release: { ...b.release, [k]: 1 } }]) {
      const root = mkdtempSync(path.join(tmpdir(), 'safe-errors-'));
      const r = await runPost({ bundle: bad, post: { bundle_sha256: b.bundle_sha256, summary: 'x', sections: [] }, postsDir: path.join(root, 'posts'), scanText: () => [], repoRoot: root });
      assert.equal(r.status, 'refused');
      assert.match(r.message, /does not validate against t3cp\/post-bundle\/1/);
      assert.equal(leaks(r.message), false, r.message);
    }
  }
});

test('news/check.mjs reports an invalid bundle without naming an unknown key', () => {
  const b = buildPostBundle(source(), { catalogue });
  for (const k of ODD) {
    const d = mkdtempSync(path.join(tmpdir(), 'safe-errors-cli-'));
    writeFileSync(path.join(d, 'bundle.json'), JSON.stringify({ ...b, [k]: 1, counts: { ...b.counts, [k]: 1 } }));
    writeFileSync(path.join(d, 'post.json'), JSON.stringify({ bundle_sha256: b.bundle_sha256, summary: 'x', sections: [] }));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'news', 'check.mjs'), '--bundle', path.join(d, 'bundle.json'), '--post', path.join(d, 'post.json')], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /is not a t3cp\/post-bundle\/1/);
    assert.equal(leaks(r.stderr + r.stdout), false, r.stderr);
  }
});

test('buildPostBundle refuses a source with an unknown key without naming it', () => {
  for (const k of ODD) {
    const src = source();
    src[k] = 1;
    src.metrics[0] = { ...src.metrics[0], [k]: 1 };
    assert.throws(() => buildPostBundle(src, { catalogue }), (e) => /does not validate against t3cp\/release-bundle\/1/.test(e.message) && !leaks(e.message), k);
  }
});

test('no file in news/ or site/build/ prints a raw validator path or uses formatErrors', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'release-fixtures') walk(p);
      else if (e.isFile() && /\.m?js$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'news'));
  walk(path.join(ROOT, 'site', 'build'));
  const offenders = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/\$\{\s*[A-Za-z_$][\w$]*\.path\s*\}/.test(line) || /\bformatErrors\s*\(/.test(line)) offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

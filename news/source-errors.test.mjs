// A malformed or invalid news/posts/<tag>.json never prints its text: release-post's refusal (stdout) and
// release-build's log (stderr, the publish log) name the file, an offset or a schema rule, never a fragment of
// the file, an unknown key or a value from it. Every name here is invented.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPostBundle } from '../site/build/release-bundle.mjs';
import { source } from '../site/build/release-fixtures/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogue = JSON.parse(readFileSync(path.join(ROOT, 'catalogue', 'catalogue.json'), 'utf8'));
const TAG = 'v0.1.9-perf.8';
const base = { schema: 't3cp/post-source/1', tag: TAG, status: 'retry', post: null, changelog: [] };
// Keys the validator writes in brackets ($["…"]), at the top level and nested: a space and a figure, a hyphen, a
// leading digit, brackets inside the key.
const ODD_KEYS = ['zorblax host 4321', 'zorblax-host', '4321', 'tag[4321]'];
const BAD = {
  'malformed': '{"schema": "t3cp/post-source/1", "status": "Zorbelhost answered in 98765 ms',
  'an unknown key': JSON.stringify({ ...base, Zorbelhost98765: 1 }),
  ...Object.fromEntries(ODD_KEYS.map((k) => [`the top-level key ${k}`, JSON.stringify({ ...base, [k]: 1 })])),
  ...Object.fromEntries(ODD_KEYS.map((k) => [`the nested key ${k}`, JSON.stringify({ ...base, checker: { [k]: 1 } })])),
};
const leaks = (s) => /zorbel|orbelhost|98765|zorblax|4321/i.test(s);
let inDir;

before(() => {
  const out = mkdtempSync(path.join(tmpdir(), 'source-errors-data-'));
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 't3cp', 'dev', 'synth-data.mjs'), '--out', out], { stdio: 'ignore' });
  inDir = path.join(out, 'input', 'v1');
});

test('release-post.mjs refuses a malformed or invalid source without printing any of it (stdout and stderr)', () => {
  for (const [what, text] of Object.entries(BAD)) {
    const d = mkdtempSync(path.join(tmpdir(), 'source-errors-'));
    const b = buildPostBundle(source(), { catalogue });
    writeFileSync(path.join(d, 'bundle.json'), JSON.stringify(b));
    writeFileSync(path.join(d, 'post.json'), JSON.stringify({ bundle_sha256: b.bundle_sha256, summary: `{claim:${b.claims[0].id}}.`, sections: [] }));
    mkdirSync(path.join(d, 'posts'));
    writeFileSync(path.join(d, 'posts', `${TAG}.json`), text);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'site', 'build', 'release-post.mjs'), '--bundle', path.join(d, 'bundle.json'), '--post', path.join(d, 'post.json'), '--posts', path.join(d, 'posts'), '--preview', path.join(d, 'preview.json')], { encoding: 'utf8' });
    assert.equal(leaks(r.stdout + r.stderr), false, `${what}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /refused|not valid JSON|does not validate/, what);
  }
});

test('release-build.mjs logs a malformed or invalid source without printing any of it (the publish log)', () => {
  for (const [what, text] of Object.entries(BAD)) {
    const d = mkdtempSync(path.join(tmpdir(), 'source-errors-build-'));
    mkdirSync(path.join(d, 'posts'));
    writeFileSync(path.join(d, 'posts', `${TAG}.json`), text);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'site', 'build', 'release-build.mjs'), '--in', inDir, '--out', path.join(d, 'out'), '--posts', path.join(d, 'posts'), '--dev'], { encoding: 'utf8' });
    assert.equal(leaks(r.stdout + r.stderr), false, `${what}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${TAG.replace(/\./g, '\\.')}.*(not valid JSON \\(offset \\d+\\)|does not validate)`), what);
  }
});

test('an error path names only the schema\'s own properties: bracketed keys, at any depth, read <key>', async () => {
  const { safeSourcePath } = await import('../site/build/release-post.mjs');
  for (const k of ODD_KEYS) {
    for (const p of [`$[${JSON.stringify(k)}]`, `$.checker[${JSON.stringify(k)}]`, `$.attempts[0].findings[2][${JSON.stringify(k)}]`, `$[${JSON.stringify(k)}].tag`]) {
      const safe = safeSourcePath(p);
      assert.equal(/zorblax|4321/.test(safe), false, `${p} -> ${safe}`);
    }
  }
  assert.equal(safeSourcePath('$.attempts[0].findings[2].rule'), '$.attempts[0].findings[2].rule');
  assert.equal(safeSourcePath('$.checker.zorblax4321'), '$.checker.<key>');
  assert.equal(safeSourcePath('zorblax.tag'), '<path>');
});

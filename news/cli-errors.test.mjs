// The command lines never echo a malformed post: a JSON error names the input and an offset, never its text,
// so no fragment of a refused draft reaches a terminal or a CI log. Every name here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPostBundle } from '../site/build/release-bundle.mjs';
import { source } from '../site/build/release-fixtures/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogue = JSON.parse(readFileSync(path.join(ROOT, 'catalogue', 'catalogue.json'), 'utf8'));
const MALFORMED = ['{"summary": "Zorbelhost answered in 98765 ms', '{"Zorbelhost": 98765,', '{"summary": Zorbelhost}'];

function inputs(post) {
  const d = mkdtempSync(path.join(tmpdir(), 'cli-errors-'));
  writeFileSync(path.join(d, 'bundle.json'), JSON.stringify(buildPostBundle(source(), { catalogue })));
  writeFileSync(path.join(d, 'post.json'), post);
  return d;
}
const leaks = (s) => /zorbel|orbelhost|98765|summary/i.test(s);

test('news/check.mjs: a malformed post is reported as not valid JSON with an offset, nothing of its text', () => {
  for (const post of MALFORMED) {
    const d = inputs(post);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'news', 'check.mjs'), '--bundle', path.join(d, 'bundle.json'), '--post', path.join(d, 'post.json')], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /post is not valid JSON \(offset \d+\)/);
    assert.equal(leaks(r.stderr + r.stdout), false, r.stderr);
  }
});

test('site/build/release-post.mjs: the same for a malformed post', () => {
  for (const post of MALFORMED) {
    const d = inputs(post);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'site', 'build', 'release-post.mjs'), '--bundle', path.join(d, 'bundle.json'), '--post', path.join(d, 'post.json'), '--posts', path.join(d, 'posts')], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /post is not valid JSON \(offset \d+\)/);
    assert.equal(leaks(r.stderr + r.stdout), false, r.stderr);
  }
});

// review-posts' minors on #31u. A verdict paired with any note is never a claim (fail closed: the aggregator
// never pairs them). One phrase per note across the site: the release captions use site/app.js's own NOTE
// phrases, read from app.js so the two cannot drift. The in-session way to write a post: iterate with
// news/check.mjs, record once with release-post.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTE_PHRASE, claimIndex, verdictOf } from './claims.mjs';
import { bundle } from './fixtures/bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a verdict paired with any note is never a claim', () => {
  for (const note of ['zero_reference', 'hollow', 'gated', 'context', 'no_band', 'wide_band', 'no_reference', 'no_data', 'not_comparable', 'something_new']) {
    const b = bundle();
    b.metrics = b.metrics.map((m) => (m.id === 'rss_peak_mib' && m.level === '250' ? { ...m, note, note_vs_prev: note } : m));
    const row = b.metrics.find((m) => m.id === 'rss_peak_mib' && m.level === '250');
    assert.equal(row.verdict, 'regressed');
    assert.equal(verdictOf(row, 'base'), null, note);
    assert.equal(verdictOf(row, 'prev'), null, note);
    assert.ok(!claimIndex(b).has('rss_peak_mib.linux-x64.250.base'), note);
    assert.ok(!claimIndex(b).has('rss_peak_mib.linux-x64.250.prev'), note);
  }
});

// site/app.js's NOTE map, read from its source: `const NOTE = { key: 'phrase', ... };`.
function siteNotes() {
  const src = readFileSync(path.join(ROOT, 'site', 'app.js'), 'utf8');
  const m = /const NOTE = \{([\s\S]*?)\};/.exec(src);
  assert.ok(m, 'site/app.js has a NOTE map');
  return Object.fromEntries([...m[1].matchAll(/([a-z_]+): '([^']*)'/g)].map((x) => [x[1], x[2]]));
}

test('one phrase per note: the release captions use exactly site/app.js\'s NOTE phrases', () => {
  const site = siteNotes();
  assert.deepEqual({ ...NOTE_PHRASE }, site);
  assert.equal(site.zero_reference, 'zero reference, no verdict');
});

test('release-post.mjs\'s usage says to iterate with news/check.mjs and record once', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'site', 'build', 'release-post.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /news\/check\.mjs/);
  assert.match(r.stderr, /once/);
});

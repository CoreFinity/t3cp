// review-posts' two minors on the findings fix. The checker's command line prints findings as they may be
// written (rule, field, sentence, position), never the refused text; and a failed attempt is committed without
// the hash of the refused post (a refused post of the small vocabulary could be confirmed by brute force), while
// a passing attempt keeps its hash. Identical failed answers are recognised within one run, in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPostBundle } from '../site/build/release-bundle.mjs';
import { source } from '../site/build/release-fixtures/source.mjs';
import { runPost } from '../site/build/release-post.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogue = JSON.parse(readFileSync(path.join(ROOT, 'catalogue', 'catalogue.json'), 'utf8'));
const clean = () => [];
const refused = (b, verb) => ({ bundle_sha256: b.bundle_sha256, summary: `Zorbelhost ${verb} in 98765 ms today.`, sections: [] });

test('node news/check.mjs prints findings with rule, field, sentence and position only', () => {
  const b = buildPostBundle(source(), { catalogue });
  const d = mkdtempSync(path.join(tmpdir(), 'check-cli-'));
  writeFileSync(path.join(d, 'bundle.json'), JSON.stringify(b));
  writeFileSync(path.join(d, 'post.json'), JSON.stringify(refused(b, 'answered')));
  let out;
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, 'news', 'check.mjs'), '--bundle', path.join(d, 'bundle.json'), '--post', path.join(d, 'post.json')], { encoding: 'utf8' });
  } catch (e) {
    out = String(e.stdout);
  }
  const result = JSON.parse(out);
  assert.ok(result.findings.length > 0);
  for (const f of result.findings) assert.deepEqual(Object.keys(f).filter((k) => !['rule', 'field', 'sentence', 'index'].includes(k)), [], JSON.stringify(f));
  assert.doesNotMatch(out, /98765|zorbelhost|U\+003\d/i);
});

test('a failed attempt is committed without a post hash; a passing one keeps its own', async () => {
  const b = buildPostBundle(source(), { catalogue });
  const root = mkdtempSync(path.join(tmpdir(), 'hash-'));
  const postsDir = path.join(root, 'posts');
  const first = await runPost({ bundle: b, post: refused(b, 'answered'), postsDir, scanText: clean, repoRoot: root });
  assert.equal(first.status, 'retry');
  // The same refused answer again, in the same run: recognised in memory, not counted.
  const again = await runPost({ bundle: b, post: refused(b, 'answered'), postsDir, scanText: clean, repoRoot: root });
  assert.equal(again.status, 'retry');
  assert.match(again.message, /identical to attempt 1/);
  const src = JSON.parse(readFileSync(first.file, 'utf8'));
  assert.equal(src.attempts.length, 1);
  assert.equal('post_sha256' in src.attempts[0], false);
  assert.equal('post_sha256' in src.checker, false);
  // A passing attempt keeps its hash (a correction is refused against it).
  const passing = { bundle_sha256: b.bundle_sha256, summary: `{claim:${b.claims.filter((c) => c.verdict !== 'within').sort((x, y) => y.size - x.size)[0].id}}.`, sections: [] };
  const ok = await runPost({ bundle: b, post: passing, postsDir, scanText: clean, repoRoot: root });
  if (ok.status === 'passed') {
    const after = JSON.parse(readFileSync(ok.file, 'utf8'));
    assert.match(after.checker.post_sha256, /^[0-9a-f]{64}$/);
    assert.equal('post_sha256' in after.attempts[0], false);
  }
});

// The publish gate's determinism check: two builds must be byte-identical; a build whose second run differs (a planted
// timestamp) is refused before deploy, and the site build itself is deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareTrees } from './same-tree.mjs';
import { build } from './build.mjs';

const CLI = fileURLToPath(new URL('./same-tree.mjs', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 't3cp-same-'));

test('two builds of the same inputs are byte-identical', async () => {
  const a = tmp(), b = tmp();
  try {
    await build({ out: a, in: join(a, 'no-data-yet'), posts: 'news/posts' });
    await build({ out: b, in: join(b, 'no-data-yet'), posts: 'news/posts' });
    const r = compareTrees(a, b);
    assert.deepEqual(r.differ, []);
    assert.deepEqual(r.onlyA, []);
    assert.deepEqual(r.onlyB, []);
    assert.ok(r.files > 100, `compared ${r.files} files`);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('a planted timestamp in the second build is refused (exit 1, the file named)', async () => {
  const a = tmp(), b = tmp();
  try {
    await build({ out: a, in: join(a, 'no-data-yet'), posts: 'news/posts' });
    await build({ out: b, in: join(b, 'no-data-yet'), posts: 'news/posts' });
    const f = join(b, 'about', 'index.html');
    writeFileSync(f, readFileSync(f, 'utf8').replace('</footer>', `<!-- built ${new Date().toISOString()} --></footer>`));
    writeFileSync(join(b, 'stray.txt'), 'only in b');
    const r = spawnSync(process.execPath, [CLI, a, b], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /differ: about\/index\.html/);
    assert.match(r.stdout + r.stderr, /only in .*: stray\.txt/);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

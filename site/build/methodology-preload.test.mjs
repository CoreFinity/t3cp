// Red first: Methodology says how a record's preload_sha256 is computed, as the record schema describes it
// (tools/t3cp/lib/schemas.mjs): run.ts's own identity of its event-loop preload, the sha256 over the lines
// '<file name>\0<sha256 of the file>\n' for tools/server-bench/preload/bench-preload.cjs and then bench-preload.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from './build.mjs';

test('Methodology names preload_sha256, its method and both preload files, in order', async () => {
  const out = mkdtempSync(join(tmpdir(), 't3cp-preload-'));
  try {
    await build({ out: join(out, 'dist'), in: join(out, 'no-data-yet'), posts: 'news/posts' });
    const html = readFileSync(join(out, 'dist/methodology/index.html'), 'utf8');
    const p = html.split('<p>').find(x => x.includes('preload_sha256')) || '';
    assert.ok(p, 'a paragraph names preload_sha256');
    assert.match(p, /<code>&lt;file name&gt;\\0&lt;sha256 of the file&gt;\\n<\/code>/, 'the line format');
    const cjs = p.indexOf('tools/server-bench/preload/bench-preload.cjs'), mjs = p.indexOf('bench-preload.mjs');
    assert.ok(cjs >= 0 && mjs > cjs, 'bench-preload.cjs, then bench-preload.mjs');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// The prose pages take their figures from the repository's files, never from text typed by hand: the fixture's
// counts on About and Methodology come from fixture/public-large.shape.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from './build.mjs';

const shape = JSON.parse(readFileSync(new URL('../../fixture/public-large.shape.json', import.meta.url), 'utf8'));
const count = id => shape.tables[id].rows.toLocaleString('en-GB');

test('About and Methodology state the fixture counts from the shape file', async () => {
  const out = mkdtempSync(join(tmpdir(), 't3cp-pages-'));
  try {
    await build({ out, in: join(out, 'no-data-yet'), posts: 'news/posts' });
    const about = readFileSync(join(out, 'about/index.html'), 'utf8'), method = readFileSync(join(out, 'methodology/index.html'), 'utf8');
    for (const [id, what] of [['orchestration_v2_projection_threads', 'threads'], ['orchestration_v2_projection_turn_items', 'turn items']]) {
      assert.match(about, new RegExp(`${count(id)} ${what}`), `About: ${what}`);
      assert.match(method, new RegExp(`${count(id)} ${what}`), `Methodology: ${what}`);
    }
    assert.match(method, new RegExp(`${count('orchestration_events')} events`));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

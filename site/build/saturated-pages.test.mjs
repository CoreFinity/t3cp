// Red first: Records shows each saturated level of a record with "n of N agents served" and the symptoms in the
// flag's tooltip; Methodology and About describe the final load profile (real3), saturation, the compaction
// schedule era and the two sources of event-loop delay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApp } from './lib/app-vm.mjs';
import { record } from './lib/test-data.mjs';
import * as P from './pages.mjs';
import { build } from './build.mjs';

const T = loadApp();

test('Records flags a saturated level with n of N served and its symptoms', () => {
  const rec = record({ date: '2026-11-10', values: { agents_served: 210 } });
  rec.cells['250'] = rec.cells['100']; delete rec.cells['100'];
  Object.assign(rec.cells['250'], { saturated: true, agents_total: 250, attempts: [{ n: 1, valid: true, saturated: true, saturated_by: ['call_timeouts'], agents_total: 250 }] });
  rec.workload = { cells: {} };
  const path = 'records/linux-x64/2026-11-10.v0.1.9-nightly.20261110.4001.json';
  const c = {
    T, plat: 'linux-x64', platName: 'Linux x64', forks: [], read: p => (p === path ? rec : null), ix: {},
    records: [{ date: '2026-11-10', tag: rec.release.tag, sha: '0'.repeat(40), platforms: { 'linux-x64': { record_id: rec.record_id, status: 'complete', path } } }],
  };
  const html = P.records(c).body;
  assert.match(html, /250 agents: 210 of 250 served/);
  assert.match(html, /title="[^"]*calls timed out[^"]*"/);
});

test('Methodology and About describe real3, saturation, the compaction era and the two loop-delay sources', async () => {
  const out = mkdtempSync(join(tmpdir(), 't3cp-real3-'));
  try {
    await build({ out, in: join(out, 'no-data-yet'), posts: 'news/posts' });
    const method = readFileSync(join(out, 'methodology/index.html'), 'utf8'), about = readFileSync(join(out, 'about/index.html'), 'utf8');
    for (const html of [method, about]) {
      assert.match(html, /3 people watching live, switching threads every 300 s/);
      assert.match(html, /may saturate/);
    }
    assert.match(method, /n of N agents served/);
    assert.match(method, /compaction schedule/);
    assert.match(method, /preload histogram/);
    assert.match(method, /server's own gauge/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

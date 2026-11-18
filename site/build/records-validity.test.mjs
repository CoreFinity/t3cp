// Red first: the Records page shows, for a record whose levels did not all run every attempt valid, how many were
// valid at each such level, read from the record file at build time (no cause is claimed). Inputs are hand-made
// synthetic records (tools/t3cp/lib/fake.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildOutputs } from './aggregate.mjs';
import { build } from './build.mjs';
import { mergeRecord } from '../../tools/t3cp/merge.mjs';
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from '../../tools/t3cp/lib/fake.mjs';
import { loadCatalogue } from '../../tools/t3cp/lib/repo.mjs';

const catalogue = loadCatalogue();
const txt = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/ ([.,;:)])/g, '$1').trim();

test('Records: per-level validity where a level had invalid attempts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3cp-validity-'));
  try {
    const input = path.join(root, 'input', 'v1');
    // 2 Nov: every attempt valid. 3 Nov: 100 and 150 agents no valid attempt, 200 agents two of three.
    const bad = { '2026-11-03': (cell, n) => cell === '100' || cell === '150' || (cell === '200' && n === 1) };
    for (const date of ['2026-11-02', '2026-11-03']) {
      const identity = fakeIdentity({ date }), inv = bad[date] || (() => false);
      const r = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0, attempt: (cell, n) => (inv(cell, n) ? { valid: false, problems: ['driver_failed'] } : {}) }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
      const f = path.join(input, 'records', r.platform.id, `${r.release.date}.${r.release.tag}.json`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `${JSON.stringify(r)}\n`);
    }
    fs.writeFileSync(path.join(input, 'bands.json'), JSON.stringify({ schema: 't3cp/bands/1', method: 'validity', platforms: { 'linux-x64': { pending: true }, 'darwin-arm64': { pending: true } } }));
    for (const [rel, bytes] of buildOutputs(input, { publicRefs: FAKE_PUBLIC_REFS, warn: () => {} })) {
      const f = path.join(root, 'v1', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes);
    }
    await build({ out: path.join(root, 'dist'), dev: root, posts: 'news/posts' });
    const html = fs.readFileSync(path.join(root, 'dist', 'records', 'index.html'), 'utf8');
    const row = d => txt((html.split('<tr>').find(r => r.includes(`<td>${d}</td>`)) || '').split('</tr>')[0]);
    assert.match(row('3 Nov 2026'), /0\/3 valid at 100 and 150 agents; 2\/3 valid at 200 agents/);
    assert.doesNotMatch(row('2 Nov 2026'), /valid at/, 'a record with every attempt valid says nothing');
    assert.doesNotMatch(html, /crash|driver/i, 'no cause is claimed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

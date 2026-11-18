// Red first, from the review of the measured-failure change:
// - the Records page shows per-level validity on fork release rows too, not only on nightly rows;
// - the static homepage names a failure on the first nightly even when no headline has a value and nightlies of the
//   window are still to be measured (the pending sentence then moves under "What changed", said once).
// Inputs are hand-made synthetic records (tools/t3cp/lib/fake.mjs) and a stub context.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildOutputs } from './aggregate.mjs';
import { build } from './build.mjs';
import * as P from './pages.mjs';
import { loadApp } from './lib/app-vm.mjs';
import { mergeRecord } from '../../tools/t3cp/merge.mjs';
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from '../../tools/t3cp/lib/fake.mjs';
import { loadCatalogue } from '../../tools/t3cp/lib/repo.mjs';

const catalogue = loadCatalogue();
const txt = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/ ([.,;:)])/g, '$1').trim();

test('Records: a fork release row shows its per-level validity', () => {
  const T = loadApp();
  const cells = { 1: { valid: 3, total: 3 }, 100: { valid: 0, total: 3 }, 150: { valid: 0, total: 3 } };
  const c = {
    T, plat: 'linux-x64', platName: 'Linux x64', pending: null, records: [],
    forks: [{ tag: 'v0.0.1-perf.1', date: '2026-11-04', sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), platforms: { 'linux-x64': { path: 'fork/f.json', status: 'partial' } } }],
    read: p => (p === 'fork/f.json' ? { status: 'partial', status_reason: 'attempts_invalid', cells } : null),
  };
  const html = P.records(c).body, row = txt((html.split('<tr>').find(r => r.includes('v0.0.1-perf.1')) || '').split('</tr>')[0]);
  assert.match(row, /partial attempts_invalid 0\/3 valid at 100 and 150 agents/);
});

test('the static homepage names a failure on the first nightly when no headline has a value', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3cp-fail-static-'));
  try {
    const input = path.join(root, 'input', 'v1'), date = '2026-11-02', identity = fakeIdentity({ date });
    const r = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0, attempt: cell => (cell === '50' ? { valid: false, problems: ['driver_failed'] } : {}) }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
    // No headline value at all at 50 agents: the record-scope headline's extra timed out too.
    for (const part of ['fixture', 'empty']) if (r.extras[part] && r.extras[part].metrics.db_ready_warm_ms) r.extras[part].metrics.db_ready_warm_ms = { median: null, min: null, max: null, n: 0, values: [null, null, null], reason: 'extra_timeout' };
    const f = path.join(input, 'records', r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(r)}\n`);
    fs.writeFileSync(path.join(input, 'bands.json'), JSON.stringify({ schema: 't3cp/bands/1', method: 'fail', platforms: { 'linux-x64': { pending: true }, 'darwin-arm64': { pending: true } } }));
    for (const [rel, bytes] of buildOutputs(input, { publicRefs: FAKE_PUBLIC_REFS, warn: () => {} })) {
      const o = path.join(root, 'v1', rel); fs.mkdirSync(path.dirname(o), { recursive: true }); fs.writeFileSync(o, bytes);
    }
    await build({ out: path.join(root, 'dist'), dev: root, posts: 'news/posts' });
    const html = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8'), main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    assert.equal(txt((/<p[^>]*id="sline"[^>]*>([^]*?)<\/p>/.exec(main) || [])[1] || ''), 'Nightly 2 Nov 2026, 50 agents: failed, no valid attempt.');
    const changed = (/<summary>What changed<\/summary>([^]*?)<\/details>/.exec(main) || [])[1] || '';
    assert.match(txt(changed), /Nightlies from 17 Oct to 1 Nov 2026 are still to be measured/, 'the pending sentence moves under What changed');
    assert.equal((main.match(/still to be measured/g) || []).length, 1, 'said once');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Red first: four gaps found while checking the built site against its acceptance criteria. Records shows the reason
// code of a record that is not complete; Downloads serves every fixture shape file with its size and the sha256 that
// fixture/SHA256SUMS lists; every chart in a release post has a table view, rendered by the build; and while macOS is
// hidden the built pages name it only in Methodology's one sentence and in catalogue definitions (which say how a
// metric is measured, not that macOS records exist).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApp } from './lib/app-vm.mjs';
import { dates, forkOf, level, record, shard } from './lib/test-data.mjs';
import * as P from './pages.mjs';
import * as B from './build.mjs';

const T = loadApp();
const cat = JSON.parse(readFileSync(new URL('../../catalogue/catalogue.json', import.meta.url), 'utf8'));
const fixtureDir = new URL('../../fixture/', import.meta.url);
const sums = Object.fromEntries(readFileSync(new URL('SHA256SUMS', fixtureDir), 'utf8').split('\n').filter(Boolean).map(l => { const [h, n] = l.trim().split(/\s+/); return [n.replace(/^\*/, ''), h]; }));
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const htmlFiles = dir => readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.html')).map(f => join(dir, f));

async function built(cfg) {
  const out = mkdtempSync(join(tmpdir(), 't3cp-launch-'));
  const o = { out: join(out, 'dist'), in: join(out, 'no-data-yet'), posts: 'news/posts' };
  if (cfg) { o.config = join(out, 'config.json'); writeFileSync(o.config, JSON.stringify(cfg)); }
  await B.build(o);
  return { dist: o.out, done: () => rmSync(out, { recursive: true, force: true }) };
}

test('Records shows the reason code of a record that is not complete, and none for a complete one', () => {
  const partial = record({ date: '2026-10-25' }), complete = record({ date: '2026-10-26' }), fork = record({ kind: 'fork', tag: 'v0.1.9-perf.8', date: '2026-11-15' });
  Object.assign(partial, { status: 'partial', status_reason: 'attempts_invalid' });
  Object.assign(fork, { status: 'partial', status_reason: 'build_failed' });
  const files = { 'records/linux-x64/a.json': partial, 'records/linux-x64/b.json': complete, 'fork/v0.1.9-perf.8.linux-x64.json': fork };
  const row = (r, path, status) => ({ date: r.release.date, tag: r.release.tag, sha: '0'.repeat(40), platforms: { 'linux-x64': { record_id: r.record_id, status, path } } });
  const c = {
    T, plat: 'linux-x64', platName: 'Linux x64', ix: {}, read: p => files[p] || null,
    records: [row(partial, 'records/linux-x64/a.json', 'partial'), row(complete, 'records/linux-x64/b.json', 'complete')],
    forks: [{ tag: 'v0.1.9-perf.8', date: '2026-11-15', sha: '1'.repeat(40), base_sha: '2'.repeat(40), platforms: { 'linux-x64': { status: 'partial', path: 'fork/v0.1.9-perf.8.linux-x64.json' } } }],
  };
  const rows = P.records(c).body.split('<tr>');
  const rowOf = s => rows.find(r => r.includes(s)) || '';
  assert.match(rowOf('25 Oct 2026'), /partial[\s\S]*attempts_invalid/);
  assert.doesNotMatch(rowOf('26 Oct 2026'), /attempts_invalid|build_failed/);
  assert.match(rowOf('v0.1.9-perf.8'), /partial[\s\S]*build_failed/);
});

test('Downloads serves every fixture shape file with its size and the sha256 fixture/SHA256SUMS lists', async () => {
  const b = await built();
  try {
    const dl = readFileSync(join(b.dist, 'downloads/index.html'), 'utf8');
    const shapes = Object.keys(sums).filter(n => n.endsWith('.shape.json'));
    assert.ok(shapes.length >= 3, `shape files in SHA256SUMS: ${shapes.join(', ')}`);
    for (const n of shapes) {
      const src = readFileSync(new URL(n, fixtureDir));
      assert.ok(existsSync(join(b.dist, 'fixture', n)), `${n} is served`);
      assert.deepEqual(readFileSync(join(b.dist, 'fixture', n)), src, `${n} is served unchanged`);
      assert.match(dl, new RegExp(`href="/fixture/${escRe(n)}"`), `${n} is linked`);
      assert.match(dl, new RegExp(`${escRe(src.length.toLocaleString('en-GB'))} bytes`), `${n} has its size`);
      assert.match(dl, new RegExp(sums[n]), `${n} has the sha256 SHA256SUMS lists`);
    }
  } finally { b.done(); }
});

test('a fixture file that disagrees with fixture/SHA256SUMS is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 't3cp-sums-'));
  try {
    mkdirSync(join(root, 'fixture'));
    writeFileSync(join(root, 'fixture/x.shape.json'), '{"tables":{}}\n');
    const good = createHash('sha256').update('{"tables":{}}\n').digest('hex');
    assert.equal(typeof B.fixtureFile, 'function', 'build.mjs exports fixtureFile');
    assert.deepEqual(B.fixtureFile(root, 'fixture/x.shape.json', { 'x.shape.json': good }), { path: 'fixture/x.shape.json', bytes: 14, sha256: good });
    assert.throws(() => B.fixtureFile(root, 'fixture/x.shape.json', { 'x.shape.json': 'f'.repeat(64) }), /x\.shape\.json[\s\S]*SHA256SUMS/);
    assert.equal(B.fixtureFile(root, 'fixture/absent.shape.json', {}), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every chart in a release post has a table view, rendered by the build', () => {
  const n = 12, ids = cat.headlines['linux-x64'], ds = dates(n);
  const vals = k => Array.from({ length: n }, (_, i) => 100 + k + i);
  const fk = forkOf(n, [{ tag: 'v0.1.9-perf.7', i: 5, v: 90, vp: null, vpv: null }, { tag: 'v0.1.9-perf.8', i: 10, v: 80, vp: -11.1, vpv: 'improved' }]);
  const shards = Object.fromEntries(ids.concat(['agents_served']).map((id, k) => [id, shard(id, { 1: level(vals(k)), 100: level(vals(k)), 250: level(vals(k)), once: level(vals(k)) }, { n, fork: { ...fk, levels: { 1: fk.levels['100'], 100: fk.levels['100'], 250: fk.levels['100'], once: fk.levels['100'] } } })]));
  const chartsOnly = { schema: 't3cp/release/1', tag: 'v0.1.9-perf.8', date: ds[10], base: { tag: null, date: ds[9], sha: null, sha7: null }, charts_only: true, charts_only_reason: 'no_text_yet', deltas: [], changelog: [], checker: { passed: null } };
  const text = {
    ...chartsOnly, tag: 'v0.1.9-perf.7', date: ds[5], charts_only: false, charts_only_reason: null,
    post: { title: 'perf.7', summary: 's', quotes: [], sections: [{ chart_id: 'series.turn_p50_ms.linux-x64', caption: 'a' }, { chart_id: 'fork-vs-prev.turn_p50_ms.linux-x64', caption: 'b' }, { chart_id: 'series.turn_p50_ms.ladder.linux-x64', caption: 'c' }] },
    checker: { passed: true, numbers_checked: 3, charts: 3, findings: [], footer: 'Text written from the record and checked against it: 3 numbers, 3 charts, 0 findings.' },
  };
  const rels = { 'v0.1.9-perf.8': chartsOnly, 'v0.1.9-perf.7': text };
  const c = {
    T, plat: 'linux-x64', platName: 'Linux x64', catalogue: cat.metrics, headlines: ids, log: () => {}, ix: { compare: [] }, read: () => null,
    forks: [{ tag: 'v0.1.9-perf.7', date: ds[5], platforms: { 'linux-x64': {} } }, { tag: 'v0.1.9-perf.8', date: ds[10], platforms: { 'linux-x64': {} } }],
    release: t => rels[t] || null, shard: id => shards[id] || null,
  };
  const fr = P.releaseFragments(c);
  assert.equal(fr.files.length, 8); // two releases at the four headline levels
  for (const f of fr.files) {
    const plots = f.html.match(/data-chart="[^"]+"/g) || [];
    assert.ok(plots.length >= 3, `${f.path}: ${plots.length} charts`);
    const tabled = f.html.match(/data-chart="[^"]+"><\/div><details class="ctab"><summary>[^<]+<\/summary><div class="tw"><table>[\s\S]*?<\/table><\/div><\/details>/g) || [];
    assert.equal(tabled.length, plots.length, `${f.path}: every chart is followed by its table`);
  }
  const lead = fr.files.find(f => f.path.startsWith('releases/v0.1.9-perf.8/100.')).html;
  assert.match(lead, new RegExp(`<td class="n">${escRe(T.fmtU(100 + n - 1, cat.metrics.find(m => m.id === ids[0])))}</td>`), 'the first chart\'s table holds its latest median');
  const post = fr.files.find(f => f.path.startsWith('releases/v0.1.9-perf.7/100.')).html;
  assert.match(post, /<th>Release<\/th>[\s\S]*perf\.8/, 'the release-to-release chart lists the releases');
  assert.match(post, /<th>Agents<\/th>/, 'the ladder chart lists the levels');
  assert.match(P.releases(c, fr.hash).body, /<details class="ctab">/, 'the page\'s own lead post carries the tables too');
});

test('while macOS is hidden, the built pages name it only in Methodology\'s one sentence and in catalogue definitions', async () => {
  const b = await built();
  try {
    const defs = cat.metrics.map(m => m.definition).filter(d => /macOS/.test(d));
    const strip = s => defs.reduce((t, d) => t.split(d).join('').split(T.esc(d)).join(''), s);
    const hits = {};
    for (const f of htmlFiles(b.dist)) { const n = (strip(readFileSync(f, 'utf8')).match(/macOS/g) || []).length; if (n) hits[f.slice(b.dist.length + 1)] = n; }
    assert.deepEqual(hits, { 'methodology/index.html': 1 });
  } finally { b.done(); }
});

test('with macOS shown, its notes come back on the metric pages, Compare and About', async () => {
  const b = await built({ site_url: 'https://t3cp.io', macos: 'show', link_repository: false, analytics: { plausible_script: '', cloudflare_beacon_token: '', cloudflare_pages_injected: false } });
  try {
    const read = p => readFileSync(join(b.dist, p), 'utf8');
    assert.match(read('metrics/turn_p50_ms/index.html'), /<dt>Platforms<\/dt><dd>[^<]*macOS/);
    assert.match(read('metrics/index.html'), /<td class="hs">Linux, macOS<\/td>/);
    assert.match(read('compare/index.html'), /Linux against macOS shows ratios only/);
    assert.match(read('about/index.html'), /macOS/);
  } finally { b.done(); }
});

// Red first: the pages around the fork's second line. With fork-head records the overview and the metric pages say
// "When upstream merges a fix, the lines meet." beside the chart, the legend names the lines "Upstream nightly" and
// "Performance fork", and the Records page lists each fork-head record with the nightly it was paired with. With none,
// every page is as before. Inputs are hand-made synthetic records (tools/t3cp/lib/fake.mjs).
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
const TAG = 'v0.1.9-perf.9', CAPTION = 'When upstream merges a fix, the lines meet.';
const merged = identity => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0 }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${identity.release.date}T18:00:00Z` });
const DATES = ['2026-11-14', '2026-11-15', '2026-11-16'];
const nightlies = DATES.map(d => merged(fakeIdentity({ date: d })));
const base = { tag: nightlies[0].release.tag, date: nightlies[0].release.date, sha: nightlies[0].release.sha };
const release = merged(fakeIdentity({ date: '2026-11-14', kind: 'fork', tag: TAG, base }));
const head = D => { const id = fakeIdentity({ date: '2026-11-14', kind: 'fork', tag: TAG, base }); id.record_id = `${D}.linux-x64.fork`; id.paired_nightly = { tag: nightlies[DATES.indexOf(D)].release.tag, date: D }; return merged(id); };

async function site(withHeads) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3cp-forkhead-pages-'));
  const input = path.join(root, 'input', 'v1');
  const put = (rel, value) => { const f = path.join(input, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(value)}\n`); };
  for (const r of nightlies) put(`records/linux-x64/${r.release.date}.${r.release.tag}.json`, r);
  put(`fork/${TAG}.linux-x64.json`, release);
  if (withHeads) for (const D of DATES.slice(1)) { const h = head(D); put(`fork-nightly/linux-x64/${D}.${TAG}.json`, h); }
  put('bands.json', { schema: 't3cp/bands/1', method: 'fork-head', platforms: { 'linux-x64': { pending: true }, 'darwin-arm64': { pending: true } } });
  for (const [rel, bytes] of buildOutputs(input, { publicRefs: FAKE_PUBLIC_REFS, warn: () => {} })) {
    const f = path.join(root, 'v1', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes);
  }
  const dist = path.join(root, 'dist');
  await build({ out: dist, dev: root, posts: 'news/posts' });
  const read = p => fs.readFileSync(path.join(dist, p), 'utf8');
  const pages = { home: read('index.html'), metric: read('metrics/turn_p50_ms/index.html'), records: read('records/index.html') };
  fs.rmSync(root, { recursive: true, force: true });
  return pages;
}

test('with fork-head records: the caption beside the charts, the lines named, the Records page lists them', async () => {
  const p = await site(true);
  for (const [name, html] of [['overview', p.home], ['metric page', p.metric]]) {
    const main = html.slice(html.indexOf('<main'));
    assert.ok(txt(main).includes(CAPTION), `${name}: the caption`);
    const lg = txt(main.slice(main.indexOf('<div class="lg"><span')).split('</div>')[0]);
    assert.match(lg, /^Upstream nightly Performance fork /, `${name}: the legend names the lines`);
  }
  const home = p.home.slice(p.home.indexOf('<main'));
  const before = home.slice(0, home.indexOf('<details'));
  assert.ok(txt(before).includes(CAPTION), 'the caption is visible under the graph, not behind a toggle');
  const sec = p.records.slice(p.records.indexOf('<h2>The fork, measured each night.</h2>'));
  assert.ok(p.records.includes('<h2>The fork, measured each night.</h2>'), 'a Records section');
  const rows = sec.split('</table>')[0].split('<tr>').slice(2).map(r => txt(r.split('</tr>')[0]));
  assert.equal(rows.length, 2, 'one row per fork-head record');
  assert.match(rows[0], new RegExp(`^16 Nov 2026 ${TAG.replace(/\./g, '\\.')} ${nightlies[2].release.tag.replace(/\./g, '\\.')} complete JSON$`));
  assert.match(sec, new RegExp(`href="/data/v1/fork-nightly/linux-x64/2026-11-16\\.${TAG.replace(/\./g, '\\.')}\\.json"`));
});

test('without fork-head records every page is as before: no caption, the lines named as now, no Records section', async () => {
  const p = await site(false);
  for (const html of [p.home, p.metric]) {
    assert.ok(!html.includes(CAPTION));
    const main = html.slice(html.indexOf('<main'));
    assert.match(txt(main.slice(main.indexOf('<div class="lg"><span')).split('</div>')[0]), /^Nightly Fork release /);
  }
  assert.ok(!p.records.includes('measured each night'));
});

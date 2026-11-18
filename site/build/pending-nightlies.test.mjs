// Red first: the site says which nightlies of the window are still to be measured, and claims no date before its
// first published record. When the first record comes after the catalogue's window_start (the launch may go out
// with 2 Nov onwards), the overview, the Records lede and every metric page carry one data-derived sentence, and
// "Recorded from" is the later of the metric's era start and the first record; the sentence disappears once the
// window's first nightly is published. An era of the fixture list with no published record says so, and the
// compaction schedule era is described only when one of its (unscheduled) nightlies is published.
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
const txt = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// A site built from nightlies on the given dates (fake records, aggregated by the aggregator itself).
async function site(dates) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3cp-pending-'));
  const input = path.join(root, 'input', 'v1');
  for (const date of dates) {
    const identity = fakeIdentity({ date });
    const r = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0 }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
    const f = path.join(input, 'records', r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify(r)}\n`);
  }
  fs.writeFileSync(path.join(input, 'bands.json'), JSON.stringify({ schema: 't3cp/bands/1', method: 'pending', platforms: { 'linux-x64': { pending: true }, 'darwin-arm64': { pending: true } } }));
  for (const [rel, bytes] of buildOutputs(input, { publicRefs: FAKE_PUBLIC_REFS, warn: () => {} })) {
    const f = path.join(root, 'v1', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes);
  }
  const dist = path.join(root, 'dist');
  await build({ out: dist, dev: root, posts: 'news/posts' });
  return { read: p => fs.readFileSync(path.join(dist, p), 'utf8'), all: () => fs.readdirSync(dist, { recursive: true }).filter(f => f.endsWith('.html')).map(f => fs.readFileSync(path.join(dist, f), 'utf8')), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const recordedFrom = html => (/<dt>Recorded from<\/dt><dd>([^<]*)/.exec(html) || [])[1] || '';
const catalogueFrom = (html, id) => (new RegExp(`<code class="dim">${id}</code></td><td>[^<]*</td><td>[^<]*</td><td class="n">[^<]*</td><td class="hs">([^<]*)</td>`).exec(html) || [])[1];
const SENTENCE = 'Nightlies from 17 Oct to 1 Nov 2026 are still to be measured; the series start on 2 Nov.';

test('launch shape (2 Nov onwards): the sentence on the overview, Records and metric pages; nothing dated before 2 Nov', async () => {
  const s = await site(['2026-11-02', '2026-11-03']);
  try {
    assert.ok(txt(s.read('index.html')).includes(SENTENCE), 'overview');
    assert.ok(txt(s.read('records/index.html')).includes(SENTENCE), 'Records');
    const metric = s.read('metrics/turn_p50_ms/index.html');
    assert.ok(txt(metric).includes(SENTENCE), 'metric page');
    assert.match(recordedFrom(metric), /^2 Nov 2026/, 'Recorded from follows the first record');
    assert.equal(catalogueFrom(s.read('metrics/index.html'), 'turn_p50_ms'), '2 Nov', 'the catalogue table too');
    const dl = s.read('downloads/index.html'), section = id => (dl.split(`<h2>${id}.</h2>`)[1] || '').split('</section>')[0];
    assert.match(txt(section('large-63')), /still to be measured/, 'an era with no published record says so');
    assert.doesNotMatch(txt(section('large-76')), /still to be measured/, 'an era with records does not');
    assert.doesNotMatch(txt(s.read('methodology/index.html')), /form their own era/, 'no compaction era sentence without an unscheduled nightly published');
  } finally { s.done(); }
});

test('window covered (17 Oct onwards): no sentence anywhere, and Recorded from is the era start', async () => {
  const s = await site(['2026-10-17', '2026-11-02']);
  try {
    for (const html of s.all()) assert.doesNotMatch(txt(html), /still to be measured/);
    assert.match(recordedFrom(s.read('metrics/turn_p50_ms/index.html')), /^17 Oct 2026/);
  } finally { s.done(); }
});

test('no record at all: the sentence says the whole window is still to be measured', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3cp-pending-none-'));
  try {
    await build({ out: path.join(root, 'dist'), in: path.join(root, 'no-data-yet'), posts: 'news/posts' });
    const read = p => txt(fs.readFileSync(path.join(root, 'dist', p), 'utf8'));
    for (const p of ['index.html', 'records/index.html', 'metrics/turn_p50_ms/index.html']) assert.ok(read(p).includes('Nightlies from 17 Oct 2026 onwards are still to be measured.'), p);
    assert.match(read('methodology/index.html'), /large-63 : nightlies from 17 Oct 2026 to 30 Oct 2026[^.]*still to be measured/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

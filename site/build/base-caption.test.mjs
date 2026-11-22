// Red first: the base caption. When a fork release's upstream base is a release whose version (from the base record,
// not the fork record's base tag) differs from the fork version's numeric prefix, the pages that show the fork release
// beside its base say why, in one fixed sentence filled from the data:
// "Base <version> is upstream's <tag> release commit (<sha12>). Fork releases built on it are named <prefix>-perf.N
// because their version comes from the code's manifest, which still read <prefix> at that commit."
// - Releases: under each such release's header line (the lead post and every fragment);
// - Overview: under the fork table when the release it shows is such a release;
// - Records: under the fork releases table, once per distinct base.
// A release whose base has its own version (0.1.9-perf.9 on base 0.1.9) gets none. Static HTML, no script.
// Inputs are hand-made synthetic records (tools/t3cp/lib/fake.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildOutputs } from './aggregate.mjs';
import { build } from './build.mjs';
import { mergeRecord } from '../../tools/t3cp/merge.mjs';
import { FAKE_PUBLIC_REFS, fakeAttempts, fakeExtras, fakeIdentity } from '../../tools/t3cp/lib/fake.mjs';
import { loadCatalogue } from '../../tools/t3cp/lib/repo.mjs';

const catalogue = loadCatalogue();
const txt = s => s.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ').replace(/ ([.,;:)])/g, '$1').trim();
const merged = identity => mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0 }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${identity.release.date}T18:00:00Z` });
const SHA_9 = 'a'.repeat(40), SHA_10 = 'b'.repeat(40);
const CAPTION = "Base 0.1.10 is upstream's v0.1.10 release commit (bbbbbbbbbbbb). Fork releases built on it are named 0.1.9-perf.N because their version comes from the code's manifest, which still read 0.1.9 at that commit.";

async function site(forkTags) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3cp-base-caption-'));
  const input = path.join(root, 'input', 'v1'), posts = path.join(root, 'posts');
  fs.mkdirSync(posts, { recursive: true });
  const put = (rel, value) => { const f = path.join(input, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(value)}\n`); };
  const nightlies = ['2026-11-14', '2026-11-15', '2026-11-16'].map(date => merged(fakeIdentity({ date })));
  for (const r of nightlies) put(`records/linux-x64/${r.release.date}.${r.release.tag}.json`, r);
  // Two upstream bases: release v0.1.9 (the nightly of 15 Nov's commit) and release v0.1.10 (16 Nov's).
  const bases = { [SHA_9]: merged(fakeIdentity({ date: '2026-11-15', kind: 'base', sha: SHA_9, tag: 'v0.1.9' })), [SHA_10]: merged(fakeIdentity({ date: '2026-11-16', kind: 'base', sha: SHA_10, tag: 'v0.1.10' })) };
  for (const r of Object.values(bases)) put(`base/${r.release.sha.slice(0, 12)}.linux-x64.json`, r);
  // perf.9 on the v0.1.9 base; perf.10 and perf.11 on the v0.1.10 base. A fork record's base names the nightly tag.
  const ON = { 'v0.1.9-perf.9': [SHA_9, nightlies[1]], 'v0.1.9-perf.10': [SHA_10, nightlies[2]], 'v0.1.9-perf.11': [SHA_10, nightlies[2]] };
  forkTags.forEach((tag, k) => {
    const [sha, n] = ON[tag];
    const r = merged(fakeIdentity({ date: `2026-11-${17 + k}`, kind: 'fork', tag, base: { tag: n.release.tag, date: n.release.date, sha } }));
    put(`fork/${tag}.linux-x64.json`, r);
  });
  put('bands.json', { schema: 't3cp/bands/1', method: 'base caption', platforms: { 'linux-x64': { pending: true }, 'darwin-arm64': { pending: true } } });
  for (const [rel, bytes] of buildOutputs(input, { publicRefs: FAKE_PUBLIC_REFS, warn: () => {} })) {
    const f = path.join(root, 'v1', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes);
  }
  const dist = path.join(root, 'dist');
  await build({ out: dist, dev: root, posts, 'dev-releases': posts });
  const read = p => fs.readFileSync(path.join(dist, p), 'utf8');
  const main = p => { const h = read(p); return h.slice(h.indexOf('<main'), h.indexOf('</main>')); };
  // Every release fragment of a tag (one per headline level).
  const fragments = tag => fs.readdirSync(path.join(dist, 'releases', tag)).filter(f => f.endsWith('.html')).map(f => fs.readFileSync(path.join(dist, 'releases', tag, f), 'utf8'));
  const result = { read, main, fragments };
  return Object.assign(result, { done: () => fs.rmSync(root, { recursive: true, force: true }) });
}
const count = (html, s) => txt(html).split(s).length - 1;

test('a fork release on a base whose version is ahead of its own: the caption on Releases, the Overview and Records', async () => {
  const s = await site(['v0.1.9-perf.9', 'v0.1.9-perf.10', 'v0.1.9-perf.11']);
  try {
    // Releases: the lead release (perf.11) and every fragment of perf.10 and perf.11, under the header line.
    const rel = s.main('releases/index.html');
    assert.equal(count(rel, CAPTION), 1, 'the lead release shows it once');
    const head = (/<div id="rhead">([^]*?)<\/div>/.exec(rel) || [])[1] || '';
    assert.ok(txt(head).includes(CAPTION), 'in the release header');
    assert.ok(txt(head).indexOf(CAPTION) > txt(head).indexOf('Measured'), 'under the header line');
    for (const tag of ['v0.1.9-perf.10', 'v0.1.9-perf.11']) {
      const frs = s.fragments(tag);
      assert.ok(frs.length >= 4, `${tag}: a fragment per level`);
      for (const f of frs) assert.equal(count(f.split('<!--body-->')[0], CAPTION), 1, `${tag}: in each fragment's header`);
    }
    for (const f of s.fragments('v0.1.9-perf.9')) assert.equal(count(f, 'release commit'), 0, 'perf.9 is on base 0.1.9: no caption');
    // Overview: under the fork table, outside what the script redraws.
    const home = s.main('index.html');
    const forkSec = home.slice(home.indexOf('The fork, against its base.'));
    assert.equal(count(forkSec, CAPTION), 1);
    const inFork = (/<div id="fork">([^]*?)<\/div>\s*<p/.exec(forkSec) || [])[1] || '';
    assert.equal(count(inFork, CAPTION), 0, 'not inside #fork');
    // Records: once for the one base, however many releases are on it.
    const rec = s.main('records/index.html');
    assert.equal(count(rec, CAPTION), 1);
    assert.ok(rec.indexOf(CAPTION.slice(0, 20)) > rec.indexOf('<h2>Fork releases.</h2>') || txt(rec).indexOf(CAPTION) > txt(rec).indexOf('Fork releases.'), 'under the fork releases table');
  } finally { s.done(); }
});

test('fork releases on bases with their own version get no caption anywhere', async () => {
  const s = await site(['v0.1.9-perf.9']);
  try {
    for (const p of ['releases/index.html', 'index.html', 'records/index.html']) assert.equal(count(s.main(p), 'release commit'), 0, p);
  } finally { s.done(); }
});

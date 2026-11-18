// Red first: the homepage opens with what the project is, and the detail moves under the graph.
// - At the very top, one intro sentence, then the three-sentence description whose "MRs" links to the MRs page.
// - The status lines (latest nightly, nightlies still to be measured, how many headline metrics moved) become one
//   compact line above the graph; the detail and the movement badges sit under the graph behind "What changed".
// - The headline metrics table sits behind "Show the numbers", the legend behind "How to read this": native
//   <details>/<summary>, closed by default, nothing remembered.
// - The eight metric tiles and the "Open this metric" link stay visible.
// - In the browser the compact line follows the agents switch, and the table's caption names the level.
// Inputs are hand-made synthetic records (tools/t3cp/lib/fake.mjs) and synthetic series (lib/test-data.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildOutputs } from './aggregate.mjs';
import { build } from './build.mjs';
import { level, shard } from './lib/test-data.mjs';
import { mergeRecord } from '../../tools/t3cp/merge.mjs';
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from '../../tools/t3cp/lib/fake.mjs';
import { loadCatalogue } from '../../tools/t3cp/lib/repo.mjs';

const catalogue = loadCatalogue();
const ENT = { '&amp;': '&', '&#39;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>' };
const txt = s => s.replace(/<[^>]+>/g, ' ').replace(/&(amp|#39|quot|lt|gt);/g, e => ENT[e]).replace(/\s+/g, ' ').trim();
const INTRO = 'Nightly benchmarks of T3 Code under many concurrent agents, comparing upstream with our performance fork whose fixes we send back upstream.';
const DESC = "We forked T3 Code to optimise it for high-concurrency workloads: one server running many coding agents at once. Every fix we make goes back upstream as a pull request (see our MRs). Each night we benchmark upstream's nightly against our performance fork under the same load; as upstream merges our fixes, the two lines should meet.";

async function site(dates) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3cp-home-'));
  if (!dates.length) { // before the first record: no data directory at all
    try {
      await build({ out: path.join(root, 'dist'), in: path.join(root, 'no-data-yet'), posts: 'news/posts' });
      const html = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');
      return html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  const input = path.join(root, 'input', 'v1');
  for (const date of dates) {
    const identity = fakeIdentity({ date });
    const r = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0 }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
    const f = path.join(input, 'records', r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify(r)}\n`);
  }
  fs.writeFileSync(path.join(input, 'bands.json'), JSON.stringify({ schema: 't3cp/bands/1', method: 'home', platforms: { 'linux-x64': { pending: true }, 'darwin-arm64': { pending: true } } }));
  for (const [rel, bytes] of buildOutputs(input, { publicRefs: FAKE_PUBLIC_REFS, warn: () => {} })) {
    const f = path.join(root, 'v1', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes);
  }
  const dist = path.join(root, 'dist');
  await build({ out: dist, dev: root, posts: 'news/posts' });
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  fs.rmSync(root, { recursive: true, force: true });
  return html.slice(html.indexOf('<main'), html.indexOf('</main>'));
}
// Each <details> of the page: its attributes, its summary's text and its body.
const toggles = main => [...main.matchAll(/<details([^>]*)><summary[^>]*>([^<]*)<\/summary>([^]*?)<\/details>/g)].map(m => ({ attrs: m[1], label: m[2], body: m[3] }));
const outside = (main, needle) => { const i = main.indexOf(needle), before = main.slice(0, i); assert.ok(i >= 0, needle); return (before.match(/<details/g) || []).length === (before.match(/<\/details>/g) || []).length; };
const lineOf = main => txt((/<p[^>]*id="sline"[^>]*>([^]*?)<\/p>/.exec(main) || [])[1] || '');

test('the top of the homepage: the intro sentence, then the description with its MRs link', async () => {
  const main = await site(['2026-11-02', '2026-11-03']);
  assert.match(main, /<h1 class="sr">[^<]*<\/h1>\s*<p[^>]*>([^<]*)<\/p>/, 'the first paragraph follows the heading');
  assert.equal(txt(/<h1 class="sr">[^<]*<\/h1>\s*<p[^>]*>([^<]*)<\/p>/.exec(main)[1]), INTRO);
  const desc = /<p[^>]*>(We forked T3 Code[^]*?)<\/p>/.exec(main);
  assert.ok(desc, 'the description is on the page');
  assert.equal(txt(desc[1]), DESC);
  assert.match(desc[1], /\(see our <a href="\/mrs\/">MRs<\/a>\)/, 'MRs links to the MRs page');
  assert.ok(main.indexOf(INTRO) < main.indexOf('We forked') && main.indexOf('We forked') < main.indexOf('id="hero"'), 'intro, description, then the graph');
});

test('one compact status line above the graph; the detail, the table and the legend under it, closed', async () => {
  const main = await site(['2026-11-02', '2026-11-03']);
  const hero = main.indexOf('id="hero"'), above = main.slice(0, hero);
  assert.ok(above.indexOf('id="sline"') > 0, 'the compact line is above the graph');
  assert.equal(lineOf(main), 'Nightly 3 Nov 2026, 50 agents: none of the 8 headline metrics moved beyond noise.');
  assert.doesNotMatch(txt(above), /Latest nightly|still to be measured|since 2 Nov/, 'the detail is not above the graph');
  assert.doesNotMatch(above, /strip-l|<details/, 'no badges and no toggle above the graph');
  const t = toggles(main.slice(hero));
  assert.deepEqual(t.map(x => x.label), ['What changed', 'Show the numbers', 'How to read this']);
  for (const x of t) assert.doesNotMatch(x.attrs, /\bopen\b/, `${x.label} is closed by default`);
  assert.match(txt(t[0].body), /^Latest nightly v\S+, 3 Nov 2026, Linux x64 \w+\. Nightlies from 17 Oct to 1 Nov 2026 are still to be measured; the series start on 2 Nov\. None of the 8 headline metrics moved beyond noise since 2 Nov\./);
  assert.match(t[0].body, /id="strip"/, 'the live strip is in What changed');
  assert.match(t[1].body, /<p[^>]*id="hcap"[^>]*>The eight headline metrics, 50 agents<\/p>/);
  assert.match(t[1].body, /id="htable"[^>]*><table>/);
  assert.match(t[2].body, /class="lg"[^]*Nightly[^]*Noise band[^]*green = better/);
  assert.ok(outside(main, 'id="open"'), 'Open this metric stays visible');
  assert.ok(outside(main, 'id="grid"'), 'the eight tiles stay visible');
  assert.ok(outside(main, 'Every metric, over time.'), 'their heading too');
});

test('before the first record the compact line is the sentence on what is still to be measured', async () => {
  const main = await site([]);
  assert.equal(lineOf(main), 'Nightlies from 17 Oct 2026 onwards are still to be measured.');
  assert.equal((main.match(/still to be measured/g) || []).length, 1, 'said once');
});

// The browser: the overview page drawn from synthetic shards behind a minimal page.
const code = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function page() {
  const node = () => ({ dataset: {}, hidden: false, innerHTML: '', textContent: '', style: {}, clientWidth: 960, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, getAttribute: () => null, addEventListener() {}, querySelector: s => $(s), querySelectorAll: () => [], closest: () => null, contains: () => false, focus() {} });
  const nodes = {};
  const $ = s => (nodes[s] = nodes[s] || node());
  const document = { body: Object.assign(node(), { dataset: { page: 'overview', mac: '0' } }), documentElement: node(), querySelector: $, querySelectorAll: () => [], addEventListener() {}, createElement: node, createElementNS: node, getElementById: id => $('#' + id) };
  const waits = {};
  const window = {
    document, location: { search: '', pathname: '/', hash: '', href: '/', origin: 'https://t3cp.io', replace() {} }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}, scrollY: 0,
    console: { log() {}, warn() {}, info() {}, error() {} },
    fetch: p => new Promise(resolve => { waits[String(p).replace('/data/v1/', '')] = { resolve }; }),
  };
  Object.defineProperty(window, 'localStorage', { get() { return { getItem: () => null, setItem() {} }; } });
  new Function('window', 'document', code)(window, document);
  const answer = (p, body) => { assert.ok(waits[p], `fetched ${p}`); waits[p].resolve({ ok: true, status: 200, json: () => Promise.resolve(body) }); };
  return { T: window.T3CP, $, answer, waits };
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('in the browser the compact line and the table caption follow the agents switch', async () => {
  const P = page();
  let pageFn = null;
  P.T.page = (keys, fn) => { pageFn = fn; };
  P.T.mountTS = () => {};
  const H = catalogue.headlines['linux-x64'], ids = H.concat(['agents_served']);
  P.answer('index.json', { catalogue: catalogue.metrics, platforms: [{ id: 'linux-x64', name: 'Linux x64', live: true }], series: { 'linux-x64': Object.fromEntries(ids.map(id => [id, ['latest']])) }, fork: [], compare: [], records_index: 'records-index.json', headlines: catalogue.headlines, eras: { fixture: [], feature: [], harness: [] } });
  await tick(); await tick();
  assert.equal(typeof pageFn, 'function', 'the overview registered its draw');
  pageFn({ m: '', p: 'linux', l: '100', r: 30 }, true, () => true);
  await tick();
  // 10 nightlies, 17 to 26 Oct; the first headline regressed on the last one at 100 agents, nothing at 50.
  const lv = moved => level([10, 11, 10, 11, 10, 11, 10, 11, 10, 14], moved ? { 9: ['regressed', 30, 10.5] } : {});
  ids.forEach((id, i) => P.answer(`series/linux-x64/${id}.latest.json`, shard(id, { 50: lv(false), 100: lv(i === 0), once: lv(false) }, { n: 10 })));
  await tick(); await tick(); await tick();
  assert.equal(txt(P.$('#sline').innerHTML), 'Nightly 26 Oct 2026, 100 agents: 1 of 8 headline metrics moved beyond noise.');
  assert.match(P.$('#sline').innerHTML, /<b>1 of 8<\/b>/);
  assert.equal(P.$('#hcap').textContent, 'The eight headline metrics, 100 agents');
  pageFn({ m: '', p: 'linux', l: '50', r: 30 }, false, () => true);
  await tick(); await tick(); await tick();
  assert.equal(txt(P.$('#sline').innerHTML), 'Nightly 26 Oct 2026, 50 agents: none of the 8 headline metrics moved beyond noise.');
  assert.equal(P.$('#hcap').textContent, 'The eight headline metrics, 50 agents');
});

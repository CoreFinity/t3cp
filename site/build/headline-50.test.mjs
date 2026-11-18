// Red first (option a): the headline levels are 1, 50, 100 and 250 agents, and 50 is the default: on the benchmark
// machine the server saturates from 100 agents, so most verdicts live at 1 and 50. The overview and Releases switch
// offer the four, open at 50, and the release fragments exist at each; the site-wide default level (the state, the
// URL's omitted l=, the static pages) is 50; any other level maps to the nearest of the four; and the series the
// aggregator publishes carry headline data at 50.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadApp } from './lib/app-vm.mjs';
import { buildOutputs } from './aggregate.mjs';
import { build } from './build.mjs';
import * as P from './pages.mjs';
import { mergeRecord } from '../../tools/t3cp/merge.mjs';
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from '../../tools/t3cp/lib/fake.mjs';
import { loadCatalogue } from '../../tools/t3cp/lib/repo.mjs';

const T = loadApp();
const catalogue = loadCatalogue();
const pressed = (html, label) => [...(new RegExp(`aria-label="${label}"[^>]*>(.*?)</span>`).exec(html) || [, ''])[1].matchAll(/data-v="([^"]+)" aria-pressed="(true|false)"/g)].map(m => (m[2] === 'true' ? `*${m[1]}` : m[1]));

async function site({ invalidLast = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3cp-h50-'));
  const input = path.join(root, 'input', 'v1');
  for (const date of ['2026-11-13', '2026-11-14', '2026-11-15']) {
    const identity = fakeIdentity({ date });
    // invalidLast: the last nightly ran, but every attempt at 100 agents and above was invalid.
    const attempt = cell => (invalidLast && date === '2026-11-15' && ['100', '150', '200', '250'].includes(cell) ? { valid: false } : {});
    const r = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0, attempt }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
    const f = path.join(input, 'records', r.platform.id, `${r.release.date}.${r.release.tag}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(r)}\n`);
  }
  fs.writeFileSync(path.join(input, 'bands.json'), JSON.stringify({ schema: 't3cp/bands/1', method: 'pending', platforms: { 'linux-x64': { pending: true }, 'darwin-arm64': { pending: true } } }));
  for (const [rel, bytes] of buildOutputs(input, { publicRefs: FAKE_PUBLIC_REFS, warn: () => {} })) {
    const f = path.join(root, 'v1', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes);
  }
  await build({ out: path.join(root, 'dist'), dev: root, posts: 'news/posts' });
  return { root, read: p => fs.readFileSync(path.join(root, 'dist', p), 'utf8'), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the overview and Releases offer 1, 50, 100 and 250 agents, opening at 50; the static pages default to 50', async () => {
  const s = await site();
  try {
    const home = s.read('index.html');
    assert.deepEqual(pressed(home, 'Agents: 1, 50, 100 or 250'), ['1', '*50', '100', '250']);
    assert.match(home, /<summary id="hcap">Table: the eight headline metrics, 50 agents<\/summary>/);
    assert.deepEqual(pressed(s.read('releases/index.html'), 'Agents: 1, 50, 100 or 250'), ['1', '*50', '100', '250']);
    assert.match(pressed(s.read('metrics/turn_p50_ms/index.html'), 'Agents, concurrent sessions').join(' '), /\*50/, 'a metric page opens at 50');
    assert.match(s.read('metrics/index.html'), /latest value at 50 agents/);
    // The series the aggregator publishes carry the headline metrics at 50 agents.
    for (const id of catalogue.headlines['linux-x64'].filter(id => catalogue.metrics.find(m => m.id === id).scope === 'level')) {
      const sh = JSON.parse(fs.readFileSync(path.join(s.root, 'v1', 'series', 'linux-x64', `${id}.latest.json`), 'utf8'));
      assert.ok(sh.levels['50'] && sh.levels['50'].median.some(v => v != null), `${id} has data at 50`);
    }
  } finally { s.done(); }
});

test('the ladder preselects the latest nightly with a value at the default level (50), not at 100', async () => {
  const s = await site({ invalidLast: true });
  try {
    const lt = (/<div class="tw" id="ltable">(.*?)<\/div>/s.exec(s.read('metrics/turn_p50_ms/index.html')) || [])[1] || '';
    assert.match(lt, /<th class="n">Nightly 15 Nov<\/th>/, 'the last nightly has a value at 50 agents');
  } finally { s.done(); }
});

test('release fragments exist at 1, 50, 100 and 250 agents', () => {
  const cat = JSON.parse(fs.readFileSync(new URL('../../catalogue/catalogue.json', import.meta.url), 'utf8'));
  const c = { T, plat: 'linux-x64', platName: 'Linux x64', catalogue: cat.metrics, headlines: cat.headlines['linux-x64'], log: () => {}, forks: [{ tag: 'v0.1.9-perf.8', date: '2026-11-15', platforms: { 'linux-x64': {} } }], release: () => null, shard: () => null };
  assert.deepEqual(P.releaseFragments(c).files.map(f => f.path.split('/')[2].split('.')[0]), ['1', '50', '100', '250']);
});

test('the browser: any level maps to the nearest of 1, 50, 100 and 250, and the default level is 50', () => {
  assert.deepEqual(['1', '50', '75', '100', '150', '200', '250', '1e'].map(T.headlineLevel), ['1', '50', '50', '100', '100', '250', '250', '1']);
  const code = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const el = () => ({ dataset: {}, style: {}, hidden: true, textContent: '', innerHTML: '', clientWidth: 960, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute() {}, getAttribute: () => null, querySelectorAll: () => [], querySelector: () => null, closest: () => null });
  const document = { body: Object.assign(el(), { dataset: { page: 'overview', mac: '0' } }), documentElement: el(), querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, createElement: el, createElementNS: el, getElementById: () => el() };
  const window = { document, location: { search: '', pathname: '/', hash: '', href: '/', origin: 'https://t3cp.io', replace() {} }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}, scrollY: 0, console: { log() {}, warn() {}, info() {}, error() {} }, fetch: () => new Promise(() => {}) };
  Object.defineProperty(window, 'localStorage', { get() { return { getItem: () => null, setItem() {} }; } });
  new Function('window', 'document', code)(window, document);
  assert.equal(window.T3CP.state.l, '50', 'the default level');
});

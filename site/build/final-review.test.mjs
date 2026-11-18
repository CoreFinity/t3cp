// Red first: three findings of the final review of the site.
// - A bands entry that is still pending ({"pending": true}) builds: Methodology says the bands are being measured
//   instead of reading attempts it does not have. At go-live the bands may still be pending.
// - A checked post's title is built per level from that level's counts, as the charts-only path builds it: the
//   stored title is the template at the headline level only.
// - Enter on a focused chart point with a link follows it (a local width variable once shadowed window).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApp } from './lib/app-vm.mjs';
import { releaseHTML } from './render-post.mjs';
import { build } from './build.mjs';

const T = loadApp();
const cat = JSON.parse(readFileSync(new URL('../../catalogue/catalogue.json', import.meta.url), 'utf8'));
const STATUS = { schema: 't3cp/status/1', generated_at: '2026-11-17T01:33:04.746Z', platforms: { 'linux-x64': { latest_record_id: null, latest_date: null, latest_status: null, queue: { pending: 0, active: 0 }, last_failure: null, heartbeat_at: null } } };

test('pending bands build: Methodology says they are being measured', async () => {
  const root = mkdtempSync(join(tmpdir(), 't3cp-pending-'));
  try {
    mkdirSync(join(root, 'in'));
    writeFileSync(join(root, 'in/status.json'), JSON.stringify(STATUS));
    writeFileSync(join(root, 'in/bands.json'), JSON.stringify({ schema: 't3cp/bands/1', method: 'band = (max - min) / median, in percent, over repeated identical attempts', platforms: { 'linux-x64': { pending: true } } }));
    await build({ out: join(root, 'dist'), in: join(root, 'in'), posts: 'news/posts' });
    const method = readFileSync(join(root, 'dist/methodology/index.html'), 'utf8');
    assert.match(method, /noise bands are being measured/);
    assert.doesNotMatch(method, /undefined/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a checked post\'s title carries the counts of the level shown, at every level', () => {
  const ctx = { catalogue: cat.metrics, headlines: cat.headlines['linux-x64'], platform: 'linux-x64' };
  const scope = Object.fromEntries(cat.metrics.map(m => [m.id, m.scope]));
  // At 100 agents two improve and one regresses; at 1 agent nothing moves; at 250 agents three regress.
  const at = { 100: i => (i < 2 ? ['improved', -20] : i === 2 ? ['regressed', 25] : ['within', 1]), 1: () => ['within', 1], 250: i => (i < 3 ? ['regressed', 30] : ['within', 1]) };
  const deltas = ['1', '100', '250'].flatMap(L => ctx.headlines.map((metric, i) => {
    const [verdict, delta_pct] = at[L](i);
    return { metric, platform: 'linux-x64', level: scope[metric] === 'record' ? 'once' : L, headline: i + 1, fork: 100 + i, base: 110 + i, delta_pct, threshold_pct: 15, verdict, note: null };
  })).filter((d, i, all) => all.findIndex(e => e.metric === d.metric && e.level === d.level) === i);
  const rel = {
    tag: 'v0.1.9-perf.8', date: '2026-11-15', base: { tag: 'v0.1.9-nightly.20261114.4700', date: '2026-11-14', sha: 'd57a42a124b2' + '0'.repeat(28), sha7: 'd57a42a' }, deltas,
    post: { title: 'v0.1.9-perf.8: 1 regressed, 2 improved, 5 within noise (vs v0.1.9-nightly.20261114.4700)', summary: 'Two improved.', sections: [], quotes: [] },
    changelog: [], checker: { passed: true, numbers_checked: 3, charts: 0, findings: [], footer: 'Text written from the record and checked against it: 3 numbers, 0 charts, 0 findings.' },
  };
  const title = L => /<h1 class="rel-t">([^<]*)<\/h1>/.exec(releaseHTML(T, rel, { ...ctx, level: L }).html)[1];
  assert.match(title('100'), /: 1 regressed, 2 improved, 5 within noise/);
  assert.match(title('1'), /: 0 regressed, 0 improved, 8 within noise/);
  assert.match(title('250'), /: 3 regressed, 0 improved, 5 within noise/);
  for (const L of ['1', '100', '250']) {
    const html = releaseHTML(T, rel, { ...ctx, level: L }).html, figs = [...html.matchAll(/<div class="fig"><b>(\d+)<\/b>/g)].map(m => +m[1]);
    const [, bad, good, ok] = /: (\d+) regressed, (\d+) improved, (\d+) within noise/.exec(title(L)).map(Number);
    assert.deepEqual(figs, [good, bad, ok], `level ${L}: the title and the figures agree`);
  }
});

test('Enter on a focused chart point with a link follows it', () => {
  // A page context (data-page set), so the whole script runs; fetches never resolve, so no page draws itself.
  const listeners = {};
  const node = extra => Object.assign({ dataset: {}, hidden: true, innerHTML: '', textContent: '', style: {}, offsetWidth: 80, clientWidth: 960, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], closest: () => null, addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 300 }) }, extra);
  const plain = () => node({ addEventListener() {} });
  const document = { body: Object.assign(plain(), { dataset: { page: 'metric', mac: '0' } }), documentElement: plain(), querySelector: () => plain(), querySelectorAll: () => [], addEventListener() {}, createElement: plain, createElementNS: plain, getElementById: () => plain() };
  const window = { document, location: { search: '', pathname: '/metrics/turn_p50_ms/', hash: '', href: '/metrics/turn_p50_ms/', origin: 'https://t3cp.io', replace() {} }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}, scrollY: 0, console: { log() {}, warn() {}, info() {}, error() {} }, fetch: () => new Promise(() => {}) };
  Object.defineProperty(window, 'localStorage', { get() { return { getItem: () => null, setItem() {} }; } });
  new Function('window', 'document', readFileSync(new URL('../app.js', import.meta.url), 'utf8'))(window, document);
  const A = window.T3CP;
  const svg = node(), hv = plain(), tip = plain();
  const el = plain(); el.querySelector = s => (s === 'svg' ? svg : s === '.hv' ? hv : s === '.tip' ? tip : null);
  const spec = A.ladderChart(cat.metrics.find(m => m.id === 'turn_p50_ms'), { dates: ['2026-11-14'], levels: { 1: { median: [100] }, 50: { median: [120] }, 100: { median: [140] }, 150: { median: [160] }, 200: { median: [180] }, 250: { median: [200] } }, fork: null }, 0, -1, {});
  spec.open = i => `/metrics/turn_p50_ms/?l=${i}`;
  A.mountLadder(el, spec);
  const key = k => (listeners.keydown || []).forEach(f => f({ key: k, preventDefault() {}, stopPropagation() {} }));
  key('Home');
  assert.doesNotThrow(() => key('Enter'));
  assert.equal(window.location.href, '/metrics/turn_p50_ms/?l=0');
});

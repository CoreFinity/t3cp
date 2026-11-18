// Red first: on Compare, an older comparison that answers after a newer one must change nothing: neither the table
// nor the verdict counts above it. The figures were written before the page checked that its request was still the
// current one, so a late answer could leave counts that contradict the table under them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { record } from './build/lib/test-data.mjs';

const cat = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
const code = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

// A minimal page: nodes by selector, selects that parse their options, and fetches answered by the test.
function page() {
  const node = () => ({ dataset: {}, hidden: false, innerHTML: '', textContent: '', style: {}, clientWidth: 960, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, getAttribute: () => null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null });
  const select = () => {
    const el = node(); let html = '';
    el.options = [];
    Object.defineProperty(el, 'innerHTML', { get: () => html, set(v) { html = v; el.options = [...v.matchAll(/<option value="([^"]*)"/g)].map(m => ({ value: m[1] })); } });
    el.querySelectorAll = s => (s === 'option' ? el.options : []);
    return el;
  };
  const nodes = {};
  const $ = s => (nodes[s] = nodes[s] || (s === '#a' || s === '#b' ? select() : node()));
  const document = { body: Object.assign(node(), { dataset: { page: 'compare', mac: '0' } }), documentElement: node(), querySelector: $, querySelectorAll: () => [], addEventListener() {}, createElement: node, createElementNS: node, getElementById: id => $('#' + id) };
  const waits = {};
  const answer = (path, body) => waits[path].resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  const window = {
    document, location: { search: '', pathname: '/compare/', hash: '', href: '/compare/', origin: 'https://t3cp.io', replace() {} }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}, scrollY: 0,
    console: { log() {}, warn() {}, info() {}, error() {} },
    fetch: p => new Promise(resolve => { waits[String(p).replace('/data/v1/', '')] = { resolve }; }),
  };
  Object.defineProperty(window, 'localStorage', { get() { return { getItem: () => null, setItem() {} }; } });
  new Function('window', 'document', code)(window, document);
  return { T: window.T3CP, $, answer, waits };
}

const tick = () => new Promise(r => setTimeout(r, 0));

test('an older comparison answering late changes neither the table nor the counts', async () => {
  const P = page();
  let pageFn = null;
  P.T.page = (keys, fn) => { pageFn = fn; };
  const day = d => record({ date: d, values: { client_errors: d === '2026-11-14' ? 3 : 0 } });
  const recs = ['2026-11-12', '2026-11-13', '2026-11-14'].map(d => ({ date: d, tag: day(d).release.tag, sha: '0'.repeat(40), platforms: { 'linux-x64': { record_id: `${d}.linux-x64.nightly`, status: 'complete', path: `records/linux-x64/${d}.json`, segment: { 100: 1 }, banded: true, gates: { 100: 'pass', once: 'pass' } } } }));
  const catalogue = cat.metrics.map(m => ({ ...m, bands: {}, cap: { 'linux-x64': { 100: { threshold: null, note: m.counter ? null : 'no_band' } } }, gate_exempt: m.id === 'client_errors' || m.id === 'client_unfinished', throughput: m.id === 'turns_completed' || m.id === 'agents_served' }));
  P.answer('index.json', { catalogue, platforms: [{ id: 'linux-x64', name: 'Linux x64', live: true }], series: { 'linux-x64': { client_errors: ['latest'] } }, fork: [], compare: [], records_index: 'records-index.json', headlines: cat.headlines, eras: { fixture: [], feature: [], harness: [] } });
  await tick(); await tick();
  P.answer('records-index.json', { records: recs });
  await tick(); await tick();
  assert.equal(typeof pageFn, 'function', 'the compare page registered its draw');
  let token = 0;
  const run = (a, b) => { const my = ++token; pageFn({ mode: 'nightly', a, b, p: 'linux', l: '100' }, my === 1, () => my === token); };
  run('2026-11-12', '2026-11-13'); // older request: 13 against 12, nothing moves
  run('2026-11-12', '2026-11-14'); // newer request: 14 against 12, client errors appear
  const body = d => day(d);
  P.answer('records/linux-x64/2026-11-14.json', body('2026-11-14')); P.answer('records/linux-x64/2026-11-12.json', body('2026-11-12'));
  await tick(); await tick();
  const figs = P.$('#figs').innerHTML, rows = P.$('#rows').innerHTML;
  assert.match(figs, /<b>1<\/b><span><span class="g v-bad"/, 'the newer comparison counts one regression');
  P.answer('records/linux-x64/2026-11-13.json', body('2026-11-13'));
  await tick(); await tick();
  assert.equal(P.$('#rows').innerHTML, rows, 'the table stays the newer one');
  assert.equal(P.$('#figs').innerHTML, figs, 'the counts stay the newer ones');
});

// Red first: the review's minor findings that a test can hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadApp } from './build/lib/app-vm.mjs';
import { releaseHTML } from './build/render-post.mjs';
import { META, eluShard, forkOf, level, shard } from './build/lib/test-data.mjs';
import { build } from './build/build.mjs';
import * as P from './build/pages.mjs';

const T = loadApp();
const cat = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
const rule = sel => { const i = css.indexOf(sel + '{'); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };
const apex = (html, cls) => { const m = new RegExp(`<path class="mk ${cls}" d="M([\\d.]+) ([\\d.]+)l`).exec(html); return m ? +m[2] : null; };

test('counts equal the rows they count: the headline table holds the counted rows, others sit apart', () => {
  const H = cat.headlines['linux-x64'], scope = Object.fromEntries(cat.metrics.map(m => [m.id, m.scope]));
  const deltas = H.map((metric, i) => ({ metric, platform: 'linux-x64', level: scope[metric] === 'record' ? 'once' : '100', headline: i + 1, fork: 100, base: 110, delta_pct: i ? 1 : -20, threshold_pct: 15, verdict: i ? 'within' : 'improved', note: null }))
    .concat(['turn_p95_ms', 'eld_p99_ms'].map(metric => ({ metric, platform: 'linux-x64', level: '100', headline: null, fork: 130, base: 100, delta_pct: 30, threshold_pct: 20, verdict: 'regressed', note: null })));
  const rel = { tag: 'v0.1.9-perf.8', date: '2026-11-15', base: { tag: 'v0.1.10-nightly.20261114.5628', date: '2026-11-14' }, deltas, charts_only: true, checker: { passed: false } };
  const { html } = releaseHTML(T, rel, { catalogue: cat.metrics, headlines: H, platform: 'linux-x64', level: '100' });
  const figs = [...html.matchAll(/<div class="fig"><b>(\d+)<\/b>/g)].reduce((a, m) => a + +m[1], 0);
  const tables = html.split('<table class="dt">').slice(1).map(t => (t.split('</table>')[0].match(/<tr>/g) || []).length - 1);
  assert.equal(figs, 8, 'the figures count the eight headline rows');
  assert.equal(tables[0], 8, 'the first table lists those eight');
  assert.equal(tables[1], 2, 'the other metrics beyond noise are listed apart');
  assert.match(html, /Other metrics beyond noise/);
});

test('two releases on one date both get a marker and both are links', () => {
  const S = eluShard();
  S.fork = forkOf(10, [{ tag: 'v0.1.9-perf.7', i: 8, v: 0.7, vb: -10, vbv: 'within' }, { tag: 'v0.1.9-perf.8', i: 8, v: 0.66, vb: -16, vbv: 'within', vp: -5.7, vpv: 'within' }]);
  const { html } = T.tsSVG(T.model(S, META.elu, '100', 30), 640, 320);
  for (const tag of ['v0.1.9-perf.7', 'v0.1.9-perf.8']) assert.match(html, new RegExp(`<a class="mk-a" href="/releases/\\?rel=${tag.replace(/\./g, '\\.')}"`), tag);
});

test('upstream markers point the way the value moved, coloured by the verdict', () => {
  const v = [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.99, 0.8, 0.6];
  const S = shard('elu', { 100: level(v, { 7: ['regressed', 23.75, 0.8], 9: ['improved', -25, 0.8] }) });
  const { html, y } = T.tsSVG(T.model(S, META.elu, '100', 30), 640, 320);
  assert.ok(apex(html, 'mk-bad') < y(0.99), 'a rise that is worse: a red triangle pointing up');
  assert.ok(apex(html, 'mk-good') > y(0.6), 'a fall that is better: a green triangle pointing down');
  const S2 = shard('turns_completed', { 100: level([300, 300, 300, 300, 300, 300, 300, 300, 300, 200], { 9: ['regressed', -33, 300] }, 9.6) });
  const g = T.tsSVG(T.model(S2, META.turns_completed, '100', 30), 640, 320);
  assert.ok(apex(g.html, 'mk-bad') > g.y(200), 'a fall in a higher-is-better metric: a red triangle pointing down');
});

test('fork markers point the way the release moved against the previous one, coloured by that verdict', () => {
  const S = eluShard();
  S.fork = forkOf(10, [{ tag: 'v0.1.9-perf.6', i: 4, v: 0.8, vb: 0, vbv: 'within' }, { tag: 'v0.1.9-perf.7', i: 6, v: 1.0, vb: 25, vbv: 'regressed', vp: 25, vpv: 'regressed' }, { tag: 'v0.1.9-perf.8', i: 8, v: 0.7, vb: -12, vbv: 'within', vp: -30, vpv: 'improved' }]);
  const { html, y } = T.tsSVG(T.model(S, META.elu, '100', 30), 640, 320);
  const inLink = tag => html.split(`href="/releases/?rel=${tag}"`)[1].split('</a>')[0];
  assert.ok(apex(inLink('v0.1.9-perf.7'), 'mk-bad') < y(1.0), 'perf.7 rose and is worse: red, pointing up');
  assert.ok(apex(inLink('v0.1.9-perf.8'), 'mk-good') > y(0.7), 'perf.8 fell and is better: green, pointing down');
  assert.match(inLink('v0.1.9-perf.6'), /mk-rel/, 'the first release is the plain accent dot');
});

test('the overview shows the nearest of its four headline levels: 1, 50, 100 and 250 agents', () => {
  assert.deepEqual(['1', '50', '100', '150', '200', '250', '1e'].map(T.headlineLevel), ['1', '50', '100', '100', '250', '250', '1']);
});

test('a gate script run through a symlinked path still runs (it never fails open)', () => {
  const dir = mkdtempSync(join(tmpdir(), 't3cp-argv-')), dist = join(dir, 'dist');
  try {
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>t</title>');
    let s = '', x = 2463534242; while (s.length < 120000) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; s += String.fromCharCode(33 + (x % 94)); }
    writeFileSync(join(dist, 'assets', 'app.js'), s);
    const link = join(dir, 'budgets-link.mjs');
    symlinkSync(fileURLToPath(new URL('./build/budgets.mjs', import.meta.url)), link);
    const r = spawnSync(process.execPath, [link, dist], { encoding: 'utf8' });
    assert.equal(r.status, 1, 'the over-budget tree fails through the symlink too: ' + r.stdout + r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('controls change state with no transition', () => {
  assert.doesNotMatch(rule('.plot'), /transition/);
  assert.doesNotMatch(rule('.tabs button'), /transition/);
});

test('integers show no decimals; fractions keep theirs', () => {
  assert.equal(T.fmt(37), '37');
  assert.equal(T.fmt(1196), '1,196');
  assert.equal(T.fmt(37.5), '37.5');
  assert.equal(T.fmt(0.45), '0.45');
});

test('percentages print with no space before the sign, the posts\' strings included', () => {
  const r = T.drow(META.turns_completed, 233, 290, 24.5, 'improved', null, 9.6);
  r.txt = { base: '233', fork: '290', delta_pct: '+24.5 %' };
  const html = T.deltasHTML([r], 'A', 'B');
  assert.match(html, /\+24\.5%/);
  assert.doesNotMatch(html, /\d %/);
});

test('a vanished chart id is logged once per post', () => {
  const lines = [];
  const rel = { tag: 'v0.1.9-perf.8', date: '2026-11-15', base: { tag: 'v0.1.10-nightly.20261114.5628', date: '2026-11-14' }, deltas: [],
    post: { title: 't', summary: 's', sections: [{ chart_id: 'series.no_such_metric.linux-x64', caption: 'c' }] }, checker: { passed: true, numbers_checked: 1, charts: 1, findings: [] } };
  P.releases({ T, plat: 'linux-x64', platName: 'Linux x64', forks: [{ tag: 'v0.1.9-perf.8', date: '2026-11-15', platforms: { 'linux-x64': {} } }], release: () => rel, catalogue: cat.metrics, headlines: cat.headlines['linux-x64'], log: s => lines.push(s) });
  assert.equal(lines.filter(l => /no_such_metric/.test(l)).length, 1);
});

test('the built site: "1 agent · empty" on the level control, the shape file and the harness on Downloads', async () => {
  const out = mkdtempSync(join(tmpdir(), 't3cp-minors-'));
  try {
    await build({ out, in: join(out, 'no-data-yet'), posts: 'news/posts' });
    const empty = cat.metrics.find(m => m.empty_cell && m.scope === 'level');
    assert.match(readFileSync(join(out, `metrics/${empty.id}/index.html`), 'utf8'), />1 agent · empty</);
    const dl = readFileSync(join(out, 'downloads/index.html'), 'utf8');
    const shapeBytes = readFileSync(new URL('../fixture/public-large.shape.json', import.meta.url));
    assert.match(dl, /public-large\.shape\.json/);
    assert.match(dl, new RegExp(createHash('sha256').update(shapeBytes).digest('hex')));
    assert.match(dl, /<h2>The harness\.<\/h2>/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

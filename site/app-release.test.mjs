// Red first: a release whose checker did not pass renders the charts-only form with the footer line and
// no summary; a post section whose chart id no longer exists is dropped and reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApp } from './build/lib/app-vm.mjs';
import { releaseHTML } from './build/render-post.mjs';

const T = loadApp();
const cat = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
const ctx = { catalogue: cat.metrics, headlines: cat.headlines['linux-x64'], platform: 'linux-x64', level: '100' };

function release(over = {}) {
  // schema/release-1.json: a record-scope headline (db_ready_warm_ms) carries level "once".
  const scope = Object.fromEntries(cat.metrics.map(m => [m.id, m.scope]));
  const deltas = ctx.headlines.map((metric, i) => ({
    metric, platform: 'linux-x64', level: scope[metric] === 'record' ? 'once' : '100', headline: i + 1, fork: 100 + i, base: 110 + i,
    delta_pct: i < 2 ? -20 : i === 2 ? 25 : 1, threshold_pct: 15, verdict: i < 2 ? 'improved' : i === 2 ? 'regressed' : 'within', note: null,
  }));
  return {
    tag: 'v0.1.9-perf.8', date: '2026-11-15', base: { tag: 'v0.1.9-nightly.20261114.4700', date: '2026-11-14' }, prev: 'v0.1.9-perf.7',
    counts: { improved: 2, regressed: 1, within: 5 }, deltas,
    post: { title: 'TITLE-SENTINEL', summary: 'SUMMARY-SENTINEL two improved.', sections: [{ chart_id: 'series.turn_p50_ms.linux-x64', caption: 'CAPTION-SENTINEL' }] },
    changelog: ['Reads routed to the reader pool by statement class.'],
    checker: { passed: true, numbers_checked: 14, charts: 1, findings: [], written_in_session: true },
    ...over,
  };
}

test('checker.passed == false renders the charts-only form: footer line, no summary, the eight headline charts', () => {
  const rel = release({ checker: { passed: false, numbers_checked: 14, charts: 1, findings: ['number 9,999 ms not in the bundle'], written_in_session: true } });
  const { html } = releaseHTML(T, rel, ctx);
  assert.doesNotMatch(html, /SUMMARY-SENTINEL/, 'no summary');
  assert.doesNotMatch(html, /TITLE-SENTINEL|CAPTION-SENTINEL/, 'nothing from the unchecked text');
  assert.match(html, /Charts only: the generated text did not pass the checker\./);
  assert.match(html, /v0\.1\.9-perf\.8: 1 regressed, 2 improved, 5 within noise \(vs v0\.1\.9-nightly\.20261114\.4700\)/, 'the template title');
  const charts = [...html.matchAll(/data-chart="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(charts, ctx.headlines.map(id => `series.${id}.linux-x64`));
  assert.match(html, /Reads routed to the reader pool by statement class\./, 'the changelog excerpt stays');
});

test('charts_only: true renders the same form even with a passing checker', () => {
  const rel = release({ post: undefined, charts_only: true });
  const { html } = releaseHTML(T, rel, ctx);
  assert.match(html, /Charts only/);
  assert.equal([...html.matchAll(/data-chart="/g)].length, 8);
});

test('a passing post renders its title, summary, captions and the checked footer', () => {
  const { html, dropped } = releaseHTML(T, release(), ctx);
  // The title is the template with this level's counts, never the stored title (it carries the headline level's).
  assert.match(html, /<h1 class="rel-t">v0\.1\.9-perf\.8: 1 regressed, 2 improved, 5 within noise \(vs v0\.1\.9-nightly\.20261114\.4700\)<\/h1>/);
  assert.doesNotMatch(html, /TITLE-SENTINEL/);
  assert.match(html, /SUMMARY-SENTINEL/);
  assert.match(html, /CAPTION-SENTINEL/);
  assert.match(html, /checked against it: 14 numbers, 1 chart, 0 findings/);
  assert.deepEqual(dropped, []);
});

test('a section whose chart id no longer exists is left out and reported', () => {
  const rel = release();
  rel.post.sections.push({ chart_id: 'series.no_such_metric.linux-x64', caption: 'GONE-SENTINEL' });
  const { html, dropped } = releaseHTML(T, rel, ctx);
  assert.doesNotMatch(html, /GONE-SENTINEL|no_such_metric/);
  assert.match(html, /CAPTION-SENTINEL/, 'the other sections stay');
  assert.deepEqual(dropped, ['series.no_such_metric.linux-x64']);
});

test('a pending comparison says so: no counts, no deltas, the headline charts', () => {
  const rel = release({ charts_only: true, charts_only_reason: 'pending', deltas: [], counts: {}, post: { title: 'x', summary: null, sections: [] },
    checker: { passed: false, footer: 'Comparison pending: the measured records for this release are not complete yet.' } });
  const { html } = releaseHTML(T, rel, ctx);
  assert.match(html, /v0\.1\.9-perf\.8: comparison pending/);
  assert.doesNotMatch(html, /regressed beyond noise|class="figs"/);
  assert.match(html, /Comparison pending: the measured records for this release are not complete yet\./);
  assert.equal([...html.matchAll(/data-chart="/g)].length, 8);
});

test('a release whose base is from another era says there is no comparison: no counts, no deltas, the series charts', () => {
  const rel = release({ charts_only: true, charts_only_reason: 'no_base', deltas: [], counts: {}, post: { title: 'x', summary: null, sections: [], quotes: [] },
    checker: { passed: false, footer: 'No comparison: the upstream base is from another era.' } });
  const { html } = releaseHTML(T, rel, ctx);
  assert.match(html, /v0\.1\.9-perf\.8: no comparable base/);
  assert.doesNotMatch(html, /class="figs"|beyond noise/);
  assert.match(html, /No comparison: the upstream base is from another era\./, 'the checker footer as written');
  assert.equal([...html.matchAll(/data-chart="/g)].length, 8);
});

test('a saturated level is context only: its note says so and it carries no verdict word', () => {
  const r = T.drow(cat.metrics.find(m => m.id === 'turn_p50_ms'), 300, 900, 200, null, 'saturated', 22.5);
  const html = T.deltasHTML([r], 'A', 'B');
  assert.match(html, /saturated/);
  assert.doesNotMatch(html, /regressed|improved beyond|within noise/);
});

test('a saturated level carries the flag "saturated: n of N agents served" from the agents served row', () => {
  const rel = release();
  rel.deltas = rel.deltas.map(d => (d.metric === 'turns_completed' ? d : { ...d, verdict: null, note: 'saturated', saturated: { fork: true, base: false, prev: null } }));
  rel.deltas.push({ metric: 'agents_served', platform: 'linux-x64', level: '100', headline: null, fork: 92, base: 100, delta_pct: -8, threshold_pct: null, verdict: null, note: null, saturated: { fork: true, base: false, prev: null } });
  const cat2 = { ...ctx, catalogue: cat.metrics.concat(cat.metrics.some(m => m.id === 'agents_served') ? [] : [{ ...cat.metrics[0], id: 'agents_served', name: 'Agents served', better: 'higher', headline: null }]) };
  const { html } = releaseHTML(T, rel, cat2);
  assert.match(html, /saturated: 92 of 100 agents served/i);
  assert.match(html, /context only/);
});

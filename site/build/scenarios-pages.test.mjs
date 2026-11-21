// Red first: the scenario pages. /scenarios/ lists every row of scenarios.json and /scenarios/<id>/ shows a row: its facts
// and cells from scenarios.json, each metric's name, definition, target and mapping from the catalogue, and its records
// from the aggregator's scenario series when there are any (newest first, at most 30 a table, a null value with data's
// public reason words); with none, an empty state. Static HTML from the build: no new script. The pages are linked from
// the Metrics index and from Methodology, not from the top navigation. Inputs are hand-made synthetic records
// (tools/t3cp/lib/fake.mjs, fake-scenario.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildOutputs } from './aggregate.mjs';
import { build } from './build.mjs';
import { BUDGETS } from './budgets.mjs';
import { scenarioPages } from './scenarios-pages.mjs';
import { loadApp } from './lib/app-vm.mjs';
import { mergeRecord } from '../../tools/t3cp/merge.mjs';
import { FAKE_PUBLIC_REFS, HARNESS, fakeAttempts, fakeExtras, fakeIdentity } from '../../tools/t3cp/lib/fake.mjs';
import { fakeScenarioRecord, scenarioRecordPath } from '../../tools/t3cp/lib/fake-scenario.mjs';
import { loadCatalogue, loadScenarios } from '../../tools/t3cp/lib/repo.mjs';
import { SCENARIO_REASON_WORDS } from '../../tools/t3cp/lib/schemas.mjs';

const catalogue = loadCatalogue();
const T = loadApp();
const txt = s => s.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/ ([.,;:)])/g, '$1').trim();
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// The repository's rows, the compaction row's harness the fake one so the fake records pass its pin check.
const REAL = loadScenarios();
const SCENARIOS = { ...REAL, rows: REAL.rows.map(r => (r.id === 'event-log-compaction' ? { ...r, harness: HARNESS.version } : r)) };
const COMPACTION = SCENARIOS.rows.find(r => r.id === 'event-log-compaction');
const UNPRUNED = catalogue.metrics.find(m => m.id === 'event_log_unpruned_days');
const EMPTY = 'No records yet: this scenario has not run on a published build yet.';
const LEDE = 'A scenario is a fixed workload measured on the same machine type as the nightlies, with its own fixture, cells and metrics. A scenario is never edited: any change is a new version.';

async function site(scenarioRecords = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3cp-scenario-pages-'));
  const input = path.join(root, 'input', 'v1'), posts = path.join(root, 'posts');
  fs.mkdirSync(posts, { recursive: true });
  const put = (rel, value) => { const f = path.join(input, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(value)}\n`); };
  for (const date of ['2026-11-01', '2026-11-02']) {
    const identity = fakeIdentity({ date });
    const r = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0 }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
    put(`records/linux-x64/${r.release.date}.${r.release.tag}.json`, r);
  }
  for (const r of scenarioRecords) put(scenarioRecordPath(r), r);
  put('bands.json', { schema: 't3cp/bands/1', method: 'scenario pages', platforms: { 'linux-x64': { pending: true }, 'darwin-arm64': { pending: true } } });
  for (const [rel, bytes] of buildOutputs(input, { publicRefs: FAKE_PUBLIC_REFS, scenarios: SCENARIOS, warn: () => {} })) {
    const f = path.join(root, 'v1', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes);
  }
  const dist = path.join(root, 'dist');
  // No release posts here (the release step reads the repository's own rows); the pages read the test rows.
  await build({ out: dist, dev: root, posts, 'dev-releases': posts, scenarios: SCENARIOS });
  const read = p => fs.readFileSync(path.join(dist, p), 'utf8');
  const main = p => { const h = read(p); return h.slice(h.indexOf('<main'), h.indexOf('</main>')); };
  const files = p => fs.existsSync(path.join(dist, p));
  return { read, main, files, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const rowsOf = html => [...html.matchAll(/<tr>([^]*?)<\/tr>/g)].map(m => txt(m[1]));

test('with no scenario record: the index lists every row, a row page has its facts, cells, metric texts and the empty state', async () => {
  const s = await site();
  try {
    const ix = s.main('scenarios/index.html');
    assert.match(ix, /<h1>Scenarios\.<\/h1>/);
    assert.ok(txt(ix).includes(LEDE), 'the approved lede');
    assert.match(s.read('scenarios/index.html'), /<title>Scenarios · t3cp<\/title>/);
    const table = rowsOf(ix.slice(ix.indexOf('<table')));
    assert.equal(table[0], 'Scenario Version Status Added Metrics Records');
    assert.deepEqual(table.slice(1), SCENARIOS.rows.map(r => `${r.id} ${r.version} ${r.status} ${T.dLong(r.added)} ${r.metrics === 'catalogue' ? 'Metrics' : r.metrics.map(id => catalogue.metrics.find(m => m.id === id).short).join(', ')} none yet`));
    assert.match(ix, /<a href="\/scenarios\/event-log-compaction\/"><code>event-log-compaction<\/code><\/a>/);

    const page = s.main('scenarios/event-log-compaction/index.html');
    assert.match(page, /<h1>event-log-compaction, version 1\.<\/h1>/);
    assert.match(s.read('scenarios/event-log-compaction/index.html'), /<title>event-log-compaction · Scenarios · t3cp<\/title>/);
    const facts = txt((/<dl class="spec[^"]*">([^]*?)<\/dl>/.exec(page) || [])[1] || '');
    assert.equal(facts, `Suite ${COMPACTION.suite} Status active Added ${T.dLong(COMPACTION.added)} Harness ${COMPACTION.harness} Fixture large-76 Attempts per cell 3 Platforms Linux x64`, 'macOS is hidden while it has no record');
    const cells = rowsOf(page.slice(page.indexOf('<h2>Cells.</h2>')).split('</table>')[0]);
    assert.equal(cells[0], 'Cell Mode Agents Watching live Status pollers Turn gap Warm-up Window After the window');
    assert.deepEqual(cells.slice(1), ['cmp history 1 1 0 5s 60 s 300 s prune-mark']);
    const sec = page.slice(page.indexOf('id="event_log_unpruned_days"'));
    assert.ok(sec.includes(`<h2>${UNPRUNED.name}</h2>`), 'the catalogue name');
    assert.ok(txt(sec).includes(txt(UNPRUNED.definition)), 'the catalogue definition');
    assert.ok(txt(sec).includes(EMPTY), 'the empty state');
    assert.doesNotMatch(sec, /<table/);

    const ladder = s.main('scenarios/ladder/index.html');
    assert.match(ladder, /<h1>ladder, version 1\.<\/h1>/);
    assert.ok(txt(ladder).includes('This row is the load ladder that every nightly runs. Its metrics and results are on the Overview and Metrics pages.'));
    assert.match(ladder, /<a href="\/">Overview<\/a> and <a href="\/metrics\/">Metrics<\/a>/);
    assert.equal(rowsOf(ladder.slice(ladder.indexOf('<h2>Cells.</h2>')).split('</table>')[0]).length, 1 + SCENARIOS.rows[0].cells.length);

    // Linked from the Metrics index and Methodology; the top navigation is unchanged.
    for (const p of ['metrics/index.html', 'methodology/index.html']) assert.match(s.main(p), /<a href="\/scenarios\/">Scenarios<\/a>/, p);
    const nav = (/<nav[^>]*>([^]*?)<\/nav>/.exec(s.read('index.html')) || [])[1] || '';
    assert.doesNotMatch(nav, /scenarios/i, 'no top navigation entry');
  } finally { s.done(); }
});

test('with records: the index counts them, the row page lists nightlies newest first (at most 30), with reason words for a null', async () => {
  const dates = Array.from({ length: 35 }, (_, i) => addDays('2026-10-01', i));
  const NULL_DAY = dates[33];
  const records = dates.map(date => fakeScenarioRecord({ row: COMPACTION, date, value: () => (date === NULL_DAY ? null : 2), reason: () => 'no_event_prune' }));
  const s = await site(records);
  try {
    const ix = rowsOf(s.main('scenarios/index.html'));
    assert.ok(ix.some(r => r.startsWith('event-log-compaction ') && r.endsWith(`35 records, latest ${T.dLong(dates[34])}`)), ix.join(' | '));
    const page = s.main('scenarios/event-log-compaction/index.html');
    const sec = page.slice(page.indexOf('id="event_log_unpruned_days"'));
    assert.ok(!txt(sec).includes(EMPTY), 'no empty state');
    const nights = rowsOf(sec.slice(sec.indexOf('Nightlies.')).split('</table>')[0]);
    assert.equal(nights[0], 'Date Tag cmp');
    assert.equal(nights.length - 1, 30, 'the newest 30 only');
    assert.ok(nights[1].startsWith(T.dLong(dates[34])), 'newest first');
    assert.ok(nights[1].endsWith(`${txt(T.fmtU(2, UNPRUNED))} (3 valid)`), nights[1]);
    assert.ok(nights[2].startsWith(T.dLong(NULL_DAY)) && nights[2].endsWith(SCENARIO_REASON_WORDS.no_event_prune), nights[2]);
    assert.ok(!nights.some(r => r.startsWith(T.dLong(dates[4]))), 'older ones left out');
    const gz = gzipSync(s.read('scenarios/event-log-compaction/index.html'), { level: 9 }).length;
    assert.ok(gz <= BUDGETS.html, `${gz} B gzipped, over ${BUDGETS.html}`);
  } finally { s.done(); }
});

test('a metric with a target and a mapping in the catalogue shows both; a second version gets its own page', () => {
  const metricId = catalogue.targets[0].metric;
  const row = { ...COMPACTION, id: 'two-versions', version: 1, suite: 'two-versions@1', metrics: [metricId] };
  const v2 = { ...row, version: 2, suite: 'two-versions@2' };
  const pages = scenarioPages({ T, catFile: catalogue, read: () => null }, { rows: [row, v2] });
  const by = Object.fromEntries(pages.map(p => [p.path, p]));
  assert.ok(by['scenarios/two-versions/index.html'] && by['scenarios/two-versions/1/index.html'], Object.keys(by).join(' '));
  assert.match(by['scenarios/two-versions/index.html'].body, /<h1>two-versions, version 2\.<\/h1>/, 'the latest version at the row address');
  const body = txt(by['scenarios/two-versions/index.html'].body);
  assert.ok(body.includes(`Target: ${txt(catalogue.targets[0].text)}`));
  const mapping = catalogue.mappings.find(x => x.metric === metricId);
  assert.ok(body.includes(`Beside the ladder: ${txt(mapping.text)}`));
  assert.match(by['scenarios/index.html'].body, /href="\/scenarios\/two-versions\/1\/"/);
});

// A release measured at every level fits its 48 KB budget. The release file carries what the release page renders:
// the headline rows at every level, the rows beyond noise against the base at their own level, and agents_served at
// a level where the fork or its base is saturated (the page's saturated line quotes it), each with the fields
// site/build/render-post.mjs reads, written as compact JSON like every other data file. The comparison with the
// previous release reaches the page through the series files, never through this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as post from './release-post.mjs';
import { buildPostBundle } from './release-bundle.mjs';
import { buildReleases } from './release-build.mjs';
import { wideSource } from './release-fixtures/source.mjs';
import { loadApp } from './lib/app-vm.mjs';
import { releaseHTML } from './render-post.mjs';
import { noteOf, verdictOf } from '../../news/claims.mjs';
import { loadScanner } from '../../news/check.mjs';
import { validate } from '../../tools/t3cp/lib/validate.mjs';

const { BUDGET_BYTES, renderRelease } = post;
const serialiseRelease = (x) => post.serialiseRelease(x);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const json = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const catalogue = json('catalogue/catalogue.json');
const releaseSchema = json('schema/release-1.json');
const clean = () => [];
const moved = (v) => v === 'improved' || v === 'regressed';
const wide = () => buildPostBundle(wideSource(catalogue), { catalogue });
const key = (d) => `${d.metric}.${d.level}`;

// The rows and fields every release file carried before: a whole metric at every level once it moved anywhere,
// against the base or the previous release, with the comparison against the previous release in each row.
function previousForm(b) {
  const keep = (r) => r.headline != null || moved(verdictOf(r, 'base')) || moved(verdictOf(r, 'prev'));
  const ids = new Set(b.metrics.filter(keep).map((r) => r.id));
  return b.metrics.filter((r) => ids.has(r.id)).map((r) => ({
    metric: r.id, platform: r.platform, level: r.level, headline: r.headline,
    fork: r.value.fork, base: r.value.base, prev: r.value.prev, delta_pct: r.value.delta_pct,
    threshold_pct: r.value.threshold_pct, verdict: verdictOf(r, 'base'), note: verdictOf(r, 'base') ? r.note : noteOf(r, 'base'),
    delta_vs_prev_pct: r.value.delta_vs_prev_pct, verdict_vs_prev: verdictOf(r, 'prev'), note_vs_prev: verdictOf(r, 'prev') ? r.note_vs_prev : noteOf(r, 'prev'),
    saturated: { fork: r.saturated.fork, base: r.saturated.base, prev: r.saturated.prev },
    text: { fork: r.text.fork, base: r.text.base, prev: r.text.prev, delta_pct: r.text.delta_pct, threshold_pct: r.text.threshold_pct, delta_vs_prev_pct: r.text.delta_vs_prev_pct },
  }));
}

test('a release measured at every level, a whole metric table of rows, fits the unchanged 48 KB budget', () => {
  const b = wide();
  assert.ok(b.metrics.length >= 220, `a full table: ${b.metrics.length} rows`);
  assert.ok(Buffer.byteLength(serialiseRelease({ deltas: previousForm(b) })) > BUDGET_BYTES, 'the previous form of its rows alone is over the budget');
  assert.equal(BUDGET_BYTES, 48 * 1024);
  const rel = renderRelease({ bundle: b, source: null, scanText: clean });
  assert.ok(Buffer.byteLength(serialiseRelease(rel)) <= BUDGET_BYTES, `${Buffer.byteLength(serialiseRelease(rel))} bytes`);
  assert.deepEqual(validate(releaseSchema, rel), []);
});

test('the budget check itself is unchanged: a release over the budget is refused, naming its bytes and the budget', () => {
  assert.throws(() => renderRelease({ bundle: wide(), source: null, scanText: clean, budgetBytes: 1024 }), /^Error: release v0\.1\.9-perf\.8: \d+ bytes, over the 1024-byte budget$/);
});

test('its rows: the headline rows at every level, rows beyond noise against the base at their level, agents_served where saturated', () => {
  const b = wide();
  const rel = renderRelease({ bundle: b, source: null, scanText: clean });
  const sat = (r) => r.saturated.fork === true || r.saturated.base === true;
  const want = b.metrics.filter((r) => r.headline != null || moved(verdictOf(r, 'base')) || (r.id === 'agents_served' && sat(r)));
  assert.deepEqual(rel.deltas.map(key), want.map((r) => `${r.id}.${r.level}`));
  // A metric beyond noise at one level only is listed at that level only.
  const one = b.metrics.filter((r) => r.headline == null && moved(verdictOf(r, 'base')));
  assert.ok(one.length > 20, `rows beyond noise: ${one.length}`);
  for (const r of one) for (const o of b.metrics.filter((x) => x.id === r.id && x.level !== r.level && !moved(verdictOf(x, 'base')))) {
    assert.ok(!rel.deltas.some((d) => key(d) === `${o.id}.${o.level}`), `${o.id}.${o.level} is within noise there`);
  }
  // agents_served within noise at the saturated level is there for the saturated line; within noise elsewhere it is not.
  const served = rel.deltas.filter((d) => d.metric === 'agents_served');
  assert.ok(served.some((d) => d.level === '250' && d.verdict === 'within' && d.saturated.base === true), JSON.stringify(served));
  assert.ok(!rel.deltas.some((d) => d.verdict_vs_prev !== undefined), 'no comparison with the previous release in a row');
});

test('each row carries exactly the fields the release page reads', () => {
  const rel = renderRelease({ bundle: wide(), source: null, scanText: clean });
  for (const d of rel.deltas) {
    assert.deepEqual(Object.keys(d), ['metric', 'platform', 'level', 'headline', 'fork', 'base', 'delta_pct', 'threshold_pct', 'verdict', 'note', 'saturated', 'text'], key(d));
    assert.deepEqual(Object.keys(d.saturated), ['fork', 'base'], key(d));
    assert.deepEqual(Object.keys(d.text), ['fork', 'base', 'delta_pct'], key(d));
  }
});

test('schema/release-1.json still accepts a row in the previous form: the dropped fields are optional, never removed', () => {
  const b = wide();
  const rel = renderRelease({ bundle: b, source: null, scanText: clean });
  assert.deepEqual(validate(releaseSchema, { ...rel, deltas: previousForm(b).slice(0, 400) }), []);
});

test('the release page renders byte-identical, except the rows of its "Other metrics beyond noise" table', () => {
  const T = loadApp();
  const b = wide();
  const rel = renderRelease({ bundle: b, source: null, scanText: clean });
  const before = { ...rel, deltas: previousForm(b) };
  const TABLE = /<h3 class="mt3">Other metrics beyond noise<\/h3><div class="tw">.*?<\/table><\/div>/s;
  const rows = (html) => [...((TABLE.exec(html) || [''])[0]).matchAll(/<tr><td><a href="\/metrics\/([^/]+)\//g)].map((m) => m[1]);
  for (const level of ['1', '50', '100', '250']) {
    const ctx = { catalogue: catalogue.metrics, headlines: catalogue.headlines['linux-x64'], platform: 'linux-x64', level };
    const now = releaseHTML(T, rel, ctx).html;
    const then = releaseHTML(T, before, ctx).html;
    assert.equal(now.replace(TABLE, ''), then.replace(TABLE, ''), `level ${level}: everything but that table`);
    const listed = rel.deltas.filter((d) => d.level === level && d.headline == null).map((d) => d.metric);
    assert.deepEqual(rows(now).sort(), listed.sort(), `level ${level}: the table lists the rows the file carries`);
    for (const d of rel.deltas.filter((x) => x.level === level && x.headline == null)) assert.ok(moved(d.verdict) || d.metric === 'agents_served', `${key(d)} is beyond noise`);
    assert.ok(rows(then).length > rows(now).length, `level ${level}: the previous form listed rows within noise there`);
  }
});

test('every release on the committed data builds within the budget as compact JSON, or is pending with its reason', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'release-size-'));
  const lines = [];
  const res = await buildReleases({ inDir: path.join(ROOT, 'data', 'v1'), outDir, postsDir: path.join(ROOT, 'news', 'posts'), scanText: await loadScanner(ROOT), log: (l) => lines.push(l) });
  for (const r of res) {
    const text = readFileSync(r.file, 'utf8');
    const rel = JSON.parse(text);
    assert.equal(text, `${JSON.stringify(rel)}\n`, `${r.tag}: compact JSON`);
    assert.ok(Buffer.byteLength(text) <= BUDGET_BYTES, `${r.tag}: ${Buffer.byteLength(text)} bytes`);
    assert.deepEqual(validate(releaseSchema, rel), [], r.tag);
    if (r.charts_only_reason === 'pending' || r.charts_only_reason === 'no_base') {
      assert.ok(lines.some((l) => l.startsWith(`release-build: ${r.tag} pending: `) && l.length > `release-build: ${r.tag} pending: `.length), `${r.tag}: pending with a stated reason`);
    }
  }
});

test('agents_served at a saturated level is in the release even with no verdict anywhere, so the saturated line has its number', () => {
  const T = loadApp();
  const src = wideSource(catalogue, { servedBand: null });
  const b = buildPostBundle(src, { catalogue });
  assert.ok(!b.metrics.some((r) => r.id === 'agents_served'), 'the post bundle leaves it out: no verdict at any level');
  const rel = renderRelease({ bundle: b, source: null, scanText: clean, src });
  assert.deepEqual(validate(releaseSchema, rel), []);
  const served = rel.deltas.filter((d) => d.metric === 'agents_served');
  const at250 = src.metrics.find((m) => m.id === 'agents_served' && m.level === '250');
  assert.deepEqual(served.map((d) => [d.level, d.verdict, d.note, d.saturated.base, d.base]), [['250', null, 'no_band', true, at250.base.median]]);
  const ctx = { catalogue: catalogue.metrics, headlines: catalogue.headlines['linux-x64'], platform: 'linux-x64', level: '250' };
  const html = releaseHTML(T, rel, ctx).html;
  assert.match(html, new RegExp(`saturated: ${T.fmt(at250.base.median).replace(/[.]/g, '[.]')} of 250 agents served by its base`));
  assert.doesNotMatch(html, /\? of 250 agents/);
  // Within the bundle it is the bundle's own row; never twice.
  const withBand = wideSource(catalogue);
  const relBand = renderRelease({ bundle: buildPostBundle(withBand, { catalogue }), source: null, scanText: clean, src: withBand });
  assert.deepEqual(relBand.deltas.filter((d) => d.metric === 'agents_served').map((d) => d.level), ['250']);
});

test('over budget: the size check throws a BudgetError with its bytes, and the over_budget form keeps the headline rows', () => {
  const b = wide();
  let err;
  try { renderRelease({ bundle: b, source: null, scanText: clean, budgetBytes: 1024 }); } catch (e) { err = e; }
  assert.ok(err instanceof post.BudgetError, String(err));
  assert.equal(err.budget, 1024);
  assert.ok(err.bytes > 1024);
  const rel = renderRelease({ bundle: b, source: null, scanText: clean, overBudget: true });
  assert.deepEqual(validate(releaseSchema, rel), []);
  assert.equal(rel.charts_only_reason, 'over_budget');
  assert.deepEqual(rel.deltas.map(key), b.metrics.filter((r) => r.headline != null || (r.id === 'agents_served' && (r.saturated.fork === true || r.saturated.base === true))).map((r) => `${r.id}.${r.level}`));
  // A schema or scan failure is never a BudgetError: it still stops the build.
  assert.throws(() => renderRelease({ bundle: b, source: null, scanText: () => [{ id: 'x' }] }), (e) => !(e instanceof post.BudgetError));
});

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
const pageCtx = (level) => ({ catalogue: catalogue.metrics, headlines: catalogue.headlines['linux-x64'], platform: 'linux-x64', level });
const OTHERS = /<h3 class="mt3">Other metrics beyond noise<\/h3><div class="tw">.*?<\/table><\/div>/s;
const othersListed = (html) => [...((OTHERS.exec(html) || [''])[0]).matchAll(/<tr><td><a href="\/metrics\/([^/]+)\//g)].map((m) => m[1]);

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

test('the release page renders the same from the previous form and from this one; "Other metrics beyond noise" lists only rows beyond noise', () => {
  const T = loadApp();
  const b = wide();
  const rel = renderRelease({ bundle: b, source: null, scanText: clean });
  const before = { ...rel, deltas: previousForm(b) };
  for (const level of ['1', '50', '100', '250']) {
    const now = releaseHTML(T, rel, pageCtx(level)).html;
    assert.equal(now, releaseHTML(T, before, pageCtx(level)).html, `level ${level}`);
    const beyond = rel.deltas.filter((d) => d.level === level && d.headline == null && moved(d.verdict)).map((d) => d.metric);
    assert.ok(beyond.length > 0 || level === '250', `level ${level}: rows beyond noise`);
    assert.deepEqual(othersListed(now).sort(), beyond.sort(), `level ${level}: that table lists exactly the rows beyond noise`);
  }
});

test('a row kept only for the saturated line feeds that line and is never listed beyond noise, in both forms', () => {
  const T = loadApp();
  const b = wide();
  for (const form of [{}, { overBudget: true }]) {
    const rel = renderRelease({ bundle: b, source: null, scanText: clean, ...form });
    const served = rel.deltas.find((d) => d.metric === 'agents_served' && d.level === '250');
    assert.ok(served && served.saturated.base === true && !moved(served.verdict), JSON.stringify(served));
    const html = releaseHTML(T, rel, pageCtx('250')).html;
    assert.match(html, new RegExp(`saturated: ${T.fmt(served.base).replace(/[.]/g, '[.]')} of 250 agents served by its base`), JSON.stringify(form));
    assert.ok(!othersListed(html).includes('agents_served'), `${JSON.stringify(form)}: ${othersListed(html)}`);
  }
});

test('agents_served beyond noise at the saturated level feeds the line and is listed beyond noise, in both forms', () => {
  const T = loadApp();
  const b = buildPostBundle(wideSource(catalogue, { servedMoves: true }), { catalogue });
  for (const form of [{}, { overBudget: true }]) {
    const rel = renderRelease({ bundle: b, source: null, scanText: clean, ...form });
    const served = rel.deltas.find((d) => d.metric === 'agents_served' && d.level === '250');
    assert.ok(served && served.saturated.base === true && moved(served.verdict), JSON.stringify(served));
    const html = releaseHTML(T, rel, pageCtx('250')).html;
    assert.match(html, new RegExp(`saturated: ${T.fmt(served.base).replace(/[.]/g, '[.]')} of 250 agents served by its base`), JSON.stringify(form));
    assert.ok(othersListed(html).includes('agents_served'), `${JSON.stringify(form)}: ${othersListed(html)}`);
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
    // Over budget is an alert (CI's release budget step warns), never a failure here.
    if (r.over_budget_bytes === undefined) assert.ok(Buffer.byteLength(text) <= BUDGET_BYTES, `${r.tag}: ${Buffer.byteLength(text)} bytes`);
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

test('over budget, on the page: the footer says why, the headline table stays, no other row', () => {
  const T = loadApp();
  const rel = renderRelease({ bundle: wide(), source: null, scanText: clean, overBudget: true });
  for (const level of ['1', '50', '100', '250']) {
    const ctx = { catalogue: catalogue.metrics, headlines: catalogue.headlines['linux-x64'], platform: 'linux-x64', level };
    const html = releaseHTML(T, rel, ctx).html;
    assert.match(html, /Charts only: this release is over its page&#39;s size budget, so only the headline metrics are listed; its changelog is on GitHub\./);
    const others = (/<h3 class="mt3">Other metrics beyond noise<\/h3>(.*?)<\/table>/s.exec(html) || ['', ''])[1];
    const listed = [...others.matchAll(/<tr><td><a href="\/metrics\/([^/]+)\//g)].map((m) => m[1]);
    // agents_served stays at the saturated level (250 here) for the saturated line, never in that table.
    assert.deepEqual(listed, [], `level ${level}`);
    assert.match(html, /<table class="dt">/, `level ${level}: the headline table`);
  }
});

test('fail closed before size: a scan hit in a row the over_budget form would drop still stops the build', () => {
  const b = wide();
  const row = b.metrics.find((r) => r.headline == null && moved(verdictOf(r, 'base')));
  const hit = (t) => (String(t).includes(row.id) ? [{ id: 'name' }] : []);
  assert.throws(() => renderRelease({ bundle: b, source: null, scanText: hit, budgetBytes: 1024 }), (e) => !(e instanceof post.BudgetError) && /fails the internal-name scan/.test(e.message));
});

test('over budget, never fatal: the over_budget form is validated and scanned, and written even if still over the budget', () => {
  const b = wide();
  const rel = renderRelease({ bundle: b, source: null, scanText: clean, budgetBytes: 1024, overBudget: true });
  assert.equal(rel.charts_only_reason, 'over_budget');
  assert.ok(Buffer.byteLength(serialiseRelease(rel)) > 1024, 'still over that budget, and returned');
  assert.throws(() => renderRelease({ bundle: b, source: null, scanText: () => [{ id: 'x' }], budgetBytes: 1024, overBudget: true }), /fails the internal-name scan/);
});

// A changelog at the schema's limit in a script that compresses poorly: 40 lines of 399 characters (invented text).
const LONG = Array.from({ length: 40 }, (_, i) => `${'変更'.repeat(199)}${i % 10}`);

test('over budget at the real budget: a long changelog; the over_budget form drops it, fits by construction, and its page fits the HTML budget', async () => {
  const { gzipSync } = await import('node:zlib');
  const { BUDGETS } = await import('./budgets.mjs');
  const T = loadApp();
  const b = buildPostBundle(wideSource(catalogue), { catalogue, changelog: LONG, scanText: clean });
  assert.throws(() => renderRelease({ bundle: b, source: null, scanText: clean }), post.BudgetError);
  const rel = renderRelease({ bundle: b, source: null, scanText: clean, overBudget: true });
  assert.equal(rel.charts_only_reason, 'over_budget');
  assert.deepEqual(rel.changelog, []);
  assert.ok(Buffer.byteLength(serialiseRelease(rel)) <= BUDGET_BYTES, `${Buffer.byteLength(serialiseRelease(rel))} bytes`);
  for (const level of ['1', '50', '100', '250']) {
    const gz = gzipSync(releaseHTML(T, rel, pageCtx(level)).html).length;
    assert.ok(gz <= BUDGETS.html, `level ${level}: ${gz} bytes gzipped`);
  }
});

test('a pending release over budget keeps its pending form without the changelog, and its footer says why', () => {
  const b = buildPostBundle(wideSource(catalogue), { catalogue, changelog: LONG, scanText: clean, pending: true });
  assert.equal(b.pending, true);
  assert.throws(() => renderRelease({ bundle: b, source: null, scanText: clean }), post.BudgetError);
  const rel = renderRelease({ bundle: b, source: null, scanText: clean, overBudget: true });
  assert.deepEqual(validate(releaseSchema, rel), []);
  assert.equal(rel.charts_only_reason, 'pending');
  assert.deepEqual(rel.deltas, []);
  assert.deepEqual(rel.changelog, []);
  assert.match(rel.checker.footer, /^Comparison pending: the measured records for this release are not complete yet\. Its changelog is over this page's size budget; it is on GitHub\.$/);
  assert.ok(Buffer.byteLength(serialiseRelease(rel)) <= BUDGET_BYTES);
});

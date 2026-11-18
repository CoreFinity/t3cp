// Tests for site/build/release-post.mjs: the two-attempt rule recorded in news/posts/<tag>.json, and
// renderRelease(), which turns a source and a bundle into the published t3cp/release/1 file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runPost, renderRelease } from './release-post.mjs';
import { buildPostBundle } from './release-bundle.mjs';
import { source } from './release-fixtures/source.mjs';
import { validate } from '../../tools/t3cp/lib/validate.mjs';

const json = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const catalogue = json('../../catalogue/catalogue.json');
const releaseSchema = json('../../schema/release-1.json');
const sourceSchema = json('../../news/post-source-1.json');
const clean = () => [];
const TAG = 'v0.1.9-perf.8';
// These tests read the 100-agent counts and claims; the default level (50) is covered by news/headline-50.test.mjs.
const bundle = () => buildPostBundle(source(), { catalogue, headline: '100' });
const NOW = () => '2026-11-16T00:00:00.000Z';

const sha = (b) => b.bundle_sha256;
const goodPost = (b = bundle()) => ({
  bundle_sha256: sha(b),
  summary: '{claim:reader_tx_wait_p95_ms.linux-x64.100.base}. {claim:rss_peak_mib.linux-x64.250.base}. {claim:turns_completed.linux-x64.100.base}.',
  sections: [
    { chart_id: 'fork-vs-base.reader_tx_wait_p95_ms.ladder.linux-x64', caption: '{claim:reader_tx_wait_p95_ms.linux-x64.250.base}.' },
    { chart_id: 'fork-vs-base.turns_completed.ladder.linux-x64', caption: '{claim:turns_completed.linux-x64.250.base}.' },
    { chart_id: 'fork-vs-base.writer_tx_p95_ms.ladder.linux-x64', caption: '{claim:writer_tx_p95_ms.linux-x64.100.base}.' },
    { chart_id: 'fork-vs-base.rss_peak_mib.ladder.linux-x64', caption: 'In this chart: {claim:rss_peak_mib.linux-x64.250.base}.' },
  ],
});
const badPost = (word = 'dramatically', b = bundle()) => ({ ...goodPost(b), summary: `A ${word} good run: {claim:turns_completed.linux-x64.100.base}.` });

function dirs() {
  const root = mkdtempSync(path.join(tmpdir(), 'release-post-'));
  return { root, postsDir: path.join(root, 'posts') };
}
const run = (d, post, extra = {}) => runPost({ bundle: bundle(), post, postsDir: d.postsDir, scanText: clean, repoRoot: d.root, now: NOW, ...extra });
const srcFile = (d) => path.join(d.postsDir, `${TAG}.json`);
const readSrc = (d) => JSON.parse(readFileSync(srcFile(d), 'utf8'));
const render = (src, b = bundle(), extra = {}) => renderRelease({ bundle: b, source: src, scanText: clean, ...extra });

test('a passing post writes news/posts/<tag>.json with the text and its checker record', async () => {
  const d = dirs();
  const r = await run(d, goodPost());
  assert.equal(r.status, 'passed', JSON.stringify(r));
  const s = readSrc(d);
  assert.deepEqual(validate(sourceSchema, s), []);
  assert.equal(s.status, 'passed');
  assert.deepEqual(s.post, goodPost());
  assert.equal(s.checker.passed, true);
  assert.equal(s.checker.written_in_session, true);
  assert.equal(s.attempts.length, 1);
  assert.equal(s.synthetic, true);
});

test('renderRelease turns a passed source into the published file, valid against schema/release-1.json', async () => {
  const d = dirs();
  await run(d, goodPost());
  const rel = render(readSrc(d));
  assert.deepEqual(validate(releaseSchema, rel), []);
  assert.equal(rel.charts_only, false);
  assert.equal(rel.charts_only_reason, null);
  assert.equal(rel.post.title, 'v0.1.9-perf.8: 0 regressed, 3 improved, 4 within noise (vs v0.1.9-nightly.20261114.4700)');
  assert.equal(rel.post.summary.split('. ').length, 3);
  assert.match(rel.post.summary, /^Reader lock wait p95 at 100 agents: 260 ms on the upstream base, 120 ms on perf\.8, \u221253\.8%, improved beyond noise\. /);
  assert.equal(rel.post.sections[3].caption, 'In this chart: Peak RSS at 250 agents: 1,240 MiB on the upstream base, 1,530 MiB on perf.8, +23.4%, regressed beyond noise.');
  assert.ok(!JSON.stringify(rel.post).includes('{claim:'));
  assert.equal(rel.checker.passed, true);
  assert.equal(rel.checker.written_in_session, true);
  assert.equal(rel.checker.prompt_sha256, undefined);
  assert.equal(rel.checker.attempts, 1);
  assert.match(rel.checker.footer, /checked against it: \d+ numbers, 4 charts, 0 findings/);
  assert.ok(rel.deltas.some((x) => x.metric === 'db_ready_warm_ms' && x.level === 'once'), 'headline rows kept');
  assert.ok(rel.deltas.some((x) => x.metric === 'writer_tx_p95_ms'), 'a non-headline metric beyond noise kept');
  assert.ok(!rel.deltas.some((x) => x.metric === 'stall_share_40ms'), 'a non-headline metric within noise dropped');
});

test('a first failure records the attempt without the post text and publishes nothing new', async () => {
  const d = dirs();
  const r = await run(d, badPost());
  assert.equal(r.status, 'retry');
  assert.ok(r.result.findings.length > 0);
  const s = readSrc(d);
  assert.deepEqual(validate(sourceSchema, s), []);
  assert.equal(s.status, 'retry');
  assert.equal(s.post, null);
  assert.ok(!JSON.stringify(s).includes('good run'), 'the source keeps the failed post\'s hash, not its text');
  const rel = render(s);
  assert.equal(rel.charts_only, true);
  assert.equal(rel.charts_only_reason, 'no_text_yet');
});

test('a second failure records charts_only; the render ships the charts-only form with the finding count only', async () => {
  const d = dirs();
  await run(d, badPost());
  const r = await run(d, badPost('significantly'));
  assert.equal(r.status, 'charts-only');
  const s = readSrc(d);
  assert.equal(s.status, 'charts_only');
  const rel = render(s);
  assert.deepEqual(validate(releaseSchema, rel), []);
  assert.equal(rel.charts_only, true);
  assert.equal(rel.charts_only_reason, 'checker_failed');
  assert.equal(rel.post.title, 'v0.1.9-perf.8: 0 regressed, 3 improved, 4 within noise (vs v0.1.9-nightly.20261114.4700)');
  assert.ok(!rel.post.summary.includes('good run'), 'the fallback carries rendered claims only');
  assert.match(rel.post.summary, /^Reader lock wait p95 at 100 agents: /);
  const b = bundle();
  const headline = new Set(b.metrics.filter((m) => m.headline != null).map((m) => m.id));
  assert.equal(rel.post.sections.length, 8);
  for (const sec of rel.post.sections) {
    const chart = b.charts.find((c) => c.id === sec.chart_id);
    assert.ok(chart && headline.has(chart.metric));
    assert.equal(sec.caption, chart.caption);
    assert.ok(!/\{claim:/.test(sec.caption));
  }
  assert.equal(rel.checker.passed, false);
  assert.equal(rel.checker.attempts, 2);
  // The findings are recorded by rule in the source file only; the release carries none, the footer counts them.
  assert.ok(readSrc(d).attempts.at(-1).findings.some((f) => f.rule === 'banned'));
  assert.deepEqual(rel.checker.findings, []);
  assert.match(rel.checker.footer, /^Charts only: the written text did not pass the checker \([1-9]\d* findings\)/);
});

test('after two failures no third attempt is taken, even for a passing post', async () => {
  const d = dirs();
  await run(d, badPost());
  await run(d, badPost('significantly'));
  const r = await run(d, goodPost());
  assert.equal(r.status, 'charts-only');
  assert.equal(readSrc(d).attempts.length, 2);
});

test('resubmitting an identical failed post is not a new attempt', async () => {
  const d = dirs();
  await run(d, badPost());
  const r = await run(d, badPost());
  assert.equal(r.status, 'retry');
  assert.equal(readSrc(d).attempts.length, 1);
});

test('after a pass the same post leaves the source byte for byte and a different post is refused', async () => {
  const d = dirs();
  await run(d, goodPost());
  const first = readFileSync(srcFile(d), 'utf8');
  assert.equal((await run(d, goodPost(), { now: () => '2026-11-17T00:00:00.000Z' })).status, 'passed');
  assert.equal(readFileSync(srcFile(d), 'utf8'), first);
  const other = goodPost();
  other.sections.pop();
  assert.equal((await run(d, other)).status, 'refused');
});

test('a synthetic bundle is never written under news/posts or data/ of the repository', async () => {
  for (const sub of [['news', 'posts'], ['data', 'v1']]) {
    const d = dirs();
    const r = await run(d, goodPost(), { postsDir: path.join(d.root, ...sub) });
    assert.equal(r.status, 'refused');
    assert.match(r.message, /synthetic/);
    assert.ok(!existsSync(path.join(d.root, sub[0])));
  }
});

test('a missing scanner refuses before checking and records nothing', async () => {
  const d = dirs();
  const r = await run(d, goodPost(), { scanText: null });
  assert.equal(r.status, 'refused');
  assert.ok(!existsSync(srcFile(d)));
});

test('an impossible bundle (no allowed numbers) ends charts-only after exactly one retry', async () => {
  const d = dirs();
  const b = { ...bundle(), allowed_numbers: [] };
  const first = await runPost({ bundle: b, post: goodPost(b), postsDir: d.postsDir, scanText: clean, repoRoot: d.root, now: NOW });
  assert.equal(first.status, 'retry');
  const p2 = goodPost(b);
  p2.sections.pop();
  const second = await runPost({ bundle: b, post: p2, postsDir: d.postsDir, scanText: clean, repoRoot: d.root, now: NOW });
  assert.equal(second.status, 'charts-only');
  const rel = render(readSrc(d), b);
  assert.equal(rel.charts_only_reason, 'checker_failed');
  assert.ok(readSrc(d).attempts.at(-1).findings.some((f) => f.rule === 'number-not-allowed'));
  assert.deepEqual(rel.checker.findings, []);
});

test('no source renders the charts-only form with no_text_yet', () => {
  const rel = render(null);
  assert.deepEqual(validate(releaseSchema, rel), []);
  assert.equal(rel.charts_only_reason, 'no_text_yet');
  assert.equal(rel.checker.attempts, 0);
  assert.deepEqual(rel.checker.findings, []);
  assert.match(rel.checker.footer, /no text has been written/);
});

test('text written from another bundle renders stale', async () => {
  const d = dirs();
  await run(d, goodPost());
  const rebuilt = buildPostBundle(source(), { catalogue, headline: '100', bundleSha256: 'b'.repeat(64) });
  const rel = render(readSrc(d), rebuilt);
  assert.deepEqual(validate(releaseSchema, rel), []);
  assert.equal(rel.charts_only, true);
  assert.equal(rel.charts_only_reason, 'stale');
  assert.deepEqual(rel.checker.findings, []);
  assert.match(rel.checker.footer, /no longer matches the measured record \([1-9]\d* findings\)/);
});

test('a render over the size budget is refused, and the same inputs render the same bytes', async () => {
  const d = dirs();
  await run(d, goodPost());
  assert.throws(() => render(readSrc(d), bundle(), { budgetBytes: 2000 }), /budget/);
  assert.equal(JSON.stringify(render(readSrc(d))), JSON.stringify(render(readSrc(d))));
});

// ---- The CI path: provenance, failed answers, the decision, and pending comparisons. ----

test('a post from the model records the prompt sha256, the model and its usage; the release carries prompt_sha256', async () => {
  const d = dirs();
  const provenance = { prompt_sha256: 'e'.repeat(64), model: 'claude-opus-5-5', usage: { input_tokens: 15000, output_tokens: 900 } };
  const r = await run(d, goodPost(), { provenance });
  assert.equal(r.status, 'passed');
  const s = readSrc(d);
  assert.deepEqual(validate(sourceSchema, s), []);
  assert.equal(s.checker.prompt_sha256, 'e'.repeat(64));
  assert.equal(s.checker.written_in_session, undefined);
  assert.deepEqual(s.checker.usage, { input_tokens: 15000, output_tokens: 900 });
  const rel = render(s);
  assert.equal(rel.checker.prompt_sha256, 'e'.repeat(64));
  assert.equal(rel.checker.written_in_session, undefined);
  assert.deepEqual(validate(releaseSchema, rel), []);
});

test('a refusal or an unparseable answer is a failed attempt; two of them end charts_only', async () => {
  const d = dirs();
  const provenance = { prompt_sha256: 'e'.repeat(64), model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 0 } };
  const first = await run(d, null, { failure: { rule: 'refusal', detail: 'the request was declined' }, provenance });
  assert.equal(first.status, 'retry');
  const second = await run(d, null, { failure: { rule: 'refusal', detail: 'the request was declined' }, provenance });
  assert.equal(second.status, 'charts-only');
  const s = readSrc(d);
  assert.equal(s.status, 'charts_only');
  assert.deepEqual(s.attempts.map((a) => a.findings[0].rule), ['refusal', 'refusal']);
  const rel = render(s);
  assert.equal(rel.charts_only_reason, 'checker_failed');
  assert.deepEqual(validate(releaseSchema, rel), []);
});

test('decision() says what the source decided for this bundle', async () => {
  const { decision } = await import('./release-post.mjs');
  const d = dirs();
  assert.equal(decision({ bundle: bundle(), postsDir: d.postsDir }), null);
  await run(d, badPost());
  assert.equal(decision({ bundle: bundle(), postsDir: d.postsDir }), null);
  await run(d, badPost('significantly'));
  assert.equal(decision({ bundle: bundle(), postsDir: d.postsDir }), 'charts_only');
  const e = dirs();
  await run(e, goodPost());
  assert.equal(decision({ bundle: bundle(), postsDir: e.postsDir }), 'passed');
  assert.equal(decision({ bundle: buildPostBundle(source({ prev: false }), { catalogue }), postsDir: e.postsDir }), null, 'a new bundle starts again');
});

test('a pending comparison: no post is recorded, and the release renders tag, date, changelog and charts with no claims', async () => {
  const pend = buildPostBundle(source({ prev: false }), { catalogue, pending: true });
  assert.equal(pend.pending, true);
  const d = dirs();
  const r = await runPost({ bundle: pend, post: goodPost(pend), postsDir: d.postsDir, scanText: clean, repoRoot: d.root, now: NOW });
  assert.equal(r.status, 'refused');
  assert.match(r.message, /pending/);
  const rel = render(null, pend);
  assert.deepEqual(validate(releaseSchema, rel), []);
  assert.equal(rel.charts_only, true);
  assert.equal(rel.charts_only_reason, 'pending');
  assert.equal(rel.post.title, 'v0.1.9-perf.8: comparison pending');
  assert.equal(rel.post.summary, null);
  assert.deepEqual(rel.deltas, []);
  assert.ok(rel.post.sections.length >= 1 && rel.post.sections.every((s) => /^[^:%]+ by nightly, perf\.8 marked\.$/.test(s.caption)), 'no claims, no numbers');
  assert.match(rel.checker.footer, /^Comparison pending/);
});

test('the bundle is pending when the base is missing or the previous release is not the one before', () => {
  const noBase = { ...source(), base: null, metrics: source().metrics.map((m) => ({ ...m, base: null, verdict: null, note: 'no_reference', delta_pct: null, worse_pct: null, text: { ...m.text, base: null, delta_pct: null } })) };
  assert.equal(buildPostBundle(noBase, { catalogue }).pending, true);
  const skipped = { ...source(), prev: { tag: 'v0.1.7-perf.6', date: '2026-11-08' } };
  assert.equal(buildPostBundle(skipped, { catalogue }).pending, true);
  const first = { ...source({ prev: false }), release: { ...source().release, tag: 'v0.1.6-perf.1' } };
  assert.equal(buildPostBundle(first, { catalogue }).pending, false, 'the first release has no previous one');
  assert.equal(buildPostBundle(source(), { catalogue }).pending, false);
});

test('a model\'s second answer counts as attempt 2 even when it repeats the first', async () => {
  const d = dirs();
  const provenance = { prompt_sha256: 'e'.repeat(64), model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } };
  assert.equal((await run(d, badPost(), { provenance })).status, 'retry');
  assert.equal((await run(d, badPost(), { provenance })).status, 'charts-only');
  assert.equal(readSrc(d).attempts.length, 2);
});

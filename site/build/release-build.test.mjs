// Tests for site/build/release-build.mjs on a synthetic input tree from tools/t3cp/dev/synth-data.mjs.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildReleases } from './release-build.mjs';
import { buildPostBundle, loadSource } from './release-bundle.mjs';
import { runPost } from './release-post.mjs';
import { validate } from '../../tools/t3cp/lib/validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const catalogue = json(path.join(ROOT, 'catalogue', 'catalogue.json'));
const releaseSchema = json(path.join(ROOT, 'schema', 'release-1.json'));
const clean = () => [];
let inDir;

before(() => {
  const out = mkdtempSync(path.join(tmpdir(), 'release-build-data-'));
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 't3cp', 'dev', 'synth-data.mjs'), '--out', out], { stdio: 'ignore' });
  inDir = path.join(out, 'input', 'v1');
});

const fresh = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'release-build-'));
  const postsDir = path.join(root, 'posts');
  mkdirSync(postsDir);
  return { root, postsDir, outDir: path.join(root, 'dist', 'data', 'v1', 'releases') };
};
const build = (d, extra = {}) => buildReleases({ inDir, outDir: d.outDir, postsDir: d.postsDir, dev: true, scanText: clean, ...extra });

const PERF8 = 'v0.1.9-perf.8';
async function writePassingPost(d) {
  const { recordsDigest } = await import('./release-bundle.mjs');
  const src = await loadSource({ dataDir: inDir, tag: PERF8, dev: true });
  const b = buildPostBundle(src, { catalogue, bundleSha256: recordsDigest({ dataDir: inDir, tag: PERF8, prevTag: src.prev.tag }) });
  const post = {
    bundle_sha256: b.bundle_sha256,
    summary: '{claim:turns_completed.linux-x64.100.base}.',
    sections: [{ chart_id: 'fork-vs-base.turns_completed.ladder.linux-x64', caption: '{claim:turns_completed.linux-x64.250.base}.' }],
  };
  const r = await runPost({ bundle: b, post, postsDir: d.postsDir, scanText: clean, repoRoot: d.root, now: () => '2026-11-16T00:00:00.000Z' });
  assert.equal(r.status, 'passed', JSON.stringify(r.result && r.result.findings));
}

test('one release file per fork tag, each valid; with no sources every one is charts-only, no_text_yet', async () => {
  const d = fresh();
  const res = await build(d);
  const files = readdirSync(d.outDir).sort();
  assert.equal(files.length, 8);
  assert.ok(files.includes(`${PERF8}.json`));
  for (const f of files) {
    const rel = json(path.join(d.outDir, f));
    assert.deepEqual(validate(releaseSchema, rel), [], f);
    assert.equal(rel.synthetic, true);
    assert.equal(rel.charts_only_reason, 'no_text_yet');
  }
  assert.equal(res.length, 8);
});

test('a passed source publishes its text after the build re-runs the checker', async () => {
  const d = fresh();
  await writePassingPost(d);
  await build(d, { tags: ['v0.1.9-perf.7', PERF8] });
  const rel = json(path.join(d.outDir, `${PERF8}.json`));
  assert.equal(rel.charts_only, false);
  assert.equal(rel.checker.passed, true);
  assert.equal(json(path.join(d.outDir, 'v0.1.9-perf.7.json')).charts_only_reason, 'no_text_yet');
});

test('a source whose text no longer passes against the data publishes charts-only, stale', async () => {
  const d = fresh();
  await writePassingPost(d);
  const file = path.join(d.postsDir, `${PERF8}.json`);
  const src = json(file);
  src.post.summary = `${src.post.summary} A further 12 turns.`;
  writeFileSync(file, JSON.stringify(src));
  await build(d, { tags: [PERF8] });
  const rel = json(path.join(d.outDir, `${PERF8}.json`));
  assert.equal(rel.charts_only_reason, 'stale');
  // A release never carries findings; the footer counts them.
  assert.deepEqual(rel.checker.findings, []);
  assert.match(rel.checker.footer, /no longer matches the measured record \([1-9]\d* findings\)/);
});

test('fails closed: a synthetic source in a real build, a source with no fork record, no scanner', async () => {
  const d = fresh();
  await writePassingPost(d);
  await assert.rejects(build(d, { dev: false }), /synthetic|not a synthetic|dev/);
  const e = fresh();
  writeFileSync(path.join(e.postsDir, 'v0.1.9-perf.99.json'), JSON.stringify({ schema: 't3cp/post-source/1', tag: 'v0.1.9-perf.99', synthetic: true, status: 'retry', post: null, changelog: [], checker: null, attempts: [] }));
  await assert.rejects(build(e), /perf\.99/);
  await assert.rejects(build(fresh(), { scanText: null }), /scanner/);
});

test('the same inputs build the same bytes', async () => {
  const a = fresh();
  const b = fresh();
  await writePassingPost(a);
  await writePassingPost(b);
  await build(a);
  await build(b);
  for (const f of readdirSync(a.outDir)) assert.equal(readFileSync(path.join(a.outDir, f), 'utf8'), readFileSync(path.join(b.outDir, f), 'utf8'), f);
});

test('bundle_sha256 is the records digest tick computes: sha256 over sorted "<public path> <sha256 of bytes>" lines', async () => {
  const { recordsDigest } = await import('./release-bundle.mjs');
  const { createHash: h } = await import('node:crypto');
  const sha = (b) => h('sha256').update(b).digest('hex');
  const fork = JSON.parse(readFileSync(path.join(inDir, 'fork', `${PERF8}.linux-x64.json`), 'utf8'));
  // The base is its own record (base/<merge-base sha12>) when the data has one, else the base nightly's record.
  const baseRel = existsSync(path.join(inDir, 'base', `${fork.base.sha.slice(0, 12)}.linux-x64.json`))
    ? `base/${fork.base.sha.slice(0, 12)}.linux-x64.json` : `records/linux-x64/${fork.base.date}.${fork.base.tag}.json`;
  const files = [`fork/${PERF8}.linux-x64.json`, baseRel, 'fork/v0.1.9-perf.7.linux-x64.json'];
  const lines = files.map((f) => `data/v1/${f} ${sha(readFileSync(path.join(inDir, f)))}`).sort();
  const want = sha(`${lines.join('\n')}\n`);
  assert.equal(recordsDigest({ dataDir: inDir, tag: PERF8, prevTag: 'v0.1.9-perf.7' }), want);
  const src = await loadSource({ dataDir: inDir, tag: PERF8, dev: true });
  const b = buildPostBundle(src, { catalogue, bundleSha256: want });
  assert.equal(b.bundle_sha256, want);
  assert.equal(recordsDigest({ dataDir: inDir, tag: PERF8, prevTag: 'v0.1.9-perf.99' }), null, 'a missing record gives no digest');
  assert.equal(buildPostBundle(src, { catalogue, bundleSha256: null }).pending, true);
});

// ---- Pending comparisons and broken inputs, through the real aggregator path. ----
import { cpSync, rmSync } from 'node:fs';

const copyData = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'release-build-copy-'));
  cpSync(inDir, d, { recursive: true });
  return d;
};
const baseRelOf = (dir) => {
  const fork = JSON.parse(readFileSync(path.join(dir, 'fork', `${PERF8}.linux-x64.json`), 'utf8'));
  return path.join('base', `${fork.base.sha.slice(0, 12)}.linux-x64.json`);
};
const editJson = (file, fn) => { const j = JSON.parse(readFileSync(file, 'utf8')); fn(j); writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`); };
const reasonsOf = async (dir, postsDir) => {
  const d = fresh();
  const res = await buildReleases({ inDir: dir, outDir: d.outDir, postsDir: postsDir ?? d.postsDir, dev: true, scanText: clean, tags: [PERF8] });
  return Object.fromEntries(res.map((r) => [r.tag, r.charts_only_reason ?? 'text']));
};

test('pending: a deleted base record never crashes the build; the release renders pending', async () => {
  const dir = copyData();
  rmSync(path.join(dir, baseRelOf(dir)));
  const reasons = await reasonsOf(dir);
  assert.equal(reasons[PERF8], 'pending');
  const d = fresh();
  await buildReleases({ inDir: dir, outDir: d.outDir, postsDir: d.postsDir, dev: true, scanText: clean, tags: [PERF8] });
  const rel = json(path.join(d.outDir, `${PERF8}.json`));
  assert.deepEqual(validate(releaseSchema, rel), []);
  assert.match(rel.post.title, /comparison pending/);
});

test('pending: a base record that is partial, or lacks a headline-level cell, makes the release pending', async () => {
  for (const edit of [(j) => { j.status = 'partial'; j.status_reason = 'preempted'; }, (j) => { delete j.cells['100']; }, (j) => { delete j.cells['250']; }, (j) => { j.cells['1'].valid = 1; }]) {
    const dir = copyData();
    editJson(path.join(dir, baseRelOf(dir)), edit);
    assert.equal((await reasonsOf(dir))[PERF8], 'pending');
  }
});

test('pending: a partial fork record or an incomplete previous record makes the release pending', async () => {
  const a = copyData();
  editJson(path.join(a, 'fork', `${PERF8}.linux-x64.json`), (j) => { j.status = 'partial'; j.status_reason = 'preempted'; });
  assert.equal((await reasonsOf(a))[PERF8], 'pending');
  const b = copyData();
  editJson(path.join(b, 'fork', 'v0.1.9-perf.7.linux-x64.json'), (j) => { delete j.cells['250']; });
  assert.equal((await reasonsOf(b))[PERF8], 'pending');
});

test('recordsDigest uses the base record only: with it deleted there is no digest, even with the base nightly present', async () => {
  const { recordsDigest } = await import('./release-bundle.mjs');
  const dir = copyData();
  rmSync(path.join(dir, baseRelOf(dir)));
  assert.equal(recordsDigest({ dataDir: dir, tag: PERF8, prevTag: 'v0.1.9-perf.7' }), null);
});

test('a malformed news/posts file fails only its release, and the error names the file', async () => {
  const d = fresh();
  writeFileSync(path.join(d.postsDir, `${PERF8}.json`), '{"schema": "t3cp/post-source/1", "tag": ');
  const res = await buildReleases({ inDir, outDir: d.outDir, postsDir: d.postsDir, dev: true, scanText: clean });
  const r8 = res.find((r) => r.tag === PERF8);
  assert.equal(r8.charts_only_reason, 'no_text_yet');
  assert.match(r8.error, new RegExp(`news/posts/${PERF8.replace(/\./g, '\\.')}\\.json`));
  assert.equal(res.length, 8);
});

test('a charts_only decision made against older data renders no_text_yet against new data, never checker_failed', async () => {
  const d = fresh();
  const { recordsDigest } = await import('./release-bundle.mjs');
  const src = await loadSource({ dataDir: inDir, tag: PERF8, dev: true });
  const b = buildPostBundle(src, { catalogue, bundleSha256: recordsDigest({ dataDir: inDir, tag: PERF8, prevTag: src.prev.tag }) });
  const bad = { bundle_sha256: b.bundle_sha256, summary: 'A dramatically good run: {claim:turns_completed.linux-x64.100.base}.', sections: [{ chart_id: 'fork-vs-base.turns_completed.ladder.linux-x64', caption: '{claim:turns_completed.linux-x64.250.base}.' }] };
  await runPost({ bundle: b, post: bad, postsDir: d.postsDir, scanText: clean, repoRoot: d.root });
  await runPost({ bundle: b, post: { ...bad, summary: 'A significantly good run: {claim:turns_completed.linux-x64.100.base}.' }, postsDir: d.postsDir, scanText: clean, repoRoot: d.root });
  assert.equal(json(path.join(d.postsDir, `${PERF8}.json`)).status, 'charts_only');
  const dir = copyData();
  writeFileSync(path.join(dir, 'fork', `${PERF8}.linux-x64.json`), `${readFileSync(path.join(dir, 'fork', `${PERF8}.linux-x64.json`), 'utf8').trimEnd()}\n\n`);
  assert.equal((await reasonsOf(dir, d.postsDir))[PERF8], 'no_text_yet');
  assert.equal((await reasonsOf(inDir, d.postsDir))[PERF8], 'checker_failed', 'against the same data it stays checker_failed');
});

test('the release file carries the base merge-base sha and its short form', async () => {
  const d = fresh();
  await buildReleases({ inDir, outDir: d.outDir, postsDir: d.postsDir, dev: true, scanText: clean, tags: [PERF8] });
  const rel = json(path.join(d.outDir, `${PERF8}.json`));
  const fork = json(path.join(inDir, 'fork', `${PERF8}.linux-x64.json`));
  assert.equal(rel.base.sha, fork.base.sha);
  assert.equal(rel.base.sha7, fork.base.sha.slice(0, 7));
  assert.deepEqual(validate(releaseSchema, rel), []);
});

test('the base is named as the upstream base: in the title by sha7, in every clause, and with no sha before its record exists', async () => {
  const d = fresh();
  await buildReleases({ inDir, outDir: d.outDir, postsDir: d.postsDir, dev: true, scanText: clean, tags: [PERF8] });
  const rel = json(path.join(d.outDir, `${PERF8}.json`));
  const sha7 = json(path.join(inDir, 'fork', `${PERF8}.linux-x64.json`)).base.sha.slice(0, 7);
  assert.match(rel.post.title, new RegExp(`\\(vs upstream base ${sha7}\\)$`));
  assert.ok(rel.post.sections.every((s) => !/ on the base,/.test(s.caption)), 'clauses say the upstream base');
  assert.ok(rel.post.sections.some((s) => / on the upstream base, /.test(s.caption)));
  const dir = copyData();
  rmSync(path.join(dir, baseRelOf(dir)));
  const e = fresh();
  await buildReleases({ inDir: dir, outDir: e.outDir, postsDir: e.postsDir, dev: true, scanText: clean, tags: [PERF8] });
  const pend = json(path.join(e.outDir, `${PERF8}.json`));
  assert.equal(pend.base.sha, null);
  assert.deepEqual(validate(releaseSchema, pend), []);
});

test('loadSource never serves a stale tree: a same-size edit with the same modification time is read again', async () => {
  const { cpSync, statSync, utimesSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'release-build-stale-'));
  cpSync(inDir, dir, { recursive: true });
  const file = path.join(dir, 'fork', `${PERF8}.linux-x64.json`);
  const T = 1700000000;
  utimesSync(file, T, T);
  const a = await loadSource({ dataDir: dir, tag: PERF8, dev: true });
  const text = readFileSync(file, 'utf8');
  const sha = JSON.parse(text).release.sha;
  const other = `${sha[0] === '0' ? '1' : '0'}${sha.slice(1)}`;
  writeFileSync(file, text.split(sha).join(other));
  utimesSync(file, T, T);
  assert.equal(statSync(file).size, Buffer.byteLength(text));
  const b = await loadSource({ dataDir: dir, tag: PERF8, dev: true });
  assert.equal(a.release.sha, sha);
  assert.equal(b.release.sha, other, 'the second read sees the edit');
});

test('buildReleases can build a subset of the tags, and a second build of an unchanged tree reuses the aggregator', async () => {
  const d = fresh();
  const res = await buildReleases({ inDir, outDir: d.outDir, postsDir: d.postsDir, dev: true, scanText: clean, tags: [PERF8] });
  assert.deepEqual(res.map((r) => r.tag), [PERF8]);
  assert.deepEqual(readdirSync(d.outDir), [`${PERF8}.json`]);
  const { sourceCacheStats } = await import('./release-bundle.mjs');
  const before = sourceCacheStats().hits;
  await buildReleases({ inDir, outDir: fresh().outDir, postsDir: d.postsDir, dev: true, scanText: clean, tags: [PERF8] });
  assert.ok(sourceCacheStats().hits > before, 'the second build of the same tree hits the cache');
  await assert.rejects(buildReleases({ inDir, outDir: fresh().outDir, postsDir: d.postsDir, dev: true, scanText: clean, tags: ['v0.1.9-perf.99'] }), /perf\.99/);
});

test('agents_served at a saturated level reaches the release through the aggregator, even with no verdict anywhere', async () => {
  const { loadApp } = await import('./lib/app-vm.mjs');
  const { releaseHTML } = await import('./render-post.mjs');
  const dir = copyData();
  // agents_served without a noise band: no verdict at any level, against the base or the previous release.
  editJson(path.join(dir, 'bands.json'), (j) => { delete j.platforms['linux-x64'].metrics.agents_served; });
  // The fork saturated at 250 agents: every valid attempt saturated, 210 of 250 agents served.
  editJson(path.join(dir, 'fork', `${PERF8}.linux-x64.json`), (j) => {
    const c = j.cells['250'];
    for (const a of c.attempts) if (a.valid) Object.assign(a, { saturated: true, saturated_by: ['sessions_starved'], problems: ['sessions_starved'] });
    const s = c.metrics.agents_served;
    c.metrics.agents_served = { ...s, median: 210, min: 210, max: 210, values: s.values.map(() => 210) };
    c.saturated = true;
  });
  const d = fresh();
  const [r] = await buildReleases({ inDir: dir, outDir: d.outDir, postsDir: d.postsDir, dev: true, scanText: clean, tags: [PERF8] });
  assert.equal(r.charts_only_reason, 'no_text_yet');
  const rel = json(path.join(d.outDir, `${PERF8}.json`));
  assert.deepEqual(validate(releaseSchema, rel), []);
  const served = rel.deltas.filter((x) => x.metric === 'agents_served');
  assert.deepEqual(served.map((x) => [x.level, x.verdict, x.note, x.fork, x.saturated.fork]), [['250', null, 'no_band', 210, true]]);
  const ctx = { catalogue: catalogue.metrics, headlines: catalogue.headlines['linux-x64'], platform: 'linux-x64', level: '250' };
  const html = releaseHTML(loadApp(), rel, ctx).html;
  assert.match(html, /saturated: 210 of 250 agents served by the fork/);
  assert.doesNotMatch(html, /\? of 250 agents/);
});

// ---- Over budget: one release over its byte budget never stops the build. ----
const OVER = 24 * 1024;
// perf.8 with every measured value of the fork moved far beyond noise at every level: a release whose rows fill
// the file. Invented: the synthetic values doubled, and those of one or less halved (a 0-1 ratio stays in range).
const inflated = () => {
  const dir = copyData();
  const move = (v) => (typeof v !== 'number' ? v : v <= 1 ? v * 0.5 : v * 2);
  editJson(path.join(dir, 'fork', `${PERF8}.linux-x64.json`), (j) => {
    for (const c of Object.values(j.cells)) for (const [id, s] of Object.entries(c.metrics || {})) {
      if (id === 'agents_served' || !s || typeof s.median !== 'number') continue;
      for (const k of ['median', 'min', 'max']) s[k] = move(s[k]);
      if (Array.isArray(s.values)) s.values = s.values.map(move);
    }
  });
  return dir;
};

test('over budget: that release builds charts-only, reason over_budget, headline rows only; every other release is unchanged', async () => {
  const { statSync } = await import('node:fs');
  const dir = inflated();
  const full = fresh();
  const before = await buildReleases({ inDir: dir, outDir: full.outDir, postsDir: full.postsDir, dev: true, scanText: clean });
  const size = (r) => statSync(r.file).size;
  const big = before.find((r) => r.tag === PERF8);
  assert.ok(size(big) > OVER, `the fixture release is over the test budget: ${size(big)} bytes`);
  for (const r of before.filter((x) => x.tag !== PERF8)) assert.ok(size(r) <= OVER, `${r.tag} is under it`);
  const d = fresh();
  const lines = [];
  const res = await buildReleases({ inDir: dir, outDir: d.outDir, postsDir: d.postsDir, dev: true, scanText: clean, budgetBytes: OVER, log: (l) => lines.push(l) });
  const r8 = res.find((r) => r.tag === PERF8);
  assert.equal(r8.charts_only_reason, 'over_budget');
  assert.equal(r8.over_budget_bytes, size(big));
  assert.ok(lines.includes(`release-build: ${PERF8} over_budget: ${size(big)} bytes`), lines.join('\n'));
  const rel = json(r8.file);
  assert.deepEqual(validate(releaseSchema, rel), []);
  assert.ok(statSync(r8.file).size <= OVER);
  assert.equal(rel.charts_only, true);
  assert.equal(rel.charts_only_reason, 'over_budget');
  assert.equal(rel.checker.passed, false);
  assert.match(rel.checker.footer, /^Charts only: this release is over its page's size budget, so only the headline metrics are listed; its changelog is on GitHub\.$/);
  assert.ok(rel.deltas.length > 0 && rel.deltas.every((x) => x.headline != null), 'headline rows only');
  const headline = json(big.file).deltas.filter((x) => x.headline != null);
  assert.deepEqual(rel.deltas, headline, 'the same headline rows as the full release');
  for (const r of res.filter((x) => x.tag !== PERF8)) {
    assert.equal(r.charts_only_reason, before.find((x) => x.tag === r.tag).charts_only_reason, r.tag);
    assert.equal(readFileSync(r.file, 'utf8'), readFileSync(before.find((x) => x.tag === r.tag).file, 'utf8'), `${r.tag} unchanged`);
  }
});

test('over budget, the alert: the build prints a GitHub warning naming the release and still exits 0', () => {
  const dir = inflated();
  const d = fresh();
  const out = execFileSync(process.execPath, [path.join(ROOT, 'site', 'build', 'release-build.mjs'), '--in', dir, '--out', d.outDir, '--posts', d.postsDir, '--dev', '--budget-bytes', String(OVER)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const warnings = out.split('\n').filter((l) => l.startsWith('::warning::'));
  assert.equal(warnings.length, 1, out);
  assert.match(warnings[0], new RegExp(`^::warning::release ${PERF8.replace(/\./g, '\\.')} over budget: \\d+ bytes$`));
  // Under the real budget the same tree warns about nothing.
  const quiet = execFileSync(process.execPath, [path.join(ROOT, 'site', 'build', 'release-build.mjs'), '--in', dir, '--out', fresh().outDir, '--posts', d.postsDir, '--dev'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(!quiet.includes('::warning::'), quiet);
});

test('over budget, the alert runs in CI: a report-only step builds every release on the committed data', async () => {
  const { parseYaml } = await import('../../tools/audit/lib/yaml-lite.mjs');
  const ci = parseYaml(readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));
  const [, job] = Object.entries(ci.jobs)[0];
  const step = job.steps.find((s) => /^node site\/build\/release-build\.mjs --in data\/v1 /.test(String(s.run ?? '')));
  assert.ok(step, 'the release budget step');
  assert.equal(step.if, '${{ !cancelled() }}');
  assert.match(step.run, /--out "\$RUNNER_TEMP\/releases"$/);
  assert.equal(step['continue-on-error'], undefined, 'it passes on its own: over budget is a warning, never a failure');
});

test('over budget, never fatal: when even the charts-only form is over the budget, the build completes, ships it and warns', async () => {
  const TINY = 2048;
  const d = fresh();
  const lines = [];
  const res = await buildReleases({ inDir, outDir: d.outDir, postsDir: d.postsDir, dev: true, scanText: clean, budgetBytes: TINY, log: (l) => lines.push(l) });
  assert.ok(res.length > 1);
  for (const r of res) {
    assert.equal(r.charts_only_reason, 'over_budget', r.tag);
    assert.ok(r.over_budget_bytes > TINY, r.tag);
    assert.deepEqual(validate(releaseSchema, json(r.file)), [], r.tag);
  }
  const out = execFileSync(process.execPath, [path.join(ROOT, 'site', 'build', 'release-build.mjs'), '--in', inDir, '--out', fresh().outDir, '--posts', d.postsDir, '--dev', '--budget-bytes', String(TINY)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(out.split('\n').filter((l) => l.startsWith('::warning::release ')).length, res.length, out);
});

// ---- Sources: a dev build reads only synthetic ones; a real build is unchanged. ----
// A real source, as the pipeline commits them: a passing synthetic one with its synthetic flag removed.
async function writeRealPost(d) {
  await writePassingPost(d);
  editJson(path.join(d.postsDir, `${PERF8}.json`), (j) => { delete j.synthetic; });
}

test('a dev build skips a real source with a log line, even one whose tag the synthetic tree lacks', async () => {
  const dir = copyData();
  rmSync(path.join(dir, 'fork', `${PERF8}.linux-x64.json`));
  const d = fresh();
  await writeRealPost(d);
  const lines = [];
  const res = await buildReleases({ inDir: dir, outDir: d.outDir, postsDir: d.postsDir, dev: true, scanText: clean, log: (l) => lines.push(l) });
  assert.ok(!res.some((r) => r.tag === PERF8));
  assert.ok(lines.includes(`release-build: news/posts/${PERF8}.json is not synthetic; a dev build reads only synthetic sources`), lines.join('\n'));
});

test('a dev build never applies a real source to synthetic data: that release has no text', async () => {
  const d = fresh();
  await writeRealPost(d);
  const res = await buildReleases({ inDir, outDir: d.outDir, postsDir: d.postsDir, dev: true, scanText: clean });
  assert.equal(res.find((r) => r.tag === PERF8).charts_only_reason, 'no_text_yet');
});

test('a real build still refuses a source with no fork record: the committed data with one fork record removed', async (t) => {
  const posts = path.join(ROOT, 'news', 'posts');
  const real = existsSync(posts) ? readdirSync(posts).filter((f) => f.endsWith('.json')).sort() : [];
  if (!real.length) return t.skip('no committed release post yet');
  const tag = real[0].slice(0, -'.json'.length);
  const dir = mkdtempSync(path.join(tmpdir(), 'release-build-real-'));
  cpSync(path.join(ROOT, 'data', 'v1'), dir, { recursive: true });
  rmSync(path.join(dir, 'fork', `${tag}.linux-x64.json`));
  const { loadScanner } = await import('../../news/check.mjs');
  await assert.rejects(
    buildReleases({ inDir: dir, outDir: fresh().outDir, postsDir: posts, scanText: await loadScanner(ROOT) }),
    new RegExp(`news/posts/${tag.replace(/\./g, '\\.')}\\.json has no fork record for ${tag.replace(/\./g, '\\.')} on linux-x64`),
  );
});

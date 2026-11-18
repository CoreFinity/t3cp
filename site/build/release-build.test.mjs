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

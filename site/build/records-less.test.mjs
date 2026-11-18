// Red first: the records-less site (data/v1 holding the pipeline's status.json and no record yet) reads as empty,
// not broken, and every fixture check fails closed.
// - status.json goes through the aggregator's checks (strict JSON, the scan, schema/status-1.json) and is published
//   at /data/v1/status.json; a malformed or schema-violating one fails the build. bands.json (the noise bands, which
//   land before the first record) gets the aggregator's bands checks and is published too. Any other file fails.
// - Every page says it is records-less (data-empty="1") and the browser then fetches no data: no 404, no error box.
// - A served fixture file without a fixture/SHA256SUMS entry, or fixtures.json without SHA256SUMS, refuses the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_PATH } from './lib/app-vm.mjs';
import * as B from './build.mjs';

const STATUS = { schema: 't3cp/status/1', generated_at: '2026-11-17T01:33:04.746Z', platforms: { 'linux-x64': { latest_record_id: null, latest_date: null, latest_status: null, queue: { pending: 0, active: 0 }, last_failure: null, heartbeat_at: null } } };

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 't3cp-rless-'));
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(root, 'in', rel, '..'), { recursive: true }); writeFileSync(join(root, 'in', rel), text); }
  return { in: join(root, 'in'), out: join(root, 'dist'), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a records-less tree publishes its status.json, re-serialised, and marks every page empty', async () => {
  const t = tree({ 'status.json': JSON.stringify(STATUS, null, 2) + '\n' });
  try {
    await B.build({ out: t.out, in: t.in, posts: 'news/posts' });
    assert.equal(readFileSync(join(t.out, 'data/v1/status.json'), 'utf8'), JSON.stringify(STATUS) + '\n');
    const pages = readdirSync(t.out, { recursive: true }).filter(f => f.endsWith('.html'));
    assert.ok(pages.length > 100);
    for (const p of pages) assert.match(readFileSync(join(t.out, p), 'utf8'), /<body[^>]*\sdata-empty="1"/, p);
  } finally { t.done(); }
});

test('a malformed or schema-violating status.json, a bands.json that fails its schema, or an unknown file fails a records-less build', async () => {
  const bad = [
    [{ 'status.json': '{"schema": "t3cp/status/1",' }, /status\.json/],
    [{ 'status.json': '{"schema": "t3cp/status/1", "generated_at": "2026-11-17T00:00:00Z"}\n' }, /status\.json/],
    [{ 'status.json': JSON.stringify({ ...STATUS, extra: 1 }) }, /status\.json/],
    [{ 'status.json': JSON.stringify(STATUS), 'bands.json': '{}' }, /bands\.json/],
    [{ 'status.json': JSON.stringify(STATUS), 'notes.txt': 'x' }, /notes\.txt/],
  ];
  for (const [files, want] of bad) {
    const t = tree(files);
    try { await assert.rejects(B.build({ out: t.out, in: t.in, posts: 'news/posts' }), want, Object.keys(files).join(' + ')); } finally { t.done(); }
  }
});

test('status.json with a valid bands.json builds with empty states and publishes both; a malformed bands.json fails', async () => {
  const cat = JSON.parse(readFileSync(new URL('../../catalogue/catalogue.json', import.meta.url), 'utf8'));
  const measured = { from: '2026-11-16', to: '2026-11-16', attempts: 42, machines: 3, tag: 'v0.1.10-nightly.20261116.5702' };
  const BANDS = { schema: 't3cp/bands/1', method: 'Noise bands from repeated attempts: (max - min) / median in percent', platforms: { 'linux-x64': { measured, metrics: Object.fromEntries(cat.headlines['linux-x64'].map(id => [id, { band: 4.6, n: 6 }])) } } };
  const t = tree({ 'status.json': JSON.stringify(STATUS), 'bands.json': JSON.stringify(BANDS, null, 1) });
  try {
    await B.build({ out: t.out, in: t.in, posts: 'news/posts' });
    assert.equal(readFileSync(join(t.out, 'data/v1/bands.json'), 'utf8'), JSON.stringify(BANDS) + '\n');
    assert.equal(readFileSync(join(t.out, 'data/v1/status.json'), 'utf8'), JSON.stringify(STATUS) + '\n');
    assert.match(readFileSync(join(t.out, 'index.html'), 'utf8'), /<body[^>]*\sdata-empty="1"/);
    assert.match(readFileSync(join(t.out, 'downloads/index.html'), 'utf8'), /href="\/data\/v1\/bands\.json"/, 'Downloads lists the published bands');
  } finally { t.done(); }
  const bad = ['{"schema": "t3cp/bands/1",', JSON.stringify({ ...BANDS, platforms: { 'linux-x64': { measured, metrics: { turn_p50_ms: { band: 4.6, n: 6 } } } } }), JSON.stringify({ ...BANDS, platforms: { 'linux-x64': { pending: true, measured } } })];
  for (const b of bad) {
    const u = tree({ 'status.json': JSON.stringify(STATUS), 'bands.json': b });
    try { await assert.rejects(B.build({ out: u.out, in: u.in, posts: 'news/posts' }), /bands\.json/, b.slice(0, 60)); } finally { u.done(); }
  }
});

test('the browser fetches no data on a records-less page, and fetches index.json otherwise', () => {
  const code = readFileSync(APP_PATH, 'utf8');
  const boot = dataset => {
    const calls = [];
    const el = () => ({ dataset: {}, style: {}, hidden: true, textContent: '', innerHTML: '', clientWidth: 960, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute() {}, getAttribute: () => null, querySelectorAll: () => [], querySelector: () => null, closest: () => null });
    const body = Object.assign(el(), { dataset });
    const document = { body, documentElement: el(), querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, createElement: el, createElementNS: el, getElementById: () => el() };
    const window = { document, location: { search: '', pathname: '/', hash: '', href: '/', origin: 'https://t3cp.io', replace() {} }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}, scrollY: 0, console: { log() {}, warn() {}, info() {}, error() {} }, fetch: p => { calls.push(String(p)); return new Promise(() => {}); } };
    Object.defineProperty(window, 'localStorage', { get() { return { getItem: () => null, setItem() {} }; } });
    new Function('window', 'document', code)(window, document);
    return calls;
  };
  assert.deepEqual(boot({ page: 'overview', mac: '0', empty: '1' }), []);
  assert.ok(boot({ page: 'overview', mac: '0' }).some(p => /\/data\/v1\/index\.json$/.test(p)), 'a page with records still loads its index');
});

test('fixture checks fail closed: an unlisted served file, or fixtures.json without SHA256SUMS, is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 't3cp-fx-'));
  try {
    mkdirSync(join(root, 'fixture'));
    writeFileSync(join(root, 'fixture/x.shape.json'), '{}\n');
    assert.throws(() => B.fixtureFile(root, 'fixture/x.shape.json', {}), /x\.shape\.json[\s\S]*SHA256SUMS/, 'a served file SHA256SUMS does not list');
    assert.equal(typeof B.loadFixtures, 'function', 'build.mjs exports loadFixtures');
    const zst = { name: 'f-v1.sqlite.zst', bytes: 1, sha256: 'a'.repeat(64) };
    writeFileSync(join(root, 'fixture/fixtures.json'), JSON.stringify([{ id: 'f', version: 1, zst, sqlite: { name: 'f-v1.sqlite', bytes: 2, sha256: 'b'.repeat(64) } }]));
    assert.throws(() => B.loadFixtures(root), /SHA256SUMS/, 'fixtures.json without SHA256SUMS');
    writeFileSync(join(root, 'fixture/SHA256SUMS'), `${'b'.repeat(64)}  f-v1.sqlite\n`);
    assert.throws(() => B.loadFixtures(root), /f-v1\.sqlite\.zst[\s\S]*SHA256SUMS/, 'a fixtures.json file SHA256SUMS does not list');
    writeFileSync(join(root, 'fixture/SHA256SUMS'), `${'b'.repeat(64)}  f-v1.sqlite\n${'a'.repeat(64)}  f-v1.sqlite.zst\n`);
    assert.equal(B.loadFixtures(root).fixtures.length, 1, 'a fully listed fixture loads');
    const h = createHash('sha256').update('{}\n').digest('hex');
    writeFileSync(join(root, 'fixture/public-large.shape.json'), '{}\n');
    assert.throws(() => B.loadFixtures(root), /public-large\.shape\.json[\s\S]*SHA256SUMS/, 'the served shape file must be listed');
    writeFileSync(join(root, 'fixture/SHA256SUMS'), `${'b'.repeat(64)}  f-v1.sqlite\n${'a'.repeat(64)}  f-v1.sqlite.zst\n${h}  public-large.shape.json\n`);
    assert.deepEqual(B.loadFixtures(root).fixtureFiles.map(f => f.path), ['fixture/public-large.shape.json']);
    assert.ok(!existsSync(join(root, 'nothing')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

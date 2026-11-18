// Red first: the browser's Compare gives exactly the aggregator's verdict and note, for every metric and level of
// every nightly pair the aggregator compares itself (compare/<a>__<b>.json). It judges from what the aggregator
// publishes (cap, gate_exempt and throughput in index.json; segment, banded and gates in records-index.json) and
// keeps only the arithmetic. Two trees: hand-made nightlies that reach each rule (a per-level band, a wide client
// band, a small change, a client-errors gate, a contaminated attempt, a single valid attempt, a zero reference, a CPU
// pin mismatch, a missing empty-database cell) and the synthetic development tree (eras, saturation, a partial record).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadApp } from './build/lib/app-vm.mjs';
import { buildOutputs } from './build/aggregate.mjs';
import { mergeRecord } from '../tools/t3cp/merge.mjs';
import { fakeAttempts, fakeExtras, fakeIdentity, FAKE_PUBLIC_REFS } from '../tools/t3cp/lib/fake.mjs';
import { loadCatalogue } from '../tools/t3cp/lib/repo.mjs';

const T = loadApp();
const catalogue = loadCatalogue();
const LEVELS = ['1', '50', '100', '150', '200', '250', '1e'];

// Every nightly pair the aggregator compared: the browser's {verdict, note} must equal each row's.
function equalPairs(read, list, label) {
  const ix = read('index.json'), ri = read('records-index.json');
  const pairs = list.map(f => /^compare\/(v[^_]+-nightly\.[^_]+)__(v[^_]+-nightly\.[^_]+)\.(linux-x64|darwin-arm64)\.json$/.exec(f)).filter(Boolean);
  assert.ok(pairs.length >= 3, `${label}: nightly pairs compared: ${pairs.length}`);
  let rows = 0;
  for (const [file, ta, tb, p] of pairs) {
    const cf = read(file), ea = ri.records.find(r => r.tag === ta).platforms[p], eb = ri.records.find(r => r.tag === tb).platforms[p];
    const a = read(ea.path), b = read(eb.path), got = new Map();
    for (const L of LEVELS) {
      for (const r of T.compare(a, b, { catalogue: ix.catalogue, level: L, seg: { a: ea, b: eb } }).rows) got.set(`${r.id}@${T.effLevel(r.meta, L)}`, { verdict: r.verdict, note: r.note });
    }
    for (const row of cf.rows) {
      const key = `${row.metric}@${row.level}`;
      assert.deepEqual(got.get(key), { verdict: row.verdict, note: row.note }, `${label}: ${ta} -> ${tb}, ${key}`);
      got.delete(key); rows++;
    }
    assert.deepEqual([...got.keys()], [], `${label}: ${ta} -> ${tb}: rows the aggregator does not publish`);
  }
  return rows;
}

const BANDS = {
  schema: 't3cp/bands/1', method: 'test bands',
  platforms: {
    'linux-x64': {
      measured: { from: '2026-11-01', to: '2026-11-02', attempts: 42, machines: 3, tag: 'v0.1.10-nightly.20261115.4749' },
      metrics: { ...Object.fromEntries(catalogue.headlines['linux-x64'].map(id => [id, { band: 10, n: 6 }])), turn_p50_ms: { band: 10, n: 6, levels: { 250: { band: 20, n: 6 } } }, turn_p95_ms: { band: 45, n: 6 }, dispatch_p95_ms: { band: 10, n: 6 } },
    },
    'darwin-arm64': { pending: true },
  },
};

test('Compare equals the aggregator on hand-made nightlies that reach every rule', () => {
  const day = (date, { value, attempt, edit } = {}) => {
    const identity = fakeIdentity({ date });
    const r = mergeRecord({ publicRefs: FAKE_PUBLIC_REFS, attempts: fakeAttempts(catalogue, identity, { jitter: 0, value, attempt }), extras: [fakeExtras(catalogue, identity)], catalogue, generatedAt: `${date}T18:00:00Z` });
    if (edit) edit(r);
    return r;
  };
  const records = [
    day('2026-11-01'),
    day('2026-11-02', { value: (id, cell, v) => (id === 'turn_p50_ms' && cell === '250' ? v * 1.22 : id === 'turn_p95_ms' && cell === '100' ? v * 1.6 : id === 'elu' && cell === '100' ? v * 1.05 : id === 'dispatch_p95_ms' && cell === '100' ? v * 2 : id === 'client_errors' && cell === '100' ? 2 : undefined) }),
    day('2026-11-03', { attempt: (cell, n) => (cell === '150' && n === 1 ? { contaminated: true } : {}) }),
    day('2026-11-04', { attempt: (cell, n) => (cell === '50' && n > 1 ? { valid: false } : {}) }),
    day('2026-11-05', { value: (id, cell) => (id === 'reader_tx_wait_p95_ms' ? 0 : undefined) }),
    day('2026-11-06'),
    day('2026-11-07', { edit: r => { r.platform.cpu_model = 'Apple M2'; } }),
    day('2026-11-08', { edit: r => { delete r.cells['1e']; } }),
    day('2026-11-09'),
    day('2026-11-10', { attempt: cell => (['100', '150', '200', '250'].includes(cell) ? { valid: false } : {}) }),
    day('2026-11-11'),
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3cp-eq-'));
  try {
    for (const r of records) {
      const f = path.join(dir, 'records', r.platform.id, `${r.release.date}.${r.release.tag}.json`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `${JSON.stringify(r, null, 2)}\n`);
    }
    fs.writeFileSync(path.join(dir, 'bands.json'), `${JSON.stringify(BANDS, null, 2)}\n`);
    const files = buildOutputs(dir, { publicRefs: FAKE_PUBLIC_REFS, warn: () => {} });
    const read = rel => JSON.parse(files.get(rel).toString('utf8'));
    // The pairs reach the rules this test is for (the aggregator's own output, before the browser is asked).
    const notes = new Set([...files.keys()].filter(f => f.startsWith('compare/')).flatMap(f => read(f).rows.map(r => r.note || r.verdict)));
    for (const n of ['regressed', 'within', 'wide_band', 'gated', 'hollow', 'zero_reference', 'context', 'no_band']) assert.ok(notes.has(n), `reached: ${n}`);
    assert.ok([...files.keys()].filter(f => f.startsWith('compare/')).some(f => read(f).rows.some(r => r.note === 'hollow' && (r.a === null || r.b === null))), 'reached: a level run with no valid attempt, on either side');
    const rows = equalPairs(read, [...files.keys()], 'hand-made');
    assert.ok(rows > 500, `rows compared: ${rows}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Compare equals the aggregator on the synthetic development tree', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 't3cp-eq-dev-'));
  try {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/t3cp/dev/synth-data.mjs', import.meta.url)), '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const v1 = path.join(out, 'v1'), read = rel => JSON.parse(fs.readFileSync(path.join(v1, rel), 'utf8'));
    const list = fs.readdirSync(path.join(v1, 'compare')).map(f => `compare/${f}`);
    const rows = equalPairs(read, list, 'synthetic');
    assert.ok(rows > 1000, `rows compared: ${rows}`);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

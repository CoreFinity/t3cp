// Hand-made synthetic shapes for the site's tests. Small, readable, and never derived from any real record.

export const dates = n => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 9, 17 + i)).toISOString().slice(0, 10));
export const tagOf = (d, i) => `v0.1.9-nightly.${d.replace(/-/g, '')}.${4000 + i}`;

export const META = {
  elu: {
    id: 'elu', name: 'Event loop utilisation, mean', short: 'Event loop', group: 'cpu', unit: '0–1', better: 'lower',
    definition: 'Share of time the event loop is busy.', lane: 'daily', scope: 'level', form: 'ts', era_start: '2026-10-20',
    upstream: 'yes', platforms: ['linux-x64', 'darwin-arm64'], na_on: [], empty_cell: false, gate: false, headline: 5,
    source: { file: 'result.json', field: 'gauges.elu' }, bands: { 'linux-x64': { band: 12, threshold: 17, n: 6 }, 'darwin-arm64': null },
  },
  turns_completed: {
    id: 'turns_completed', name: 'Turns completed in the window', short: 'Turns', group: 'client', unit: 'n', better: 'higher',
    definition: 'Turns finished inside the window.', lane: 'daily', scope: 'level', form: 'ts', era_start: '2026-10-17',
    upstream: 'yes', platforms: ['linux-x64', 'darwin-arm64'], na_on: [], empty_cell: false, gate: false, headline: 1,
    source: { file: 'result.json', field: 'calls.count' }, bands: { 'linux-x64': { band: 4.6, threshold: 9.6, n: 6 }, 'darwin-arm64': null },
  },
};

const blank = n => Array(n).fill(null);

// One level's arrays. `vals` holds medians (null = not recorded); `flags` maps an index to [verdict, deltaPct, ref].
export function level(vals, flags = {}, threshold = 17) {
  const n = vals.length;
  const L = {
    band: threshold - 5, threshold, median: vals.slice(), min: vals.map(v => (v == null ? null : v * 0.98)), max: vals.map(v => (v == null ? null : v * 1.02)),
    n: vals.map(v => (v == null ? 0 : 3)), ref: blank(n), delta: blank(n), verdict: blank(n), note: vals.map(v => (v == null ? 'no_data' : 'no_reference')),
    thin: Array(n).fill(false), dod_delta: blank(n), dod_verdict: blank(n),
  };
  let first = vals.findIndex(v => v != null);
  vals.forEach((v, i) => {
    if (v == null || i === first) return;
    const prev = vals.slice(Math.max(first, i - 7), i).filter(x => x != null).sort((a, b) => a - b);
    const ref = prev.length >= 3 ? prev[prev.length >> 1] : prev[prev.length - 1];
    L.ref[i] = ref; L.delta[i] = ((v - ref) / ref) * 100; L.verdict[i] = 'within'; L.note[i] = null; L.thin[i] = prev.length < 3;
  });
  for (const [i, f] of Object.entries(flags)) { L.verdict[i] = f[0]; L.delta[i] = f[1]; L.ref[i] = f[2]; L.note[i] = null; }
  return L;
}

export function shard(id, levels, { n = 10, platform = 'linux-x64', fork = null, eras = [] } = {}) {
  const ds = dates(n);
  return {
    schema: 't3cp/series/1', id, platform, shard: 'latest', generated_at: `${ds[n - 1]}T00:00:00Z`, from: ds[0], to: ds[n - 1],
    band: 12, threshold: 17, dates: ds, tags: ds.map(tagOf), status: ds.map(() => 'complete'), levels, fork, eras,
  };
}

// The illustrative "event loop" series: nothing before its era (index 3), a regression at index 7.
export function eluShard() {
  const v = [null, null, null, 0.8, 0.81, 0.8, 0.79, 0.99, 0.8, 0.81];
  return shard('elu', { 100: level(v, { 7: ['regressed', 23.75, 0.8] }) }, { eras: [{ date: '2026-10-20', kind: 'metric', label: 'gauges from 20 Oct' }] });
}

// A t3cp/record/1-shaped record with one cell, for the compare tests.
export function record({ platform = 'linux-x64', fixture = 'large-76', harness = 'a'.repeat(64), kind = 'nightly', date = '2026-11-14', tag, values = {} } = {}) {
  const metrics = {};
  for (const [id, v] of Object.entries(values)) metrics[id] = { median: v, min: v, max: v, n: 3, values: [v, v, v] };
  return {
    schema: 't3cp/record/1', record_id: kind === 'fork' ? `${(tag || 'v0.1.9-perf.8').slice(1)}.${platform}.fork` : `${date}.${platform}.nightly`, kind,
    release: { tag: tag || tagOf(date, 1), sha: '0'.repeat(40), date, version: '0.1.9', archive: null, binary_sha256: null, build: null },
    base: null, platform: { id: platform }, harness: { version: 't3cp-harness/2.0.1', sha: '0'.repeat(40), files_sha256: harness },
    fixture: { id: fixture, sha256: 'f'.repeat(64), bytes: 1, migration: fixture === 'large-63' ? 63 : 76, recipe_sha256: null },
    cells: { 100: { attempts: [], valid: 3, total: 3, metrics } }, extras: { fixture: null, empty: null, migration: null, weekly: null },
    status: 'complete',
  };
}

// A fork section for `shard`: releases [{tag, i (date index), v, vb, vbv, vp, vpv}] at one level, the step held from
// each release's date until the next (two releases on one date: the later holds the step).
export function forkOf(n, releases, L = '100') {
  const ds = dates(n), rs = releases.slice().sort((a, b) => a.i - b.i);
  const stepTags = ds.map((_, i) => { let t = null; rs.forEach(r => { if (r.i <= i) t = r.tag; }); return t; });
  const step = stepTags.map(t => (t ? rs.find(r => r.tag === t).v : null));
  const col = k => rs.map(r => (r[k] === undefined ? null : r[k]));
  return {
    tags: rs.map(r => r.tag), dates: rs.map(r => ds[r.i]), base_tags: rs.map(r => tagOf(ds[Math.max(0, r.i - 1)], 9)), base_dates: rs.map(r => ds[Math.max(0, r.i - 1)]),
    base_shas: rs.map(() => 'abcdef1234567890abcdef1234567890abcdef12'), prev_tags: rs.map((r, k) => (k ? rs[k - 1].tag : null)), step_tags: stepTags,
    levels: { [L]: { value: col('v'), min: col('v'), max: col('v'), n: rs.map(() => 3), vs_base: col('vb'), vs_base_verdict: col('vbv'), vs_base_note: rs.map(() => null),
      vs_prev: col('vp'), vs_prev_verdict: col('vpv'), vs_prev_note: rs.map(() => null), step } },
  };
}

// A test metric as index.json publishes it for Compare (final review M4): cap per platform and level, as
// aggregate.mjs capability() gives it (counters {null, null}; context; no band; else the band's threshold), and the
// gate_exempt and throughput flags; lane defaults to daily as in the catalogue.
export function published(m, platform = 'linux-x64') {
  const b = m.bands && m.bands[platform], counter = !!m.counter;
  const cap = { threshold: counter || !b ? null : b.threshold, note: counter ? null : m.better === 'context' ? 'context' : b ? null : 'no_band' };
  const levels = (m.scope === 'record' ? ['once'] : ['1', '50', '100', '150', '200', '250']).concat(m.empty_cell ? ['1e'] : []);
  return { lane: 'daily', ...m, cap: { [platform]: Object.fromEntries(levels.map(L => [L, cap])) }, gate_exempt: m.id === 'client_errors' || m.id === 'client_unfinished', throughput: m.id === 'turns_completed' || m.id === 'agents_served' };
}

// A record's published comparability (records-index.json) with every validity gate passing at its levels.
export const passing = s => (s && s.segment ? { ...s, gates: Object.fromEntries(Object.keys(s.segment).concat('once').map(L => [L, 'pass'])) } : s);

// A hand-made synthetic `t3cp/release-bundle/1` (the shape site/build/aggregate.mjs releaseBundle() returns),
// for the tests of release-bundle.mjs and release-post.mjs. Every number is invented. Metric ids and names are
// the catalogue's. The verdicts follow the regression rule (threshold = band + 5 points) from the numbers here.

const MINUS = '−';
const group = (n) => n.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const num = (v) => {
  const a = Math.abs(v);
  const d = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  const [i, f] = Math.abs(v).toFixed(d).split('.');
  return (v < 0 ? MINUS : '') + group(i) + (f ? `.${f}` : '');
};
const SUFFIX = { n: '', '0–1': '', '%': '%', '% of one core': '%', ms: ' ms', s: ' s', MiB: ' MiB', '/s': '/s' };
const fmt = (v, unit) => (v == null ? null : num(v) + SUFFIX[unit]);
const pct = (r) => {
  if (r == null) return null;
  const t = Math.abs(r).toFixed(1);
  return (t === '0.0' ? '' : r >= 0 ? '+' : MINUS) + t + '%';
};
const round = (x, d = 3) => (x == null ? null : Number(x.toFixed(d)));

// [id, name, unit, better, headline, band (null = none), levels {L: [fork, base, prev]}]
const SPEC = [
  ['turns_completed', 'Turns completed in the window', 'n', 'higher', 1, 4.6, { 1: [61, 60, 60], 50: [200, 190, 195], 100: [352, 318, 340], 250: [290, 240, 281] }],
  ['turn_p50_ms', 'Turn end to end p50', 'ms', 'lower', 2, 17.5, { 1: [812, 820, 815], 50: [990, 1010, 1000], 100: [1234, 1456, 1301], 250: [2105, 2980, 2240] }],
  ['dispatch_p95_ms', 'Dispatch p95', 'ms', 'lower', 3, 18.7, { 1: [12.1, 12.0, 12.2], 50: [150, 152, 151], 100: [305, 318, 311], 250: [640, 655, 650] }],
  ['main_busy_pct', 'Main thread busy', '% of one core', 'lower', 4, 7.2, { 1: [4.2, 4.3, 4.2], 50: [40.1, 41.0, 40.5], 100: [61.0, 70.4, 62.0], 250: [88.0, 96.5, 90.1] }],
  ['elu', 'Event loop utilisation, mean', '0–1', 'lower', 5, 9.8, { 1: [0.05, 0.05, 0.05], 50: [0.41, 0.42, 0.41], 100: [0.62, 0.66, 0.63], 250: [0.81, 0.85, 0.82] }],
  ['reader_tx_wait_p95_ms', 'Reader lock wait p95', 'ms', 'lower', 6, 17.7, { 1: [0.8, 0.82, 0.81], 50: [40, 44, 41], 100: [120, 260, 125], 250: [300, 610, 310] }],
  ['rss_peak_mib', 'Peak RSS', 'MiB', 'lower', 7, 12.5, { 1: [402, 398, 400], 50: [800, 790, 795], 100: [1120, 1010, 1100], 250: [1530, 1240, 1250] }],
  ['db_ready_warm_ms', 'Start to database ready, warm start', 'ms', 'lower', 8, null, { once: [1840, 1850, 1845] }],
  ['writer_tx_p95_ms', 'Writer transaction p95', 'ms', 'lower', null, 3.6, { 1: [4.1, 4.12, 4.11], 50: [9.0, 9.1, 9.0], 100: [15.1, 17.2, 15.3], 250: [22.0, 24.9, 22.4] }],
  ['stall_share_40ms', 'Seconds with a stall of 40 ms or more', '%', 'lower', null, 20, { 1: [0.4, 0.41, 0.4], 50: [1.0, 1.0, 1.0], 100: [2.1, 2.05, 2.08], 250: [6.2, 6.1, 6.15] }],
  ['heap_peak_mib', 'Peak V8 heap used', 'MiB', 'lower', null, null, { 1: [210, 205, 208], 50: [400, 390, 398], 100: [610, 590, 600], 250: [900, 880, 890] }],
  ['push_p95_ms', 'Push latency p95', 'ms', 'context', null, null, { 1: [9, 9.5, 9.2], 50: [30, 31, 30], 100: [80, 120, 85], 250: [200, 260, 210] }],
];

function judge(better, band, fork, ref) {
  if (better === 'context') return { delta: (fork - ref) / ref * 100, worse: null, verdict: null, note: 'context', threshold: null };
  const delta = (fork - ref) / ref * 100;
  const worse = better === 'higher' ? -delta : delta;
  if (band == null) return { delta, worse, verdict: null, note: 'no_band', threshold: null };
  const threshold = band + 5;
  const verdict = worse > threshold ? 'regressed' : worse < -threshold ? 'improved' : 'within';
  return { delta, worse, verdict, note: null, threshold };
}

const stats = (v) => ({ median: v, min: v, max: v, n: 3 });

/** @param {{prev?: boolean}} opts prev: false gives a first release with no previous one. */
export function source({ prev = true } = {}) {
  const metrics = [];
  const counts = { regressed: 0, improved: 0, within: 0, no_verdict: 0 };
  for (const [id, name, unit, better, headline, band, levels] of SPEC) {
    for (const [level, [f, b, p]] of Object.entries(levels)) {
      const vb = judge(better, band, f, b);
      const vp = prev ? judge(better, band, f, p) : { delta: null, worse: null, verdict: null, note: 'no_reference' };
      if (headline && (level === '100' || level === 'once')) counts[vb.verdict ?? 'no_verdict'] += 1;
      metrics.push({
        id, name, unit, better, headline, platform: 'linux-x64', level,
        fork: stats(f), base: stats(b), prev: prev ? stats(p) : null,
        band_pct: band, threshold_pct: vb.threshold ?? null,
        delta_pct: round(vb.delta), worse_pct: round(vb.worse), verdict: vb.verdict, note: vb.note,
        delta_vs_prev_pct: round(vp.delta), worse_vs_prev_pct: round(vp.worse), verdict_vs_prev: vp.verdict, note_vs_prev: vp.note,
        saturated: { fork: false, base: false, prev: prev ? false : null },
        text: {
          fork: fmt(f, unit), base: fmt(b, unit), prev: prev ? fmt(p, unit) : null, delta_pct: pct(vb.delta),
          band_pct: band == null ? null : `${band.toFixed(1)}%`, threshold_pct: vb.threshold == null ? null : `${vb.threshold.toFixed(1)}%`,
          delta_vs_prev_pct: pct(vp.delta),
        },
      });
    }
  }
  const allowed = new Set();
  for (const m of metrics) for (const s of Object.values(m.text)) if (s) allowed.add(s);
  return {
    schema: 't3cp/release-bundle/1',
    synthetic: true,
    release: { tag: 'v0.1.9-perf.8', date: '2026-11-16', sha: '0123456789abcdef0123456789abcdef01234567' },
    base: { tag: 'v0.1.9-nightly.20261114.4700', date: '2026-11-14' },
    prev: prev ? { tag: 'v0.1.9-perf.7', date: '2026-11-09' } : null,
    platforms: ['linux-x64'],
    levels: ['1', '50', '100', '150', '200', '250', '1e', 'once'],
    counts,
    metrics,
    allowed_numbers: [...allowed].sort(),
    allowed_metric_names: [...new Set(metrics.filter((m) => m.verdict).map((m) => m.name))].sort(),
  };
}

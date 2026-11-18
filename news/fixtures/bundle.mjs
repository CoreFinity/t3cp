import { createHash } from 'node:crypto';

// A hand-made synthetic post bundle for the checker's tests. Every number is invented; nothing here comes from
// a measured record. The shape is `t3cp/post-bundle/1` as `site/build/release-bundle.mjs` writes it.

const SPELLED = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const MINUS = '−';

const unsigned = (s) => s.replace(/^[+−]/, '');

// [id, name, unit, better, headline order, band, threshold, rows by level: [fork, base, delta, verdict, prev, dprev, vprev]]
const METRICS = [
  ['turns_completed', 'Turns completed', 'n', 'higher', 1, '4.6%', '9.6%', {
    1: ['61', '60', '+1.7%', 'within', '60', '+1.7%', 'within'],
    100: ['352', '318', '+10.7%', 'improved', '340', '+3.5%', 'within'],
    250: ['290', '240', '+20.8%', 'improved', '281', '+3.2%', 'within'],
  }],
  ['turn_p50_ms', 'Turn time p50', 'ms', 'lower', 2, '17.5%', '22.5%', {
    1: ['812 ms', '820 ms', `${MINUS}1.0%`, 'within', '815 ms', `${MINUS}0.4%`, 'within'],
    100: ['1,234 ms', '1,456 ms', `${MINUS}15.2%`, 'within', '1,301 ms', `${MINUS}5.1%`, 'within'],
    250: ['2,105 ms', '2,980 ms', `${MINUS}29.4%`, 'improved', '2,240 ms', `${MINUS}6.0%`, 'within'],
  }],
  ['dispatch_p95_ms', 'Dispatch p95', 'ms', 'lower', 3, '18.7%', '23.7%', {
    1: ['12.1 ms', '12.0 ms', '+0.8%', 'within', '12.2 ms', `${MINUS}0.8%`, 'within'],
    100: ['305 ms', '318 ms', `${MINUS}4.1%`, 'within', '311 ms', `${MINUS}1.9%`, 'within'],
    250: ['640 ms', '655 ms', `${MINUS}2.3%`, 'within', '650 ms', `${MINUS}1.5%`, 'within'],
  }],
  ['rss_peak_mib', 'Peak memory', 'MiB', 'lower', 4, '14.0%', '19.0%', {
    1: ['402 MiB', '398 MiB', '+1.0%', 'within', '400 MiB', '+0.5%', 'within'],
    100: ['1,120 MiB', '1,010 MiB', '+10.9%', 'within', '1,100 MiB', '+1.8%', 'within'],
    250: ['1,530 MiB', '1,240 MiB', '+23.4%', 'regressed', '1,250 MiB', '+22.4%', 'regressed'],
  }],
  ['db_ready_ms', 'Database ready', 'ms', 'lower', 5, null, null, {
    once: ['1,840 ms', '1,850 ms', `${MINUS}0.5%`, null, '1,845 ms', `${MINUS}0.3%`, null],
  }],
  ['writer_tx_p95_ms', 'Writer transaction p95', 'ms', 'lower', null, '3.6%', '8.6%', {
    1: ['4.10 ms', '4.12 ms', `${MINUS}0.5%`, 'within', '4.11 ms', `${MINUS}0.2%`, 'within'],
    100: ['15.1 ms', '17.2 ms', `${MINUS}12.2%`, 'improved', '15.3 ms', `${MINUS}1.3%`, 'within'],
    250: ['22.0 ms', '24.9 ms', `${MINUS}11.6%`, 'improved', '22.4 ms', `${MINUS}1.8%`, 'within'],
  }],
  ['stall_share_40ms', 'Seconds with a stall of 40 ms or more', '%', 'lower', null, '20.0%', '25.0%', {
    1: ['0.40%', '0.41%', `${MINUS}2.4%`, 'within', '0.40%', '0.0%', 'within'],
    100: ['2.10%', '2.05%', '+2.4%', 'within', '2.08%', '+1.0%', 'within'],
    250: ['7.02%', '6.90%', '+1.7%', 'within', '6.95%', '+1.0%', 'within'],
  }],
];

// The ordering key: the largest |change| / threshold over the levels, for each comparison.
const SIZE = {
  base: { turns_completed: 2.167, writer_tx_p95_ms: 1.419, turn_p50_ms: 1.307, rss_peak_mib: 1.232, dispatch_p95_ms: 0.173, stall_share_40ms: 0.096, db_ready_ms: 0 },
  prev: { rss_peak_mib: 1.179, turns_completed: 0.365, turn_p50_ms: 0.267, writer_tx_p95_ms: 0.209, dispatch_p95_ms: 0.08, stall_share_40ms: 0.04, db_ready_ms: 0 },
};

// Headline metrics only.
const COUNTS = {
  1: { improved: 0, regressed: 0, within: 4, no_verdict: 1, total: 5 },
  100: { improved: 1, regressed: 0, within: 3, no_verdict: 1, total: 5 },
  250: { improved: 2, regressed: 1, within: 1, no_verdict: 1, total: 5 },
};

export function bundle() {
  const metrics = [];
  const allowed = new Set(['1 agent', '100 agents', '250 agents']);
  for (const [id, name, unit, better, headline, band, threshold, levels] of METRICS) {
    for (const [level, row] of Object.entries(levels)) {
      const [fork, base, delta, verdict, prev, dprev, vprev] = row;
      metrics.push({
        id, name, unit, better, headline, platform: 'linux-x64', level,
        verdict, note: verdict ? null : 'no_band', verdict_vs_prev: vprev, note_vs_prev: vprev ? null : 'no_band',
        thin_reference: false,
        saturated: { fork: false, base: false, prev: false },
        text: { fork, base, prev, delta_pct: delta, band_pct: band, threshold_pct: threshold, delta_vs_prev_pct: dprev },
      });
      for (const s of [fork, base, prev, delta, dprev, unsigned(delta), unsigned(dprev), band, threshold]) if (s) allowed.add(s);
    }
  }
  for (const c of Object.values(COUNTS)) {
    for (const n of Object.values(c)) { allowed.add(String(n)); allowed.add(SPELLED[n]); }
  }
  const charts = [];
  for (const [id, name, , , headline, , , levels] of METRICS) {
    if (!levels.once) charts.push({ id: `fork-vs-base.${id}.ladder.linux-x64`, metric: id, platform: 'linux-x64', kind: 'ladder', comparison: 'base', size: SIZE.base[id], headline, caption: `${name}, fork against base, from 1 agent to 250 agents.` });
    charts.push({ id: `series.${id}.linux-x64`, metric: id, platform: 'linux-x64', kind: 'series', comparison: 'base', size: SIZE.base[id], headline, caption: `${name} by nightly, with perf.8 marked.` });
    charts.push({ id: `fork-vs-prev.${id}.linux-x64`, metric: id, platform: 'linux-x64', kind: 'prev', comparison: 'prev', size: SIZE.prev[id], headline, caption: `${name}, perf.8 against perf.7.` });
  }
  const withVerdict = new Set(metrics.filter((m) => m.verdict || m.verdict_vs_prev).map((m) => m.name));
  // One claim per row and comparison with a verdict; id = metric.platform.level.comparison.
  const claims = [];
  for (const m of metrics) {
    for (const [comparison, verdict] of [['base', m.verdict], ['prev', m.verdict_vs_prev]]) {
      const pct = (s) => Math.abs(parseFloat(String(s).replace(/[^\d.]/g, '')));
      const size = Math.round((pct(comparison === 'prev' ? m.text.delta_vs_prev_pct : m.text.delta_pct) / pct(m.text.threshold_pct)) * 1000) / 1000;
      if (verdict) claims.push({ id: `${m.id}.${m.platform}.${m.level}.${comparison}`, metric: m.id, platform: m.platform, level: m.level, comparison, verdict, size, clause: `${m.name} at ${m.level}` });
    }
  }
  return {
    schema: 't3cp/post-bundle/1',
    release: {
      tag: 'v0.1.9-perf.8', short: 'perf.8', date: '2026-11-16',
      base: { tag: 'v0.1.9-nightly.20261114.4700', date: '2026-11-14' },
      prev: { tag: 'v0.1.9-perf.7', short: 'perf.7', date: '2026-11-09' },
    },
    platforms: ['linux-x64'],
    levels: ['1', '100', '250'],
    headline_level: '100',
    changelog: ['Reads routed to the reader pool by statement class.', 'Message ordinals read through an index, not a scan.'],
    metrics,
    counts: COUNTS,
    charts,
    claims,
    allowed_numbers: [...allowed].sort(),
    allowed_literals: ['v0.1.9-perf.8', 'perf.8', 'v0.1.9-perf.7', 'perf.7', 'v0.1.9-nightly.20261114.4700',
      '2026-11-16', '16 Nov 2026', '2026-11-14', '14 Nov 2026', '2026-11-09', '9 Nov 2026', '2026'],
    allowed_metric_names: [...withVerdict].sort(),
    catalogue_names: [
      ...METRICS.map(([id, name]) => ({ id, name })),
      { id: 'push_p95_ms', name: 'Push latency p95' }, { id: 'turn_p95_ms', name: 'Turn time p95' },
    ],
  };
}

// A post that passes every rule against bundle().
export function goodPost() {
  return {
    title: 'v0.1.9-perf.8: 1 improved, 3 within noise',
    summary: 'Turns completed improved beyond noise at 100 agents: 352 against 318, +10.7%. '
      + 'Turn time p50 improved beyond noise at 250 agents, −29.4%. '
      + 'Peak memory regressed beyond noise at 250 agents: 1,530 MiB against 1,240 MiB.',
    sections: [
      { chart_id: 'fork-vs-base.turns_completed.ladder.linux-x64', caption: 'Turns completed improved beyond noise at 250 agents: 290 against 240, +20.8%.' },
      { chart_id: 'fork-vs-base.writer_tx_p95_ms.ladder.linux-x64', caption: 'Writer transaction p95 improved beyond noise: 15.1 ms against 17.2 ms. The changelog says "Reads routed to the reader pool by statement class."' },
      { chart_id: 'fork-vs-base.turn_p50_ms.ladder.linux-x64', caption: 'Turn time p50 is lower at 250 agents: 2,105 ms against 2,980 ms.' },
      { chart_id: 'fork-vs-base.rss_peak_mib.ladder.linux-x64', caption: 'Peak memory regressed beyond noise at 250 agents, +23.4% against a threshold of 19.0%.' },
      { chart_id: 'fork-vs-prev.rss_peak_mib.linux-x64', caption: 'Against perf.7, Peak memory is higher at 250 agents: 1,530 MiB against 1,250 MiB.' },
      { chart_id: 'fork-vs-base.dispatch_p95_ms.ladder.linux-x64', caption: 'Dispatch p95 within noise at 100 agents: 305 ms against 318 ms.' },
    ],
  };
}

// The same post in the placeholder form: free text only connects claims; the renderer writes every number.
export function goodClaimPost(b = bundle()) {
  return {
    bundle_sha256: createHash('sha256').update(JSON.stringify(b)).digest('hex'),
    summary: '{claim:rss_peak_mib.linux-x64.250.base}. {claim:turns_completed.linux-x64.100.base}.',
    sections: [
      { chart_id: 'fork-vs-base.turns_completed.ladder.linux-x64', caption: '{claim:turns_completed.linux-x64.250.base}.' },
      { chart_id: 'fork-vs-base.writer_tx_p95_ms.ladder.linux-x64', caption: '{claim:writer_tx_p95_ms.linux-x64.100.base}.' },
      { chart_id: 'fork-vs-base.turn_p50_ms.ladder.linux-x64', caption: '{claim:turn_p50_ms.linux-x64.250.base}.' },
      { chart_id: 'fork-vs-base.rss_peak_mib.ladder.linux-x64', caption: '{claim:rss_peak_mib.linux-x64.250.base}.' },
      { chart_id: 'fork-vs-prev.rss_peak_mib.linux-x64', caption: 'In this chart: {claim:rss_peak_mib.linux-x64.250.prev}.' },
      { chart_id: 'fork-vs-base.dispatch_p95_ms.ladder.linux-x64', caption: '{claim:dispatch_p95_ms.linux-x64.100.base}.' },
    ],
  };
}

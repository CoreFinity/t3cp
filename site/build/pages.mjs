// The pages. Each returns {path, title, desc, nav, page, body, attrs}. The body is static HTML that reads without
// script: every chart has its table, the overview carries the last deployed verdict strip, the lead release is
// rendered in full. app.js (loaded into the build as T) renders the tables, so the static and the live forms match.
import { esc, LEGEND, PREV, NEXT } from './layout.mjs';
import { releaseHTML } from './render-post.mjs';
import { createHash } from 'node:crypto';

const LEVELS = ['1', '50', '100', '150', '200', '250'];
const seg = (key, opts, cur, label, cls = '') => `<span class="seg${cls}" data-seg="${key}" role="group" aria-label="${esc(label)}">${opts.map(([v, l, hidden]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${String(v) === String(cur)}"${hidden ? ' hidden' : ''}>${l}</button>`).join('')}</span>`;
const LEVEL_OPTS = empty => LEVELS.map(l => [l, l]).concat(empty ? [['1e', '<span title="A fresh install, one agent">1 agent · empty</span>']] : []);
// The headline levels, 50 the default: on the benchmark machine the server saturates from 100 agents.
const LEAD_OPTS = [['1', '1 agent'], ['50', '50 agents'], ['100', '100 agents'], ['250', '250 agents']], DEF = '50';
const agents = (opts, cur, label, extra = '') => `<span class="ctl-g"><span class="ctl-l" title="N agents, 3 people watching live, status polling that grows with N">Agents</span>${seg('l', opts, cur, label)}${extra}</span>`;
const range = () => `<span class="ctl-g"><span class="ctl-l">Range</span>${seg('r', [[7, '7d'], [14, '14d'], [30, '30d']], 30, 'Time range')}</span>`;
const stepper = (what, attr = 'data-step', pos = '') => `<div class="stepper"><button type="button" class="icon" ${attr}="-1" aria-label="Previous ${what}">${PREV}</button><span id="pos">${pos}</span><button type="button" class="icon" ${attr}="1" aria-label="Next ${what}">${NEXT}</button></div>`;
const ERR = '<p class="err" id="err" role="alert" hidden></p>';
const kb = n => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' KB' : n + ' bytes');
const bytes = n => Number(n).toLocaleString('en-GB') + ' bytes';
const UP = { yes: 'Every upstream build', 'yes L': 'Every upstream build, Linux only', pre: "Needs the harness's preload", fork: 'Fork builds only' };
const LANE = { daily: 'Every record, inside the agent ladder', record: 'Once per record, outside the ladder', weekly: 'The weekly long-run lane, which starts after launch', release: 'Fork releases only', later: 'Catalogued; not measured yet' };

// ---------- overview ----------
// The nightlies of the window still to be measured, as one sentence ('' once the window's first nightly is published).
export function pendingLine(c) {
  const p = c.pending, T = c.T;
  if (!p) return '';
  return p.to ? `Nightlies from ${T.dShort(p.from)} to ${T.dLong(p.to)} are still to be measured; the series start on ${T.dShort(p.first)}.` : `Nightlies from ${T.dLong(p.from)} onwards are still to be measured.`;
}
// Whether any published record falls in an era (a fixture's span of nightlies).
export const eraMeasured = (c, from, to) => (c.records || []).some(r => r.date >= from && (!to || r.date <= to));
// The date a metric's series starts: the later of its era start and the first published record.
const startOf = (c, m) => (m.era_start && c.first ? (m.era_start > c.first ? m.era_start : c.first) : m.era_start);

export function overview(c) {
  const { T, cat, plat } = c, H = c.headlines, m0 = H[1], L = DEF;
  const Ms = H.map(id => c.model(id, L, 30));
  const tabs = H.map(id => `<button type="button" role="tab" aria-selected="${id === m0}" tabindex="${id === m0 ? 0 : -1}" data-id="${id}">${esc(T.cap(cat[id].short || cat[id].name))}</button>`).join('');
  const f = c.forks.filter(x => x.platforms[plat]).pop();
  const fk = T.forkFor(H, f ? c.read(T.basePath(f, plat)) : null, cat, f, { plat: c.platName, level: L });
  const latest = c.ix && c.ix.platforms.find(p => p.id === plat);
  const rec = latest && latest.latest_date ? `<p class="dim">Latest nightly <span class="tag">${esc(latest.latest_tag)}</span>, ${T.dLong(latest.latest_date)}, ${esc(c.platName)} ${esc(latest.latest_status)}.</p>` : '';
  const body = `<h1 class="sr">T3 Code, performance over time</h1>
${ERR}
<div class="strip" id="strip-w">${rec}${c.pending ? `<p class="dim">${esc(pendingLine(c))}</p>` : ''}<div id="strip">${T.stripFor(H, Ms, cat, { plat: c.platName, level: L })}</div></div>
<section class="hero" aria-label="Headline metric over time">
  <div class="tabs-row">
    <div class="tabs" id="tabs" role="tablist" aria-label="Metric">${tabs}</div>
    ${stepper('metric', 'data-step', `2 / ${H.length}`)}
  </div>
  <div class="head">
    <div id="ro" aria-live="polite">${T.readoutHTML(cat[m0], Ms[1])}</div>
    <div class="ctl">
      ${agents(LEAD_OPTS, L, 'Agents: 1, 50, 100 or 250', `<a class="ctl-x" id="full" href="/metrics/${m0}/" title="The metric page offers every level from 1 to 250 agents">1 to 250 on the metric page</a>`)}
      ${range()}
    </div>
  </div>
  <div class="plot h-hero" id="hero"></div>
  ${LEGEND(`<a id="open" href="/metrics/${m0}/">Open this metric</a>`)}
  <details class="mt3"><summary id="hcap">Table: the eight headline metrics, 50 agents</summary><div class="tw" id="htable">${T.headTable(Ms)}</div></details>
</section>

<section class="sec">
  <div class="sec-h"><h2>Every metric, over time.</h2><a class="btn" href="/metrics/" data-nav="/metrics/" id="all">See all ${c.catalogue.length} metrics</a></div>
  <div class="grid" id="grid">${H.map((id, i) => T.cardHTML(cat[id], Ms[i], '/metrics/' + id + '/')).join('')}</div>
</section>

<section class="sec">
  <div class="sec-h"><div><h2>The fork, against its base.</h2><p id="forksub">${esc(fk.sub)}</p></div>
  <div class="row"><a class="btn btn-p" href="/compare/" data-nav="/compare/">Compare two builds</a><a class="btn" href="/releases/" data-nav="/releases/">See the latest release</a></div></div>
  <div id="fork">${fk.html}</div>
</section>`;
  return { path: 'index.html', title: 't3cp · T3 Code, performance over time', desc: "An independent record of T3 Code's performance over time: every upstream nightly measured at 1 to 250 agents, with the performance fork's releases on the same charts.", nav: 'Overview', page: 'overview', body };
}

// ---------- metrics index: the catalogue ----------
export function metrics(c) {
  const { T, cat } = c, groups = c.groups;
  const val = (id, L) => ((c.latest[c.plat] || {})[id] || {})[L];
  const rows = groups.map(g => {
    const ms = c.catalogue.filter(m => m.group === g.id);
    if (!ms.length) return '';
    return `<tr><th colspan="9" class="grp">${esc(g.name)}</th></tr>` + ms.map(m => {
      const L = T.effLevel(m, DEF), x = val(m.id, L), b = m.bands && m.bands[c.plat];
      const na = m.na_on.includes(c.plat) ? 'n/a on macOS' : null;
      return `<tr><td class="wrapc"><a href="/metrics/${m.id}/">${esc(m.name)}</a><br><code class="dim">${m.id}</code></td><td>${esc(m.unit)}</td><td>${m.better}</td><td class="n">${b ? b.band.toFixed(1) + '%' : '–'}</td><td class="hs">${startOf(c, m) ? T.dShort(startOf(c, m)) : '–'}</td><td class="hs">${m.na_on.length || !c.mac.show ? 'Linux' : 'Linux, macOS'}</td><td class="hs">${esc(m.lane)}</td><td class="n">${na || (x ? T.fmtU(x[0], m) : '–')}</td><td class="mut">${na ? 'no verdict' : x ? (x[2] == null ? '' : T.glyph(T.vk(x[1]), x[2])) + esc(T.say(T.vk(x[1]), x[3])) : 'no records'}</td></tr>`;
    }).join('');
  }).join('');
  const body = `<header class="page-h"><h1>Every metric, over time.</h1></header>
${ERR}
<div id="unknown" hidden></div>
<div class="filters">
  <div class="ctl"><span class="ctl-g">${seg('g', [['all', 'All']].concat(groups.map(g => [g.id, esc(g.name)])), 'all', 'Group')}</span></div>
  <div class="ctl">
    <span class="ctl-g">${seg('v', [['all', 'All'], ['bad', 'Regressed'], ['good', 'Improved'], ['ok', 'Within noise']], 'all', 'Latest verdict')}</span>
    ${agents(LEVEL_OPTS(false), DEF, 'Agents, concurrent sessions')}
    ${range()}
  </div>
</div>
<p class="count" id="count" aria-live="polite">${c.catalogue.length} metrics, ${esc(c.platName)}, 50 agents</p>
<div class="grid" id="grid"></div>
<div class="empty" id="none" hidden><p>No metric matches.</p><p class="mt1"><button type="button" class="btn" id="clear">Clear filters</button></p></div>
${LEGEND()}
<details class="mt3" id="cat"><summary>The catalogue as a table: every metric, its unit, direction, band and latest value at 50 agents</summary><div class="tw"><table><thead><tr><th>Metric</th><th>Unit</th><th>Better</th><th class="n">Band</th><th class="hs">From</th><th class="hs">Platforms</th><th class="hs">Lane</th><th class="n">Latest</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table></div></details>
<script type="application/json" id="latest">${JSON.stringify(c.latest).replace(/</g, '\\u003c')}</script>`;
  return { path: 'metrics/index.html', title: 'All metrics · t3cp', desc: `The ${c.catalogue.length} metrics t3cp records for T3 Code, with unit, direction, noise band and the latest value.`, nav: 'Metrics', page: 'metrics', body };
}

// ---------- one metric ----------
export function metric(c, m, i) {
  const { T, cat } = c, L = T.effLevel(m, DEF);
  const M = c.model(m.id, L, 30), MA = c.model(m.id, L, 0), b = m.bands && m.bands[c.plat], na = m.na_on.includes(c.plat) ? 'na' : null;
  const opts = c.groups.map(g => `<optgroup label="${esc(g.name)}">${c.catalogue.filter(x => x.group === g.id).map(x => `<option value="${x.id}"${x.id === m.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('');
  const lvl = m.scope === 'record'
    ? `<span class="ctl-g"><span class="ctl-l" title="Start-up is measured once per record, on the large fixture and on an empty database">Database</span>${seg('l', [['once', 'Large fixture']].concat(m.empty_cell ? [['1e', 'Fresh install']] : []), 'once', 'Database')}</span>`
    : agents(LEVEL_OPTS(m.empty_cell), DEF, 'Agents, concurrent sessions');
  // Counters are judged without a band (aggregate.mjs decide()): an absolute counter flags any value above zero, a rise
  // counter a rise above its reference.
  const counted = m.counter === 'absolute' ? 'Counted, not banded: any value above zero is flagged as regressed.' : m.counter ? 'Counted, not banded: a rise above the reference is flagged as regressed.' : null;
  const rule = m.better === 'context' ? 'Shown for context: never judged.' : counted ? `${m.better === 'higher' ? 'Higher' : 'Lower'} is better. ${counted}` : b ? `${m.better === 'higher' ? 'Higher' : 'Lower'} is better. Noise band ${b.band.toFixed(1)}% on ${esc(c.platName)} (n = ${b.n}), so a change counts beyond ${b.threshold.toFixed(1)}%.` : `${m.better === 'higher' ? 'Higher' : 'Lower'} is better. No noise band measured yet, so no verdict.`;
  const Sh = c.shard(m.id), F = Sh && Sh.fork;
  let ladder = '', ltable = '';
  if (m.scope === 'record') ladder = `<p class="cap"><b>${esc(m.name)}</b>${T.dir(m)}</p><p class="note">Measured once per record, outside the agent ladder: on the large fixture after its migration, and on an empty database where the catalogue says so.</p>`;
  else {
    let j = -1, k = F ? F.tags.length - 1 : -1;
    if (Sh) { j = Sh.dates.length - 1; while (j > 0 && (!Sh.levels[DEF] || Sh.levels[DEF].median[j] == null)) j--; }
    const lc = Sh && j >= 0 ? T.ladderChart(m, Sh, j, k, { plat: c.platName }) : null;
    ladder = `<p class="cap"><b>${esc(m.name)}</b>${T.dir(m)} at 1 to 250 agents, ${esc(c.platName)}</p><div class="pick"><select id="ln" aria-label="Nightly"></select><span class="vs">against</span><select id="lf" aria-label="Fork release"></select></div><div class="plot h-lad" id="ladder"></div>`;
    ltable = `<details><summary>Ladder as a table</summary><div class="tw" id="ltable">${lc ? lc.table() : '<p class="note">No records yet.</p>'}</div></details>`;
  }
  const shards = (c.ix && c.ix.series[c.plat] && c.ix.series[c.plat][m.id]) || [];
  const dl = shards.map(s => { const f = T.shardFile(c.plat, m.id, [s]), sz = c.size(f); return `<li><span><a href="/data/v1/${f}"><code>${f}</code></a></span><span>${s === 'latest' ? 'last 90 days' : s === 'all' ? 'every record' : s}, JSON${sz ? ', ' + kb(sz) : ''}</span></li>`; }).join('');
  const body = `<h1 class="sr" id="h1">${esc(m.name)}</h1>
${ERR}
<section class="hero" aria-label="Metric over time">
  <div class="tabs-row pickrow">
    <a class="note" href="/metrics/" data-nav="/metrics/">All metrics</a>
    <select id="pick" aria-label="Metric">${opts}</select>
    <span class="grow"></span>
    ${stepper('metric', 'data-step', `${i + 1} / ${c.catalogue.length}`)}
  </div>
  <div class="head">
    <div id="ro" aria-live="polite">${T.readoutHTML(m, M, { na: na || (M && T.lastPt(M) ? null : 'none') })}</div>
    <div class="ctl">${lvl}${range()}</div>
  </div>
  <div class="plot h-hero" id="hero"></div>
  ${LEGEND()}
</section>

<section class="sec">
  <div class="two">
    <div><h2>${m.scope === 'record' ? 'Once per record.' : 'As agents grow.'}</h2><p class="lede" id="info">${esc(m.definition)}</p><p class="note" id="rule">${rule}</p>
      <dl class="spec mt3">
        <dt>Unit</dt><dd>${esc(m.unit)}</dd>
        <dt>Better</dt><dd><b>${m.better}</b></dd>
        <dt>Noise band</dt><dd>${counted ? 'not used: a counter is judged by its count' : b ? `<b>${b.band.toFixed(1)}%</b>, threshold ${b.threshold.toFixed(1)}% (n = ${b.n})` : 'none measured yet: no verdict'}</dd>
        <dt>Recorded from</dt><dd>${c.pending && !c.pending.to ? esc(pendingLine(c)) : m.era_start ? T.dLong(startOf(c, m)) + '; before that the series is a gap, never a zero' + (c.pending ? '. ' + esc(pendingLine(c)) : '') : 'not recorded yet'}</dd>
        <dt>Platforms</dt><dd>${!c.mac.show ? 'Linux x64' : m.na_on.includes('darwin-arm64') ? 'Linux x64 only: macOS cannot measure it (no /proc)' : c.mac.live ? 'Linux x64 and macOS arm64' : 'Linux x64; macOS records are not yet published'}</dd>
        <dt>Lane</dt><dd>${LANE[m.lane] || esc(m.lane)}</dd>
        <dt>Upstream builds</dt><dd>${UP[m.upstream] || esc(m.upstream)}</dd>
        <dt>Source</dt><dd><code>${esc(m.source.file)}</code>: <code>${esc(m.source.field)}</code></dd>
      </dl>
    </div>
    <div>${ladder}</div>
  </div>
</section>

<details id="records"><summary id="rsum">Records, ${T.lvLabel(L)}</summary><div class="tw" id="rtable">${MA ? T.recordsTable(MA) : '<p class="note">No records yet.</p>'}</div></details>
${ltable}
<details><summary>Download this series</summary>${dl ? `<ul class="plain pad">${dl}</ul>` : '<p class="note pad">No series file yet.</p>'}</details>`;
  return { path: `metrics/${m.id}/index.html`, title: `${m.name} · t3cp`, desc: `${m.name} for T3 Code, every nightly at 1 to 250 agents: ${m.definition}`, nav: 'Metrics', page: 'metric', attrs: { metric: m.id }, body };
}

// ---------- compare ----------
export function compare(c) {
  const { T, cat, plat } = c, f = c.forks.filter(x => x.platforms[plat]).pop();
  let figs = '', rows = '<p class="note">No fork release has a record yet.</p>', sub = '';
  if (f) {
    const pre = c.read(T.basePath(f, plat));
    sub = T.baseSub(f) + '.';
    if (pre) {
      const rs = T.cmpRows(c.catalogue.map(m => m.id), pre, cat, DEF);
      figs = T.figs(T.tally(rs)); rows = T.deltasHTML(rs, T.baseName(f), 'Fork ' + T.short(f.tag));
    } else rows = '<p class="note">No comparison with its upstream base yet.</p>';
  }
  const modes = [['fork', 'Fork against its base'], ['nightly', 'Two nightlies']].concat(c.mac.show ? [['platform', 'Linux against macOS']] : []);
  const body = `<header class="page-h"><h1>Compare two builds.</h1><p class="lede" id="cmp-sub">${esc(sub)}</p></header>
${ERR}
<div class="ctl">${seg('mode', modes, 'fork', 'What to compare')}</div>
<div class="pick mt1">
  <select data-sel="a" id="a" aria-label="Base build"></select>
  <span id="b-wrap" hidden><span class="vs">against</span> <select data-sel="b" id="b" aria-label="Build to compare"></select></span>
  <button type="button" class="btn" id="swap" hidden>Swap</button>
</div>
<div class="ctl mt1">${agents(LEVEL_OPTS(false), DEF, 'Agents, concurrent sessions')}</div>
<div class="figs" id="figs" aria-live="polite">${figs}</div>
<div id="rows">${rows}</div>
<p class="note mt2">The shaded zone is each metric's noise band plus five points. A bar that stays inside it is within noise.${c.mac.show ? ' Linux against macOS shows ratios only: different machines get no verdict.' : ''}</p>`;
  return { path: 'compare/index.html', title: 'Compare builds · t3cp', desc: 'Compare two T3 Code builds over every metric: a fork release against its base, or two nightlies.', nav: 'Compare', page: 'compare', body };
}

// ---------- releases ----------
// A release chart's table view, rendered by the build from the shard the browser draws the chart from: the last 30
// records for a series, the releases in turn for fork-vs-prev, the load levels for a ladder. app.js renders none.
function chartTable(c, rel, L) {
  const { T } = c, cat = {}; c.catalogue.forEach(m => { cat[m.id] = m; });
  const none = '<table><tbody><tr><td class="mut">No records yet.</td></tr></tbody></table>';
  return p => {
    const m = cat[p.metric], Sh = m && c.shard(m.id), Lm = m && T.effLevel(m, L);
    if (!m) return '';
    let t = null, what = 'the last 30 records';
    if (Sh && p.ladder && m.scope !== 'record') {
      what = 'at each load level';
      const fi = c.forks.find(f => f.tag === rel.tag), cp = fi && fi.base_sha ? T.basePath(fi, c.plat) : null;
      if (cp) { const cf = c.ix && (c.ix.compare || []).includes(cp) ? c.read(cp) : null; t = cf ? T.baseLadderChart(m, cf, fi, { plat: c.platName }).table() : null; }
      else { let j = Sh.dates.indexOf(rel.base_date || (rel.base && rel.base.date)); if (j < 0) j = Sh.dates.length - 1; t = T.ladderChart(m, Sh, j, Sh.fork ? Sh.fork.tags.indexOf(rel.tag) : -1, { plat: c.platName }).table(); }
    } else if (Sh && p.kind === 'fork-vs-prev') {
      what = 'release by release';
      const F = Sh.fork, fl = F && F.levels[Lm];
      if (fl) t = `<table><thead><tr><th>Release</th><th>Date</th><th class="n">Value</th><th class="n">vs previous</th><th>Verdict</th></tr></thead><tbody>${F.tags.map((tag, k) => (fl.value[k] == null ? '' : `<tr><td class="tag">${esc(T.short(tag))}</td><td>${T.dLong(F.dates[k])}</td><td class="n">${T.fmtU(fl.value[k], m)}</td><td class="n">${fl.vs_prev[k] == null ? '–' : T.glyph(T.vk(fl.vs_prev_verdict[k]), fl.vs_prev[k]) + T.pct(fl.vs_prev[k])}</td><td class="mut">${esc(T.say(T.vk(fl.vs_prev_verdict[k]), fl.vs_prev_note[k]))}</td></tr>`)).join('')}</tbody></table>`;
    } else if (Sh) {
      const M = T.model(Sh, m, Lm, 30, c.shard('agents_served'));
      t = M ? T.recordsTable(M) : null;
    }
    return `<details class="ctab"><summary>Table: ${esc(m.name)}, ${what}</summary><div class="tw">${t || none}</div></details>`;
  };
}

export function releases(c, frag) {
  const { T, plat } = c, F = c.forks, lead = F[F.length - 1];
  let head = '<h1 class="rel-t">Releases</h1><p class="lede rel-s">No fork release has been measured yet.</p>', post = '';
  if (lead) {
    const rel = c.release(lead.tag);
    if (rel) {
      const r = releaseHTML(T, rel, { catalogue: c.catalogue, headlines: c.headlines, platform: plat, level: DEF, platName: c.platName, table: chartTable(c, rel, DEF) });
      head = r.head; post = r.body;
    } else {
      head = `<h1 class="rel-t">${esc(lead.tag)}</h1><p class="lede rel-s">${T.dLong(lead.date)}. Measured; its post is not written yet.</p>`;
      post = '<p class="note">The release post appears here once it is written and checked.</p>';
    }
  }
  // Every release gets a tab; posts that fail their checker still render, charts only.
  F.forEach(f => { if (c.release(f.tag)) releaseHTML(T, c.release(f.tag), { catalogue: c.catalogue, headlines: c.headlines, platform: plat, level: DEF }).dropped.forEach(id => c.log(`releases: ${f.tag}: chart ${id} is not in the catalogue, section left out`)); });
  const tabs = F.map(f => [f.tag, esc(T.short(f.tag))]).concat([['next', 'next']]);
  const body = `<header class="page-h tight"><p class="note">Releases of <a href="https://github.com/navidnadali/t3code">the performance fork</a>, oldest to newest. Each one is measured against the upstream code it is based on.</p><div id="rhead">${head}</div></header>
${ERR}
<div class="tabs-row rel-tabs">
  <div class="tabs" id="rtabs">${seg('rel', tabs, lead ? lead.tag : 'next', 'Release', ' seg-s')}</div>
  ${stepper('release', 'data-rstep', lead ? `${F.length} / ${F.length + 1}` : '')}
</div>
<div class="ctl mt1">${agents(LEAD_OPTS, DEF, 'Agents: 1, 50, 100 or 250')}</div>
<article class="post" id="post">${post}</article>`;
  return { path: 'releases/index.html', title: 'Releases · t3cp', desc: "Every release of the T3 Code performance fork, measured against its upstream base, built from source.", nav: 'Releases', page: 'releases', attrs: { frag: frag || '' }, body };
}

// ---------- records ----------
export function records(c) {
  const { T, plat } = c, ix = c.ix;
  // A record that is not complete shows its reason code (status_reason) from the record file.
  const status = (s, why) => (s ? `<span class="st${s === 'complete' ? ' st-merged' : ''}">${esc(s)}</span>${why && s !== 'complete' ? ` <code class="dim">${esc(why)}</code>` : ''}` : '<span class="dim">–</span>');
  const nr = c.records.slice().reverse().slice(0, 120);
  const nrows = nr.map(r => {
    const p = r.platforms[plat], rec = p && c.read(p.path), arch = rec && rec.release.archive, tol = c.T.tolerance(rec);
    // Each saturated level: "N agents: n of N served", the symptoms in the flag's tooltip.
    const sat = rec && rec.cells ? Object.keys(rec.cells).filter(L => rec.cells[L] && rec.cells[L].saturated).map(L => { const cl = rec.cells[L], s = cl.metrics && cl.metrics.agents_served, by = [...new Set((cl.attempts || []).flatMap(x => x.saturated_by || []))], N = cl.agents_total || +L; return `<span class="st"${by.length ? ` title="${esc(c.T.satWords(by))}"` : ''}>${esc(L)} agents: ${s ? c.T.fmt(s.median) : '?'} of ${esc(N)} served</span>`; }).join(' ') : '';
    return `<tr><td>${T.dLong(r.date)}</td><td class="tag">${esc(r.tag)}</td><td class="hs sha" title="${esc(r.sha)}">${esc(r.sha.slice(0, 12))}</td><td class="hs sha"${arch ? ` title="${esc(arch.sha256)}"` : ''}>${arch ? esc(arch.sha256.slice(0, 16)) + '…' : '–'}</td><td class="n hs">${tol == null ? '–' : esc(tol)}</td><td>${status(p && p.status, rec && rec.status_reason)}${sat ? ' ' + sat : ''}</td><td>${p ? `<a href="/data/v1/${esc(p.path)}">JSON</a>` : ''}</td></tr>`;
  }).join('');
  const frows = c.forks.slice().reverse().map(f => {
    const p = f.platforms[plat], rec = p && p.path && c.read(p.path);
    return `<tr><td class="tag">${esc(f.tag)}</td><td>${T.dLong(f.date)}</td><td class="hs sha" title="${esc(f.sha)}">${esc(f.sha.slice(0, 12))}</td><td class="hs">${f.base_sha ? `built from source at <span class="sha">${esc(f.base_sha.slice(0, 12))}</span>` : f.base_tag ? `<span class="tag">${esc(f.base_tag)}</span>` : '–'}</td><td>${status(p && p.status, rec && rec.status_reason)}</td><td>${p ? `<a href="/data/v1/${esc(p.path)}">JSON</a>` : ''}</td></tr>`;
  }).join('');
  const more = c.records.length > 120 ? `<p class="note mt1">The ${c.records.length - 120} older records are in <a href="/downloads/">the downloads</a>.</p>` : '';
  const body = `<header class="page-h"><h1>Records.</h1><p class="lede">One record per upstream nightly on ${esc(c.platName)}, and one per fork release. Each links to its JSON file, which carries every attempt's values.${c.pending ? ' ' + esc(pendingLine(c)) : ''}</p></header>
<div class="tw"><table><thead><tr><th>Date</th><th>Tag</th><th class="hs">Commit</th><th class="hs">Archive sha256</th><th class="n hs" title="The recorded tolerance of the driver's check that sessions represent the fixture">Tolerance</th><th>Status</th><th>File</th></tr></thead><tbody>${nrows || '<tr><td colspan="7" class="mut">No records yet.</td></tr>'}</tbody></table></div>${more}
<section class="sec mt3"><div class="sec-h"><h2>Fork releases.</h2></div>
<div class="tw"><table><thead><tr><th>Tag</th><th>Date</th><th class="hs">Commit</th><th class="hs">Upstream base</th><th>Status</th><th>File</th></tr></thead><tbody>${frows || '<tr><td colspan="6" class="mut">No fork release measured yet.</td></tr>'}</tbody></table></div></section>`;
  return { path: 'records/index.html', title: 'Records · t3cp', desc: 'Every t3cp record of T3 Code: date, tag, commit, archive sha256, status and the record file.', nav: '', page: 'records', body };
}

// ---------- downloads ----------
export function downloads(c) {
  const files = c.downloads.map(d => `<li><span><a href="/data/v1/${esc(d.path)}"><code>${esc(d.path)}</code></a> <span class="dim">${esc(d.what)}</span></span><span>${bytes(d.bytes)}</span><span class="sha">sha256 ${esc(d.sha256)}</span></li>`).join('');
  const fx = c.fixtures;
  const pend = '<span class="dim">pending</span>';
  const fixtures = (fx && fx.length ? fx : c.eras.map(e => ({ id: e.id, era_from: e.from, era_to: e.to, migration: e.migration, pending: true }))).map(f => {
    const zst = f.zst || {}, sq = f.sqlite || {}, name = zst.name || `${f.id}-v${f.version || 1}.sqlite.zst`;
    return `<section class="sec"><div class="sec-h"><div><h2>${esc(f.id)}.</h2><p>Serves nightlies from ${c.T.dLong(f.era_from)}${f.era_to ? ' to ' + c.T.dLong(f.era_to) : ' onwards'}, migration head ${esc(f.migration)}.${eraMeasured(c, f.era_from, f.era_to) ? '' : ' Its nightlies are still to be measured.'}</p></div></div>
<dl class="spec">
  <dt>File</dt><dd><a href="https://files.t3cp.io/fixtures/${esc(name)}"><code>https://files.t3cp.io/fixtures/${esc(name)}</code></a></dd>
  <dt>Builder</dt><dd>${f.pending ? pend : `The tag <a href="https://github.com/navidnadali/t3code/tree/t3cp-fixture/${esc(f.id)}-v${esc(f.version || 1)}"><code>t3cp-fixture/${esc(f.id)}-v${esc(f.version || 1)}</code></a> on the fork.`}</dd>
  <dt>Compressed</dt><dd>${zst.bytes ? `<b>${bytes(zst.bytes)}</b>` : pend}<br><span class="sha">sha256 ${zst.sha256 ? esc(zst.sha256) : pend}</span></dd>
  <dt>Uncompressed</dt><dd>${sq.bytes ? `<b>${bytes(sq.bytes)}</b>` : pend}<br><span class="sha">sha256 ${sq.sha256 ? esc(sq.sha256) : pend}</span></dd>
  <dt>Decompress</dt><dd><code>zstd -d --long=31 ${esc(name)}</code><br>The <code>--long=31</code> flag is required: the file was compressed with a 2 GiB window.</dd>
  <dt>Shape</dt><dd>${c.shapeFile ? `<a href="/${esc(c.shapeFile.path)}"><code>${esc(c.shapeFile.path)}</code></a>, ${bytes(c.shapeFile.bytes)}, sha256 <span class="sha">${esc(c.shapeFile.sha256)}</span>` : pend}${f.measured ? `<br>Measured counts and sizes: <a href="/${esc(f.measured.path)}"><code>${esc(f.measured.path)}</code></a>, ${bytes(f.measured.bytes)}, sha256 <span class="sha">${esc(f.measured.sha256)}</span>` : f.shape_measured ? `<br>Measured counts and sizes: <code>${esc(f.shape_measured)}</code>` : ''}</dd>
  <dt>Recipe</dt><dd>${f.recipe ? `<code>${esc(f.recipe)}</code>` : pend}</dd>
  <dt>Licence</dt><dd>CC BY 4.0, attributed to t3cp.io.</dd>
</dl></section>`;
  }).join('');
  const body = `<header class="page-h"><h1>Take the data.</h1><p class="lede">Every record, every series and the noise bands, under CC BY 4.0, attributed to t3cp.io: "Data: t3cp.io, CC BY 4.0" with a link is enough. Each file lists its size and sha256.</p></header>
<ul class="plain">${files || '<li><span>No data files yet.</span><span></span></li>'}</ul>
<p class="note mt2">Every record is also its own file, listed on <a href="/records/">Records</a>; each metric's series is linked from its page.</p>
<section class="sec mt3"><div class="sec-h"><div><h2>The harness.</h2><p>The program that drives the server and measures it. Each record names its version and the sha256 of its files.</p></div></div>
<ul class="plain">${c.harness.length ? c.harness.map(h => `<li><span><a href="https://github.com/navidnadali/t3code/tree/${esc(h.version)}"><span class="tag">${esc(h.version)}</span></a> <span class="dim">records from ${c.T.dLong(h.from)} to ${c.T.dLong(h.to)}</span></span><span class="sha">files sha256 ${esc(h.files_sha256)}</span></li>`).join('') : '<li><span>No harness version recorded yet.</span><span></span></li>'}</ul></section>
<section class="sec mt3"><div class="sec-h"><div><h2>The fixtures.</h2><p>The synthetic databases every record runs on, one per schema era, built from a published recipe through the server's own code.</p></div></div></section>
${fixtures}`;
  return { path: 'downloads/index.html', title: 'Downloads · t3cp', desc: 'Download every t3cp record, series, noise band and fixture, with sizes and sha256.', nav: '', page: 'downloads', body };
}

// ---------- prose pages from site/pages/*.html with {{tokens}} ----------
export function prose(c, name, tpl, tokens, meta) {
  const body = tpl.replace(/\{\{([a-z_]+)\}\}/g, (_, k) => { if (!(k in tokens)) throw new Error(`site/pages/${name}.html: unknown token {{${k}}}`); return tokens[k]; });
  return Object.assign({ path: `${name}/index.html`, page: name, body }, meta);
}

export function notFound() {
  const body = `<header class="page-h"><h1>Page not found.</h1><p class="lede">Nothing lives at this address. <a href="/">The overview</a> and <a href="/metrics/">every metric</a> are one click away.</p></header>`;
  return { path: '404.html', title: 'Not found · t3cp', desc: 'This page does not exist.', nav: '', page: 'page404', body };
}

export function mrsPage(c, render) {
  return { path: 'mrs/index.html', title: 'MRs · t3cp', desc: "The performance fork's pull requests to T3 Code: open, merged and closed.", nav: 'MRs', page: 'mrs', body: render(c.mrs) };
}

// Every release at each headline level, as a fragment (head, a marker, body) the Releases page fetches. The URLs carry
// a hash of all fragments, which the page names, so a fresh page never pairs with a stale fragment.
export function releaseFragments(c) {
  const out = [];
  c.forks.forEach(f => {
    const rel = c.release(f.tag);
    LEAD_OPTS.map(o => o[0]).forEach(L => {
      const r = rel ? releaseHTML(c.T, rel, { catalogue: c.catalogue, headlines: c.headlines, platform: c.plat, level: L, platName: c.platName, table: chartTable(c, rel, L) })
        : { head: `<h1 class="rel-t">${esc(f.tag)}</h1><p class="lede rel-s">${c.T.dLong(f.date)}. Measured; its post is not written yet.</p>`, body: '<p class="note">The release post appears here once it is written and checked.</p>' };
      out.push({ tag: f.tag, L, html: `${r.head}<!--body-->${r.body}\n` });
    });
  });
  const hash = createHash('sha256').update(out.map(f => `${f.tag}/${f.L}\n${f.html}`).join('\n')).digest('hex').slice(0, 12);
  return { hash, files: out.map(f => ({ path: `releases/${f.tag}/${f.L}.${hash}.html`, html: f.html })) };
}

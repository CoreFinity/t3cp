// The scenario pages: /scenarios/ (every row of scenarios.json) and /scenarios/<id>/ (the row's latest version; an
// older version at /scenarios/<id>/<version>/). Static HTML from the build, no script of their own: the rows, their
// cells and the metric texts come from scenarios.json and catalogue/catalogue.json, the values from the aggregator's
// scenarios/index.json and series shards when records exist. A null value shows data's public reason words.
import { esc } from './layout.mjs';
import { SCENARIO_REASON_WORDS } from '../../tools/t3cp/lib/schemas.mjs';

// Each records table shows the newest rows only, so a page stays within its budget however long the history.
export const TABLE_ROWS = 30;
const EMPTY = 'No records yet: this scenario has not run on a published build yet.';
const DESC = 'Fixed workloads t3cp measures beside the load ladder, one page per scenario.';

const pageOf = (row, latest) => (latest ? `scenarios/${row.id}/index.html` : `scenarios/${row.id}/${row.version}/index.html`);
const hrefOf = (row, latest) => `/${pageOf(row, latest).replace(/index\.html$/, '')}`;

// The rows by id, newest version first.
function byId(rows) {
  const ids = new Map();
  for (const row of rows) ids.set(row.id, [...(ids.get(row.id) || []), row]);
  for (const list of ids.values()) list.sort((a, b) => b.version - a.version);
  return ids;
}

export function scenarioPages(c, scenarios) {
  const { T } = c;
  const catFile = c.catFile;
  const metric = id => catFile.metrics.find(m => m.id === id) || null;
  const platName = id => (catFile.platforms.find(p => p.id === id) || {}).name || id;
  const ix = c.read('scenarios/index.json');
  const indexRow = row => (ix ? ix.rows.find(r => r.id === row.id && r.version === row.version) : null) || null;
  const ids = byId(scenarios.rows);
  // While macOS is hidden (site/config.json, no macOS record yet), no page names it.
  const shown = row => row.platforms.filter(p => p !== 'darwin-arm64' || (c.mac && c.mac.show));
  const isLatest = row => ids.get(row.id)[0] === row;

  // ---------- the index ----------
  // A row's records and the date of its newest of any kind (nightly, fork release, upstream base): the ladder's from
  // the ladder's own lists, a scenario row's from the aggregator's index and its series.
  const recordsOf = row => {
    const plats = shown(row);
    if (row.metrics === 'catalogue') {
      const ix0 = c.ix || {};
      const lists = [c.records || [], ix0.fork || [], ix0.bases || []].map(l => l.filter(e => plats.some(p => e.platforms && e.platforms[p])));
      return { n: lists.reduce((s, l) => s + l.reduce((k, e) => k + plats.filter(p => e.platforms[p]).length, 0), 0), dates: lists.flat().map(e => e.date) };
    }
    const r = indexRow(row);
    if (!r) return { n: 0, dates: [] };
    const dates = [];
    for (const p of plats) {
      const first = (r.series[p] || [])[0], sh = first ? c.read(first) : null;
      if (sh) dates.push(...sh.nightly.dates, ...sh.fork.map(e => e.date), ...sh.base.map(e => e.date));
    }
    return { n: plats.reduce((k, p) => k + ((r.platforms[p] || {}).records || 0), 0), dates };
  };
  const recordsCell = row => {
    const { n, dates } = recordsOf(row);
    if (!n) return 'none yet';
    const latest = dates.filter(Boolean).sort().pop();
    return `${n} record${n === 1 ? '' : 's'}${latest ? `, latest ${T.dLong(latest)}` : ''}`;
  };
  const metricsCell = row => (row.metrics === 'catalogue' ? '<a href="/metrics/">Metrics</a>' : row.metrics.map(id => esc((metric(id) || { short: id }).short || id)).join(', '));
  const indexRows = scenarios.rows.map(row => `<tr><td><a href="${hrefOf(row, isLatest(row))}"><code>${esc(row.id)}</code></a></td><td class="n">${row.version}</td><td>${esc(row.status)}</td><td>${T.dLong(row.added)}</td><td>${metricsCell(row)}</td><td class="mut">${esc(recordsCell(row))}</td></tr>`).join('');
  const index = {
    path: 'scenarios/index.html', title: 'Scenarios · t3cp', desc: DESC, nav: '', page: 'scenarios',
    body: `<header class="page-h"><h1>Scenarios.</h1><p class="lede">A scenario is a fixed workload measured on the same machine type as the nightlies, with its own fixture, cells and metrics. A scenario is never edited: any change is a new version.</p></header>
<div class="tw"><table id="scenarios"><thead><tr><th>Scenario</th><th class="n">Version</th><th>Status</th><th>Added</th><th>Metrics</th><th>Records</th></tr></thead><tbody>${indexRows}</tbody></table></div>`,
  };

  // ---------- one row ----------
  // The Cells table: one column per field of scenarios.json's cell, in the schema's order, each shown only when a cell of
  // the row carries it (Fixture always: the cell's own, else the row's). An absent driver option is its default.
  const code = v => `<code>${esc(v)}</code>`;
  const COLS = [
    ['name', 'Cell', '', cl => code(cl.name)],
    ['fixture', 'Fixture', '', (cl, row) => code(cl.fixture ?? row.fixture), true],
    ['mode', 'Mode', '', cl => code(cl.mode)],
    ['sessions', 'Agents', 'n', cl => esc(cl.sessions)],
    ['subscribers', 'Watching live', 'n', cl => esc(cl.subscribers)],
    ['pollers', 'Status pollers', 'n', cl => esc(cl.pollers)],
    ['turn_gap', 'Turn gap', '', cl => esc(cl.turn_gap)],
    ['switch_interval', 'Switch interval', '', cl => esc(cl.switch_interval ?? 'default')],
    ['poll_rate', 'Poll rate, calls/s per poller', 'n', cl => esc(cl.poll_rate ?? 'default')],
    ['warmup_s', 'Warm-up', 'n', cl => `${esc(cl.warmup_s)} s`],
    ['window_s', 'Window', 'n', cl => `${esc(cl.window_s)} s`],
    ['seed_compacted_at', 'Seeded compaction mark', '', cl => code(String(cl.seed_compacted_at))],
    ['post', 'After the window', '', cl => code(cl.post)],
    ['mark_age_days', 'Mark age', 'n', cl => (cl.mark_age_days == null ? '–' : `${esc(cl.mark_age_days)} days`)],
  ];
  const cellsTable = row => {
    const cols = COLS.filter(([field, , , , always]) => always || row.cells.some(cl => cl[field] !== undefined));
    const th = cols.map(([, label, cls]) => `<th${cls ? ` class="${cls}"` : ''}>${label}</th>`).join('');
    const tr = row.cells.map(cl => `<tr>${cols.map(([, , cls, show]) => `<td${cls ? ` class="${cls}"` : ''}>${show(cl, row)}</td>`).join('')}</tr>`).join('');
    return `<h2>Cells.</h2><div class="tw"><table class="sc-cells"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
  };
  const facts = row => `<dl class="spec mt2"><dt>Suite</dt><dd><code>${esc(row.suite)}</code></dd><dt>Status</dt><dd>${esc(row.status)}</dd><dt>Added</dt><dd>${T.dLong(row.added)}</dd><dt>Harness</dt><dd><code>${esc(row.harness)}</code></dd><dt>Fixture</dt><dd><code>${esc(row.fixture)}</code></dd><dt>Attempts per cell</dt><dd>${esc(row.attempts)}</dd><dt>Platforms</dt><dd>${shown(row).map(p => esc(platName(p))).join(', ')}</dd></dl>`;

  // One value: the median with its unit and the valid attempts, or why there is none.
  const value = (v, m) => (v.median != null ? `${T.fmtU(v.median, m)} <span class="dim">(${v.n} valid)</span>` : v.reason && SCENARIO_REASON_WORDS[v.reason] ? `<span class="mut">${esc(SCENARIO_REASON_WORDS[v.reason])}</span>` : '<span class="mut">–</span>');
  const cellHeads = row => row.cells.map(cl => `<th><code>${esc(cl.name)}</code></th>`).join('');
  const records = (row, m) => {
    const r = indexRow(row);
    const parts = [];
    const plats = shown(row);
    for (const p of plats) {
      const rel = r && (r.series[p] || []).find(s => s.endsWith(`/${m.id}.json`));
      const s = rel ? c.read(rel) : null;
      if (!s) continue;
      const head = plats.length > 1 ? `<h3>${esc(platName(p))}</h3>` : '';
      const n = s.nightly.dates.length, from = Math.max(0, n - TABLE_ROWS);
      const nights = [];
      for (let j = n - 1; j >= from; j--) nights.push(`<tr><td>${T.dLong(s.nightly.dates[j])}</td><td class="tag">${esc(s.nightly.tags[j])}</td>${row.cells.map(cl => { const k = s.nightly.cells[cl.name]; return `<td>${value({ median: k.median[j], n: k.n[j], reason: k.reason[j] }, m)}</td>`; }).join('')}</tr>`);
      const table = (caption, heads, list, first) => (list.length ? `<p class="cap mt2">${caption}</p><div class="tw"><table><thead><tr>${heads}${cellHeads(row)}</tr></thead><tbody>${list.slice(-TABLE_ROWS).reverse().map(e => `<tr>${first(e)}${row.cells.map(cl => `<td>${value(e.cells[cl.name] || {}, m)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '');
      parts.push(head
        + (nights.length ? `<p class="cap mt2">Nightlies.</p><div class="tw"><table><thead><tr><th>Date</th><th>Tag</th>${cellHeads(row)}</tr></thead><tbody>${nights.join('')}</tbody></table></div>` : '')
        + table('Fork releases.', '<th>Release</th><th>Base</th>', s.fork, e => `<td class="tag">${esc(e.tag)}</td><td class="tag">${esc(e.base_tag || '–')}</td>`)
        + table('Upstream bases.', '<th>Base</th><th>Date</th>', s.base, e => `<td class="tag">${esc(e.tag)} <span class="sha dim">${esc(e.sha.slice(0, 12))}</span></td><td>${T.dLong(e.date)}</td>`));
    }
    return parts.length ? parts.join('') : `<p class="note">${EMPTY}</p>`;
  };
  const metricSection = (row, id) => {
    const m = metric(id);
    if (!m) return '';
    const target = (catFile.targets || []).filter(t => t.metric === id).map(t => `<p class="lede mt1"><b>Target:</b> ${esc(t.text)}</p>`).join('');
    const mapping = (catFile.mappings || []).filter(x => x.metric === id).map(x => `<p class="lede mt1"><b>Beside the ladder:</b> ${esc(x.text)}</p>`).join('');
    return `<section class="sec" id="${esc(id)}"><h2>${esc(m.name)}</h2><p class="lede mt1">${esc(m.definition)}</p>${target}${mapping}${records(row, m)}</section>`;
  };
  const rowPage = row => {
    const latest = isLatest(row);
    const ladder = row.metrics === 'catalogue';
    const body = `<header class="page-h"><p class="note"><a href="/scenarios/">Scenarios</a></p><h1>${esc(row.id)}, version ${row.version}.</h1>${facts(row)}</header>
<section class="sec">${cellsTable(row)}</section>
${ladder ? '<section class="sec"><p class="lede">This row is the load ladder that every nightly runs. Its metrics and results are on the <a href="/">Overview</a> and <a href="/metrics/">Metrics</a> pages.</p></section>' : row.metrics.map(id => metricSection(row, id)).join('\n')}`;
    return { path: pageOf(row, latest), title: `${row.id} · Scenarios · t3cp`, desc: DESC, nav: '', page: 'scenario', body };
  };
  return [index, ...scenarios.rows.map(rowPage)];
}

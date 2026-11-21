// The site build: the public data tree, then static HTML per page, one hashed stylesheet, one hashed script,
// _headers, _redirects and the favicon, then the budget check. Deterministic: the same inputs give the same bytes
// (no clock, sorted inputs), which the publish workflow asserts by building twice. No dependency.
//
//   node site/build/build.mjs --out dist --in data/v1 [--posts news/posts] [--mrs <mrs.json>]   (CI)
//   node site/build/build.mjs --out dist --dev site/.dev-data [--dev-releases <dir>]             (local, synthetic)
//
// --in runs site/build/aggregate.mjs into <out>/data/v1 and site/build/release-build.mjs into
// <out>/data/v1/releases; without data/v1 (before the first record) the site builds with empty states.
// --dev copies the synthetic tree from tools/t3cp/dev/synth-data.mjs: never deploy it (the publish gate refuses it).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import vm from 'node:vm';
import { loadApp } from './lib/app-vm.mjs';
import { formatSafeErrors, parseJsonStrict, schemaErrors } from '../../tools/t3cp/lib/safe-errors.mjs';
import { scanText, scanValue } from '../../tools/t3cp/lib/scan.mjs';
import { loadSchema, loadScenarios } from '../../tools/t3cp/lib/repo.mjs';
import { layout, analytics, THEME_HASH, esc } from './layout.mjs';
import * as P from './pages.mjs';
import { scenarioPages } from './scenarios-pages.mjs';
import { checkBudgets, report } from './budgets.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'site');
const readJson = f => JSON.parse(readFileSync(f, 'utf8'));
const tryJson = f => (existsSync(f) ? readJson(f) : null);
const sha = (b, n) => createHash('sha256').update(b).digest('hex').slice(0, n);

function run(script, args) {
  const r = spawnSync(process.execPath, [join(ROOT, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${script} exited ${r.status}`);
}

// The data tree under <out>/data/v1.
// Whether a data tree holds any record, fork or base file (any file at all under records/, fork/ or base/, so a
// malformed one still reaches the aggregator and fails the build).
function holdsRecords(dir) {
  return ['records', 'fork', 'base'].some(d => existsSync(join(dir, d)) && readdirSync(join(dir, d), { recursive: true }).some(f => statSync(join(dir, d, f)).isFile()));
}

// The two files a data tree can hold before its first record, as the aggregator treats them (aggregate.mjs,
// loadInputs): strict JSON, the scan of the raw text and of the value, the file's schema, for bands.json the
// per-platform rules; published re-serialised; synthetic data is refused. Throws on any failure.
const BEFORE_RECORDS = { 'status.json': 'status-1.json', 'bands.json': 'bands-1.json' };
export function publishInput(rel, text) {
  const fail = why => { throw new Error(`data: ${rel}: ${why}`); };
  if (!BEFORE_RECORDS[rel]) fail('not a file the data tree can hold before its first record');
  let value;
  try { value = parseJsonStrict(text); } catch (e) { fail(e.message); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('not a JSON object');
  if (value.synthetic === true) fail('synthetic development data is refused');
  const hits = [...scanText(text, { privatePatterns: [], env: false }), ...scanValue(value)];
  if (hits.length) fail(`forbidden pattern(s) ${[...new Set(hits.map(h => h.pattern))].join(', ')}`);
  const errors = schemaErrors(loadSchema(BEFORE_RECORDS[rel]), value);
  if (errors.length) fail(formatSafeErrors(errors, loadSchema(BEFORE_RECORDS[rel]), 5));
  if (rel === 'bands.json') {
    const headlines = readJson(join(ROOT, 'catalogue/catalogue.json')).headlines;
    for (const [platform, entry] of Object.entries(value.platforms)) {
      const measured = entry.measured !== undefined || entry.metrics !== undefined;
      if (entry.pending === true ? measured : !(entry.measured && entry.metrics)) fail(`${platform} must be either "pending": true or carry measured and metrics`);
      if (entry.pending === true) continue;
      if (!Object.keys(entry.metrics).length) fail(`${platform} is measured but has no metric bands`);
      const missing = (headlines[platform] || []).filter(id => entry.metrics[id] === undefined);
      if (missing.length) fail(`${platform} has no band for the headline metric(s) ${missing.join(', ')}`);
    }
  }
  return `${JSON.stringify(value)}\n`;
}

// A tree with no records: status.json and bands.json, each published after its checks; any other file fails the build.
function recordsLess(dir, dv) {
  const files = readdirSync(dir, { recursive: true }).filter(f => statSync(join(dir, f)).isFile()).map(f => f.split(sep).join('/'));
  const other = files.filter(f => !BEFORE_RECORDS[f]);
  if (other.length) throw new Error(`data: ${other.join(', ')} in a data tree with no records; before the first record only status.json and bands.json are published`);
  for (const rel of files.sort()) { mkdirSync(dv, { recursive: true }); writeFileSync(join(dv, rel), publishInput(rel, readFileSync(join(dir, rel), 'utf8'))); }
}

function data(o, out, log) {
  const dv = join(out, 'data', 'v1');
  if (o.dev) {
    const src = join(resolve(o.dev), 'v1');
    if (!existsSync(join(src, 'index.json'))) throw new Error(`--dev ${o.dev}: no v1/index.json (run node tools/t3cp/dev/synth-data.mjs)`);
    cpSync(src, dv, { recursive: true, filter: f => !f.endsWith('.t3cp-aggregate') });
    const input = join(resolve(o.dev), 'input', 'v1');
    if (o['dev-releases']) cpSync(resolve(o['dev-releases']), join(dv, 'releases'), { recursive: true });
    else if (existsSync(join(ROOT, 'site/build/release-build.mjs')) && existsSync(input)) run('site/build/release-build.mjs', ['--in', input, '--posts', resolve(o.posts), '--out', join(dv, 'releases'), '--dev']);
    log(`data: synthetic development tree from ${o.dev} (never deploy this build)`);
  } else if (o.in && existsSync(resolve(o.in)) && !holdsRecords(resolve(o.in))) {
    // Before the first record the tree holds the pipeline's status.json and nothing the aggregator reads.
    recordsLess(resolve(o.in), dv);
    log(`data: ${o.in} holds no records yet; building the site with empty states`);
  } else if (o.in && existsSync(resolve(o.in))) {
    run('site/build/aggregate.mjs', ['--in', resolve(o.in), '--out', dv]);
    if (existsSync(join(ROOT, 'site/build/release-build.mjs'))) run('site/build/release-build.mjs', ['--in', resolve(o.in), '--posts', resolve(o.posts), '--out', join(dv, 'releases')]);
    else log('releases: site/build/release-build.mjs is not in the tree yet, no release posts built');
  } else {
    log(`data: ${o.in || 'no --in'} does not exist yet; building the site with empty states`);
  }
  if (o.mrs && existsSync(resolve(o.mrs))) { mkdirSync(dv, { recursive: true }); cpSync(resolve(o.mrs), join(dv, 'mrs.json')); }
  return dv;
}

// The records list, from the file index.json names (records_index): off the overview's path, read once here. An index
// without it fails the build (no fallback); no index at all is the empty-state build before the first record.
export function loadRecords(read, ix) {
  if (!ix) return [];
  const doc = ix.records_index ? read(ix.records_index) : null;
  if (!doc || !Array.isArray(doc.records)) throw new Error(`data: ${ix.records_index || 'records-index.json'} is missing or holds no records list; index.json ${ix.records_index ? 'names it' : 'names no records file'}`);
  return doc.records;
}

// The nightly fork-head records on one platform, from records-index.json's fork_heads (none before the first).
export function loadForkHeads(read, ix, plat) {
  const doc = ix && ix.records_index ? read(ix.records_index) : null;
  return ((doc && doc.fork_heads) || []).filter(h => h.platforms && h.platforms[plat]);
}

// fixture/SHA256SUMS: the published sha256 of each fixture file, by file name.
export function sha256sums(root) {
  const f = join(root, 'fixture/SHA256SUMS');
  if (!existsSync(f)) return {};
  return Object.fromEntries(readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [h, n] = l.split(/\s+/); return [String(n).replace(/^\*/, ''), h]; }));
}

// A fixture file the repository holds and the site serves: its size and sha256. Fails closed: refused when
// fixture/SHA256SUMS does not list it or lists another sha256. An absent file is null (nothing is served).
export function fixtureFile(root, rel, sums) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return null;
  const buf = readFileSync(abs), sha256 = createHash('sha256').update(buf).digest('hex'), want = sums[basename(rel)];
  if (!want) throw new Error(`fixture: ${rel} is served but fixture/SHA256SUMS lists no ${basename(rel)}`);
  if (want !== sha256) throw new Error(`fixture: ${rel} has sha256 ${sha256}, but fixture/SHA256SUMS lists ${want}`);
  return { path: rel, bytes: buf.length, sha256 };
}

// fixture/fixtures.json, every file it names checked against fixture/SHA256SUMS (which must exist and list it), each
// fixture with its measured shape file; and the shape files the site serves. Fails closed on any gap.
export function loadFixtures(root) {
  const list = tryJson(join(root, 'fixture/fixtures.json'));
  if (list && !existsSync(join(root, 'fixture/SHA256SUMS'))) throw new Error('fixture: fixture/fixtures.json exists but fixture/SHA256SUMS does not');
  const sums = sha256sums(root);
  const fixtures = Array.isArray(list) ? list.map(f => {
    for (const part of [f.zst, f.sqlite]) {
      if (!part || !part.name) continue;
      const want = sums[part.name];
      if (!want) throw new Error(`fixture: fixture/fixtures.json names ${part.name}, which fixture/SHA256SUMS does not list`);
      if (part.sha256 !== want) throw new Error(`fixture: fixture/fixtures.json gives ${part.name} sha256 ${part.sha256}, but fixture/SHA256SUMS lists ${want}`);
    }
    return Object.assign({}, f, { measured: f.shape_measured ? fixtureFile(root, f.shape_measured, sums) : null });
  }) : list;
  const shapeFile = fixtureFile(root, 'fixture/public-large.shape.json', sums);
  const fixtureFiles = [shapeFile].concat((fixtures || []).map(f => f.measured)).filter((f, i, all) => f && all.findIndex(g => g && g.path === f.path) === i);
  return { fixtures, shapeFile, fixtureFiles };
}

function context(dv, cfg, log, js) {
  const T = loadApp({ source: js });
  const read = rel => tryJson(join(dv, rel));
  const size = rel => (existsSync(join(dv, rel)) ? statSync(join(dv, rel)).size : null);
  const ix = read('index.json'), records = loadRecords(read, ix);
  const catFile = readJson(join(ROOT, 'catalogue/catalogue.json'));
  const catalogue = ix ? ix.catalogue : catFile.metrics.map(m => Object.assign({}, m, { bands: {} }));
  const cat = {}; catalogue.forEach(m => { cat[m.id] = m; });
  const plat = 'linux-x64', heads = loadForkHeads(read, ix, plat);
  const darwin = records.some(r => r.platforms['darwin-arm64']);
  const mode = (cfg.macos || 'auto');
  if (!['auto', 'show', 'hide'].includes(mode)) throw new Error(`site/config.json: macos must be auto, show or hide, not ${mode}`);
  const mac = { show: mode === 'show' || (mode === 'auto' && darwin), live: darwin };
  // The window's nightlies still to be measured: from catalogue.window_start to the day before the first published
  // record (or onwards, with no record), when the first record comes later. Gone once the window's first is published.
  const first = records.length ? records.map(r => r.date).sort()[0] : null, ws = catFile.window_start;
  const pending = ws && (!first || first > ws) ? { from: ws, to: first ? new Date(Date.parse(`${first}T00:00:00Z`) - 864e5).toISOString().slice(0, 10) : null, first } : null;
  const shards = {};
  const shard = id => {
    if (id in shards) return shards[id];
    const list = ix && ix.series[plat] && ix.series[plat][id];
    return (shards[id] = list && list.length ? read(T.shardFile(plat, id, list)) : null);
  };
  const model = (id, L, r) => { const S = shard(id), m = cat[id]; return S && m ? T.model(S, m, T.effLevel(m, L), r, shard('agents_served')) : null; };
  // The metrics index filters on the latest value and verdict at every level without loading 100 shards.
  const latest = { [plat]: {} };
  catalogue.forEach(m => {
    const S = shard(m.id); if (!S) return;
    const row = {};
    Object.keys(S.levels).sort().forEach(L => {
      const lv = S.levels[L]; let j = lv.median.length - 1; while (j >= 0 && lv.median[j] == null) j--;
      if (j >= 0) row[L] = [Number(lv.median[j].toPrecision(4)), lv.verdict[j], lv.delta[j] == null ? null : Math.round(lv.delta[j] * 10) / 10, lv.note[j]];
    });
    latest[plat][m.id] = row;
  });
  const hash = rel => { const f = join(dv, rel); return existsSync(f) ? { path: rel, bytes: statSync(f).size, sha256: createHash('sha256').update(readFileSync(f)).digest('hex') } : null; };
  const WHAT = { 'downloads/records.ndjson.gz': 'every record, one JSON per line', 'downloads/series.csv.gz': 'every series, long format', 'bands.json': 'the noise bands' };
  const downloads = (ix ? ix.downloads.slice() : []).concat([hash('bands.json')].filter(Boolean)).map(d => Object.assign({ what: WHAT[d.path] || '' }, d));
  // The fixtures: their published files are checked against fixture/SHA256SUMS, and the shape files the repository
  // holds are served beside the site with their size and sha256.
  const { fixtures, shapeFile, fixtureFiles } = loadFixtures(ROOT);
  const releases = {};
  const release = tag => (tag in releases ? releases[tag] : (releases[tag] = read(`releases/${tag}.json`)));
  return {
    T, ix, records, heads, cat, catalogue, catFile, plat, platName: 'Linux x64', mac, first, pending, read, size, shard, model, latest, downloads, fixtures, shapeFile, fixtureFiles, release, log, cfg,
    harness: ix ? ix.eras.harness : [],
    groups: ix ? ix.groups : catFile.groups, headlines: (ix ? ix.headlines : catFile.headlines)[plat], forks: ix ? ix.fork : [],
    eras: ix ? ix.eras.fixture : catFile.fixture_eras, bands: read('bands.json'), mrs: read('mrs.json'),
  };
}

// The stylesheet with the delta bars' position classes (CSP forbids style attributes), and the script.
function assets(out) {
  let css = readFileSync(join(SITE, 'app.css'), 'utf8');
  const pos = []; for (let i = 0; i <= 100; i++) pos.push(`.bl-${i}{left:${i}%}.bw-${i}{width:${i}%}`);
  css += '/* delta bar positions, generated */\n' + pos.join('') + '\n';
  const js = shipJs(readFileSync(join(SITE, 'app.js'), 'utf8'));
  const a = { css: `app.${sha(css, 12)}.css`, js: `app.${sha(js, 12)}.js` };
  mkdirSync(join(out, 'assets'), { recursive: true });
  writeFileSync(join(out, 'assets', a.css), css);
  writeFileSync(join(out, 'assets', a.js), js);
  return a;
}

// The shipped script: app.js without its comment lines and indentation (no bundler, no minifier). Safe because no
// template literal in app.js spans lines; the compile check and the build's own rendering through these exact bytes
// catch a mistake.
export function shipJs(src) {
  const out = src.replace(/^\/\*[\s\S]*?\*\/\n/, '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//')).join('\n') + '\n';
  new vm.Script(out, { filename: 'app.js' });
  return out;
}

export function headers(cfg) {
  const a = (cfg && cfg.analytics) || {};
  // Plausible (only its pa- script is accepted) and Cloudflare Web Analytics (a beacon token, or the beacon Pages injects).
  const script = ["'self'", THEME_HASH, 'https://plausible.io', 'https://static.cloudflareinsights.com'], connect = ["'self'", 'https://plausible.io', 'https://cloudflareinsights.com'];
  const csp = `default-src 'none'; script-src ${script.join(' ')}; connect-src ${connect.join(' ')}; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  // Design Appendix C as written. Pages joins a header that two matching rules set with a comma, so each specific
  // rule detaches the /* value first ("! name"). Every data file revalidates; only the hashed assets are immutable.
  const cache = v => `  ! cache-control\n  cache-control: ${v}\n`;
  return `/*\n  x-content-type-options: nosniff\n  referrer-policy: strict-origin-when-cross-origin\n  permissions-policy: interest-cohort=()\n  content-security-policy: ${csp}\n  cache-control: public, max-age=0, s-maxage=600, stale-while-revalidate=86400\n` +
    `/data/v1/*\n${cache('public, max-age=300, s-maxage=1800, stale-while-revalidate=86400')}/assets/*\n${cache('public, max-age=31536000, immutable')}`;
}

// www.t3cp.io to the apex is a redirect rule on the zone: Pages' _redirects matches paths, not hosts.
export const REDIRECTS = `# t3cp.io redirects. www.t3cp.io -> t3cp.io is a zone redirect rule (Pages _redirects cannot match a host).
/news /releases/ 301
/release /releases/ 301
/news/* /releases/ 301
/metric/* /metrics/:splat 301
`;

// The fixture's shape as fixture/public-large.shape.json states it (row counts by table), never typed by hand.
const SHAPE = [['projection_projects', 'projects'], ['orchestration_v2_projection_threads', 'threads'], ['orchestration_v2_projection_runs', 'runs'],
  ['orchestration_v2_projection_turn_items', 'turn items'], ['orchestration_v2_projection_messages', 'messages'], ['orchestration_events', 'events']];
function shape(log) {
  const s = tryJson(join(ROOT, 'fixture/public-large.shape.json'));
  const rows = id => s && s.tables && s.tables[id] && Number.isFinite(s.tables[id].rows) ? s.tables[id].rows : null;
  const out = SHAPE.map(([id, what]) => (rows(id) == null ? null : { what, n: rows(id).toLocaleString('en-GB') })).filter(Boolean);
  if (!out.length) log('fixture: fixture/public-large.shape.json is missing or names no counted table; the shape counts are left out');
  return out;
}
const listed = xs => (xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1] : xs.join(''));

// What a fork release is compared with: the source-built upstream base once base records exist, else its nightly.
const forkBase = () => '<b>its upstream base</b>: the upstream code at the commit the fork release is based on, built from source the same way';

function aboutTokens(c) {
  // The counters that run: Plausible, and Cloudflare Web Analytics by token or injected by Pages at the edge.
  const a = (c.cfg.analytics) || {}, inj = a.cloudflare_pages_injected === true, cf = !!a.cloudflare_beacon_token || inj;
  const n = [a.plausible_script && 'Plausible', cf && 'Cloudflare Web Analytics'].filter(Boolean), host = inj ? ', which the host adds to every page' : '';
  const big = (c.fixtures || []).map(f => f.sqlite && f.sqlite.bytes).filter(Boolean).pop() || (c.ix && c.ix.fixtures.map(f => f.bytes).pop());
  const dl = c.downloads.map(d => `<li><span><a href="/data/v1/${esc(d.path)}"><code>${esc(d.path.replace(/^downloads\//, ''))}</code></a></span><span>${esc(d.what)}, ${(d.bytes / 1e6 >= 1 ? (d.bytes / 1e6).toFixed(1) + ' MB' : (d.bytes / 1e3).toFixed(0) + ' KB')}</span></li>`).join('');
  return {
    machines: c.mac.live
      ? '<b>Linux x64:</b> a cloud VM (n2d-standard-16, AMD EPYC 7B13, spot), a new one for every record, its CPU model pinned. <b>macOS arm64:</b> one Mac mini (Apple silicon) dedicated to the benchmark; nothing else runs on it. It cannot measure per-thread CPU, syscalls or faults (no /proc): those rows are shown, labelled "n/a on macOS", never hidden.'
      : c.mac.show
        ? '<b>Linux x64:</b> a cloud VM (n2d-standard-16, AMD EPYC 7B13, spot), a new one for every record, its CPU model pinned. macOS records are not yet published; they start on a dedicated Mac mini after launch.'
        : '<b>Linux x64:</b> a cloud VM (n2d-standard-16, AMD EPYC 7B13, spot), a new one for every record, its CPU model pinned.',
    database: big ? `A ${Math.round(big / 1e9)} GB synthetic database` : 'A synthetic database',
    downloads: dl || '<li><span>No data files yet.</span><span></span></li>',
    shape: (sh => (sh.length ? sh.filter(x => x.what === 'threads' || x.what === 'turn items').map(x => `${x.n} ${x.what}`).join(', ') + '. ' : ''))(shape(c.log)),
    analytics: n.length === 2 ? `Two page-view counters run: Plausible and Cloudflare Web Analytics${host}. Neither sets a cookie.` : n.length === 1 ? `One page-view counter runs: ${n[0]}${host}. It sets no cookie.` : 'No page-view counter runs.',
    attempts: c.mac.live ? '21 attempts per record and platform' : '21 attempts per record',
    // Linked once the repository is public (site/config.json link_repository, flipped at go-live); the URL stays in
    // this exact href form, which is the only form the private gate permits.
    repository: c.cfg.link_repository === true ? '<a href="https://github.com/CoreFinity/t3cp">the project\'s public repository on GitHub</a>' : "the project's public repository on GitHub",
    forkbase: forkBase(c),
  };
}

// The compaction schedule era: the records whose builds schedule compaction differently ("unscheduled").
function compactionDates(c) {
  const rs = c.records.filter(r => r.platforms[c.plat]).map(r => ({ date: r.date, s: (c.read(r.platforms[c.plat].path) || {}).compaction_schedule }));
  const early = rs.filter(r => r.s === 'unscheduled').map(r => r.date), later = rs.find(r => r.s === 'scheduled' && (!early.length || r.date > early[early.length - 1]));
  return { early, from: later ? later.date : null };
}
// The compaction schedule era: named by its dates only when one of its (unscheduled) nightlies is published;
// otherwise the rule alone, which claims no published nightly.
function compactionEra(c) {
  const { early } = compactionDates(c), rule = 'The charts mark the boundary, and no verdict, noise band or reference median crosses it; the bands are measured in the later era.';
  return early.length ? `<p>The nightlies from ${c.T.dLong(early[0])} to ${c.T.dLong(early[early.length - 1])} form their own era: their database compaction schedule differs from later builds'. ${rule}</p>`
    : `<p>Builds whose database compaction schedule differs from later builds' are kept in an era of their own. ${rule}</p>`;
}

// The per-level load, read from the latest record's workload.cells: agents (sessions), people watching live
// (subscribers) and status pollers. Never typed by hand.
function loadTable(c) {
  const r = c.records.slice().reverse().find(x => x.platforms[c.plat]);
  const rec = r && c.read(r.platforms[c.plat].path), cells = rec && rec.workload && rec.workload.cells;
  if (!cells || typeof cells !== 'object') { c.log('methodology: the record workload carries no per-level load numbers yet; the load table is left out'); return ''; }
  const keys = ['1', '50', '100', '150', '200', '250', '1e'].filter(k => cells[k]);
  const n = v => (v == null ? '–' : esc(v));
  return `<div class="tw mt1"><table><thead><tr><th>Cell</th><th class="n">Agents</th><th class="n">Watching live</th><th class="n">Status pollers</th><th class="hs">Database</th></tr></thead><tbody>${keys.map(k => { const x = cells[k]; return `<tr><td>${k === '1e' ? 'Fresh install' : k === '1' ? '1 agent' : k + ' agents'}</td><td class="n">${n(x.sessions)}</td><td class="n">${n(x.subscribers)}</td><td class="n">${n(x.pollers)}</td><td class="hs">${x.fixture === 'none' ? 'empty' : 'the era fixture'}</td></tr>`; }).join('')}</tbody></table></div><p class="note">From the latest record's workload, <span class="tag">${esc(rec.workload.profile)}</span>.</p>`;
}

function methodTokens(c) {
  // A platform whose bands are still pending ({pending: true}) has no measurement to describe yet.
  const T = c.T, ix = c.ix, pb = c.bands && c.bands.platforms && c.bands.platforms[c.plat], b = pb && pb.pending !== true && pb.measured ? pb : null;
  const withBand = c.catalogue.filter(m => m.bands && m.bands[c.plat]).length;
  const fx = (c.fixtures && c.fixtures.length ? c.fixtures : null);
  return {
    macos: c.mac.live ? 'macOS arm64: a dedicated Mac mini (Apple silicon). It cannot measure per-thread CPU, syscalls or faults (no /proc); those rows stay on every macOS page, labelled "n/a on macOS".' : 'macOS records are not yet published; they start on a dedicated Mac mini after launch.',
    fixtures: c.eras.map(e => `<li><b>${esc(e.id)}</b>: nightlies from ${T.dLong(e.from)}${e.to ? ' to ' + T.dLong(e.to) : ' onwards'}, built at migration head ${e.migration}${P.eraMeasured(c, e.from, e.to) ? '' : '; its nightlies are still to be measured'}.</li>`).join(''),
    recipe: esc(fx && fx[fx.length - 1].recipe ? fx[fx.length - 1].recipe : 'node tools/server-bench/fixture.ts synth --like fixture/public-large.shape.json --scale 1 --seed 20261017 --now 2026-10-17T00:00:00Z --workspace-root /t3-bench-synthetic <out>'),
    bands: b ? `On ${esc(c.platName)} the bands come from ${b.measured.attempts} identical attempts on ${b.measured.machines} machines of the record's type, measured ${T.dLong(b.measured.from)} to ${T.dLong(b.measured.to)} on <span class="tag">${esc(b.measured.tag)}</span>. ${withBand} of the ${c.catalogue.length} metrics have a band.` : pb && pb.pending === true ? `On ${esc(c.platName)} the noise bands are being measured; until they are published, records carry no verdict except the counters, which need no band.` : `${withBand} of the ${c.catalogue.length} metrics have a band so far.`,
    method: esc(c.bands ? c.bands.method : 'band = (max - min) / median, in percent, over repeated identical attempts.'),
    shape: (sh => (sh.length ? `Its shape, as <code>fixture/public-large.shape.json</code> states it: ${listed(sh.map(x => `${x.n} ${x.what}`))}.` : ''))(shape(() => {})),
    features: (ix ? ix.eras.feature : []).map(e => `<li>${esc(e.what[0].toUpperCase() + e.what.slice(1))}: recorded from ${T.dLong(e.from)}.</li>`).join('') || '<li>None yet.</li>',
    harness: (ix ? ix.eras.harness : []).map(h => `<li><span class="tag">${esc(h.version)}</span>: ${T.dLong(h.from)} to ${T.dLong(h.to)}, files sha256 <span class="sha">${esc(h.files_sha256)}</span>.</li>`).join('') || '<li>No record yet.</li>',
    loadtable: loadTable(c),
    compaction: compactionEra(c),
    maintfrom: (d => (d ? c.T.dLong(d) : 'the start of the scheduled compaction era'))(compactionDates(c).from),
    forkbase: forkBase(c).replace(/<\/?b>/g, ''),
    count: String(c.catalogue.length),
    forkonly: String(c.catalogue.filter(m => m.upstream === 'fork').length),
    nacount: String(c.catalogue.filter(m => m.na_on.includes('darwin-arm64')).length),
  };
}

export async function build(o) {
  const out = resolve(o.out), lines = [], log = s => { lines.push(s); console.log(s); };
  const cfg = readJson(resolve(o.config || join(SITE, 'config.json')));
  analytics(cfg); // the analytics config is checked before the output directory is touched
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  const dv = data(o, out, log);
  const a = assets(out);
  const c = context(dv, cfg, log, readFileSync(join(out, 'assets', a.js), 'utf8'));
  const { renderMrsPart } = await import('./mrs-render.mjs');
  const tpl = n => readFileSync(join(SITE, 'pages', n + '.html'), 'utf8');
  const frags = P.releaseFragments(c);
  const pages = [
    P.overview(c), P.metrics(c), ...c.catalogue.map((m, i) => P.metric(c, m, i)), P.compare(c), P.records(c), P.releases(c, frags.hash),
    P.mrsPage(c, renderMrsPart), P.downloads(c),
    P.prose(c, 'methodology', tpl('methodology'), methodTokens(c), { title: 'Methodology · t3cp', desc: 'How t3cp measures T3 Code: the suite, the machine, the fixtures, the validity rules, the noise bands and the regression rule.', nav: '' }),
    P.prose(c, 'about', tpl('about'), aboutTokens(c), { title: 'About · t3cp', desc: "About t3cp: an independent, community-run record of T3 Code's performance.", nav: 'About' }),
    P.notFound(c),
    // The scenario pages: the rows of scenarios.json (o.scenarios in tests), their values from the aggregator's series.
    ...scenarioPages(c, o.scenarios || loadScenarios()),
  ];
  for (const p of pages) {
    const file = join(out, p.path);
    mkdirSync(dirname(file), { recursive: true });
    // A build with no records marks every page, so the browser fetches no data (no 404, no error box).
    writeFileSync(file, layout(Object.assign({ mac: c.mac }, p, c.ix ? {} : { attrs: Object.assign({}, p.attrs, { empty: '1' }) }), a, cfg));
  }
  for (const f of frags.files) { const file = join(out, f.path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, f.html); }
  // The fragments are parts of the Releases page, not pages: keep them out of search results.
  writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /releases/*/*.html\n');
  // Plausible's init, our own static file, only when Plausible is on.
  if (cfg.analytics && cfg.analytics.plausible_script) cpSync(join(SITE, 'analytics-init.js'), join(out, 'analytics-init.js'));
  // The fixture's shape file, listed on Downloads.
  for (const f of c.fixtureFiles) { mkdirSync(dirname(join(out, f.path)), { recursive: true }); cpSync(join(ROOT, f.path), join(out, f.path)); }
  writeFileSync(join(out, '_headers'), headers(cfg));
  writeFileSync(join(out, '_redirects'), REDIRECTS);
  log(`pages: ${pages.length} (${c.catalogue.length} metric pages), assets ${a.css} ${a.js}`);
  const r = checkBudgets(out);
  if (o.verbose) console.log(report(r));
  if (!r.ok) { console.error(report(r)); throw new Error(`budget check failed: ${r.over.map(x => x.path).join(', ')}`); }
  return { out, pages: pages.length, assets: a, budgets: r, log: lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'dist' }, in: { type: 'string' }, dev: { type: 'string' }, 'dev-releases': { type: 'string' }, posts: { type: 'string', default: 'news/posts' }, mrs: { type: 'string' }, config: { type: 'string' }, verbose: { type: 'boolean' } } });
  if (values.in && values.dev) { console.error('build: --in and --dev are exclusive'); process.exit(2); }
  build(values).catch(e => { console.error(`build failed: ${e.message}`); process.exit(1); });
}

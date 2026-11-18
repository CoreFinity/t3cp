/* t3cp.io: the site's one script. Draws the charts and tables from the aggregator's files (verdicts come computed;
   only the compare page applies the noise-band rule to two records). ES2020, no dependency, no framework. */
(function (W, D) {
  'use strict';
  const T = (W.T3CP = {});
  const $ = (s, r) => (r || D).querySelector(s);
  const $$ = (s, r) => Array.from((r || D).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  T.$ = $; T.$$ = $$; T.esc = esc;
  const DATA = '/data/v1/';
  const PLAT = { linux: 'linux-x64', mac: 'darwin-arm64' }, PKEY = { 'linux-x64': 'linux', 'darwin-arm64': 'mac' };
  const LEVELS = ['1', '50', '100', '150', '200', '250'], LEAD = ['1', '50', '100', '250'], RANGES = [7, 14, 30];

  // ---------- dates, numbers, words ----------
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dp = s => String(s).split('-').map(Number);
  const dShort = s => { const p = dp(s); return p[2] + ' ' + MON[p[1] - 1]; };
  const dLong = s => dShort(s) + ' ' + dp(s)[0];
  T.dShort = dShort; T.dLong = dLong;
  const num = (v, d) => v.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmt = v => { if (v == null || !isFinite(v)) return '–'; const a = Math.abs(v); return num(v, Number.isInteger(v) || a >= 100 ? 0 : a >= 10 ? 1 : a >= 0.1 ? 2 : 3); };
  // Percentages print with no space before the sign, the posts' display strings included.
  const nosp = s => String(s).replace(/(\d) %/g, '$1%');
  const unitS = m => { const u = (m && m.unit) || ''; return u === 'n' || u === '0–1' ? '' : u.charAt(0) === '%' ? '%' : u; };
  const sfx = m => { const u = unitS(m); return !u ? '' : u === '%' ? '%' : ' ' + u; };
  const fmtU = (v, m) => fmt(v) + (v == null ? '' : sfx(m));
  const unitL = m => (m.unit === 'n' || m.unit === '0–1' ? '' : m.unit);
  const pct = d => { if (d == null || !isFinite(d)) return ''; const t = Math.abs(d).toFixed(1); return (t === '0.0' ? '' : d >= 0 ? '+' : '−') + t + '%'; };
  const VK = { regressed: 'bad', improved: 'good', within: 'ok' };
  const vk = v => VK[v] || 'none';
  const WORD = { bad: 'regressed beyond noise', good: 'improved beyond noise', ok: 'within noise' };
  const SHORT = { bad: 'regressed', good: 'improved', ok: 'within noise' };
  const NOTE = {
    context: 'shown for context, no verdict', no_band: 'no noise band yet, no verdict', wide_band: 'noise band too wide for a verdict',
    hollow: 'fewer than two valid attempts, no verdict', gated: 'failed a validity check, no verdict', no_reference: 'no reference yet',
    no_data: 'not recorded', not_comparable: 'not comparable, no verdict', no_base: 'no comparable base, no verdict', saturated: 'saturated, context only, no verdict', zero_reference: 'zero reference, no verdict',
  };
  // Why a value noted no_data is missing, where the series gives a public reason (levels.<L>.reason).
  const REASON = { extra_timeout: 'the measurement ran out of time', no_setup_span: 'this build has no setup timing', timeout: 'the record did not finish in time' };
  const say = (k, note) => WORD[k] || NOTE[note] || 'no verdict';
  // The arrow points the way the value moved; the colour says whether that is good.
  const glyph = (k, d) => (k === 'bad' || k === 'good' ? `<span class="g v-${k}" aria-hidden="true">${d == null ? '▲▼' : d < 0 ? '▼' : '▲'}</span>` : '');
  // The direction in brackets after a metric name, the word in bold, from the catalogue's `better`.
  const dir = m => (m.better === 'context' ? ' <span class="dir">(<b>context</b>, no verdict)</span>' : ` <span class="dir">(<b>${m.better === 'higher' ? 'higher' : 'lower'}</b> is better)</span>`);
  const lvLabel = L => (L === '1e' ? 'a fresh install, one agent' : L === 'once' ? 'once per record' : L === '1' ? '1 agent' : L + ' agents');
  const short = tag => String(tag).replace(/^v[\d.]+-/, '');
  T.headlineLevel = L => { if (L === '1e') return '1'; const n = +L; return !isFinite(n) ? '50' : LEAD.reduce((a, b) => (Math.abs(+b - n) < Math.abs(+a - n) ? b : a)); };
  // The distribution tolerance a record carries (per cell, in its workload); the distinct values, or null.
  T.tolerance = rec => { const cells = rec && rec.workload && rec.workload.cells; if (!cells) return null; const v = [...new Set(Object.values(cells).map(x => x && x.distribution_tolerance).filter(x => x != null))]; return v.length ? v.map(fmt).join(', ') : null; };
  T.nosp = nosp;
  // A compaction boundary's role: the first ends the early era; a run with an unknown schedule starts, then resumes.
  T.eraRoles = eras => { let prev = null; return eras.map(e => { if (e.kind !== 'compaction') return e; const role = /unknown/.test(e.label) ? 'unknown' : prev ? 'resume' : 'early'; prev = role; return Object.assign({ role }, e); }); };
  T.errBox = (box, msg) => { if (box) { box.hidden = !msg; box.textContent = msg || ''; } };
  // A release fragment by its versioned URL. A page left open across a deploy names fragments that are gone (404):
  // read the current version from /releases/ once and try once more, then say the page is out of date. Never a loop.
  T.loadFragment = (f, tag, L, hash) => {
    const one = h => f(`/releases/${encodeURIComponent(tag)}/${L}.${h}.html`).then(r => (r.ok ? r.text().then(html => ({ html, hash: h })) : Promise.reject(Object.assign(new Error(`release ${tag}: HTTP ${r.status}`), { status: r.status }))));
    const stale = () => Promise.reject(Object.assign(new Error('This page is out of date: reload it to see this release.'), { stale: true }));
    return one(hash).catch(e => (e.status !== 404 ? Promise.reject(e) : f('/releases/').then(r => (r.ok ? r.text() : '')).then(t => { const m = /data-frag="([0-9a-f]{12})"/.exec(t); return m && m[1] !== hash ? one(m[1]).catch(stale) : stale(); }, stale)));
  };
  // The three saturation kinds (counted only when the server's event loop was at least 95% busy); any other code is
  // a defect that invalidates the attempt, never a saturation symptom.
  const SAT = { sessions_starved: 'agents not served', call_timeouts: 'calls timed out', session_mcp_missing: 'MCP not ready by the start of the window' };
  T.satWords = codes => (codes || []).filter(c => SAT[c]).map(c => SAT[c]).join('; ');
  // "saturated: n of N agents served", with the symptoms in the flag's tooltip.
  T.satFlag = (who, n, N, by) => `<p class="note sat"${by && by.length ? ` title="${esc(T.satWords(by))}"` : ''}>${esc(who)}: saturated: ${n == null ? '?' : fmt(n)} of ${esc(N)} agents served. Latency at this level is context only, never a verdict.</p>`;
  T.cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  Object.assign(T, { fmt, fmtU, pct, glyph, dir, say, word: WORD, vk, lvLabel });

  // ---------- model: one metric, one level, the last `range` nightlies ----------
  T.effLevel = (m, L) => (m.scope === 'record' ? (L === '1e' && m.empty_cell ? '1e' : 'once') : L === '1e' && !m.empty_cell ? '1' : L);
  // The direction of a change: its percentage, or for a counter (whose percentage is null by design) a rise when it regressed.
  const rise = (m, d, verdict) => (d != null ? d : m.counter && verdict === 'regressed' ? 1 : null);
  T.model = function (S, m, L, range, served) {
    const lv = S && S.levels && S.levels[L];
    if (!lv) return null;
    const N = S.dates.length, a = range && range < N ? N - range : 0, pts = [];
    for (let i = a; i < N; i++) {
      const v = lv.median[i];
      pts.push(v == null ? null : {
        date: S.dates[i], tag: S.tags[i], v, lo: lv.min[i], hi: lv.max[i], n: lv.n[i], ref: lv.ref[i], d: lv.delta[i],
        verdict: vk(lv.verdict[i]), note: lv.note[i], thin: lv.thin[i], dd: lv.dod_delta[i], dv: vk(lv.dod_verdict[i]),
        dir: rise(m, lv.delta[i], lv.verdict[i]),
        sat: !!(lv.saturated && lv.saturated[i]), served: served && served.levels[L] ? served.levels[L].median[i] : null, by: lv.saturated_by ? lv.saturated_by[i] : null,
      });
    }
    const dates = S.dates.slice(a), F = S.fork, fl = F && F.levels && F.levels[L], rel = [];
    const stepTags = fl ? F.step_tags.slice(a) : dates.map(() => null), step = fl ? fl.step.slice(a) : dates.map(() => null);
    if (fl) F.tags.forEach((tag, k) => {
      rel.push({
        k, tag, short: short(tag), date: F.dates[k], base: F.base_tags[k], baseDate: F.base_dates[k], v: fl.value[k], bv: S.dates.indexOf(F.base_dates[k]) < 0 ? null : lv.median[S.dates.indexOf(F.base_dates[k])],
        vb: fl.vs_base[k], vbr: fl.vs_base_verdict[k], vbv: vk(fl.vs_base_verdict[k]), vbn: fl.vs_base_note[k], vp: fl.vs_prev[k], vpv: vk(fl.vs_prev_verdict[k]), vpn: fl.vs_prev_note[k], vpd: rise(m, fl.vs_prev[k], fl.vs_prev_verdict[k]), first: F.prev_tags[k] == null,
        j: stepTags.indexOf(tag),
      });
    });
    // Two releases on one date: the later holds the step; the earlier sits on the same date, offset to its left.
    rel.forEach(r => { if (r.j < 0 && r.date >= dates[0] && r.date <= dates[dates.length - 1]) r.j = dates.findIndex(d => d >= r.date); });
    rel.forEach(r => { r.dx = r.j < 0 ? 0 : -8 * rel.filter(q => q.j === r.j && q.k > r.k).length; });
    const last = dates[dates.length - 1];
    return {
      meta: m, L, n: dates.length, dates, tags: S.tags.slice(a), notes: lv.note.slice(a), reasons: lv.reason ? lv.reason.slice(a) : [], pts, step, stepTags, rel, platform: S.platform,
      t: m.better === 'context' ? null : lv.threshold, eras: T.eraRoles(S.eras || []).filter(e => e.date > dates[0] && e.date <= last),
    };
  };
  const lastPt = M => { for (let j = M.n - 1; j >= 0; j--) if (M.pts[j]) return M.pts[j]; return null; };
  const relAt = (M, j) => M.rel.find(r => r.tag === M.stepTags[j]) || null;
  const lastRel = M => { for (let k = M.rel.length - 1; k >= 0; k--) if (M.rel[k].v != null) return M.rel[k]; return null; };
  T.lastPt = lastPt;

  // ---------- generic plot ----------
  function ticks(lo, hi, n) {
    const raw = (hi - lo) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    const st = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p, out = [];
    for (let v = Math.ceil(lo / st) * st; v <= hi + st * 1e-9; v += st) out.push(Math.abs(v) < st * 1e-9 ? 0 : v);
    return out;
  }
  const tickFmt = (v, span) => num(v, span >= 20 ? 0 : span >= 2 ? 1 : span >= 0.2 ? 2 : 3);
  const r1 = v => Math.round(v * 10) / 10;
  // The width of an 11 px label, estimated on the generous side (no layout pass in the build).
  T.textW = s => String(s).length * 6.6 + 4;
  function domain(c) {
    let lo = Infinity, hi = -Infinity;
    const see = v => { if (v != null && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    c.series.forEach(s => s.vals.forEach(see));
    if (c.band) { c.band.lo.forEach(see); c.band.hi.forEach(see); }
    (c.whisk || []).forEach(w => { if (w) { see(w[0]); see(w[1]); } });
    if (lo === Infinity) return null;
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.14; hi += pad; lo = Math.max(lo - pad, lo >= 0 ? 0 : -Infinity);
    return [lo, hi];
  }
  function paths(c, x, y) {
    let h = '';
    if (c.band) {
      const B = c.band, idx = B.lo.map((v, i) => (v == null ? -1 : i)).filter(i => i >= 0);
      // A shift of the reference is one clean vertical edge half-way between two records, never a ramp.
      const mid = i => (B.lo[i] + B.hi[i]) / 2, jump = (a, b) => Math.abs(mid(b) - mid(a)) / Math.abs(mid(a) || 1) > B.jump;
      const edge = (arr, list) => list.map((i, n) => { const pv = list[n - 1], hx = r1((x(pv) + x(i)) / 2); return (n && jump(pv, i) ? `${hx} ${y(arr[pv])}L${hx} ${y(arr[i])}L` : '') + `${x(i)} ${y(arr[i])}`; }).join('L');
      // One piece per unbroken run of references: the band never bridges a missing one.
      const runs = []; idx.forEach(i => { const r = runs[runs.length - 1]; if (r && r[r.length - 1] === i - 1) r.push(i); else runs.push([i]); });
      runs.forEach(r => { if (r.length > 1) h += `<path class="bd" d="M${edge(B.hi, r)}L${edge(B.lo, r.slice().reverse())}Z"/>`; });
    }
    if (c.whisk) { let d = ''; c.whisk.forEach((w, i) => { if (w && w[1] > w[0]) d += `M${x(i)} ${y(w[1])}V${y(w[0])}`; }); if (d) h += `<path class="rg" d="${d}"/>`; }
    c.series.slice().reverse().forEach(s => {
      let d = '', pen = false;
      s.vals.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += pen ? (s.step ? `H${x(i)}V${y(v)}` : `L${x(i)} ${y(v)}`) : `M${x(i)} ${y(v)}`; pen = true;
      });
      if (d) h += `<path class="ln ${s.cls}" d="${d}"/>`;
    });
    return h;
  }
  function mark(kind, X, Y, r, up) {
    // A verdict mark is a triangle pointing the way the value moved, coloured by the verdict.
    if (kind === 'bad' || kind === 'good') return up ? `<path class="mk mk-${kind}" d="M${X} ${r1(Y - r - 2)}l${r + 1.5} ${r * 2 + 1}h${-(r * 2 + 3)}z"/>` : `<path class="mk mk-${kind}" d="M${X} ${r1(Y + r + 2)}l${r + 1.5} ${-(r * 2 + 1)}h${-(r * 2 + 3)}z"/>`;
    return kind === 'sat' ? `<rect class="mk mk-sat" x="${r1(X - r)}" y="${r1(Y - r)}" width="${2 * r}" height="${2 * r}"/>` : `<circle class="mk mk-${kind}" cx="${X}" cy="${Y}" r="${r}"/>`;
  }
  // Renders a chart spec to markup at width W. Returns the scales for the tests and the hover layer.
  function draw(c, W) {
    const H = c.h, n = c.n, narrow = W < 560, dom = domain(c);
    if (!dom) return { html: '<p class="empty">No records in this range.</p>', x: () => 0, y: () => 0, empty: true };
    const [lo, hi] = dom, tk = ticks(lo, hi, narrow || H < 260 ? 3 : 4);
    const L = Math.max(30, Math.max(...tk.map(v => tickFmt(v, hi - lo).length)) * 6.4 + 14), R = c.rpad || 16, Tp = 22, B = 28;
    const pw = W - L - R, ph = H - Tp - B;
    const x = i => r1(L + (n === 1 ? pw / 2 : i / (n - 1) * pw)), y = v => r1(Tp + (1 - (v - lo) / (hi - lo)) * ph);
    let h = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" tabindex="0" aria-label="${esc(c.label)}">`;
    tk.forEach(v => { const Y = Math.round(y(v)) + 0.5; h += `<line class="gr" x1="${L}" x2="${W - R}" y1="${Y}" y2="${Y}"/><text class="ax" x="${L - 10}" y="${Y + 3.5}" text-anchor="end">${tickFmt(v, hi - lo)}</text>`; });
    c.xt.forEach(i => { h += `<text class="ax" x="${x(i)}" y="${H - 6}" text-anchor="${c.rpad ? 'middle' : i === n - 1 ? 'end' : i === 0 ? 'start' : 'middle'}"${i === n - 1 && !c.rpad ? ` dx="${R - 2}"` : ''}>${esc(c.xl(i))}</text>`; });
    // Every marker's final place first: release markers are spread so none sits on another (each its own click
    // target). Labels then go only where they cover no marker and no other label, the latest release first.
    const ms = (c.marks || []).map(k => ({ k, X: x(k.i) + (k.dx || 0), Y: y(k.v) })), rs = ms.filter(o => o.k.href).sort((p, q) => p.X - q.X), GAP = 15;
    const near = (p, q) => Math.abs(p.Y - q.Y) < GAP && Math.abs(p.X - q.X) < GAP;
    rs.forEach((o, i) => { for (let j = 0; j < i; j++) if (near(rs[j], o)) o.X = r1(rs[j].X + GAP); });
    for (let i = rs.length - 1; i >= 0; i--) { const nx = rs[i + 1], max = nx && Math.abs(nx.Y - rs[i].Y) < GAP ? nx.X - GAP : W - R + 2; if (rs[i].X > max) rs[i].X = r1(max); }
    const placed = ms.map(o => ({ x0: o.X - 8, x1: o.X + 8, y0: o.Y - 8, y1: o.Y + 8 }));
    const fits = b => !placed.some(q => q.x0 < b.x1 + 3 && b.x0 < q.x1 + 3 && q.y0 < b.y1 && b.y0 < q.y1), put = b => { placed.push(b); return true; };
    // An era label sits inside its own era and never crosses a boundary line. The compaction boundary ends the early
    // era, so its label stands to the left ("early compaction"); every other boundary starts an era, labelled to the right.
    const eXs = (c.eras || []).filter(e => e.j > 0).map(e => r1((x(e.j - 1) + x(e.j)) / 2));
    (c.eras || []).forEach(e => {
      if (e.j <= 0) return;
      const X = r1((x(e.j - 1) + x(e.j)) / 2), early = e.role === 'early', text = early ? 'early compaction' : e.label, w = T.textW(text), Yb = Tp - 10;
      h += `<line class="era" x1="${X}" x2="${X}" y1="${Tp - 8}" y2="${H - B}"/>`;
      const lo = early ? Math.max(0, ...eXs.filter(v => v < X)) : X, hi = early ? X : Math.min(W, ...eXs.filter(v => v > X));
      if (hi - lo - 10 < w) return;
      const b = early ? { x0: X - 5 - w, x1: X - 5, y0: Yb - 10, y1: Yb + 2 } : { x0: X + 5, x1: X + 5 + w, y0: Yb - 10, y1: Yb + 2 };
      if (fits(b) && put(b)) h += `<text class="ax era-l" x="${early ? X - 5 : X + 5}" y="${Yb}" text-anchor="${early ? 'end' : 'start'}">${esc(text)}</text>`;
    });
    h += paths(c, x, y);
    const side = (c.marks || []).filter(k => k.side).map(k => ({ k, Y: y(k.v) + 4 })).sort((p, q) => p.Y - q.Y);
    if (side.length === 2 && side[1].Y - side[0].Y < 15) { const mid = (side[0].Y + side[1].Y) / 2; side[0].Y = mid - 7.5; side[1].Y = mid + 7.5; }
    side.forEach(o => { h += `<text class="lb" x="${x(o.k.i) + 10}" y="${r1(o.Y)}">${esc(o.k.side)}</text>`; });
    h += `<rect class="hit" x="${L - 8}" y="0" width="${pw + 16 + R - 8}" height="${H - B + 6}"/><g class="hv"></g>`;
    const lbox = (o, below) => { const w = T.textW(o.k.label), end = o.X > W - 60, Yb = r1(o.Y + (below ? 18 : -11)); return { X: o.X, Y: Yb, end, x0: end ? o.X + 6 - w : o.X - w / 2, x1: end ? o.X + 6 : o.X + w / 2, y0: Yb - 10, y1: Yb + 2 }; };
    const lab = [];
    ms.filter(o => o.k.label && o.k.force).concat(ms.filter(o => o.k.label && !o.k.force)).forEach(o => {
      const b = [lbox(o, !!o.k.below), lbox(o, !o.k.below)].find(fits);
      if (b && put(b)) lab.push(`<text class="lb" x="${b.X}" y="${b.Y}" text-anchor="${b.end ? 'end' : 'middle'}"${b.end ? ' dx="6"' : ''}>${esc(o.k.label)}</text>`);
    });
    ms.forEach(o => {
      const k = o.k, mk = mark(k.kind, r1(o.X), o.Y, c.r || 3.5, k.up);
      h += k.href ? `<a class="mk-a" href="${esc(k.href)}" aria-label="${esc(k.title)}"><title>${esc(k.title)}</title>${mk}</a>` : mk;
    });
    h += lab.join('');
    h += `</svg><div class="tip" hidden></div>`;
    return { html: h, x, y, L, pw, Tp, B, H, W, narrow };
  }
  function mount(el, c) {
    const g = draw(c, Math.max(280, el.clientWidth || 960));
    el.innerHTML = g.html; el.classList.remove('ld');
    if (g.empty) return;
    const svg = $('svg', el), hv = $('.hv', el), tip = $('.tip', el), n = c.n;
    let cur = -1;
    const show = i => {
      i = Math.max(0, Math.min(n - 1, i)); if (i === cur && !tip.hidden) return; cur = i;
      const X = g.x(i); let h = `<line class="xh" x1="${Math.round(X) + 0.5}" x2="${Math.round(X) + 0.5}" y1="${g.Tp - 8}" y2="${g.H - g.B}"/>`;
      c.series.forEach(s => { if (s.vals[i] != null) h += `<circle class="mk ${s.cls === 'ln-f' ? 'mk-rel' : ''}" cx="${X}" cy="${g.y(s.vals[i])}" r="4"/>`; });
      hv.innerHTML = h; tip.innerHTML = c.tip(i); tip.hidden = false;
      const tw = tip.offsetWidth || 180; let left = X + 14; if (left + tw > g.W) left = X - 14 - tw; if (left < 0) left = Math.max(0, Math.min(g.W - tw, X - tw / 2));
      tip.style.transform = `translate(${Math.round(left)}px,${g.narrow ? -8 : g.Tp - 6}px)`;
    };
    const hide = () => { hv.innerHTML = ''; tip.hidden = true; cur = -1; };
    svg.addEventListener('pointermove', e => { const b = svg.getBoundingClientRect(); show(Math.round(((e.clientX - b.left) * (g.W / b.width) - g.L) / g.pw * (n - 1))); });
    svg.addEventListener('pointerleave', () => { if (D.activeElement !== svg) hide(); });
    svg.addEventListener('focus', () => { if (cur < 0) show(n - 1); });
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', e => {
      const k = e.key, to = k === 'ArrowLeft' ? cur - 1 : k === 'ArrowRight' ? cur + 1 : k === 'Home' ? 0 : k === 'End' ? n - 1 : null;
      if (to != null) { e.preventDefault(); e.stopPropagation(); show(to); } else if (k === 'Escape') hide();
      else if (k === 'Enter' && c.open && cur >= 0 && c.open(cur)) W.location.href = c.open(cur);
    });
  }
  const xticks = (n, want) => { const st = Math.max(1, Math.ceil((n - 1) / want)), out = []; for (let i = n - 1; i >= 0; i -= st) out.unshift(i); return out; };

  // The noise band: each record's reference (the median of up to seven previous), plus and minus the threshold, only
  // where the aggregator publishes one (never backfilled, so never across an era boundary or an unbanded run).
  function bandOf(M) {
    if (M.t == null) return null;
    const ref = M.pts.map(p => (p && p.ref != null ? p.ref : null)), f = M.t / 100;
    return { lo: ref.map(r => (r == null ? null : r * (1 - f))), hi: ref.map(r => (r == null ? null : r * (1 + f))), jump: f / 2 };
  }
  const relHref = tag => '/releases/?rel=' + encodeURIComponent(tag);

  // ---------- time series ----------
  T.tsChart = function (M, o) {
    o = o || {};
    const m = M.meta, marks = [], pts = M.pts, last = pts.reduce((a, p, j) => (p ? j : a), -1), lr = lastRel(M);
    pts.forEach((p, j) => {
      if (!p) return;
      if (p.verdict === 'bad' || p.verdict === 'good') marks.push({ i: j, v: p.v, kind: p.verdict, up: p.dir > 0 });
      else if (p.sat) marks.push({ i: j, v: p.v, kind: 'sat' });
      else if (p.note === 'hollow') marks.push({ i: j, v: p.v, kind: 'h' });
      else if (j === last || (!pts[j - 1] && !pts[j + 1])) marks.push({ i: j, v: p.v, kind: 'last' });
    });
    M.rel.forEach(r => {
      const v = r.v != null ? r.v : M.step[r.j];
      if (r.j < 0 || v == null) return;
      const fl = r.vpv === 'bad' || r.vpv === 'good';
      marks.push({ i: r.j, dx: r.dx, v, kind: fl ? r.vpv : 'rel', up: fl ? r.vpd > 0 : undefined, label: r.short, force: r === lr, below: r.vb != null && r.vb < 0 === (m.better !== 'higher'), href: relHref(r.tag), title: 'Open release ' + r.tag });
    });
    const W0 = o.w || 960;
    return {
      h: o.h || 320, n: M.n, label: `${m.name}, ${o.plat || ''}, ${lvLabel(M.L)}, last ${M.n} nightlies. Use the arrow keys to read each record; Enter on a release date opens its post.`,
      xt: xticks(M.n, W0 < 560 ? 3 : 6), xl: j => dShort(M.dates[j]), band: bandOf(M),
      whisk: M.n <= 60 ? pts.map(p => (p && p.lo != null && p.hi != null ? [p.lo, p.hi] : null)) : null,
      series: [{ cls: 'ln-n', vals: pts.map(p => (p ? p.v : null)) }, { cls: 'ln-f', step: true, vals: M.step }],
      eras: M.eras.map(e => ({ j: M.dates.findIndex(d => d >= e.date), label: e.role === 'unknown' ? 'compaction schedule unknown' : e.role === 'resume' ? 'compaction schedule known' : e.label, kind: e.kind, role: e.role })),
      marks, tip: j => T.tipHTML(M, j), open: j => { const r = M.rel.find(x => x.j === j); return r ? relHref(r.tag) : null; },
    };
  };
  T.tsSVG = (M, W, H) => draw(T.tsChart(M, { h: H, w: W }), W);
  // The reference as the aggregator computes it: partial records are skipped.
  const refOf = p => (p.thin ? 'the previous complete nightly' : 'the median of up to 7 previous complete nightlies');
  // A gap's reason: a level run with no valid attempt, or a value missing for a public reason; else ''.
  const gap = (M, j) => (M.notes[j] === 'hollow' ? say('none', 'hollow') : M.notes[j] === 'no_data' && REASON.hasOwnProperty(M.reasons[j]) ? REASON[M.reasons[j]] : '');
  T.tipHTML = function (M, j) {
    const m = M.meta, p = M.pts[j], date = M.dates[j], u = esc(sfx(m));
    let h = `<div class="tip-d">${dLong(date)}<span class="tag">${esc(M.tags[j])}</span></div>`;
    const era = M.eras.find(e => e.date === date);
    if (era) h += `<div class="tip-s">${{ early: 'compaction schedule changes here', unknown: 'compaction schedule unknown from this record', resume: 'compaction schedule known again from this record' }[era.role] || 'New era from this record: ' + esc(era.label)}</div>`;
    if (!p) return h + `<div class="tip-s">${gap(M, j) || (m.era_start && date < m.era_start ? 'Not recorded before ' + dShort(m.era_start) : 'No record at this level')}</div>`;
    h += `<div class="tip-r"><i class="k"></i><b>${fmt(p.v)}</b>${u} Nightly</div>`;
    h += `<div class="tip-s">${p.d == null ? glyph(p.verdict, p.dir) + esc(say(p.verdict, p.note)) : `${glyph(p.verdict, p.dir)}${pct(p.d)} vs ${refOf(p)}, ${esc(say(p.verdict, p.note))}`}</div>`;
    if (p.dd != null) h += `<div class="tip-s">${pct(p.dd)} vs the previous complete nightly</div>`;
    if (p.sat) h += `<div class="tip-s">saturated: ${p.served == null ? '?' : fmt(p.served)} of ${esc(M.L)} agents served${p.by && p.by.length ? ` (${esc(T.satWords(p.by))})` : ''}</div>`;
    h += `<div class="tip-s">Range ${fmt(p.lo)} to ${fmt(p.hi)}, ${p.n} valid attempt${p.n === 1 ? '' : 's'}</div>`;
    const r = relAt(M, j);
    if (r && M.step[j] != null) {
      h += `<div class="tip-r"><i class="k k-f"></i><b>${fmt(M.step[j])}</b>${u} Fork ${esc(r.short)}</div>`;
      h += `<div class="tip-s">${r.first ? 'First release' : `${glyph(r.vpv, r.vpd)}${pct(r.vp)} vs the previous release, ${esc(say(r.vpv, r.vpn))}`}</div>`;
      h += `<div class="tip-s">${r.vb == null ? esc(say(r.vbv, r.vbn)) : `${glyph(r.vbv, r.vb)}${pct(r.vb)} vs its upstream base, ${esc(say(r.vbv, r.vbn))}`}</div>`;
    }
    return h;
  };
  T.recordsTable = function (M) {
    const m = M.meta, rows = [];
    for (let j = M.n - 1; j >= 0; j--) {
      const p = M.pts[j];
      if (!p) { const w = gap(M, j); if (w) rows.push(`<tr><td>${dLong(M.dates[j])}</td><td class="hs dim tag">${esc(M.tags[j])}</td><td class="n">–</td><td class="n hs mut">–</td><td class="n hs mut">${M.notes[j] === 'hollow' ? 0 : '–'}</td><td class="n"></td><td class="mut">${w}</td></tr>`); continue; }
      rows.push(`<tr><td>${dLong(p.date)}</td><td class="hs dim tag">${esc(p.tag)}</td><td class="n">${fmtU(p.v, m)}</td><td class="n hs mut">${fmt(p.lo)} to ${fmt(p.hi)}</td><td class="n hs mut">${p.n}</td><td class="n">${glyph(p.verdict, p.dir) + pct(p.d)}</td><td class="mut">${esc(say(p.verdict, p.note))}${p.thin ? ', thin reference' : ''}</td></tr>`);
    }
    return `<table><thead><tr><th>Date</th><th class="hs">Tag</th><th class="n">Median</th><th class="n hs">Min to max</th><th class="n hs">Valid</th><th class="n">vs up to 7 previous</th><th>Verdict</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="7" class="mut">No records at this level yet.</td></tr>'}</tbody></table>`;
  };

  // ---------- lead blocks: readout and small-multiple card ----------
  const NA = { na: ['n/a on macOS', 'macOS cannot measure this (no /proc). The row stays so the gap is visible, never drawn as zero.'], after: ['macOS records start after launch', 'The Mac mini runner joins after launch. Until then macOS rows stay empty, never drawn as zero.'], none: ['No records yet', 'This metric has no record on this platform yet.'] };
  T.naBlock = (why, cls) => `<div class="na ${cls || ''}"><div><b>${NA[why][0]}</b>${NA[why][1]}</div></div>`;
  T.readoutHTML = function (m, M, o) {
    o = o || {};
    const head = `<div class="ro-n">${esc(m.name)}${dir(m)}</div>`, p = M && lastPt(M);
    if (o.na || !p) { const w = NA[o.na || 'none']; return head + `<div class="ro-v ro-na">${o.na === 'na' ? 'n/a<small>on macOS</small>' : '–'}</div><div class="ro-s"><span>${esc(w[0])}.</span></div>`; }
    const r = lastRel(M);
    return head + `<div class="ro-v">${fmt(p.v)}<small>${esc(unitL(m))}</small></div><div class="ro-s"><span>${dShort(p.date)}</span>` +
      `<span>${p.d == null ? glyph(p.verdict, p.dir) + esc(say(p.verdict, p.note)) : `${glyph(p.verdict, p.dir)}<b>${pct(p.d)}</b> vs ${refOf(p)}, ${esc(say(p.verdict, p.note))}`}</span>` +
      (r ? `<span><i class="k k-f"></i>Fork ${esc(r.short)} <b>${fmtU(r.v, m)}</b>${r.vb == null ? '' : `, ${glyph(r.vbv, r.vb)}${pct(r.vb)} vs its upstream base`}</span>` : '') +
      (M.L === 'once' ? '<span>Once per record, at start-up: the agents control does not apply.</span>' : '') + '</div>';
  };
  T.cardHTML = function (m, M, href, o) {
    o = o || {};
    const name = `<a class="card-a" href="${esc(href)}"><span class="card-n">${esc(m.name)}${dir(m)}</span></a>`, p = M && lastPt(M);
    if (o.na || !p) return `<div class="card card-na" data-id="${esc(m.id)}">${name}<span class="card-v">${o.na === 'na' ? 'n/a<small>on macOS</small>' : '–'}</span><span class="card-d">${esc(NA[o.na || 'none'][0])}</span><span class="spark spark-na"></span></div>`;
    return `<div class="card" data-id="${esc(m.id)}">${name}<span class="card-v">${fmt(p.v)}<small>${esc(unitS(m))}</small></span><span class="card-d">${p.d == null ? glyph(p.verdict, p.dir) + esc(say(p.verdict, p.note)) : `${glyph(p.verdict, p.dir)}${pct(p.d)}, ${esc(SHORT[p.verdict] || say(p.verdict, p.note))}`}</span><span class="spark"></span></div>`;
  };
  function spark(card, M) {
    const el = $('.spark', card), W = Math.max(120, el.clientWidth || 260), H = 56, n = M.n, b = bandOf(M);
    const c = { band: b, series: [{ cls: 'ln-n', vals: M.pts.map(p => (p ? p.v : null)) }, { cls: 'ln-f', step: true, vals: M.step }] }, dom = domain(c);
    if (!dom) { el.classList.add('spark-na'); return; }
    const x = i => r1(4 + (n === 1 ? 0.5 : i / (n - 1)) * (W - 8)), y = v => r1(5 + (1 - (v - dom[0]) / (dom[1] - dom[0])) * (H - 10));
    let h = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">` + paths(c, x, y);
    M.pts.forEach((p, j) => { if (p && (p.verdict === 'bad' || p.verdict === 'good')) h += mark(p.verdict, x(j), y(p.v), 2.2, p.dir > 0); else if (p && (j === n - 1 || (!M.pts[j - 1] && !M.pts[j + 1]))) h += mark('last', x(j), y(p.v), 2.6); });
    M.rel.forEach(r => { const v = r.v != null ? r.v : M.step[r.j]; if (r.j >= 0 && v != null) h += `<a href="${relHref(r.tag)}" tabindex="-1"><title>Open release ${esc(r.tag)}</title>${mark(r.vpv === 'bad' || r.vpv === 'good' ? r.vpv : 'rel', r1(x(r.j) + r.dx * 0.6), y(v), 2.4, r.vp > 0)}</a>`; });
    el.innerHTML = h + '<g class="hv"></g></svg>';
    const svg = $('svg', el), hv = $('.hv', el), vEl = $('.card-v', card), dEl = $('.card-d', card), v0 = vEl.innerHTML, d0 = dEl.innerHTML, m = M.meta;
    card.onpointermove = e => {
      const bx = svg.getBoundingClientRect(); if (e.clientY < bx.top) return;
      const j = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - bx.left) * (W / bx.width) - 4) / (W - 8) * (n - 1)))), p = M.pts[j];
      if (!p) return;
      hv.innerHTML = `<line class="xh" x1="${x(j)}" x2="${x(j)}" y1="0" y2="${H}"/><circle class="mk" cx="${x(j)}" cy="${y(p.v)}" r="3"/>`;
      vEl.innerHTML = `${fmt(p.v)}<small>${esc(unitS(m))}</small>`; dEl.innerHTML = `${dShort(p.date)}${p.d == null ? '' : `, ${glyph(p.verdict, p.dir)}${pct(p.d)}`}`;
    };
    card.onpointerleave = () => { hv.innerHTML = ''; vEl.innerHTML = v0; dEl.innerHTML = d0; };
  }

  // ---------- ladder: value by agents for one nightly and one fork release ----------
  // A ladder: two builds' values at each agent level (ink, then accent), labelled at their right ends.
  function ladderSpec(m, A, B, an, bn, o) {
    const lastI = a => a.reduce((z, v, i) => (v != null ? i : z), -1), la = lastI(A), lb = lastI(B), u = esc(sfx(m));
    return {
      h: o.h || 300, n: LEVELS.length, label: `${m.name} at each load level, ${bn} against ${an}, ${o.plat || ''}`, xt: LEVELS.map((_, i) => i), xl: i => LEVELS[i], rpad: 110,
      series: [{ cls: 'ln-n', vals: A }, { cls: 'ln-f', vals: B }],
      marks: A.map((v, i) => (v == null ? null : { i, v, kind: 'last', side: i === la ? an : '' })).concat(B.map((v, i) => (v == null ? null : { i, v, kind: 'rel', side: i === lb ? bn : '' }))).filter(Boolean),
      tip: i => `<div class="tip-d">${lvLabel(LEVELS[i])}</div><div class="tip-r"><i class="k"></i><b>${fmt(A[i])}</b>${u} ${esc(an)}</div>` + (B[i] == null ? '' : `<div class="tip-r"><i class="k k-f"></i><b>${fmt(B[i])}</b>${u} ${esc(bn)}</div>` + (A[i] ? `<div class="tip-s">${pct((B[i] - A[i]) / A[i] * 100)} against ${esc(an)}</div>` : '')),
      table: () => `<table><thead><tr><th>Agents</th><th class="n">${esc(an)}</th><th class="n">${esc(bn)}</th></tr></thead><tbody>${LEVELS.map((L, i) => `<tr><td>${L}</td><td class="n">${fmtU(A[i], m)}</td><td class="n">${fmtU(B[i], m)}</td></tr>`).join('')}</tbody></table>`,
    };
  }
  // The latest (or picked) nightly against a fork release, from the series shard.
  T.ladderChart = (m, S, j, k, o) => ladderSpec(m, LEVELS.map(L => (S.levels[L] ? S.levels[L].median[j] : null)), LEVELS.map(L => (S.fork && k >= 0 && S.fork.levels[L] ? S.fork.levels[L].value[k] : null)), 'Nightly ' + dShort(S.dates[j]), S.fork && k >= 0 ? 'Fork ' + short(S.fork.tags[k]) : 'Fork', o || {});
  // fork-vs-base: the comparison file's base record (a) and fork (b) at each level.
  T.baseLadderChart = (m, cf, f, o) => {
    const at = (L, key) => { const r = cf && cf.rows.find(x => x.metric === m.id && x.level === L); return r ? r[key] : null; };
    return ladderSpec(m, LEVELS.map(L => at(L, 'a')), LEVELS.map(L => at(L, 'b')), f.base_sha ? 'Upstream base ' + f.base_sha.slice(0, 7) : 'Base ' + (f.base_date ? dShort(f.base_date) : ''), 'Fork ' + short(f.tag), o || {});
  };

  // fork-vs-prev: the fork's releases in turn at one level, each judged against the one before it.
  T.forkChart = function (m, S, L, cur, o) {
    const F = S.fork, fl = F && F.levels[L];
    if (!fl) return null;
    const ks = F.tags.map((_, k) => k).filter(k => fl.value[k] != null), vals = ks.map(k => fl.value[k]);
    return {
      h: o.h || 300, n: ks.length, label: `${m.name}, fork releases in turn, ${o.plat || ''}, ${lvLabel(L)}`, xt: ks.map((_, i) => i), xl: i => short(F.tags[ks[i]]), rpad: 24,
      series: [{ cls: 'ln-f', step: true, vals }],
      marks: ks.map((k, i) => { const v = vk(fl.vs_prev_verdict[k]), fl2 = v === 'bad' || v === 'good'; return { i, v: fl.value[k], kind: fl2 ? v : 'rel', up: rise(m, fl.vs_prev[k], fl.vs_prev_verdict[k]) > 0, label: F.tags[k] === cur ? short(F.tags[k]) : '', force: true, href: relHref(F.tags[k]), title: 'Open release ' + F.tags[k] }; }),
      tip: i => { const k = ks[i], v = vk(fl.vs_prev_verdict[k]); return `<div class="tip-d">${esc(F.tags[k])}<span class="tag">${dLong(F.dates[k])}</span></div><div class="tip-r"><i class="k k-f"></i><b>${fmt(fl.value[k])}</b>${esc(sfx(m))} Fork ${esc(short(F.tags[k]))}</div><div class="tip-s">${F.prev_tags[k] == null ? 'First release' : `${glyph(v, rise(m, fl.vs_prev[k], fl.vs_prev_verdict[k]))}${pct(fl.vs_prev[k])} vs the previous release, ${esc(say(v, fl.vs_prev_note[k]))}`}</div>`; },
      open: i => relHref(F.tags[ks[i]]),
    };
  };

  // ---------- deltas: the table with the noise zone, figures, compare ----------
  const bp = v => Math.max(0, Math.min(100, Math.round(v)));
  T.deltasHTML = function (rows, aName, bName, o) {
    o = o || {};
    const ord = { bad: 0, good: 1, ok: 2, none: 3, na: 4 };
    rows = rows.slice().sort((r, s) => ord[r.k] - ord[s.k] || Math.abs(s.adj || 0) - Math.abs(r.adj || 0));
    const max = Math.max(40, ...rows.map(r => Math.min(100, Math.abs(r.adj || 0)))), w = v => Math.min(50, Math.abs(v) / max * 50);
    return `<div class="tw"><table class="dt"><thead><tr><th>Metric</th><th class="n hs">${esc(aName)}</th><th class="n">${esc(bName)}</th><th class="bar-c"><span class="bar-h"><span>worse</span><span>better</span></span></th><th class="n">Change</th><th class="hs">Verdict</th></tr></thead><tbody>` +
      rows.map(r => {
        const name = `<a href="/metrics/${esc(r.m.id)}/">${esc(r.m.name)}</a>${dir(r.m)}`;
        if (r.k === 'na') return `<tr class="row-na"><td>${name}</td><td colspan="4" class="mut">${esc(r.na)}</td><td class="hs mut">no verdict</td></tr>`;
        const t = r.t == null ? 0 : w(r.t), bw = w(r.adj || 0), left = (r.adj || 0) > 0 ? 50 - bw : 50;
        const tx = r.txt || {}, av = tx.base != null ? esc(nosp(tx.base)) : fmtU(r.av, r.m), bv = tx.fork != null ? esc(nosp(tx.fork)) : fmtU(r.bv, r.m), dv = tx.delta_pct != null ? esc(nosp(tx.delta_pct)) : pct(r.d);
        return `<tr><td>${name}</td><td class="n hs mut" data-l="${esc(aName)}">${av}</td><td class="n" data-l="${esc(bName)}">${bv}</td>` +
          `<td class="bar-c"><div class="bar">${t ? `<i class="z bl-${bp(50 - t)} bw-${bp(t * 2)}"></i>` : ''}<i class="b v-${r.k} bl-${bp(left)} bw-${Math.max(1, bp(bw))}"></i></div></td>` +
          `<td class="n">${glyph(r.k, r.dir)}${dv}<span class="vw">${esc(SHORT[r.k] || 'no verdict')}</span></td><td class="hs mut">${esc(say(r.k, r.note))}</td></tr>`;
      }).join('') + '</tbody></table></div>';
  };
  T.tally = rows => ({ good: rows.filter(r => r.k === 'good').length, bad: rows.filter(r => r.k === 'bad').length, ok: rows.filter(r => r.k === 'ok').length });
  T.figs = c => `<div class="fig"><b>${c.good}</b><span>${glyph('good', null)}improved beyond noise</span></div><div class="fig"><b>${c.bad}</b><span>${glyph('bad', null)}regressed beyond noise</span></div><div class="fig"><b>${c.ok}</b><span>within noise</span></div>`;
  // A delta row from the aggregator's numbers (delta in percent, real sign; verdict already decided).
  T.drow = (m, av, bv, d, verdict, note, t) => ({ m, av, bv, d, dir: d != null ? d : m.counter && verdict === 'regressed' ? 1 : null, k: vk(verdict), note, t: t == null ? null : t, adj: d == null ? 0 : m.better === 'higher' ? -d : d });

  // A record's stat for metric m at level L, by the aggregator's statAt rules: a fork-only metric only on a fork
  // record, nothing before the metric's era, the merge-sourced counts from the cell itself, once-per-record metrics
  // from the record's extras (the fixture at "once", the empty database at "1e").
  const inEra = (rec, m) => !(m.era_start == null && m.upstream === 'fork' && rec.kind !== 'fork') && !(m.era_start != null && (rec.kind === 'fork' && rec.base ? rec.base.date : rec.release.date) < m.era_start);
  // The record ran level L with no valid attempt (aggregate.mjs ranNoValid): hollow, never no_data.
  const ranNoValid = (rec, m, L) => m.scope === 'level' && inEra(rec, m) && !!(rec.cells && rec.cells[L]) && rec.cells[L].valid === 0;
  const cellStat = (rec, m, L) => {
    if (!inEra(rec, m)) return null;
    if (m.scope === 'record') { const part = rec.extras && rec.extras[L === '1e' ? 'empty' : 'fixture']; return part && part.metrics ? part.metrics[m.id] || null : null; }
    const c = rec.cells && rec.cells[L];
    if (!c) return null;
    if (m.source && m.source.file === 'merge') { const v = m.id === 'attempts_valid' ? c.valid : m.id === 'attempts_total' ? c.total : c.attempts.filter(x => x.contaminated).length; return { median: v, n: c.total }; }
    return c.metrics ? c.metrics[m.id] || null : null;
  };
  // Two records, b against a, by the aggregator's own rules (aggregate.mjs compareOne), in its order, from what it
  // publishes: comparability (segment), the gates and banded per record and level (records-index.json), and each
  // metric's capability per platform and level (index.json cap: threshold and note). Only the arithmetic is here.
  // Across platforms only a ratio.
  T.compare = function (a, b, ctx) {
    const pa = a.platform.id, pb = b.platform.id, sg = ctx.seg || {}, A = sg.a || {}, B = sg.b || {}, rows = [], Lv = ctx.level;
    const same = L => !!(A.segment && B.segment && A.segment[L] != null && A.segment[L] === B.segment[L]);
    const gate = (P, m, L) => { const g = (P.gates || {})[m.scope === 'record' ? 'once' : L]; return g === 'pass' || (g === 'client' && !!m.gate_exempt); };
    const satAt = (rec, L) => L !== 'once' && !!(rec.cells && rec.cells[L] && rec.cells[L].saturated);
    // A saturated level (either side): the flag names it; only throughput keeps a verdict there.
    const satOf = rec => { const c = rec.cells && rec.cells[Lv]; if (!c || !c.saturated) return null; const s = c.metrics && c.metrics.agents_served; return { n: s ? s.median : null, N: c.agents_total || +Lv, by: [...new Set((c.attempts || []).flatMap(x => x.saturated_by || []))] }; };
    const sat = { a: satOf(a), b: satOf(b) };
    ctx.catalogue.forEach(m => {
      if ((m.lane !== 'daily' && m.lane !== 'record') || m.na_on.includes(pa)) return;
      const L = T.effLevel(m, Lv), sa = cellStat(a, m, L), sb = cellStat(b, m, L), av = sa ? sa.median : null, bv = sb ? sb.median : null;
      if (av == null && bv == null) return;
      const row = { id: m.id, meta: m, av, bv, delta: null, ratio: null, verdict: null, note: null }, mn = m.scope === 'record' ? 1 : 2;
      if (av != null && bv != null) { row.delta = av ? (bv - av) / Math.abs(av) * 100 : bv ? null : 0; row.ratio = av ? bv / av : null; }
      const cap = (m.cap && m.cap[pa] && m.cap[pa][L]) || { threshold: null, note: m.counter ? null : 'no_band' };
      const t = m.counter || (A.banded && B.banded) ? cap.threshold : null, note = m.counter || (A.banded && B.banded) ? cap.note : cap.note || 'no_band';
      if (pa !== pb) row.note = 'not_comparable';
      else if (bv == null) row.note = ranNoValid(b, m, L) ? 'hollow' : 'no_data';
      else if (av == null) row.note = ranNoValid(a, m, L) ? 'hollow' : 'no_reference';
      else if (sa.n < mn || sb.n < mn) row.note = 'hollow';
      else if (!gate(A, m, L) || !gate(B, m, L)) row.note = 'gated';
      else if (!m.throughput && (satAt(a, L) || satAt(b, L))) row.note = 'saturated';
      else if (!same(L)) row.note = 'not_comparable';
      else if (m.counter) row.verdict = (m.counter === 'absolute' ? bv > 0 : bv > av) ? 'regressed' : 'within';
      else if (note) row.note = note;
      else if (av === 0) { if (bv === 0) row.verdict = 'within'; else row.note = 'zero_reference'; }
      else { const w = (m.better === 'higher' ? -1 : 1) * (bv - av) / Math.abs(av) * 100; row.verdict = w > t ? 'regressed' : w < -t ? 'improved' : 'within'; row.t = t; }
      rows.push(row);
    });
    const refused = pa !== pb ? 'platform' : rows.some(r => r.note !== 'not_comparable' && r.note !== 'no_data') ? null : 'era';
    return { mode: refused ? 'ratio' : 'verdict', refused, rows, fixtures: [a.fixture.id, b.fixture.id], platforms: [pa, pb], sat };
  };
  T.compareHTML = function (r, aName, bName) {
    const flags = r.sat ? [[aName, r.sat.a], [bName, r.sat.b]].filter(x => x[1]).map(([w, s]) => T.satFlag(w, s.n, s.N, s.by)).join('') : '';
    if (r.mode === 'verdict') return flags + T.deltasHTML(r.rows.map(x => T.drow(x.meta, x.av, x.bv, x.delta, x.verdict, x.note, x.t)), aName, bName);
    const why = r.refused === 'platform' ? `${esc(aName)} and ${esc(bName)} run on different machines, so each row shows the ratio and no verdict.`
      : `The two records belong to different eras of the benchmark${r.fixtures[0] !== r.fixtures[1] ? ` (fixtures ${esc(r.fixtures[0])} and ${esc(r.fixtures[1])})` : ''}: fixture, harness, compaction schedule or load differ, so the values are shown with no verdict.`;
    return `<p class="note cmp-why">${why}</p><div class="tw"><table class="dt"><thead><tr><th>Metric</th><th class="n">${esc(aName)}</th><th class="n">${esc(bName)}</th><th class="n">${r.refused === 'platform' ? 'Ratio' : 'Change'}</th></tr></thead><tbody>` +
      r.rows.map(x => `<tr><td><a href="/metrics/${esc(x.id)}/">${esc(x.meta.name)}</a></td><td class="n" data-l="${esc(aName)}">${fmtU(x.av, x.meta)}</td><td class="n" data-l="${esc(bName)}">${fmtU(x.bv, x.meta)}</td><td class="n">${x.ratio == null ? '–' : r.refused === 'platform' ? '×' + num(x.ratio, 2) : pct(x.delta)}</td></tr>`).join('') + '</tbody></table></div>';
  };

  // ---------- releases ----------
  const CHART = /^(series|fork-vs-base|fork-vs-prev)\.([a-z0-9_]+)\.(?:(ladder)\.)?(linux-x64|darwin-arm64)$/;
  T.parseChart = id => { const m = CHART.exec(String(id)); return m ? { kind: m[1], metric: m[2], ladder: !!m[3], platform: m[4] } : null; };
  // The shard a chart reads: the last 90 days when it exists, else the whole series, else the newest year.
  T.shardFile = (p, id, list) => `series/${p}/${id}.${list.includes('latest') ? 'latest' : list.includes('all') ? 'all' : list.slice().sort().pop()}.json`;

  // ---------- metric ids ----------
  T.resolveMetric = (ids, id) => (Array.prototype.indexOf.call(ids, id) >= 0 ? { ok: true, id, href: `/metrics/${id}/` } : { ok: false, href: '/metrics/?m=' + encodeURIComponent(String(id)) });
  T.metricNotice = id => `<p class="note notice" role="status">“${esc(id)}” is not in the catalogue. Here is every metric it holds.</p>`;
  T.metricFromPath = path => { const m = /^\/metrics\/([^/]+)\/?$/.exec(String(path)); return m ? decodeURIComponent(m[1]) : null; };

  // ---------- overview: the verdict strip and the headline table ----------
  T.stripHTML = function (items, o) {
    const moved = items.filter(x => x.p && (x.p.verdict === 'bad' || x.p.verdict === 'good')), bad = moved.filter(x => x.p.verdict === 'bad').length;
    const since = o.prev ? ' since ' + dShort(o.prev) : '';
    return `<p>${moved.length ? `<b>${moved.length} of ${items.length}</b> headline metrics moved beyond noise${since}: ${bad} regressed, ${moved.length - bad} improved.` : `None of the ${items.length} headline metrics moved beyond noise${since}.`} <span class="dim">${esc(o.plat)}, ${lvLabel(o.level)}.</span></p>` +
      (moved.length ? `<p class="strip-l">${moved.map(x => `<span>${glyph(x.p.verdict, x.p.dir)}${esc(T.cap(x.m.short || x.m.name))} ${pct(x.p.d)}, ${SHORT[x.p.verdict]} <span class="dim">(threshold ${num(x.t, 1)}%)</span></span>`).join('')}</p>` : '');
  };
  T.headTable = function (models) {
    const ref = models.find(M => M) || null;
    if (!ref) return '<p class="note">No records yet.</p>';
    let rows = '';
    for (let j = ref.n - 1; j >= 0; j--) rows += `<tr><td>${dLong(ref.dates[j])}</td>${models.map(M => { const p = M && M.pts[j]; return `<td class="n">${p ? glyph(p.verdict, p.dir) + fmtU(p.v, M.meta) + (SHORT[p.verdict] && p.verdict !== 'ok' ? ` <span class="dim">${SHORT[p.verdict]}</span>` : '') : '–'}</td>`; }).join('')}</tr>`;
    return `<table><thead><tr><th>Nightly</th>${models.map(M => `<th class="n">${M ? esc(T.cap(M.meta.short || M.meta.name)) : ''}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  };

  // The overview's verdict strip and fork strip from the eight headline models; shared by the build and the browser.
  // o.line: the compact line above the graph (the nightly, the level, how many moved), else the detail with its badges.
  T.stripFor = (H, Ms, cat, o) => {
    const M0 = Ms.find(M => M && lastPt(M));
    if (!M0) return o.line ? 'No records at this level yet.' : '<p>No records yet.</p>';
    const lp = lastPt(M0), prev = M0.dates[M0.dates.indexOf(lp.date) - 1] || null, items = H.map((id, i) => ({ m: cat[id], p: Ms[i] && lastPt(Ms[i]), t: Ms[i] && Ms[i].t }));
    if (o.line) { const n = items.filter(x => x.p && (x.p.verdict === 'bad' || x.p.verdict === 'good')).length; return `Nightly ${dLong(lp.date)}, ${lvLabel(o.level)}: ${n ? `<b>${n} of ${H.length}</b>` : 'none of the ' + H.length} headline metrics moved beyond noise.`; }
    return T.stripHTML(items, { prev, plat: o.plat, level: o.level });
  };
  // The fork against its upstream base: the precomputed comparison (a = the base, b = the fork) for the headlines.
  T.baseName = f => (f.base_sha ? 'Upstream base ' + f.base_sha.slice(0, 7) : 'Base ' + (f.base_date ? dShort(f.base_date) : ''));
  T.baseSub = f => (f.base_sha ? `${f.tag} against its upstream base, built from source at ${f.base_sha.slice(0, 7)}` : `${f.tag} against nightly ${f.base_date ? dShort(f.base_date) : ''}`);
  T.basePath = (f, p) => (f.base_sha ? `compare/base-${f.base_sha.slice(0, 12)}__${f.tag}.${p}.json` : `compare/${f.base_tag}__${f.tag}.${p}.json`);
  T.cmpRows = (ids, cf, cat, L) => { const rows = []; ids.forEach(id => { const m = cat[id], x = m && cf && cf.rows.find(r => r.metric === id && r.level === T.effLevel(m, L)); if (x) rows.push(T.drow(m, x.a, x.b, x.delta, x.verdict, x.note, x.threshold)); }); return rows; };
  T.forkFor = (H, cf, cat, f, o) => {
    if (!f) return { sub: '', html: '<p class="note">No fork release has a record yet.</p>' };
    const rows = H.map(id => (o.na && o.na(id) ? { m: cat[id], k: 'na', na: 'n/a on macOS: per-thread CPU needs /proc' } : T.cmpRows([id], cf, cat, o.level)[0])).filter(Boolean);
    return {
      sub: `${T.baseSub(f)}. ${o.plat}, ${lvLabel(o.level)}.`,
      html: rows.length ? T.deltasHTML(rows, T.baseName(f), 'Fork ' + short(f.tag)) : `<p class="note">${cf ? 'No deltas at this level.' : 'No comparison with its upstream base yet.'}</p>`,
    };
  };
  T.short = short;
  T.overviewModels = (ids, shards, cat, L, r, served) => ids.map(id => (shards[id] && cat[id] ? T.model(shards[id], cat[id], T.effLevel(cat[id], L), r, served) : null));

  // ================= the page (browser only) =================
  if (!D.body || !D.body.dataset || !D.body.dataset.page) return;
  const store = {
    get(k) { try { return W.localStorage.getItem('t3cp-' + k); } catch (e) { return null; } },
    set(k, v) { try { W.localStorage.setItem('t3cp-' + k, v); } catch (e) { /* storage blocked: the choice lasts this page only */ } },
  };
  const S = (T.state = { p: 'linux', l: '50', r: 30, m: '', g: 'all', v: 'all', mode: '', a: '', b: '', rel: '', ln: '', lf: '' });
  let Q; try { Q = new URLSearchParams(W.location.search); } catch (e) { Q = new URLSearchParams(''); }
  (function () {
    // macOS is shown only when the build says so (data-mac="1"): until its first record the site is Linux only.
    const p = Q.get('p') || store.get('p'); if (PLAT[p] && (p === 'linux' || D.body.dataset.mac === '1')) S.p = p;
    const l = Q.get('l') || Q.get('u') || store.get('l'); if (LEVELS.includes(l) || l === '1e') S.l = l;
    const r = +Q.get('r'); if (RANGES.includes(r)) S.r = r;
    ['m', 'g', 'v', 'mode', 'a', 'b', 'rel', 'ln', 'lf'].forEach(k => { const x = Q.get(k); if (x) S[k] = x; });
  })();
  const cache = {};
  const get = path => cache[path] || (cache[path] = W.fetch(DATA + path).then(r => { if (!r.ok) throw new Error(path + ': HTTP ' + r.status); return r.json(); }));
  T.get = get;
  let IX = null;
  const cat = {};
  const pid = () => PLAT[S.p], platName = () => (IX && (IX.platforms.find(x => x.id === pid()) || {}).name) || pid();
  const live = () => !!(IX && (IX.platforms.find(x => x.id === pid()) || {}).live && (IX.series[pid()] || null));
  const naOf = id => (cat[id] && cat[id].na_on.includes(pid()) ? 'na' : !live() ? 'after' : null);
  const shardPath = id => { const sh = IX && IX.series[pid()] && IX.series[pid()][id]; return sh && sh.length ? T.shardFile(pid(), id, sh) : null; };
  T.shard = id => { const p = shardPath(id); return p ? get(p) : Promise.resolve(null); };
  // A failed fetch shows its error and leaves the static content (the last deploy's tables and strip) in place.
  const fail = (err, el) => { T.errBox($('#err'), err.stale ? err.message : `The data could not be loaded (${err.message}). What is shown is from the last deploy.`); if (el) el.classList.remove('ld'); };
  const heroH = () => { const w = D.documentElement.clientWidth; return w < 560 ? 280 : w < 1020 ? 360 : 440; };
  T.mountTS = function (el, M, h) { mount(el, T.tsChart(M, { h, w: el.clientWidth || 960, plat: platName() })); };
  T.mountLadder = function (el, c) { mount(el, c); };
  const carry = () => [S.p !== 'linux' ? 'p=' + S.p : '', S.l !== '50' ? 'l=' + S.l : '', S.r !== 30 ? 'r=' + S.r : ''].filter(Boolean).join('&');
  T.href = (path, extra) => { const q = [extra, carry()].filter(Boolean).join('&'); return path + (q ? '?' + q : ''); };
  T.sparks = function (root, ids, L) {
    const go = card => { const id = card.dataset.id, m = cat[id]; T.shard(id).catch(() => null).then(Sh => { const M = Sh && T.model(Sh, m, T.effLevel(m, L), S.r); if (M && lastPt(M)) spark(card, M); }); };
    const cards = $$('.card:not(.card-na)', root).filter(c => ids.includes(c.dataset.id));
    if (!W.IntersectionObserver) { cards.forEach(go); return; }
    const io = new W.IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); go(e.target); } }), { rootMargin: '200px' });
    cards.forEach(c => io.observe(c));
  };

  let pageFn = null, first = true, token = 0;
  function syncUrl() {
    try {
      const n = new URLSearchParams(), keep = Q.get('theme');
      (T.keys || []).forEach(k => { const v = S[k], def = { p: 'linux', l: '50', r: 30 }[k]; if (v !== '' && v !== 'all' && v !== def) n.set(k, v); });
      if (keep) n.set('theme', keep);
      const q = n.toString(); W.history.replaceState(null, '', W.location.pathname + (q ? '?' + q : '') + W.location.hash);
    } catch (e) { /* a sandboxed frame may refuse history */ }
  }
  function render() {
    $$('[data-seg]').forEach(el => $$('button', el).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === String(S[el.dataset.seg])))));
    $$('select[data-sel]').forEach(el => { if (el.value !== S[el.dataset.sel]) el.value = S[el.dataset.sel]; });
    const my = ++token;
    if (pageFn) pageFn(S, first, () => my === token); first = false;
    // After the page has settled its state (a fallback from an unknown value included), the URL and the links follow it.
    $$('a[data-nav]').forEach(a => { a.href = T.href(a.dataset.nav, a.dataset.q); });
    syncUrl();
  }
  T.set = function (k, v) { S[k] = v; if (k === 'p' || k === 'l') store.set(k, v); render(); };
  T.render = render;
  T.page = function (keys, fn) { T.keys = keys; pageFn = fn; };
  T.cat = cat;

  function boot() {
    $$('[data-seg]').forEach(el => el.addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) T.set(el.dataset.seg, typeof S[el.dataset.seg] === 'number' ? +b.dataset.v : b.dataset.v); }));
    $$('select[data-sel]').forEach(el => el.addEventListener('change', () => T.set(el.dataset.sel, el.value)));
    const th = $('#theme'); if (th) th.addEventListener('click', () => {
      // Dark is the default; the visitor's choice persists on this machine when storage allows.
      const root = D.documentElement, nx = root.dataset.theme === 'light' ? 'dark' : 'light';
      if (nx === 'light') root.dataset.theme = 'light'; else delete root.dataset.theme; store.set('theme', nx);
    });
    const nav = $('#nav'), sc = () => nav.classList.toggle('is-scrolled', W.scrollY > 4); W.addEventListener('scroll', sc, { passive: true }); sc();
    D.addEventListener('keydown', e => {
      if (!T.stepList || e.altKey || e.metaKey || e.ctrlKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      const t = e.target; if (t.closest && t.closest('svg,select,input,textarea,.seg,a')) return;
      e.preventDefault(); T.step(e.key === 'ArrowRight' ? 1 : -1);
    });
    $$('[data-step]').forEach(b => b.addEventListener('click', () => T.step(+b.dataset.step)));
    // Charts are laid out to their container's width, and again whenever that width changes.
    const main = $('#main'); let w = main.clientWidth, rt;
    const fit = () => { if (main.clientWidth === w) return; w = main.clientWidth; clearTimeout(rt); rt = setTimeout(render, 80); };
    W.addEventListener('resize', fit); if (W.ResizeObserver) new W.ResizeObserver(fit).observe(main);
    // A records-less build (data-empty) has no data to fetch: its static empty states stand.
    if (D.body.dataset.empty) { if (D.body.dataset.page === 'page404') T.pages.page404(); return; }
    get('index.json').then(ix => {
      IX = ix; ix.catalogue.forEach(m => { cat[m.id] = m; }); T.ix = ix;
      const fn = T.pages[D.body.dataset.page]; if (fn) fn(); render();
    }, err => {
      const box = $('#err'); if (box) { box.hidden = false; box.textContent = `The data could not be loaded (${err.message}). What is shown is from the last deploy.`; }
      // The static content stays: the tables, the last deployed verdict strip and the lead release post.
    });
  }
  T.step = d => { const l = T.stepList(), i = l.indexOf(S.m); T.set('m', l[(i + d + l.length) % l.length]); };

  // ---------- pages ----------
  const levelsFor = m => (m.scope === 'record' ? ['once'].concat(m.empty_cell ? ['1e'] : []) : LEVELS.concat(m.empty_cell ? ['1e'] : []));
  const leadL = T.headlineLevel;
  const naInto = (el, why) => { el.innerHTML = T.naBlock(why, el.classList.contains('h-hero') ? 'h-hero' : el.classList.contains('h-lad') ? 'h-lad' : 'h-rel'); };
  T.pages = {
    overview() {
      T.page(['m', 'p', 'l', 'r'], function (s, firstRun, still) {
        if (!LEAD.includes(s.l)) { s.l = leadL(s.l); }
        const H = IX.headlines[pid()], tabs = $('#tabs'), had = tabs.contains(D.activeElement);
        if (!H.includes(s.m)) s.m = H[1];
        T.stepList = () => H;
        tabs.innerHTML = H.map(id => { const on = id === s.m; return `<button type="button" role="tab" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-id="${id}">${esc(T.cap(cat[id].short || cat[id].name))}</button>`; }).join('');
        tabs.onclick = e => { const b = e.target.closest('button'); if (b) T.set('m', b.dataset.id); };
        const on = $('[aria-selected=true]', tabs); if (had) on.focus(); if (on.scrollIntoView && !firstRun) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        $('#pos').textContent = (H.indexOf(s.m) + 1) + ' / ' + H.length;
        $('#open').href = $('#full').href = T.href('/metrics/' + s.m + '/');
        $$('[data-seg=l] button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === s.l)));
        const hero = $('#hero'), m = cat[s.m];
        if (!live()) { $('#ro').innerHTML = T.readoutHTML(m, null, { na: naOf(s.m) || 'after' }); naInto(hero, naOf(s.m) || 'after'); }
        hero.classList.add('ld');
        Promise.all(H.map(id => T.shard(id)).concat([T.shard('agents_served')])).catch(e => { fail(e, hero); return null; }).then(shs => {
          if (!shs) return;
          const served = shs.pop();
          if (!still()) return;
          const by = {}; H.forEach((id, i) => { by[id] = shs[i]; });
          const Ms = T.overviewModels(H, by, cat, s.l, s.r, served), Mi = Ms[H.indexOf(s.m)];
          const na = naOf(s.m);
          $('#ro').innerHTML = T.readoutHTML(m, Mi, { na: na || (Mi && lastPt(Mi) ? null : 'none') });
          if (na || !Mi) naInto(hero, na || 'none'); else T.mountTS(hero, Mi, heroH());
          const grid = $('#grid');
          grid.innerHTML = H.map((id, i) => T.cardHTML(cat[id], Ms[i], T.href('/metrics/' + id + '/'), { na: naOf(id) })).join('');
          $$('.card:not(.card-na)', grid).forEach(c => { const M = Ms[H.indexOf(c.dataset.id)]; if (M && lastPt(M)) spark(c, M); });
          if (live()) { $('#strip').innerHTML = T.stripFor(H, Ms, cat, { plat: platName(), level: s.l }); $('#sline').innerHTML = T.stripFor(H, Ms, cat, { level: s.l, line: 1 }); }
          const tbl = $('#htable'); if (tbl) tbl.innerHTML = T.headTable(Ms);
          $('#hcap').textContent = 'The eight headline metrics, ' + lvLabel(s.l);
          // The fork strip: the latest fork release against its base, at this level.
          const rels = IX.fork.filter(f => f.platforms[pid()]), fe = $('#fork');
          if (!live()) { fe.innerHTML = T.naBlock('after'); $('#forksub').textContent = ''; return; }
          const f = rels[rels.length - 1], cp = f && T.basePath(f, pid());
          (cp && IX.compare.includes(cp) ? get(cp).catch(() => null) : Promise.resolve(null)).then(cf => {
            if (!still()) return;
            const fk = T.forkFor(H, cf, cat, f, { plat: platName(), level: s.l, na: naOf });
            $('#forksub').textContent = fk.sub; fe.innerHTML = fk.html;
          });
        });
      });
    },
    metrics() {
      const LAT = JSON.parse(($('#latest') || {}).textContent || '{}');
      if (S.m && !cat[S.m]) { const n = $('#unknown'); if (n) { n.innerHTML = T.metricNotice(S.m); n.hidden = false; } }
      T.page(['p', 'l', 'r', 'g', 'v'], function (s) {
        if (s.l === '1e') s.l = '1';
        const ids = IX.catalogue.map(m => m.id).filter(id => {
          const m = cat[id], L = T.effLevel(m, s.l), x = ((LAT[pid()] || {})[id] || {})[L];
          return (s.g === 'all' || m.group === s.g) && (s.v === 'all' || (x && vk(x[1]) === s.v));
        });
        $('#count').textContent = `${ids.length === IX.catalogue.length ? ids.length : ids.length + ' of ' + IX.catalogue.length} metrics, ${platName()}, ${lvLabel(s.l)}`;
        const grid = $('#grid');
        grid.innerHTML = ids.map(id => {
          const m = cat[id], x = ((LAT[pid()] || {})[id] || {})[T.effLevel(m, s.l)];
          const fake = x ? { n: 1, pts: [{ v: x[0], d: x[2], verdict: vk(x[1]), note: x[3], date: '' }], rel: [], L: s.l } : null;
          return T.cardHTML(m, fake, T.href('/metrics/' + id + '/'), { na: naOf(id) });
        }).join('');
        T.sparks(grid, ids, s.l);
        $('#none').hidden = ids.length > 0;
        $('#clear').onclick = () => { s.g = 'all'; T.set('v', 'all'); };
      });
    },
    metric() {
      const id = D.body.dataset.metric, m = cat[id];
      const want = Q.get('m'); if (want && want !== id) { W.location.replace(T.resolveMetric(Object.keys(cat), want).href); return; }
      const all = IX.catalogue.map(x => x.id), pick = $('#pick');
      pick.onchange = () => { W.location.href = T.href('/metrics/' + pick.value + '/'); };
      T.stepList = () => all; S.m = id;
      T.step = d => { const i = all.indexOf(id); W.location.href = T.href('/metrics/' + all[(i + d + all.length) % all.length] + '/'); };
      T.page(['p', 'l', 'r', 'ln', 'lf'], function (s, firstRun, still) {
        const L = T.effLevel(m, s.l), opts = levelsFor(m);
        $$('[data-seg=l] button').forEach(b => { b.hidden = !opts.includes(b.dataset.v); b.setAttribute('aria-pressed', String(b.dataset.v === L)); });
        const na = naOf(id), hero = $('#hero');
        Promise.all([T.shard(id), T.shard('agents_served')]).catch(e => { fail(e, hero); return []; }).then(([Sh, served]) => {
          if (Sh === undefined || !still()) return;
          const M = Sh && T.model(Sh, m, L, s.r, served);
          $('#ro').innerHTML = T.readoutHTML(m, M, { na: na || (M && lastPt(M) ? null : 'none') });
          if (na || !M) naInto(hero, na || 'none'); else T.mountTS(hero, M, heroH());
          $('#rsum').textContent = 'Records, ' + lvLabel(L);
          const MA = Sh && T.model(Sh, m, L, 0, served); $('#rtable').innerHTML = MA ? T.recordsTable(MA) : '<p class="note">No records yet.</p>';
          const lad = $('#ladder'); if (!lad) return;
          if (na || !Sh || m.scope === 'record') { if (na || !Sh) naInto(lad, na || 'none'); return; }
          const dsel = $('#ln'), fsel = $('#lf'), F = Sh.fork;
          dsel.innerHTML = Sh.dates.map((d, j) => `<option value="${d}">Nightly ${dShort(d)}</option>`).reverse().join('');
          fsel.innerHTML = F ? F.tags.map(t => `<option value="${esc(t)}">Fork ${esc(short(t))}</option>`).reverse().join('') : '<option value="">No fork release</option>';
          let j = Sh.dates.indexOf(s.ln); if (j < 0) { j = Sh.dates.length - 1; while (j > 0 && Sh.levels['50'] && Sh.levels['50'].median[j] == null) j--; }
          const k = F ? Math.max(F.tags.indexOf(s.lf), F.tags.length - 1 >= 0 && F.tags.indexOf(s.lf) < 0 ? F.tags.length - 1 : -1) : -1;
          dsel.value = Sh.dates[j]; if (k >= 0) fsel.value = F.tags[k];
          dsel.onchange = () => T.set('ln', dsel.value); fsel.onchange = () => T.set('lf', fsel.value);
          const c = T.ladderChart(m, Sh, j, k, { h: 300, plat: platName() }); mount(lad, c); $('#ltable').innerHTML = c.table();
        });
        if (firstRun && W.location.hash === '#records') $('#records').open = true;
      });
    },
    compare() {
      // The records list lives in its own file, off the overview's path: this page fetches it when it opens.
      get(IX.records_index || 'records-index.json').then(ri => {
      const recs = ri.records.filter(r => r.platforms[pid()]), forks = IX.fork.filter(f => f.platforms[pid()]);
      if (!S.mode) S.mode = forks.length ? 'fork' : 'nightly';
      const opt = (v, l) => `<option value="${esc(v)}">${esc(l)}</option>`;
      const sa = $('#a'), sb = $('#b');
      $('#swap').onclick = () => { const a = S.a; S.a = S.b; T.set('b', a); };
      T.page(['mode', 'a', 'b', 'p', 'l'], function (s, firstRun, still) {
        if (s.l === '1e') s.l = '1';
        const out = $('#rows'), figs = $('#figs'), fork = s.mode === 'fork', plat = s.mode === 'platform';
        $('#b-wrap').hidden = fork || plat; $('#swap').hidden = fork || plat;
        if (!live()) { figs.innerHTML = ''; out.innerHTML = T.naBlock('after'); return; }
        const nightOpts = recs.slice().reverse().map(r => opt(r.date, 'Nightly ' + dShort(r.date))).join('');
        sa.innerHTML = fork ? forks.slice().reverse().map(f => opt(f.tag, 'Fork ' + short(f.tag))).join('') : nightOpts; sb.innerHTML = nightOpts;
        const has = (sel, v) => $$('option', sel).some(o => o.value === v);
        if (!has(sa, s.a)) s.a = sa.options.length ? sa.options[fork ? 0 : Math.min(1, sa.options.length - 1)].value : '';
        if (!has(sb, s.b)) s.b = sb.options.length ? sb.options[0].value : '';
        sa.value = s.a; sb.value = s.b;
        let A, B, an, bn, pre = null, seg = null;
        if (fork) {
          const f = forks.find(x => x.tag === s.a), base = f && recs.find(r => r.date === f.base_date);
          A = f && (f.base_record || (base && base.platforms[pid()] && base.platforms[pid()].path));
          if (!f || !A) { out.innerHTML = '<p class="note">This release has no upstream base record on this platform yet.</p>'; figs.innerHTML = ''; return; }
          B = f.platforms[pid()].path; an = T.baseName(f); bn = 'Fork ' + short(f.tag);
          pre = IX.compare.find(x => x === T.basePath(f, pid()));
          if (!pre) { out.innerHTML = '<p class="note">No comparison with its upstream base yet.</p>'; figs.innerHTML = ''; return; }
          $('#cmp-sub').textContent = T.baseSub(f) + '.';
        } else if (plat) {
          const r = recs.find(x => x.date === s.a), other = r && r.platforms[pid() === 'linux-x64' ? 'darwin-arm64' : 'linux-x64'];
          if (!r || !other) { out.innerHTML = T.naBlock('after'); figs.innerHTML = ''; $('#cmp-sub').textContent = ''; return; }
          A = r.platforms['linux-x64'].path; B = r.platforms['darwin-arm64'].path; an = 'Linux x64'; bn = 'macOS arm64';
          $('#cmp-sub').textContent = `Nightly ${dShort(r.date)} on both machines: ratio only.`;
        } else {
          const ra = recs.find(x => x.date === s.a), rb = recs.find(x => x.date === s.b);
          if (!ra || !rb) { out.innerHTML = '<p class="note">Pick two nightlies.</p>'; figs.innerHTML = ''; return; }
          A = ra.platforms[pid()].path; B = rb.platforms[pid()].path; an = 'Nightly ' + dShort(ra.date); bn = 'Nightly ' + dShort(rb.date); seg = { a: ra.platforms[pid()], b: rb.platforms[pid()] };
          $('#cmp-sub').textContent = `Nightly ${dShort(rb.date)} against nightly ${dShort(ra.date)}.`;
        }
        out.classList.add('ld');
        const L = s.l;
        // Only the current request writes, its counts and its table together: a late older answer changes nothing.
        const done = (html, f) => { if (!still()) return; if (f != null) figs.innerHTML = f; out.innerHTML = html; out.classList.remove('ld'); };
        if (pre) get(pre).then(cf => {
          const rows = T.cmpRows(IX.catalogue.map(m => m.id), cf, cat, L), sv = cf.rows.find(x => x.metric === 'agents_served' && x.level === L), N = +L;
          const flags = cf.rows.some(x => x.note === 'saturated' && x.level === L) && sv ? [[an, sv.a], [bn, sv.b]].filter(x => x[1] != null && x[1] < N).map(([w, n]) => T.satFlag(w, n, N)).join('') : '';
          done(flags + T.deltasHTML(rows, an, bn), T.figs(T.tally(rows)));
        }, e => done(`<p class="note">${esc(e.message)}</p>`, ''));
        else Promise.all([get(A), get(B)]).then(([ra, rb]) => {
          const r = T.compare(ra, rb, { catalogue: IX.catalogue, level: L, seg });
          done(T.compareHTML(r, an, bn), r.mode === 'verdict' ? T.figs(T.tally(r.rows.map(x => ({ k: vk(x.verdict) })))) : '');
        }, e => done(`<p class="note">${esc(e.message)}</p>`, ''));
      });
      render();
      }, e => fail(e, $('#rows')));
    },
    releases() {
      const F = IX.fork, keys = F.map(f => f.tag).concat(['next']);
      $$('[data-rstep]').forEach(b => b.addEventListener('click', () => { const i = keys.indexOf(S.rel); T.set('rel', keys[(i + (+b.dataset.rstep) + keys.length) % keys.length]); }));
      T.page(['rel', 'p', 'l'], function (s, firstRun, still) {
        if (!keys.includes(s.rel)) s.rel = F.length ? F[F.length - 1].tag : 'next';
        if (!LEAD.includes(s.l)) s.l = leadL(s.l);
        $$('[data-seg=l] button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === s.l)));
        $$('[data-seg=rel] button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === s.rel)));
        const on = $('[data-seg=rel] [aria-pressed=true]'), sg = on && on.parentNode; if (sg && sg.scrollTo) sg.scrollTo({ left: Math.max(0, on.offsetLeft - sg.clientWidth / 2) });
        const i = keys.indexOf(s.rel), head = $('#rhead'), post = $('#post');
        $('#pos').textContent = (i + 1) + ' / ' + keys.length;
        if (s.rel === 'next') {
          D.title = 'Next release · t3cp';
          head.innerHTML = '<h1 class="rel-t">Next release</h1><p class="lede rel-s">Not yet released. This page fills in by itself when the tag lands and its record is measured.</p>';
          post.innerHTML = '<div class="blk"><p class="note">Nothing to show yet: the next fork release has no tag. When it does, the pipeline builds it from the public tag, measures it, compares it with its upstream base, and publishes this page.</p></div>';
          return;
        }
        D.title = s.rel + ' · t3cp';
        post.classList.add('ld');
        // The build renders every release at each headline level; the page fetches that fragment.
        T.loadFragment(u => W.fetch(u), s.rel, s.l, D.body.dataset.frag).then(({ html, hash }) => {
          if (!still()) return;
          D.body.dataset.frag = hash; T.errBox($('#err'), null);
          const cut = html.indexOf('<!--body-->'), rel = IX.fork.find(f => f.tag === s.rel) || {};
          head.innerHTML = html.slice(0, cut); post.innerHTML = html.slice(cut + 11); post.classList.remove('ld');
          $$('[data-chart]', post).forEach(el => {
            const c = T.parseChart(el.dataset.chart), m = c && cat[c.metric]; if (!m) return;
            if (naOf(m.id)) { naInto(el, naOf(m.id)); return; }
            const fi = IX.fork.find(x => x.tag === s.rel), cp = fi && T.basePath(fi, pid());
            if (c.ladder && m.scope !== 'record' && fi && fi.base_sha) {
              if (!IX.compare.includes(cp)) { naInto(el, 'none'); return; }
              get(cp).then(cf => mount(el, T.baseLadderChart(m, cf, fi, { h: 300, plat: platName() })), e => { el.innerHTML = `<p class="note">${esc(e.message)}</p>`; });
              return;
            }
            T.shard(m.id).then(Sh => {
              if (!Sh) { naInto(el, 'none'); return; }
              const k = Sh.fork ? Sh.fork.tags.indexOf(s.rel) : -1;
              const h = D.documentElement.clientWidth < 560 ? 240 : 320, L = T.effLevel(m, s.l);
              if (c.ladder && m.scope !== 'record') { const j = Sh.dates.indexOf(rel.base_date); mount(el, T.ladderChart(m, Sh, j < 0 ? Sh.dates.length - 1 : j, k, { h: 300, plat: platName() })); }
              else if (c.kind === 'fork-vs-prev') { const fc = T.forkChart(m, Sh, L, s.rel, { h, plat: platName() }); if (fc) mount(el, fc); else naInto(el, 'none'); }
              else T.shard('agents_served').catch(() => null).then(sv => { const M = T.model(Sh, m, L, 30, sv); if (M) T.mountTS(el, M, h); });
            }, e => { el.innerHTML = `<p class="note">${esc(e.message)}</p>`; });
          });
        }, e => { if (still()) { head.innerHTML = `<h1 class="rel-t">${esc(s.rel)}</h1>`; post.innerHTML = ''; fail(e, post); } });
      });
    },
    page404() {
      const id = T.metricFromPath(W.location.pathname);
      if (id) W.location.replace(T.resolveMetric(Object.keys(cat), id).href);
    },
  };
  try { boot(); } catch (e) { (W.console || console).error(e); }
})(window, document);

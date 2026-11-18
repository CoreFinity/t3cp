// A release post rendered from releases/<tag>.json (schema/release-1.json), with the browser's own helpers (app.js,
// loaded into the build). The build writes the newest release into the page and every release at each headline
// level as a fragment the Releases page fetches; the script itself carries no release renderer. ctx.table(chart), when
// given, returns the chart's table view, which follows the chart.
export function releaseHTML(T, rel, ctx) {
    const cat = {}; ctx.catalogue.forEach(m => { cat[m.id] = m; });
    const P = ctx.platform, L = ctx.level, chk = rel.checker || {}, dropped = [], pending = rel.charts_only_reason === 'pending', noBase = rel.charts_only_reason === 'no_base';
    const text = !rel.charts_only && rel.post && chk.passed === true;
    const ds = (rel.deltas || []).filter(d => d.platform === P && cat[d.metric] && String(d.level) === T.effLevel(cat[d.metric], L));
    const rows = ds.map(d => Object.assign(T.drow(cat[d.metric], d.base, d.fork, d.delta_pct != null ? d.delta_pct : d.delta, d.verdict, d.note, d.threshold_pct != null ? d.threshold_pct : d.threshold), { txt: d.text || null, hl: d.headline }));
    // The figures count the headline rows, and the first table lists exactly those; other metrics beyond noise sit apart.
    const hasHl = rows.some(r => r.hl != null), head8 = rows.filter(r => r.hl != null || !hasHl), others = rows.filter(r => hasHl && r.hl == null), c = T.tally(head8);
    const sha = rel.base && (rel.base.sha7 || (rel.base.sha ? rel.base.sha.slice(0, 7) : null)), baseName = sha ? 'Upstream base ' + sha : 'Base ' + (rel.base && rel.base.date ? T.dShort(rel.base.date) : '');
    const by = {}; rows.forEach(r => { by[r.m.id] = r; });
    // A level where the fork or its base could not serve every agent: the flag, and latency there is context only.
    const sat = ds.find(d => d.saturated && (d.saturated.fork || d.saturated.base)), served = ds.find(d => d.metric === 'agents_served');
    const satLine = sat ? `<p class="note sat">${[sat.saturated.fork && `saturated: ${served ? T.fmt(served.fork) : '?'} of ${T.esc(L)} agents served by the fork`, sat.saturated.base && `saturated: ${served ? T.fmt(served.base) : '?'} of ${T.esc(L)} agents served by its base`].filter(Boolean).join('; ')}. Latency at this level is context only, never a verdict.</p>` : '';
    // The title is the template with this level's counts (the stored post title carries the headline level's only).
    const title = pending ? `${rel.tag}: comparison pending` : noBase ? `${rel.tag}: no comparable base` : `${rel.tag}: ${c.bad} regressed, ${c.good} improved, ${c.ok} within noise (vs ${sha ? 'upstream base ' + sha : rel.base && rel.base.tag ? rel.base.tag : 'its base'})`;
    const sub = `${rel.date ? T.dLong(rel.date) + '. ' : ''}${sha ? `Against its upstream base, built from source at ${sha}` : `Against its base, ${rel.base && rel.base.date ? 'nightly ' + T.dShort(rel.base.date) : 'not yet recorded'}`}. ${T.esc(ctx.platName || P)}, ${T.lvLabel(L)}. <a href="https://github.com/navidnadali/t3code/releases/tag/${encodeURIComponent(rel.tag)}">Tag on GitHub</a>.`;
    let secs = [];
    if (text) (rel.post.sections || []).forEach(s => { const p = T.parseChart(s.chart_id); if (!p || !cat[p.metric]) { dropped.push(String(s.chart_id)); return; } secs.push({ id: s.chart_id, p, cap: T.esc(T.nosp(s.caption)) }); });
    else secs = (ctx.headlines || []).filter(id => cat[id]).map(id => {
      const r = by[id], m = cat[id];
      const tx = (r && r.txt) || {};
      return { id: `series.${id}.${P}`, p: { kind: 'series', metric: id, platform: P }, cap: `<b>${T.esc(m.name)}</b>${T.dir(m)}${r ? `: fork ${tx.fork != null ? T.esc(T.nosp(tx.fork)) : T.fmtU(r.bv, m)} against ${tx.base != null ? T.esc(T.nosp(tx.base)) : T.fmtU(r.av, m)}, ${T.glyph(r.k, r.dir)}${tx.delta_pct != null ? T.esc(T.nosp(tx.delta_pct)) : T.pct(r.d)}, ${T.esc(T.say(r.k, r.note))}.` : '.'}` };
    });
    const all = Array.isArray(rel.changelog) ? rel.changelog : String(rel.changelog || '').split('\n').map(s => s.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean);
    const cl = text && rel.post.quotes && rel.post.quotes.length ? rel.post.quotes : all;
    const own = text ? `Text written from the record and checked against it: ${chk.numbers_checked} numbers, ${chk.charts} chart${chk.charts === 1 ? '' : 's'}, ${(chk.findings || []).length} findings.`
      : chk.passed === false ? 'Charts only: the generated text did not pass the checker.' : 'Charts only: no text was written for this release.';
    // The checker's footer is a fixed sentence from the release build, never the post's text: shown as written.
    const fits = typeof chk.footer === 'string' && (!text || /^Text written/.test(chk.footer));
    const foot = T.esc(fits ? chk.footer : pending ? 'Comparison pending: the measured records for this release are not complete yet.' : own) + (text ? ' A post that fails the check ships with charts only.' : '');
    const head = `<h1 class="rel-t">${T.esc(title)}</h1><p class="lede rel-s">${sub}</p>`;
    const body = (pending ? '<p class="note">The comparison is pending: the measured records for this release are not complete yet.</p>' : noBase ? '<p class="note">No comparison: its upstream base is from another era, so only the series charts are shown.</p>' : `<div class="figs">${T.figs(c)}</div>${satLine}${head8.length ? T.deltasHTML(head8, baseName, 'Fork ' + T.short(rel.tag)) : '<p class="note">No measured deltas at this level yet.</p>'}` +
      (others.length ? `<h3 class="mt3">Other metrics beyond noise</h3>${T.deltasHTML(others, baseName, 'Fork ' + T.short(rel.tag))}` : '')) +
      (text && rel.post.summary ? `<div class="blk"><h2>What moved.</h2><p>${T.esc(T.nosp(rel.post.summary))}</p></div>` : '') +
      secs.map(s => `<div class="blk"><p class="cap">${s.cap}</p><div class="plot h-rel" data-chart="${T.esc(s.id)}"></div>${ctx.table ? ctx.table(s.p) : ''}</div>`).join('') +
      (cl.length ? `<div class="blk"><h3>From the fork's changelog</h3><ul>${cl.map(l => `<li>${T.esc(l)}</li>`).join('')}</ul><p class="note">Causes are quoted from the changelog, never inferred from the charts.</p></div>` : '') +
      `<p class="note rel-foot">${foot}</p>`;
    return { head, body, html: head + body, dropped };
  }

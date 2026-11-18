// The page shell: head (theme bootstrap, one stylesheet, one script, the analytics snippets), header with logo B
// (the wordmark on its time axis), the tagline, and the footer with the independence notice on every page.
import { createHash } from 'node:crypto';

export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Logo B (chosen 2026-11-15): monoline t 3 c p on a time axis, one tick per letter, ending at today's dot.
const WORD_D = '<path d="M5 3.5V15a4.5 4.5 0 0 0 4.5 4.5H11M1.5 8.5h9"/><path d="M15.5 4.5h8L19 10.2a4.7 4.7 0 1 1-4.1 7"/><path d="M38.6 9.65a6 6 0 1 0 0 7.7"/><path d="M46 7.5v18M46 13.5a6 6 0 1 0 12 0a6 6 0 1 0-12 0"/>';
const AXIS_D = '<g stroke-width="1.6"><path d="M1.5 31.5H76M5 31.5v3M19 31.5v3M34 31.5v3M52 31.5v3"/></g><circle cx="78.5" cy="31.5" r="2.2" fill="currentColor" stroke="none"/>';
export const LOGO = `<svg class="lg-b" viewBox="0 0 84 36" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="t3cp">${WORD_D}${AXIS_D}</svg>`;
// The favicon: the t on its axis. Its own stylesheet follows the browser's scheme (the file gets its own CSP).
const TAXIS_D = "<path d='M8 2.5V12a4 4 0 0 0 4 4h1.5M4 7h8'/><path d='M2.5 21H19' stroke-width='1.8'/><circle cx='21' cy='21' r='1.7' fill='currentColor' stroke='none'/>";
export const FAVICON = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><style>g{stroke:#0a0a0a;color:#0a0a0a}@media(prefers-color-scheme:dark){g{stroke:#f5f5f5;color:#f5f5f5}}</style><g>${TAXIS_D}</g></svg>\n`;

// Inlined, so _headers stays Appendix C (no rule of its own) and the icon costs no request; img-src allows data:.
export const FAVICON_URI = 'data:image/svg+xml,' + FAVICON.trim().replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E');

// Dark is the default: only a stored (or requested) light theme sets the attribute, before first paint. With storage
// blocked the read throws, the catch keeps the page dark, and nothing is logged.
export const THEME_JS = "try{var t=new URLSearchParams(location.search).get('theme')||localStorage.getItem('t3cp-theme');if(t==='light')document.documentElement.dataset.theme='light'}catch(e){}";
export const THEME_HASH = "'sha256-" + createHash('sha256').update(THEME_JS).digest('base64') + "'";

export const NAV = [['Overview', '/'], ['Metrics', '/metrics/'], ['Compare', '/compare/'], ['Releases', '/releases/'], ['MRs', '/mrs/'], ['About', '/about/']];
const CHEV = d => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
export const PREV = CHEV('M10 3L5 8l5 5'), NEXT = CHEV('M6 3l5 5-5 5');
export const TAGLINE = '<b>T3</b> <b>C</b>ode · <b>P</b>erformance over time';

// The analytics snippets, each only when configured. Plausible's newer snippet is an id script plus an init call; the
// init is our own static file (/analytics-init.js), deferred immediately before the deferred id script, so it runs
// first and the CSP needs no inline script. Only a Plausible pa- script URL is accepted.
export const PLAUSIBLE = /^https:\/\/plausible\.io\/js\/pa-[A-Za-z0-9_-]+\.js$/;
// A beacon token and the beacon Pages injects are refused together: two Cloudflare beacons would run while About
// names one counter.
export function analytics(cfg) {
  const a = (cfg && cfg.analytics) || {};
  if (a.cloudflare_beacon_token && a.cloudflare_pages_injected === true) throw new Error('site/config.json: analytics.cloudflare_beacon_token and analytics.cloudflare_pages_injected are both set; set one (with both, two Cloudflare beacons run and About counts one)');
  let h = '';
  if (a.plausible_script) {
    if (!PLAUSIBLE.test(a.plausible_script)) throw new Error('site/config.json: analytics.plausible_script must be a Plausible pa- script, https://plausible.io/js/pa-<id>.js');
    h += `<script defer src="/analytics-init.js"></script><script defer src="${a.plausible_script}"></script>`;
  }
  if (a.cloudflare_beacon_token) h += `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="${esc(JSON.stringify({ token: a.cloudflare_beacon_token }))}"></script>`;
  return h;
}

// p: {title, desc, page, nav, body, attrs, mac:{show, live}}; assets: {css, js}; cfg: site/config.json.
export function layout(p, assets, cfg) {
  const nav = NAV.map(([name, href]) => `<a href="${href}" data-nav="${href}"${name === p.nav ? ' aria-current="page"' : ''}>${name}</a>`).join('');
  const plat = p.mac.show
    ? `<div class="seg seg-s" data-seg="p" role="group" aria-label="Platform"><button type="button" data-v="linux" aria-pressed="true">Linux <span>x64</span></button><button type="button" data-v="mac" aria-pressed="false"${p.mac.live ? '' : ' title="macOS records start after launch"'}>macOS <span>${p.mac.live ? 'arm64' : 'after launch'}</span></button></div>`
    : '';
  const attrs = Object.entries(Object.assign({ page: p.page, mac: p.mac.show ? '1' : '0' }, p.attrs || {})).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.desc)}">
<meta name="color-scheme" content="dark light">
<script>${THEME_JS}</script>
<link rel="icon" href="${FAVICON_URI}" type="image/svg+xml">
<link rel="stylesheet" href="/assets/${assets.css}">
<script defer src="/assets/${assets.js}"></script>${analytics(cfg)}
</head>
<body${attrs}>
<a class="skip" href="#main">Skip to content</a>
<header class="nav" id="nav"><div class="wrap nav-in">
<a class="brand" href="/" aria-label="t3cp home">${LOGO}</a>
<nav class="nav-links" aria-label="Site">${nav}</nav>
<div class="nav-r">${plat}<button type="button" class="icon" id="theme" aria-label="Switch between light and dark"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor"/></svg></button></div>
</div></header>
<main id="main" class="wrap">
<p class="tagline lockup-x">${TAGLINE}</p>
${p.body}
</main>
<footer class="foot"><div class="wrap foot-in">
<div><span class="lockup-x"><b>t3cp</b> · ${TAGLINE}</span></div>
<div><p>Independent. Not affiliated with, endorsed by or part of T3 Code. T3 Code is the brand and copyright of its owners.</p><p>Run and funded by <a href="https://corefinity.com">Corefinity</a>.</p><p>Data CC BY 4.0, code MIT.</p></div>
<nav aria-label="More"><a href="/records/">Records</a><a href="/methodology/">Methodology</a><a href="/downloads/">Downloads</a><a href="/about/#licences">Licences</a></nav>
</div></footer>
</body>
</html>
`;
}

// The legend under a time chart. Release markers and the arrows explained once, quietly.
// heads: the platform has nightly fork-head records, so the fork line is measured each night beside the upstream nightly.
export const LEGEND = (extra, heads) => `<div class="lg"><span><i class="k"></i>${heads ? 'Upstream nightly' : 'Nightly'}</span><span><i class="k k-f"></i>${heads ? 'Performance fork' : 'Fork release'}</span><span><i class="k k-b"></i>Noise band</span><span><i class="k k-r"></i>Range of attempts</span><span><span class="g v-good" aria-hidden="true">▲▼</span> green = better, <span class="g v-bad" aria-hidden="true">▲▼</span> red = worse, beyond the noise band</span>${extra || ''}</div>`;

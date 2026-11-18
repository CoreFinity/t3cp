// Red first: analytics at go-live. Plausible's newer snippet (an id script plus an init call) runs with no inline
// script: the init is our own static file, deferred just before the id script. The script URL is validated strictly.
// Cloudflare Web Analytics may come from a beacon token or be injected by Pages at the edge; the CSP allows both,
// and About's disclosure is accurate in every state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layout, THEME_JS } from './layout.mjs';
import { build, headers } from './build.mjs';

// The configured id script (read from site/config.json, so the id lives in one file only).
const PA = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')).analytics.plausible_script;
const page = { title: 't', desc: 'd', page: 'about', nav: 'About', body: '<p>b</p>', mac: { show: false, live: false } };
const assets = { css: 'app.000000000000.css', js: 'app.000000000000.js' };
const cfg = a => ({ site_url: 'https://t3cp.io', macos: 'auto', link_repository: false, analytics: { plausible_script: '', cloudflare_beacon_token: '', cloudflare_pages_injected: false, ...a } });
const inline = html => [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);

test('analytics off: no analytics tag and no init file referenced', () => {
  const html = layout(page, assets, cfg({}));
  assert.doesNotMatch(html, /plausible|cloudflareinsights|analytics-init/);
});

test('Plausible on: our init file comes first, then the id script, both deferred, and no new inline script', () => {
  const html = layout(page, assets, cfg({ plausible_script: PA }));
  const init = html.indexOf('<script defer src="/analytics-init.js"></script>'), id = html.indexOf(`<script defer src="${PA}"></script>`);
  assert.ok(init > 0 && id > init, 'the init file is deferred immediately before the id script');
  assert.equal(html.slice(init, id), '<script defer src="/analytics-init.js"></script>');
  assert.doesNotMatch(html, /\basync\b|data-domain/);
  assert.deepEqual(inline(html), [THEME_JS], 'the theme bootstrap stays the only inline script');
});

test('a plausible_script other than a Plausible pa- script is refused', () => {
  for (const bad of ['https://plausible.io/js/script.js', 'http://plausible.io/js/pa-x.js', 'https://evil.example/js/pa-x.js', `${PA}?x=1`, 'https://plausible.io/js/pa-x.js"><script>', 'https://plausible.io.evil.example/js/pa-x.js']) {
    assert.throws(() => layout(page, assets, cfg({ plausible_script: bad })), /plausible_script/, bad);
  }
});

test('the CSP allows Plausible and both Cloudflare origins, with no unsafe-inline, whatever the config', () => {
  for (const a of [{}, { plausible_script: PA }, { cloudflare_beacon_token: 'abc' }, { cloudflare_pages_injected: true }]) {
    const csp = /content-security-policy: (.*)/.exec(headers(cfg(a)))[1];
    assert.doesNotMatch(csp, /unsafe-inline/);
    const dir = n => csp.split('; ').find(d => d.startsWith(n + ' '));
    for (const o of ['https://plausible.io', 'https://static.cloudflareinsights.com']) assert.ok(dir('script-src').split(' ').includes(o), o);
    for (const o of ['https://plausible.io', 'https://cloudflareinsights.com']) assert.ok(dir('connect-src').split(' ').includes(o), o);
  }
});

test('About discloses the counters accurately: none, Plausible, a Cloudflare token, Cloudflare injected by Pages', async () => {
  const states = [
    [{}, /No page-view counter runs\./],
    [{ plausible_script: PA }, /One page-view counter runs: Plausible\./],
    [{ plausible_script: PA, cloudflare_beacon_token: 'abc' }, /Two page-view counters run: Plausible and Cloudflare Web Analytics\./],
    [{ plausible_script: PA, cloudflare_pages_injected: true }, /Two page-view counters run: Plausible and Cloudflare Web Analytics, which the host adds to every page\./],
  ];
  for (const [a, want] of states) {
    const out = mkdtempSync(join(tmpdir(), 't3cp-an-')), c = join(out, 'config.json');
    try {
      writeFileSync(c, JSON.stringify(cfg(a)));
      await build({ out: join(out, 'dist'), in: join(out, 'no-data-yet'), posts: 'news/posts', config: c });
      assert.match(readFileSync(join(out, 'dist/about/index.html'), 'utf8'), want, JSON.stringify(a));
      assert.equal(existsSync(join(out, 'dist/analytics-init.js')), !!a.plausible_script, 'the init file ships only with Plausible on');
      if (a.plausible_script) assert.equal(readFileSync(join(out, 'dist/analytics-init.js'), 'utf8'), 'window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};\nplausible.init()\n');
    } finally { rmSync(out, { recursive: true, force: true }); }
  }
});

test('a Cloudflare beacon token together with the beacon Pages injects is refused: About would count one beacon where two run', async () => {
  const both = { plausible_script: PA, cloudflare_beacon_token: 'abc', cloudflare_pages_injected: true };
  assert.throws(() => layout(page, assets, cfg(both)), /cloudflare_beacon_token[\s\S]*cloudflare_pages_injected/);
  const out = mkdtempSync(join(tmpdir(), 't3cp-an-')), c = join(out, 'config.json');
  try {
    writeFileSync(c, JSON.stringify(cfg(both)));
    await assert.rejects(build({ out: join(out, 'dist'), in: join(out, 'no-data-yet'), posts: 'news/posts', config: c }), /cloudflare_beacon_token[\s\S]*cloudflare_pages_injected/);
    assert.ok(!existsSync(join(out, 'dist/index.html')), 'refused before any page is written');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

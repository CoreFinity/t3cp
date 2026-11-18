// Red first: the delta re-review's build items. Release fragments are versioned (a fresh page never pairs with a
// stale fragment) and kept out of search results by robots.txt; Methodology's load sentences are exact; the
// release's saturated flag is said once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApp } from './lib/app-vm.mjs';
import { releaseHTML } from './render-post.mjs';
import * as P from './pages.mjs';
import { build } from './build.mjs';

const T = loadApp();
const cat = JSON.parse(readFileSync(new URL('../../catalogue/catalogue.json', import.meta.url), 'utf8'));

test('fragment URLs carry the build hash the releases page names', () => {
  const c = { T, plat: 'linux-x64', platName: 'Linux x64', catalogue: cat.metrics, headlines: cat.headlines['linux-x64'], log: () => {},
    forks: [{ tag: 'v0.1.9-perf.8', date: '2026-11-15', platforms: { 'linux-x64': {} } }], release: () => null };
  const fr = P.releaseFragments(c);
  assert.match(fr.hash, /^[0-9a-f]{12}$/);
  for (const f of fr.files) assert.match(f.path, new RegExp(`^releases/v0\\.1\\.9-perf\\.8/(1|50|100|250)\\.${fr.hash}\\.html$`));
  assert.equal(P.releases(c, fr.hash).attrs.frag, fr.hash);
});

test('robots.txt keeps the fragments out of search results and leaves the pages in', async () => {
  const out = mkdtempSync(join(tmpdir(), 't3cp-robots-'));
  try {
    await build({ out, in: join(out, 'no-data-yet'), posts: 'news/posts' });
    assert.ok(existsSync(join(out, 'robots.txt')));
    const robots = readFileSync(join(out, 'robots.txt'), 'utf8');
    assert.match(robots, /^User-agent: \*$/m);
    assert.match(robots, /^Disallow: \/releases\/\*\/\*\.html$/m);
    assert.doesNotMatch(robots, /^Disallow: \/releases\/?$/m);
    const method = readFileSync(join(out, 'methodology/index.html'), 'utf8');
    assert.match(method, /N\/4 pollers, rounded up/);
    assert.match(method, /5 s between turns at 1 agent/);
    assert.doesNotMatch(method, /primary profile/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('the release saturated flag says it once', () => {
  const H = cat.headlines['linux-x64'];
  const deltas = H.map((metric, i) => ({ metric, platform: 'linux-x64', level: cat.metrics.find(m => m.id === metric).scope === 'record' ? 'once' : '250', headline: i + 1, fork: 100, base: 110, delta_pct: 1, threshold_pct: 15, verdict: metric === 'turns_completed' ? 'within' : null, note: metric === 'turns_completed' ? null : 'saturated', saturated: { fork: true, base: false, prev: null } }))
    .concat([{ metric: 'agents_served', platform: 'linux-x64', level: '250', headline: null, fork: 198, base: 250, delta_pct: -20.8, threshold_pct: null, verdict: null, note: null, saturated: { fork: true, base: false, prev: null } }]);
  const rel = { tag: 'v0.1.9-perf.8', date: '2026-11-15', base: { tag: null, date: '2026-11-14', sha: 'd'.repeat(40), sha7: 'ddddddd' }, deltas, charts_only: true, checker: { passed: false } };
  const { html } = releaseHTML(T, rel, { catalogue: cat.metrics, headlines: H, platform: 'linux-x64', level: '250' });
  assert.equal((html.match(/198 of 250/g) || []).length, 1, 'one mention of 198 of 250');
  assert.match(html, /saturated: 198 of 250 agents served/);
});

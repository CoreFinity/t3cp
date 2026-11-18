// Red first: a measured failure shows as one, from what the series publishes (no cause is claimed: the series
// carries none). A level that ran with no valid attempt says "failed: no valid attempt"; a saturated level with no
// value says how many agents were served and that it was not measured, instead of "No record at this level"; one
// valid attempt keeps its phrase. The homepage's compact line and strip name a failure on the newest nightly at the
// selected level instead of falling back to an older nightly with a value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, level, shard } from './build/lib/test-data.mjs';

const T = loadApp();
const strip = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/ ([.,;:)])/g, '$1').trim();
const meta = { ...META.elu, era_start: '2026-10-17' };
// Ten nightlies at 100 agents, 17 to 26 Oct: 18 Oct ran with no valid attempt, 20 Oct saturated with no value
// (63 of 100 agents served), 21 Oct one valid attempt, 23 Oct not run.
function lv10() {
  const lv = level([10, null, 11, null, 10, 11, null, 10, 11, 12]);
  lv.note[1] = 'hollow';
  lv.saturated = Array(10).fill(false); lv.saturated[3] = true;
  lv.n[4] = 1; lv.note[4] = 'hollow'; lv.verdict[4] = null; lv.delta[4] = null;
  return lv;
}
const served = shard('agents_served', { 100: level([100, 100, 100, 63, 100, 100, null, 100, 100, 100]) }, { n: 10 });
const model = (sv = served) => T.model(shard('elu', { 100: lv10() }, { n: 10 }), meta, '100', 0, sv);

test('the tooltip names a failure and a saturated level with no value', () => {
  const M = model();
  assert.equal(strip(T.tipHTML(M, 1)).replace(/^\S+ \S+ \S+ \S+ /, ''), 'failed: no valid attempt');
  assert.match(strip(T.tipHTML(M, 3)), /saturated: 63 of 100 agents served, not measured/);
  assert.doesNotMatch(strip(T.tipHTML(M, 3)), /No record at this level/);
  assert.match(strip(T.tipHTML(M, 4)), /fewer than two valid attempts, no verdict/, 'one valid attempt: unchanged');
  assert.match(strip(T.tipHTML(M, 6)), /No record at this level/, 'a level not run: unchanged');
  assert.match(strip(T.tipHTML(model(null), 3)), /saturated, not measured/, 'without the served counts');
  for (const j of [1, 3]) assert.doesNotMatch(T.tipHTML(M, j), /crash|driver|fewer than two/i, 'no cause the series does not carry');
});

test('the records table lists the failure and the saturated level', () => {
  const t = strip(T.recordsTable(model()));
  assert.match(t, /18 Oct 2026 \S+ – – 0 failed: no valid attempt/);
  assert.match(t, /20 Oct 2026 \S+ – – – saturated: 63 of 100 agents served, not measured/);
  assert.match(t, /21 Oct 2026 [^]*?fewer than two valid attempts, no verdict/);
  assert.doesNotMatch(t, /23 Oct 2026/, 'a level not run is not listed');
});

// The eight headlines at 100 agents; the newest nightly (26 Oct) ran with no valid attempt.
const cat = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
const C = Object.fromEntries(cat.metrics.map(m => [m.id, m])), H = cat.headlines['linux-x64'];
function models(last) {
  return H.map(id => {
    const lv = level([10, 11, 10, 11, 10, 11, 10, 11, 10, last === 'value' ? 14 : null]);
    if (last === 'failed') lv.note[9] = 'hollow';
    return T.model(shard(id, { 100: lv, once: level(Array(10).fill(5)) }, { n: 10 }), { ...C[id], era_start: '2026-10-17' }, T.effLevel(C[id], '100'), 30, null);
  });
}

test('the compact line and the strip name a failure on the newest nightly', () => {
  const Ms = models('failed');
  assert.equal(strip(T.stripFor(H, Ms, C, { level: '100', line: 1 })), 'Nightly 26 Oct 2026, 100 agents: failed, no valid attempt.');
  assert.match(strip(T.stripFor(H, Ms, C, { plat: 'Linux x64', level: '100' })), /^Nightly 26 Oct 2026, 100 agents: failed, no valid attempt\./);
  const notRun = strip(T.stripFor(H, models('not run'), C, { level: '100', line: 1 }));
  assert.match(notRun, /^Nightly 26 Oct 2026, 100 agents: (none|\d+ of 8)/, 'a level not run on the newest nightly is not a failure');
  assert.doesNotMatch(notRun, /failed/);
  assert.match(strip(T.stripFor(H, models('value'), C, { level: '100', line: 1 })), /^Nightly 26 Oct 2026, 100 agents: (none|\d+ of 8)/);
});

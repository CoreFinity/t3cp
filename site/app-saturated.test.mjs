// Red first: a saturated level (the server could not serve every agent) is flagged wherever it appears, as
// "saturated: n of N agents served", with the symptoms in plain words in the flag's tooltip; latency there is
// context only, never a verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, level, passing, published, shard, record } from './build/lib/test-data.mjs';

const T = loadApp();
const SERVED = { id: 'agents_served', name: 'Agents served in the window', short: 'Agents served', unit: 'n', better: 'higher', scope: 'level', era_start: '2026-10-17', na_on: [], empty_cell: false, bands: {} };
const P50 = { ...META.elu, id: 'turn_p50_ms', name: 'Turn end to end p50', unit: 'ms', bands: { 'linux-x64': { band: 17.5, threshold: 22.5, n: 6 } } };

function satShards() {
  const L = level([400, 400, 400, 400, 400, 400, 400, 400, 900, 400], {}, 22.5);
  L.saturated = L.median.map((_, i) => i === 8); L.verdict[8] = null; L.note[8] = 'saturated';
  const S = shard('turn_p50_ms', { 250: L });
  const A = level([250, 250, 250, 250, 250, 250, 250, 250, 210, 250]); A.saturated = L.saturated;
  return { S, served: shard('agents_served', { 250: A }) };
}

test('a saturated point is marked, and its tooltip says how many agents were served', () => {
  const { S, served } = satShards();
  const M = T.model(S, P50, '250', 30, served);
  assert.match(T.tipHTML(M, 8), /saturated: 210 of 250 agents served/);
  assert.doesNotMatch(T.tipHTML(M, 8), /regressed|improved beyond/);
  assert.match(T.tsSVG(M, 640, 320).html, /class="mk mk-sat"/);
  assert.doesNotMatch(T.tipHTML(M, 7), /saturated/);
});

test('compare: a saturated level keeps verdicts for turns and agents served only, with the flag and its symptoms', () => {
  const a = record({ values: { turn_p50_ms: 400, turns_completed: 300, agents_served: 250 } });
  const b = record({ date: '2026-11-15', values: { turn_p50_ms: 900, turns_completed: 200, agents_served: 210 } });
  for (const r of [a, b]) { r.cells['250'] = r.cells['100']; delete r.cells['100']; r.cells['250'].agents_total = 250; r.cells['250'].saturated = r === b; r.cells['250'].attempts = [{ n: 1, valid: true, saturated: r === b, saturated_by: r === b ? ['call_timeouts', 'driver_saturated'] : [], agents_total: 250 }]; }
  const res = T.compare(a, b, { catalogue: [P50, META.turns_completed, SERVED].map(m => published(m)), level: '250', seg: { a: passing({ segment: { 250: 7 }, banded: true }), b: passing({ segment: { 250: 7 }, banded: true }) } });
  const by = Object.fromEntries(res.rows.map(x => [x.id, x]));
  assert.equal(by.turn_p50_ms.verdict, null);
  assert.equal(by.turn_p50_ms.note, 'saturated');
  assert.equal(by.turns_completed.verdict, 'regressed', 'turns keep their verdict at a saturated level');
  const html = T.compareHTML(res, 'A', 'B');
  assert.match(html, /saturated: 210 of 250 agents served/);
  assert.match(html, /title="calls timed out"/, 'the driver falling behind is a defect, not a symptom (Q30a)');
});

test('saturation symptoms in plain words', () => {
  assert.equal(T.satWords(['call_timeouts', 'session_mcp_missing', 'driver_saturated', 'sessions_starved']),
    'calls timed out; MCP not ready by the start of the window; agents not served');
});

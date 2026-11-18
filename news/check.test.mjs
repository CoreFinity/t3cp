// Tests for news/check.mjs: one per checker rule in the order they were written red first, then the rules this
// checker adds. Strings that the public-repo scan forbids are assembled at run time, never written out here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkText as check } from './check.mjs';
import { bundle, goodPost } from './fixtures/bundle.mjs';
import { hostShape } from './fixtures/host-shape.mjs';

const clean = () => [];
const run = (post, b = bundle(), opts = {}) => check(post, b, { scanText: clean, ...opts });
const rules = (r) => r.findings.map((f) => f.rule);
const withSummary = (summary) => ({ ...goodPost(), summary });
const withTitle = (title) => ({ ...goodPost(), title });
const withCaption = (i, caption) => {
  const p = goodPost();
  p.sections[i] = { ...p.sections[i], caption };
  return p;
};
function assertFinding(r, rule) {
  assert.equal(r.passed, false, `expected a failure with ${rule}`);
  assert.ok(rules(r).includes(rule), `expected rule ${rule}, got ${JSON.stringify(r.findings)}`);
}

test('a good post passes with no findings', () => {
  const r = run(goodPost());
  assert.deepEqual(r.findings, []);
  assert.equal(r.passed, true);
});

test('rule: a number not in allowed_numbers fails', () => {
  const r = run(withSummary('Turns completed improved beyond noise at 100 agents: 353 against 318.'));
  assertFinding(r, 'number-not-allowed');
});

test('rule: a number with the wrong unit fails (305 for 305 ms)', () => {
  const r = run(withCaption(5, 'Dispatch p95 within noise at 100 agents: 305 against 318 ms.'));
  assertFinding(r, 'number-unit');
});

test('rule: a sentence naming two metrics fails', () => {
  const r = run(withSummary('Turns completed and Turn time p50 improved beyond noise at 250 agents.'));
  assertFinding(r, 'two-metrics');
});

test('rule: a verdict word of the wrong class fails', () => {
  const r = run(withCaption(5, 'Dispatch p95 improved at 100 agents: 305 ms against 318 ms.'));
  assertFinding(r, 'verdict-class');
});

test('rule: a metric with no verdict mentioned fails', () => {
  const r = run(withSummary('Database ready within noise at 100 agents: 1,840 ms against 1,850 ms.'));
  assertFinding(r, 'metric-no-verdict');
});

test('rule: a banned phrase fails', () => {
  const r = run(withSummary('Turns completed improved significantly at 100 agents: 352 against 318.'));
  assertFinding(r, 'banned');
});

test('rule: an emoji fails', () => {
  const r = run(withTitle('v0.1.9-perf.8: 1 improved, 3 within noise \u{1F680}'));
  assertFinding(r, 'emoji');
});

test('rule: an exclamation mark fails', () => {
  const r = run(withCaption(5, 'Dispatch p95 within noise at 100 agents: 305 ms against 318 ms!'));
  assertFinding(r, 'exclamation');
});

test('rule: a platform claim without a bundle row fails', () => {
  const r = run(withSummary('On macOS, Turns completed improved beyond noise at 100 agents: 352 against 318.'));
  assertFinding(r, 'platform');
});

test('rule: a quotation that is not in the changelog fails', () => {
  const r = run(withCaption(1, 'Writer transaction p95 improved beyond noise: 15.1 ms against 17.2 ms. The changelog says "Reads moved to a new pool."'));
  assertFinding(r, 'quote');
});

test('rule: an internal-name pattern fails, and the finding does not repeat it', () => {
  const host = ['w', 's4'].join('');
  const scanText = (text) => {
    const re = hostShape('g');
    return [...text.matchAll(re)].map((m) => ({ pattern: 'host-name', match: m[0], index: m.index }));
  };
  const r = run(withCaption(5, `Dispatch p95 within noise at 100 agents on ${host}: 305 ms against 318 ms.`), bundle(), { scanText });
  assertFinding(r, 'internal-name');
  assert.ok(!JSON.stringify(r).includes(host), 'a finding must never echo the internal name it found');
});

test('rule: a chart id that does not exist fails', () => {
  const p = goodPost();
  p.sections[5] = { ...p.sections[5], chart_id: 'fork-vs-base.no_such_metric.ladder.linux-x64' };
  assertFinding(run(p), 'chart-id');
});

test('rule: a ninth section fails', () => {
  const b = bundle();
  const ids = b.charts.slice().sort((x, y) => y.size - x.size).slice(0, 9).map((c) => c.id);
  assert.equal(new Set(ids).size, 9);
  const p = { ...goodPost(), sections: ids.map((chart_id) => ({ chart_id, caption: 'Fork against base, from 1 agent to 250 agents.' })) };
  assertFinding(run(p, b), 'sections-max');
});

test('rule: a title over 60 characters fails', () => {
  const title = 'v0.1.9-perf.8: 1 improved, 3 within noise, against its base nightly'.slice(0, 61);
  assert.equal(title.length, 61);
  assertFinding(run(withTitle(title)), 'length');
});

// ---- The remaining rules. ----

test('extra: a verdict word in a sentence with no metric name fails', () => {
  assertFinding(run(withSummary('The fork is faster at 250 agents.')), 'verdict-without-metric');
});

test('extra: a count that does not match the bundle fails', () => {
  assertFinding(run(withTitle('v0.1.9-perf.8: 2 improved, 3 within noise')), 'count');
});

test('extra: counts at a named level are checked against that level', () => {
  const r = run(withTitle('perf.8 at 250 agents: 2 improved, 1 regressed'));
  assert.deepEqual(r.findings, []);
});

test('extra: a duplicate chart id fails', () => {
  const p = goodPost();
  p.sections[1] = { ...p.sections[0] };
  assertFinding(run(p), 'chart-duplicate');
});

test('extra: an unknown key, a missing summary and a wrong type fail the schema', () => {
  assertFinding(run({ ...goodPost(), extra: 'x' }), 'schema');
  const { summary, ...noSummary } = goodPost();
  assertFinding(run(noSummary), 'schema');
  assertFinding(run({ ...goodPost(), sections: 'none' }), 'schema');
  assertFinding(run(null), 'schema');
});

test('extra: a caption over 200 characters and a summary over 400 fail', () => {
  assertFinding(run(withCaption(5, 'Dispatch p95 within noise at 100 agents: 305 ms against 318 ms. ' + 'The chart shows the ladder. '.repeat(6))), 'length');
  assertFinding(run(withSummary('Turns completed improved beyond noise at 100 agents: 352 against 318, +10.7%. '.repeat(6).trim())), 'length');
});

test('extra: a summary of four sentences fails', () => {
  const s = 'Turns completed improved beyond noise at 100 agents. Turn time p50 improved beyond noise at 250 agents. '
    + 'Peak memory regressed beyond noise at 250 agents. Dispatch p95 within noise.';
  assertFinding(run(withSummary(s)), 'summary-sentences');
});

test('extra: a cause without a changelog quote fails', () => {
  assertFinding(run(withCaption(1, 'Writer transaction p95 improved beyond noise because reads use the reader pool.')), 'cause');
});

test('extra: a cause stated through a changelog quote passes', () => {
  const r = run(withCaption(1, 'Writer transaction p95 improved beyond noise after "Reads routed to the reader pool by statement class."'));
  assert.deepEqual(r.findings, []);
});

test('extra: future tense fails', () => {
  assertFinding(run(withSummary('The next build will show the same.')), 'future');
});

test('extra: a number that belongs to another metric fails', () => {
  assertFinding(run(withCaption(5, 'Dispatch p95 within noise at 100 agents: 1,234 ms against 318 ms.')), 'number-unbound');
});

test('extra: a metric number in a sentence that names no metric fails', () => {
  assertFinding(run(withSummary('At 100 agents the fork completed 352 against 318.')), 'number-unbound');
});

test('extra: a number from another level fails', () => {
  assertFinding(run(withCaption(5, 'Dispatch p95 within noise at 100 agents: 640 ms against 655 ms.')), 'number-unbound');
});

test('extra: a caption about a metric other than its chart fails', () => {
  assertFinding(run(withCaption(0, 'Turn time p50 improved beyond noise at 250 agents, −29.4%.')), 'caption-metric');
});

test('extra: sections out of order by the size of the change fail', () => {
  const p = goodPost();
  [p.sections[0], p.sections[5]] = [p.sections[5], p.sections[0]];
  assertFinding(run(p), 'order');
});

test('extra: a missing internal-name scanner fails closed', () => {
  assertFinding(run(goodPost(), bundle(), { scanText: null }), 'scanner-missing');
});

test('extra: a spelled number not in allowed_numbers fails', () => {
  assertFinding(run(withSummary('Turns completed improved beyond noise at 100 agents, nine more.')), 'number-not-allowed');
});

test('extra: a ratio claim fails', () => {
  assertFinding(run(withSummary('Turns completed improved beyond noise at 250 agents, 1.2x the base.')), 'ratio');
  assertFinding(run(withSummary('Turn time p50 improved beyond noise at 250 agents, twice the speed.')), 'ratio');
});

test('extra: a metric named by its id fails', () => {
  assertFinding(run(withSummary('turns_completed improved beyond noise at 100 agents.')), 'metric-by-id');
});

test('extra: markup and links fail', () => {
  assertFinding(run(withSummary('Turns completed improved beyond noise at 100 agents, see https://example.com for more.')), 'markup');
  assertFinding(run(withSummary('**Turns completed** improved beyond noise at 100 agents.')), 'markup');
});

test('extra: a direction word outside the verdict vocabulary fails', () => {
  assertFinding(run(withSummary('Turns completed rose at 100 agents: 352 against 318.')), 'direction-word');
});

test('extra: faster and slower apply only to time metrics', () => {
  assertFinding(run(withCaption(3, 'Peak memory slower at 250 agents, +23.4%.')), 'verdict-class');
});

test('extra: a sentence about the previous release takes the vs-previous verdict', () => {
  assertFinding(run(withSummary('Against perf.7, Turns completed improved beyond noise at 100 agents.')), 'verdict-class');
  const ok = run(withSummary('Against perf.7, Turns completed within noise at 100 agents: 352 against 340, +3.5%.'));
  assert.deepEqual(ok.findings, []);
});

test('extra: a metric that is in the catalogue but not in the bundle fails', () => {
  assertFinding(run(withSummary('Push latency p95 within noise at 100 agents.')), 'metric-no-verdict');
});

test('extra: tags, dates and the year pass through the literal allow-list', () => {
  const r = run(withSummary('Measured on 16 Nov 2026 against v0.1.9-nightly.20261114.4700. Turns completed improved beyond noise at 100 agents: 352 against 318.'));
  assert.deepEqual(r.findings, []);
});

test('extra: an impossible bundle (no allowed numbers) fails every number', () => {
  const b = { ...bundle(), allowed_numbers: [] };
  const r = run(goodPost(), b);
  assert.equal(r.passed, false);
  assert.ok(rules(r).every((x) => x === 'number-not-allowed'), JSON.stringify(rules(r)));
});

test('extra: the result counts numbers and charts for the footer', () => {
  const r = run(goodPost());
  assert.equal(r.numbers_checked, 29);
  assert.equal(r.charts, 6);
});

test('extra: findings are stable and name the field', () => {
  const r = run(withCaption(5, 'Dispatch p95 within noise at 100 agents: 305 ms against 318 ms!'));
  const f = r.findings.find((x) => x.rule === 'exclamation');
  assert.equal(f.field, 'sections[5].caption');
});

test('extra: a metric name that contains numbers is not read as numbers', () => {
  const r = run(withSummary('Seconds with a stall of 40 ms or more within noise at 100 agents: 2.10% against 2.05%.'));
  assert.deepEqual(r.findings, []);
  // title 2, summary 3, captions 4 + 2 + 3 + 3 + 3 + 3.
  assert.equal(r.numbers_checked, 23);
});

test('integration: the repository scanner (tools/t3cp/lib/scan.mjs) passes the good post and flags a host name', async () => {
  const { loadScanner } = await import('./check.mjs');
  const scanText = await loadScanner();
  assert.equal(typeof scanText, 'function', 'tools/t3cp/lib/scan.mjs must load');
  assert.deepEqual(check(goodPost(), bundle(), { scanText }).findings, []);
  const host = ['w', 's4'].join('');
  const r = check(withCaption(5, `Dispatch p95 within noise at 100 agents on ${host}: 305 ms against 318 ms.`), bundle(), { scanText });
  assertFinding(r, 'internal-name');
  assert.ok(!JSON.stringify(r).includes(host));
});

test('extra: markup characters inside a verified changelog quote pass; outside a quote they fail', () => {
  const b = { ...bundle(), changelog: ['A child agent\'s checkpoint capture offers only its own tasks\' cohorts (upstream #34568).'] };
  const quoted = withCaption(1, 'Writer transaction p95 improved beyond noise: 15.1 ms against 17.2 ms. The changelog says "checkpoint capture offers only its own tasks\' cohorts (upstream #34568)."');
  assert.deepEqual(run(quoted, b).findings, []);
  assertFinding(run(withCaption(1, 'Writer transaction p95 improved beyond noise: 15.1 ms against 17.2 ms, see upstream #34568.'), b), 'markup');
});

// ---- One claim row per sentence: (metric, platform, level, comparison), or one level's counts. ----

test('row: a sentence naming two levels binds to two rows and fails', () => {
  assertFinding(run(withCaption(0, 'Turns completed improved beyond noise at 100 agents and at 250 agents: 352 against 318.')), 'row-ambiguous');
});

test('row: a sentence about the base and the previous release at once fails', () => {
  assertFinding(run(withSummary('Against perf.7 and against v0.1.9-nightly.20261114.4700, Peak memory regressed beyond noise at 250 agents.')), 'row-ambiguous');
  assertFinding(run(withSummary('Against perf.7 and its base, Peak memory regressed beyond noise at 250 agents.')), 'row-ambiguous');
});

test('row: a sentence naming two platforms fails', () => {
  assertFinding(run(withSummary('On Linux and macOS, Turns completed improved beyond noise at 100 agents.')), 'row-ambiguous');
});

test('row: a count clause and a metric in one sentence fail', () => {
  assertFinding(run(withSummary('Turns completed improved beyond noise at 100 agents, 1 improved in all.')), 'row-ambiguous');
});

test('row: count clauses at two levels in one sentence fail', () => {
  assertFinding(run(withTitle('perf.8: 1 improved at 100 agents, 2 improved at 250 agents')), 'row-ambiguous');
});

test('row: a sentence with no claim passes, a sentence with one row passes', () => {
  const r = run(withCaption(1, 'Writer transaction p95 improved beyond noise at 250 agents: 22.0 ms against 24.9 ms. The changelog lists "Message ordinals read through an index, not a scan."'));
  assert.deepEqual(r.findings, []);
});

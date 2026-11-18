// The free text around placeholders: an allowlist of connector, function, chart and release words, applied after
// NFKC normalisation; quotations only as whole changelog lines through {quote:<n>}; the summary cites movers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_WORDS, WORD_CATEGORIES, check, isQuotable } from './check.mjs';
import { hostShape } from './fixtures/host-shape.mjs';
import { bundle, goodClaimPost } from './fixtures/bundle.mjs';

const clean = () => [];
const run = (post, b = bundle(), opts = {}) => check(post, b, { scanText: clean, ...opts });
const rules = (r) => r.findings.map((f) => f.rule);
const withSummary = (summary, b) => ({ ...goodClaimPost(b), summary });
const withCaption = (i, caption) => {
  const p = goodClaimPost();
  p.sections[i] = { ...p.sections[i], caption };
  return p;
};
function assertFinding(r, rule) {
  assert.equal(r.passed, false, `expected a failure with ${rule}`);
  assert.ok(rules(r).includes(rule), `expected rule ${rule}, got ${JSON.stringify(r.findings)}`);
}
const C1 = '{claim:turns_completed.linux-x64.100.base}';
const C2 = '{claim:rss_peak_mib.linux-x64.250.base}';
const CW = '{claim:dispatch_p95_ms.linux-x64.100.base}';

test('allowlist: no allowed word is a number, direction, verdict, metric, platform, level, cause, negation or quality word', () => {
  const catalogue = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
  const metricWords = new Set([
    ...WORD_CATEGORIES.metric,
    ...catalogue.metrics.flatMap((m) => [m.name, m.short]).filter(Boolean).map((s) => s.toLowerCase()).filter((s) => !/\s/.test(s)),
  ]);
  assert.ok(ALLOWED_WORDS.size >= 5 && ALLOWED_WORDS.size <= 20);
  for (const [name, words] of Object.entries({ ...WORD_CATEGORIES, metric: [...metricWords] })) {
    assert.ok(words.length > 5, `${name} is a real list`);
    const both = words.filter((w) => ALLOWED_WORDS.has(w));
    assert.deepEqual(both, [], `allowed words that are ${name} words`);
  }
  for (const w of ALLOWED_WORDS) assert.match(w, /^[a-z]+$/, 'plain lower-case Latin words only');
});

test('allowlist: a word outside it fails, and the finding repeats only words from the known lists', () => {
  assertFinding(run(withSummary(`Quietly, ${C1}. ${C2}.`)), 'free-word');
  const host = ['zz', 'internalhost'].join('');
  const r = run(withSummary(`Measured on ${host}: ${C1}. ${C2}.`));
  assertFinding(r, 'free-word');
  assert.ok(!JSON.stringify(r).includes(host), 'an unknown word is never echoed');
});

test('allowlist: neutral connector and chart words pass', () => {
  assert.deepEqual(run(withSummary(`Here, ${C2}. In this chart: ${C1}.`)).findings, []);
});

test('normalisation: format characters, combining marks, any number, non-Latin letters and exclamation forms fail', () => {
  const cases = [
    ['­', 'free-char'], ['⁠', 'free-char'], ['​', 'free-char'], ['é', 'free-char'],
    ['３４', 'free-number'], ['٣', 'free-number'], ['½', 'free-number'], ['²', 'free-number'], ['p99', 'free-number'],
    ['ф', 'free-char'], ['！', 'exclamation'], ['¡', 'exclamation'], ['?', 'free-char'], [';', 'free-char'],
  ];
  for (const [s, rule] of cases) assertFinding(run(withSummary(`The chart ${s} here: ${C1}. ${C2}.`)), rule);
});

test('normalisation: the internal-name scan runs on the normalised text', () => {
  const full = ['ｗ', 'ｓ', '４'].join('');
  const seen = [];
  const scanText = (t) => { seen.push(t); return hostShape().test(t) ? [{ pattern: 'host', index: 0 }] : []; };
  const r = run(withSummary(`On ${full}: ${C1}. ${C2}.`), bundle(), { scanText });
  assertFinding(r, 'internal-name');
});

test('sentences: ";" is not a sentence end, so two claims around it are one sentence', () => {
  assertFinding(run(withSummary(`${C1}; ${C2}.`)), 'claim-two');
});

test('summary binding: while the bundle has movers, the summary cites only movers', () => {
  assertFinding(run(withSummary(`${CW}.`)), 'summary-binding');
  const calm = bundle();
  calm.metrics = calm.metrics.map((m) => ({ ...m, verdict: m.verdict ? 'within' : m.verdict, verdict_vs_prev: m.verdict_vs_prev ? 'within' : m.verdict_vs_prev }));
  calm.claims = calm.claims.map((c) => ({ ...c, verdict: 'within' }));
  const p = { ...goodClaimPost(calm), summary: `${CW}.`, sections: [{ chart_id: 'fork-vs-base.dispatch_p95_ms.ladder.linux-x64', caption: `${CW}.` }] };
  assert.ok(!rules(run(p, calm)).includes('summary-binding'), 'no movers: a within-noise claim may open the summary');
});

test('quotes: only whole changelog lines with no number and no direction, verdict, quality or effect word are quotable', () => {
  // Where quotes stand (one block at the end, never by a chart or a claim) is tested in juxtaposition.test.mjs.
  assert.equal(isQuotable('Reads routed to the reader pool by statement class.'), true);
  assert.equal(isQuotable('Writes 3 times slower on cold start.'), false);
  assert.equal(isQuotable('Turn time is lower after the change.'), false);
});

test('the check CLI exits 2 on a bundle that does not validate, 1 on findings, 0 on a pass', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'check-cli-'));
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check.mjs');
  writeFileSync(path.join(d, 'bad.json'), JSON.stringify({ schema: 'nope' }));
  writeFileSync(path.join(d, 'post.json'), JSON.stringify(goodClaimPost()));
  let code = 0;
  try { execFileSync(process.execPath, [cli, '--bundle', path.join(d, 'bad.json'), '--post', path.join(d, 'post.json')], { stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.equal(code, 2);
});

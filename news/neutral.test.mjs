// The connecting vocabulary cannot make or redirect a claim. Every allowed word must be in NEUTRAL below, with
// the reason it carries no subject, scope or comparison; a generated test prefixes every allowed word, alone and
// in every ordered pair, to a claim of each comparison, and any sentence the checker lets through may hold only
// neutral words. Subject, scope and comparison words are listed to keep them out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_WORDS, check, isQuotable } from './check.mjs';
import { bundle, goodClaimPost } from './fixtures/bundle.mjs';

const NEUTRAL = {
  the: 'article', a: 'article', an: 'article', this: 'points at the chart beside it', here: 'points at the chart beside it',
  in: 'locates within a chart', chart: 'the figure itself', charts: 'the figures themselves', ladder: 'a chart kind', series: 'a chart kind',
};
const SUBJECT_SCOPE_COMPARISON = ['release', 'releases', 'fork', 'base', 'upstream', 'nightly', 'nightlies', 'previous', 'agent', 'agents',
  'record', 'records', 'linux', 'macos', 'each', 'both', 'these', 'all', 'every', 'also', 'only', 'for', 'per', 'against', 'versus', 'vs',
  'compared', 'measured', 'show', 'shows', 'with', 'from', 'to', 'of', 'on', 'at', 'and', 'or', 'than', 'its', 'their'];

const clean = () => [];
const C_BASE = '{claim:turns_completed.linux-x64.100.base}';
const C_PREV = '{claim:rss_peak_mib.linux-x64.250.prev}';
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const summaryWith = (text) => {
  const b = bundle();
  return check({ ...goodClaimPost(b), summary: text }, b, { scanText: clean });
};

test('neutral: every allowed word is in the neutral table with a reason, and none is a subject, scope or comparison word', () => {
  for (const w of ALLOWED_WORDS) assert.ok(NEUTRAL[w], `${w} is allowed but has no neutral reason`);
  for (const w of Object.keys(NEUTRAL)) assert.ok(!SUBJECT_SCOPE_COMPARISON.includes(w), `${w} is a subject, scope or comparison word`);
  for (const w of SUBJECT_SCOPE_COMPARISON) assert.ok(!ALLOWED_WORDS.has(w), `${w} must not be allowed`);
});

test('neutral: every allowed word alone and in every ordered pair, before a claim of each comparison, passes only as neutral', () => {
  const words = [...ALLOWED_WORDS];
  const prefixes = [...words.map((w) => [w]), ...words.flatMap((a) => words.map((b) => [a, b]))];
  // Each sentence sits in an otherwise valid summary (the regressed metric cited, largest change first), so only
  // the words under test decide.
  const C_REG_BASE = '{claim:rss_peak_mib.linux-x64.250.base}';
  let checked = 0;
  let passed = 0;
  for (const [claim, rest] of [[C_REG_BASE, ` ${C_BASE}.`], [C_PREV, ` ${C_BASE}.`]]) {
    for (const p of prefixes) {
      for (const text of [`${cap(p.join(' '))} ${claim}.${rest}`, `${cap(p.join(' '))}: ${claim}.${rest}`, `${claim}, ${p.join(' ')}.${rest}`]) {
        const r = summaryWith(text);
        checked += 1;
        if (r.passed) {
          passed += 1;
          assert.ok(p.every((w) => NEUTRAL[w]), `${text} passed with a word outside the neutral table`);
        }
      }
    }
  }
  assert.ok(checked > 300);
  assert.ok(passed > 0, 'some neutral sentences pass: the test is not vacuous');
});

test('glue: a placeholder needs a space or punctuation on both sides', () => {
  const r1 = summaryWith(`{claim:rss_peak_mib.linux-x64.250.base}a. ${C_BASE}.`);
  assert.equal(r1.passed, false);
  const r2 = summaryWith(`Here{claim:rss_peak_mib.linux-x64.250.base}. ${C_BASE}.`);
  assert.equal(r2.passed, false);
});

test('a summary with no claim fails while the bundle has movers', () => {
  const r = summaryWith('Here in this chart.');
  assert.ok(!summaryWith('{claim:rss_peak_mib.linux-x64.250.base}. {claim:turns_completed.linux-x64.100.base}.').findings.length);
  assert.ok(r.findings.some((f) => f.rule === 'summary-binding'), JSON.stringify(r.findings));
});

test('quotes stand in captions only, never in the summary', () => {
  const r = summaryWith(`${C_BASE}. {quote:1}`);
  assert.ok(r.findings.some((f) => f.rule === 'quote'), JSON.stringify(r.findings));
});

test('quotable lines: no comparative or superlative, no quantity word; known -er nouns stay quotable', () => {
  for (const line of ['Writes are snappier now.', 'Dispatch is zippier.', 'Doubles the reader pool.', 'Turns finish in a handful of steps.',
    'Startup is quieter.', 'The newest scheduler.', 'Several threads move.', 'Most reads move to the pool.', 'Turns end later.']) {
    assert.equal(isQuotable(line), false, line);
  }
  for (const line of ['Reads routed to the reader pool by statement class.', 'The scheduler hands the poller to a worker.',
    'Message ordinals read through an index, not a scan.', 'The spawner owns the provider request.']) {
    assert.equal(isQuotable(line), true, line);
  }
});

test('characters that NFKC would change (superscript or full-width letters) fail outside placeholders', () => {
  const r = summaryWith(`ᵗʰᵉ chart ${C_BASE}.`);
  assert.ok(r.findings.some((f) => f.rule === 'free-char'), JSON.stringify(r.findings));
});

test('every committed news/posts file validates as a post source (the CI step: node --test runs this)', async () => {
  const { readSource } = await import('../site/build/release-post.mjs');
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'posts');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  for (const f of files) assert.doesNotThrow(() => readSource(path.join(dir, f), f.slice(0, -5)), f);
  assert.ok(files.every((f) => /^v\d+\.\d+\.\d+-perf\.\d+\.json$/.test(f)), 'file names are fork tags');
});

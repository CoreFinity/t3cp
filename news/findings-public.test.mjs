// A refused post's findings are committed (news/posts/<tag>.json) and, for a charts-only release, were copied into
// the published releases/<tag>.json. What the checker refused must never be published by the record of its
// refusal: a finding keeps only its rule id, field, sentence index and position, never the matched text (no
// token, no detail, no pattern), and a release carries no findings at all (the footer gives their count).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPostBundle } from '../site/build/release-bundle.mjs';
import { source } from '../site/build/release-fixtures/source.mjs';
import { cleanFinding, renderRelease, runPost } from '../site/build/release-post.mjs';
import { validate } from '../tools/t3cp/lib/validate.mjs';

const json = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
const catalogue = json('catalogue/catalogue.json');
// Invented: a host-like name, a figure with its unit, an address from a documentation range.
const NAME = 'Zorbelhost';
const FIGURE = '98765';
const ADDRESS = '203.0.113.9';
const scanText = (t) => [...String(t).matchAll(/zorbelhost/gi)].map((m) => ({ pattern: 'private_host', index: m.index }));
const refused = (b, verb = 'answered') => ({ bundle_sha256: b.bundle_sha256, summary: `${NAME} ${verb} in ${FIGURE} ms from ${ADDRESS} today.`, sections: [] });

// Every string leaf and key of a JSON file, and whether any of them carries a trace of the refused text: the name,
// the figure or the address, whole or as the digits a per-character token would list.
function traces(file) {
  const text = readFileSync(file, 'utf8');
  const found = [];
  const walk = (v, p) => {
    if (typeof v === 'string') {
      if (new RegExp(NAME, 'i').test(v)) found.push(`${p}: name`);
      if (/(?<![0-9a-f])98765(?![0-9a-f])/.test(v)) found.push(`${p}: figure`);
      if (/203\.0\.113|113\.9/.test(v)) found.push(`${p}: address`);
      if (/^U\+00[3][0-9]$/.test(v)) found.push(`${p}: a digit token`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (['token', 'detail', 'pattern'].includes(k)) found.push(`${p}.${k}: a text field`); walk(x, `${p}.${k}`); }
  };
  walk(JSON.parse(text), '$');
  return found;
}

test('a refused name, figure and address leave no trace in the committed source file or the published release', async () => {
  const b = buildPostBundle(source(), { catalogue });
  const root = mkdtempSync(path.join(tmpdir(), 'findings-'));
  const postsDir = path.join(root, 'posts');
  const first = await runPost({ bundle: b, post: refused(b), postsDir, scanText, repoRoot: root });
  assert.equal(first.status, 'retry', first.message);
  // The run that reports them still sees the findings (the retry sends them back to the writer).
  assert.ok(first.result.findings.some((f) => f.rule === 'internal-name'));
  assert.ok(first.result.findings.some((f) => f.rule === 'free-number'));
  const second = await runPost({ bundle: b, post: refused(b, 'replied'), postsDir, scanText, repoRoot: root });
  assert.equal(second.status, 'charts-only', second.message);
  assert.deepEqual(traces(second.file), []);
  const src = JSON.parse(readFileSync(second.file, 'utf8'));
  for (const a of src.attempts) for (const f of a.findings) assert.deepEqual(Object.keys(f).filter((k) => !['rule', 'field', 'sentence', 'index'].includes(k)), [], JSON.stringify(f));
  const rel = renderRelease({ bundle: b, source: src, scanText });
  assert.equal(rel.charts_only_reason, 'checker_failed');
  assert.deepEqual(rel.checker.findings, []);
  assert.match(rel.checker.footer, /\(\d+ findings\)/);
  const out = path.join(root, 'release.json');
  (await import('node:fs')).writeFileSync(out, JSON.stringify(rel));
  assert.deepEqual(traces(out), []);
});

test('a stale release carries no findings either', async () => {
  const b = buildPostBundle(source(), { catalogue });
  const root = mkdtempSync(path.join(tmpdir(), 'findings-'));
  const ok = { bundle_sha256: b.bundle_sha256, summary: `{claim:${b.claims[0].id}}.`, sections: [] };
  const src = { schema: 't3cp/post-source/1', synthetic: true, tag: b.release.tag, status: 'passed', post: refused(b), changelog: [],
    checker: { n: 1, passed: true, version: 'x', written_in_session: true, findings: [], numbers_checked: 0, charts: 0, bundle_sha256: b.bundle_sha256, post_sha256: 'a'.repeat(64), checked_at: '2026-11-17T00:00:00.000Z' }, attempts: [] };
  void ok; void root;
  let rel;
  try { rel = renderRelease({ bundle: b, source: src, scanText }); } catch (e) { rel = null; assert.doesNotMatch(String(e.message), /zorbel|98765|203\.0\.113/i); }
  if (rel) {
    assert.equal(rel.charts_only_reason, 'stale');
    assert.deepEqual(rel.checker.findings, []);
  }
});

test('cleanFinding keeps rule, field, sentence and position only', () => {
  const f = cleanFinding({ rule: 'free-number', field: 'summary', sentence: 0, index: 7, token: '98765', detail: `${FIGURE} ms`, pattern: 'private_x', match: NAME });
  assert.deepEqual(f, { rule: 'free-number', field: 'summary', sentence: 0, index: 7 });
  assert.deepEqual(cleanFinding({ rule: 'Not A Rule', field: 'elsewhere', index: -1 }), { rule: 'other', field: 'post' });
});

test('the schemas forbid a finding text field: no token, detail or pattern in the source, no findings in a release', () => {
  const sourceSchema = json('news/post-source-1.json');
  const releaseSchema = json('schema/release-1.json');
  const items = sourceSchema.$defs.attempt.properties.findings.items;
  assert.deepEqual(Object.keys(items.properties).sort(), ['field', 'index', 'rule', 'sentence']);
  assert.equal(items.additionalProperties, false);
  assert.equal(releaseSchema.properties.checker.properties.findings.maxItems, 0);
  // A finding with a token does not validate as a source attempt.
  const errors = validate({ ...sourceSchema, $ref: '#/$defs/attempt' }, { n: 1, passed: false, version: 'x', findings: [{ rule: 'free-number', field: 'summary', token: '98765' }] });
  assert.ok(errors.some((e) => /token|additional/i.test(`${e.path} ${e.message}`)), JSON.stringify(errors.slice(0, 3)));
});

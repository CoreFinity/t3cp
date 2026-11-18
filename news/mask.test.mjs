// A number the post takes from the bundle is measured data, so a private VALUE-class pattern (a production
// figure) never refuses it. Masking applies to a values list passed in deliberately (scanValues) and to nothing
// else: before that scan every numeric token whose value is a number in the bundle is masked. The names list
// (scanText: names, paths and other) always scans the text as written, so a name that contains a bundle number
// is never masked away. Generated text gets no values list at all. JSON number leaves of pipeline data (a source
// file's token counts, a release's deltas) are never scanned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, checkText, maskBundleNumbers } from './check.mjs';
import { bundle, goodClaimPost } from './fixtures/bundle.mjs';

// Stand-ins for the two private lists: one value pattern (a production figure) and name/path/other patterns,
// one of them a word with a number that is also a bundle number.
const scanner = (list) => (t) => list.flatMap(([pattern, re]) => [...String(t).matchAll(re)].map((m) => ({ pattern, index: m.index })));
const scanValues = scanner([['private_94', /(?<![\p{L}\p{N},.])8,?513(?![\p{L}\p{N},])/gu]]);
const scanText = scanner([['private_host', /secret-host-4/g], ['private_path', /\/srv\/private\/8513/g], ['private_word_number', /memory at 250/gi]]);
const rules = (r) => r.findings.map((f) => `${f.rule}:${f.pattern ?? ''}`);

// The test bundle with peak memory at 250 agents measured at 8,513 MiB (an invented value that equals the figure).
function bundleWith8513() {
  const b = bundle();
  b.metrics = b.metrics.map((m) => (m.id === 'rss_peak_mib' && m.level === '250' ? { ...m, text: { ...m.text, fork: '8,513 MiB' }, value: { ...m.value, fork: 8513 } } : m));
  b.allowed_numbers = [...b.allowed_numbers, '8,513 MiB', '8,513'].sort();
  return b;
}

test('a post citing 8,513 from a bundle that has 8,513 passes the values scan (the number is masked first)', () => {
  const b = bundleWith8513();
  const r = check(goodClaimPost(b), b, { scanText: scanner([]), scanValues });
  assert.ok(r.rendered.summary.includes('8,513 MiB'), r.rendered.summary);
  assert.deepEqual(rules(r).filter((x) => x.startsWith('internal-name')), [], JSON.stringify(r.findings));
});

test('8513 in text whose bundle has no 8513 is still refused', () => {
  const b = bundle();
  const r = checkText({ title: 'v0.1.9-perf.8: a title', summary: 'Peak RSS at 250 agents: 8513 MiB.', sections: [] }, b, { scanText: scanner([]), scanValues });
  assert.ok(rules(r).includes('internal-name:private_94'), JSON.stringify(r.findings));
});

test('a name pattern containing a bundle number is never masked away', () => {
  const b = bundleWith8513();
  // The rendered summary names peak memory at 250 agents; 250 is a bundle number (a level).
  const ok = check(goodClaimPost(b), b, { scanText: scanner([]), scanValues });
  assert.ok(ok.rendered.summary.includes('Peak memory at 250 agents'), ok.rendered.summary);
  const r = check(goodClaimPost(b), b, { scanText, scanValues });
  assert.ok(rules(r).includes('internal-name:private_word_number'), JSON.stringify(r.findings));
});

test('masking runs only for a values list passed in deliberately: the names list always scans the text as written', async () => {
  const b = bundleWith8513();
  // The value pattern handed over as if it were the names list: nothing is masked for it, so it hits.
  const r = check(goodClaimPost(b), b, { scanText: scanValues });
  assert.ok(rules(r).includes('internal-name:private_94'), JSON.stringify(r.findings));
  const { renderRelease } = await import('../site/build/release-post.mjs');
  const built = await builtWith8513();
  assert.throws(() => renderRelease({ bundle: built, source: null, scanText: scanValues }), /internal-name scan/);
});

test('a name or path pattern is never masked, even when its digits are bundle numbers', () => {
  const b = bundleWith8513();
  assert.equal(maskBundleNumbers('see secret-host-4 and /srv/private/8513 next to 8,513 MiB and 8513', b), 'see secret-host-4 and /srv/private/8513 next to ##### MiB and ####');
  const r = checkText({ title: 'v0.1.9-perf.8: a title', summary: 'From secret-host-4 at /srv/private/8513.', sections: [] }, b, { scanText });
  assert.ok(rules(r).includes('internal-name:private_host'));
  assert.ok(rules(r).includes('internal-name:private_path'));
});

test('masking takes only whole numeric tokens: not a part of a dotted, dashed or longer number', () => {
  const b = bundleWith8513();
  assert.equal(maskBundleNumbers('10.8513.1 and 8513.5 and 28513 and 2026-8513 and v8513 and 8,5130', b), '10.8513.1 and 8513.5 and 28513 and 2026-8513 and v8513 and 8,5130');
  assert.equal(maskBundleNumbers('+23.4% and −1.0% and 8,513.', b), '+####% and −###% and #####.');
});

// A real post bundle (site/build/release-bundle.mjs) whose peak memory at 250 agents is 8,513 MiB.
async function builtWith8513() {
  const { buildPostBundle } = await import('../site/build/release-bundle.mjs');
  const { source } = await import('../site/build/release-fixtures/source.mjs');
  const { readFileSync } = await import('node:fs');
  const catalogue = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
  const src = source();
  src.metrics = src.metrics.map((m) => (m.id === 'rss_peak_mib' && m.level === '250' ? { ...m, fork: { ...m.fork, median: 8513 }, text: { ...m.text, fork: '8,513 MiB' } } : m));
  return buildPostBundle(src, { catalogue, headline: '100' });
}

test('the source file is never refused for a JSON number (token counts are pipeline data)', async () => {
  const { runPost } = await import('../site/build/release-post.mjs');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const b = await builtWith8513();
  const root = mkdtempSync(path.join(tmpdir(), 'mask-'));
  const post = { bundle_sha256: b.bundle_sha256, summary: `{claim:${b.claims[0].id}}.`, sections: [] };
  const r = await runPost({ bundle: b, post, provenance: { prompt_sha256: 'e'.repeat(64), model: 'claude-opus-5-5', usage: { input_tokens: 48513, output_tokens: 8513 } }, postsDir: path.join(root, 'posts'), scanText, scanValues, repoRoot: root });
  assert.notEqual(r.status, 'refused', r.message);
  assert.match(readFileSync(r.file, 'utf8'), /"output_tokens": 8513/);
});

test('the release file is never refused for a bundle number, as a JSON number or in its display string', async () => {
  const { renderRelease } = await import('../site/build/release-post.mjs');
  const b = await builtWith8513();
  const rel = renderRelease({ bundle: b, source: null, scanText, scanValues });
  const rss = rel.deltas.find((d) => d.metric === 'rss_peak_mib' && d.level === '250');
  assert.equal(rss.fork, 8513);
  assert.equal(rss.text.fork, '8,513 MiB');
});

// The shape of a real names-list pattern with a number in it: an invented word, a space, a number that the bundle
// also holds (here a level, 100 or 250). Masking never touches the names list, so it hits through every path.
const wordNumber = (n) => scanner([['private_word_number', new RegExp(`\\bzorbel ${n}\\b|\\bat ${n}\\b`, 'gi')]]);

test('a "<word> <number>" name whose number is in the bundle hits through check() and checkText()', () => {
  const b = bundleWith8513();
  assert.ok(rules(check(goodClaimPost(b), b, { scanText: wordNumber(250), scanValues })).includes('internal-name:private_word_number'));
  const r = checkText({ title: 'v0.1.9-perf.8: a title', summary: 'Seen from zorbel 250 today.', sections: [] }, b, { scanText: wordNumber(250), scanValues });
  assert.ok(rules(r).includes('internal-name:private_word_number'), JSON.stringify(r.findings));
});

test('a "<word> <number>" name whose number is in the bundle hits through renderRelease (scanJson of the release)', async () => {
  const { renderRelease } = await import('../site/build/release-post.mjs');
  const b = await builtWith8513();
  assert.ok(b.levels.includes('100'));
  assert.doesNotThrow(() => renderRelease({ bundle: b, source: null, scanText: scanner([]), scanValues }));
  assert.throws(() => renderRelease({ bundle: b, source: null, scanText: wordNumber(100), scanValues }), /internal-name scan/);
});

test('runPost\'s source-file scan never masks: every string leaf it writes was scanned exactly as written', async () => {
  const { runPost } = await import('../site/build/release-post.mjs');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const b = await builtWith8513();
  const seen = new Set();
  const spy = (t) => { seen.add(String(t)); return []; };
  const root = mkdtempSync(path.join(tmpdir(), 'mask-'));
  const post = { bundle_sha256: b.bundle_sha256, summary: `{claim:${b.claims[0].id}}.`, sections: [] };
  const r = await runPost({ bundle: b, post, provenance: { prompt_sha256: 'e'.repeat(64), model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 250 } }, postsDir: path.join(root, 'posts'), scanText: spy, scanValues, repoRoot: root });
  assert.notEqual(r.status, 'refused', r.message);
  const leaves = [];
  const walk = (v) => { if (typeof v === 'string') leaves.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(JSON.parse(readFileSync(r.file, 'utf8')));
  assert.ok(leaves.some((l) => /\d/.test(l)), 'some written string holds digits');
  for (const l of leaves) assert.ok(seen.has(l), `scanned as written: ${l.slice(0, 40)}`);
});

test('the bundle-build scan of changelog lines never masks: a "<word> <number>" name in a line is refused', async () => {
  const { buildPostBundle } = await import('../site/build/release-bundle.mjs');
  const { source } = await import('../site/build/release-fixtures/source.mjs');
  const { readFileSync } = await import('node:fs');
  const catalogue = JSON.parse(readFileSync(new URL('../catalogue/catalogue.json', import.meta.url), 'utf8'));
  assert.throws(() => buildPostBundle(source(), { catalogue, changelog: ['Faster dispatch, seen first on zorbel 100.'], scanText: wordNumber(100) }), /internal-name scan/);
  assert.doesNotThrow(() => buildPostBundle(source(), { catalogue, changelog: ['Faster dispatch.'], scanText: wordNumber(100) }));
});

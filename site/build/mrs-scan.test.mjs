// Tests for the forbidden-pattern scan in the MRs build (tools/t3cp/lib/scan.mjs over every title and url): a
// title with an internal pattern fails the build, with the pattern named, before anything is published.
//
// The planted strings are joined at run time from pieces so that this file itself passes the repository's scan.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as mrs from './mrs.mjs';
import { scanText } from '../../tools/t3cp/lib/scan.mjs';
import { renderMrsPart } from './mrs-render.mjs';
import { NOW, pr, page, json, stubFetch, previousDoc, tempDir, runCli, removeTempDirs } from './mrs-testkit.mjs';

after(removeTempDirs);

const j = (...pieces) => pieces.join('');
const options = (over) => ({ now: () => NOW, retryDelayMs: 0, timeoutMs: 2000, log: () => {}, ...over });
const isForbidden = (pattern, number) => (e) => {
  assert.equal(e.code, 'T3CP_FORBIDDEN_PATTERN', e.stack);
  assert.ok(e.patterns.includes(pattern), `${pattern} in ${e.patterns}`);
  assert.equal(e.number, number);
  assert.match(e.message, new RegExp(`forbidden pattern .*${pattern}.*#${number}`));
  return true;
};

// [pattern id in the public list of tools/t3cp/lib/scan.mjs, planted text]: one per family, to show the wiring;
// the list itself is tested where it lives. Concrete names (people, reviewers) are on the private list only.
const planted = [
  ['host_ws', j('w', 's4')],
  ['host_local', j('build', '.lo', 'cal')],
  ['path_users', j('/Us', 'ers/x')],
  ['ip_v4', j('10.', '1.2.3')],
  ['email', j('someone', '@', 'corp', '.io')],
  ['gcp_region', j('europe', '-west2')],
  ['task_id', j('P', '2-026')],
  ['decision_id', j('A', '148')],
];

test('a forbidden pattern in a fetched title fails the build, names the pattern, and leaves the file alone', async () => {
  const dir = await tempDir();
  const out = join(dir, 'mrs.json');
  const before = `${JSON.stringify(previousDoc())}\n`;
  await writeFile(out, before);
  const fetch = stubFetch(() => json(page([
    pr(76, 'open', '2026-11-15T08:00:00Z'),
    pr(77, 'merged', '2026-11-14T08:00:00Z', `fix(server): a stall seen on ${j('w', 's4')}`),
  ])));
  await assert.rejects(mrs.buildMrs(options({ out, fetch })), isForbidden('host_ws', 77));
  assert.equal(await readFile(out, 'utf8'), before);
});

test('a planted title from each pattern family fails the build', async () => {
  for (const [pattern, text] of planted) {
    const fetch = stubFetch(() => json(page([pr(88, 'open', '2026-11-15T08:00:00Z', `fix: ${text} here`)])));
    const out = join(await tempDir(), 'mrs.json');
    await assert.rejects(mrs.buildMrs(options({ out, fetch })), isForbidden(pattern, 88), `${pattern} for a planted title`);
  }
});

test('ordinary upstream titles pass', async () => {
  const titles = [
    'fix(codex): keep the session alive after a reconnect',
    'chore(deps): bump effect@3.19.2 and vite from 7.1.0 to 7.2.1',
    'fix(web): a11y labels on the thread list',
    'perf(server): 10.5% fewer allocations per turn on Node 22.11.0',
    'fix(ws): reconnect the websocket with backoff; ws2812 is not a host',
    'perf(server): A/B the snapshot path; P2P sync stays off',
    'fix(ui): SolidJS-style signals, Solid rendering, home page, mount the volume, inventory sync, Q&A',
    'docs: Claude Code integration notes',
  ];
  const fetch = stubFetch(() => json(page(titles.map((t, i) => pr(500 + i, 'open', '2026-11-15T08:00:00Z', t)))));
  const result = await mrs.buildMrs(options({ out: join(await tempDir(), 'mrs.json'), fetch }));
  assert.equal(result.stale, false);
  assert.equal(result.doc.items.length, titles.length);
});

test('the kept list is scanned too: a forbidden title in the previous file fails a stale build', async () => {
  const out = join(await tempDir(), 'mrs.json');
  const doc = previousDoc();
  doc.items[1].title = `perf(server): measured under ${j('P', '2-003')}`;
  await writeFile(out, JSON.stringify(doc));
  const fetch = stubFetch(() => new Response('', { status: 503 }));
  await assert.rejects(mrs.buildMrs(options({ out, fetch })), isForbidden('task_id', 11));
});

test('the private list (T3CP_PRIVATE_PATTERNS) applies to the build, and its expressions are never printed', async () => {
  const dir = await tempDir();
  const name = j('Ex', 'ample', 'person');
  const list = join(dir, 'private-patterns.txt');
  await writeFile(list, `# one expression per line\n${j('ex', 'ample', 'pers', 'on')}\n`);
  const out = join(dir, 'mrs.json');
  const { code, stderr } = await runCli(['--out', out, '--retry-delay-ms', '0'], (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(page([pr(92, 'open', '2026-11-13T08:00:00Z', `fix: thanks to ${name}`)])));
  }, { T3CP_PRIVATE_PATTERNS: list });
  assert.equal(code, 1, stderr);
  assert.match(stderr, /forbidden pattern private_1 in the title of pull request #92/);
  assert.ok(!stderr.toLowerCase().includes(name.toLowerCase()), 'neither the matched text nor the expression is printed');
  await assert.rejects(readFile(out), { code: 'ENOENT' });
});

test('the command line exits 1 naming the pattern and the pull request, without echoing the matched text', async () => {
  const out = join(await tempDir(), 'mrs.json');
  const secret = j('build', '-01.lo', 'cal');
  const { code, stderr } = await runCli(['--out', out, '--retry-delay-ms', '0'], (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(page([pr(91, 'closed', '2026-11-13T08:00:00Z', `fix: cache on ${secret}`)])));
  });
  assert.equal(code, 1, stderr);
  assert.match(stderr, /forbidden pattern host_local/);
  assert.match(stderr, /#91/);
  assert.ok(!stderr.includes(secret), 'the matched text is not printed');
  await assert.rejects(readFile(out), { code: 'ENOENT' });
});

test('every top-level string is scanned too, the author query included', () => {
  const doc = { ...previousDoc(), source_query: `repo:pingdotgg/t3code author:x type:pr ${j('w', 's4')}` };
  assert.throws(() => mrs.scanDoc(doc), (e) => {
    assert.equal(e.code, 'T3CP_FORBIDDEN_PATTERN');
    assert.ok(e.patterns.includes('host_ws'), e.patterns);
    assert.equal(e.field, 'source_query');
    assert.match(e.message, /forbidden pattern .*host_ws.* in the source_query field/);
    return true;
  });
  assert.doesNotThrow(() => mrs.scanDoc(previousDoc()), 'the real author query passes the scan');
});

test('the MRs files, the schema, a built mrs.json and the rendered parts pass the scan themselves', async () => {
  const here = new URL('./', import.meta.url);
  const names = (await readdir(here)).filter((n) => n.startsWith('mrs')).sort();
  assert.ok(names.length >= 7, names.join(' '));
  const sources = [...names.map((n) => [n, new URL(n, here)]), ['schema/mrs-1.json', new URL('../../schema/mrs-1.json', here)]];
  const texts = await Promise.all(sources.map(async ([name, url]) => [name, await readFile(url, 'utf8')]));
  // A built file large enough to be trimmed, so the rendered part carries the author-query link as well.
  const all = Array.from({ length: 400 }, (_, i) => pr(3000 + i, ['open', 'merged', 'closed'][i % 3],
    new Date(Date.UTC(2026, 10, 15) - i * 3600e3).toISOString().replace('.000', ''), `perf(server): ${'a long synthetic title '.repeat(8)}${i}`));
  const fetch = stubFetch((url) => {
    const n = Number(new URL(url).searchParams.get('page'));
    return json(page(all.slice((n - 1) * 100, n * 100), all.length));
  });
  const out = join(await tempDir(), 'mrs.json');
  const built = await mrs.buildMrs(options({ out, fetch }));
  assert.ok(built.doc.omitted > 0);
  texts.push(['built mrs.json', await readFile(out, 'utf8')]);
  const trimmed = renderMrsPart(built.doc);
  assert.match(trimmed, /pulls\?q=is%3Apr\+author%3A/);
  texts.push(['rendered part with omitted items', trimmed]);
  texts.push(['rendered stale part', renderMrsPart({ ...previousDoc(), stale: true })]);
  texts.push(['rendered empty part', renderMrsPart(null)]);
  for (const [name, text] of texts) {
    text.split('\n').forEach((line, i) => {
      const hits = scanText(line, { env: false });
      assert.deepEqual(hits.map((h) => h.pattern), [], `${name}:${i + 1}`);
    });
  }
});

// Tests for the MRs build step (t3cp/mrs/2): the fork author's pull requests AND issues on upstream, from two search
// queries; fetch, pagination, the stale fallback, the one-time t3cp/mrs/1 migration, the schema and the 32 KB budget.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import * as mrs from './mrs.mjs';
import { NOW, API_PREFIX, ISSUE_PREFIX, QUERY, QUERIES, prLink, issueLink, pr, issue, page, json, stubFetch, routed, queryKind, previousDoc, previousDocV1, tempDir, runCli, removeTempDirs } from './mrs-testkit.mjs';

after(removeTempDirs);

const loadSchema = async () => JSON.parse(await readFile(new URL('../../schema/mrs-2.json', import.meta.url), 'utf8'));
const loadSchemaV1 = async () => JSON.parse(await readFile(new URL('../../schema/mrs-1.json', import.meta.url), 'utf8'));
const renderMrsPart = async (doc) => (await import('./mrs-render.mjs')).renderMrsPart(doc);
const readDoc = async (path) => JSON.parse(await readFile(path, 'utf8'));
const options = (over) => ({ now: () => NOW, retryDelayMs: 0, timeoutMs: 2000, log: () => {}, ...over });

async function withPrevious() {
  const dir = await tempDir();
  const out = join(dir, 'mrs.json');
  await writeFile(out, JSON.stringify(previousDoc()) + '\n');
  return out;
}

test('a 503 from the API keeps the previous file, marks it stale, and the page says "list from <date>"', async () => {
  const out = await withPrevious();
  const fetch = stubFetch(() => new Response('upstream unavailable', { status: 503 }));
  const result = await mrs.buildMrs(options({ out, fetch }));

  assert.equal(result.stale, true);
  assert.match(result.reason, /503/);
  assert.equal(fetch.calls.length, 2, 'one request and one retry');
  assert.ok(fetch.calls.every((c) => c.url.startsWith(API_PREFIX)));
  const written = await readDoc(out);
  assert.deepEqual(written, { ...previousDoc(), stale: true });
  assert.deepEqual(mrs.validateSchema(written, await loadSchema()), []);
  assert.match(await renderMrsPart(written), /list from 12 Nov 2026/);
});

const failures = [
  ['a timeout', { timeoutMs: 20 }, (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), /timed out|timeout/i],
  ['a network error', {}, () => { throw new TypeError('fetch failed'); }, /network|fetch failed/i],
  ['a rate limit (403, none remaining)', {}, () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }), /rate limit/i],
  ['a rate limit (429)', {}, () => json({ message: 'secondary rate limit' }, 429), /rate limit/i],
  ['bad JSON', {}, () => new Response('{"total_count": 1, "items": [', { status: 200 }), /JSON/],
  ['a body that is not a search result', {}, () => json([]), /search result/i],
  ['incomplete results', {}, () => json(page([pr(1, 'open', '2026-11-14T00:00:00Z')], 1, true)), /incomplete/i],
  ['an item that is not a pull request', {}, () => { const { pull_request, ...issue } = pr(1, 'open', '2026-11-14T00:00:00Z'); return json(page([issue])); }, /not a pull request/],
  ['a merged_at that is not a timestamp', {}, () => { const item = pr(1, 'closed', '2026-11-14T00:00:00Z'); item.pull_request.merged_at = 'not-a-date'; return json(page([item])); }, /merged_at/],
  ['an open item with merged_at set', {}, () => { const item = pr(1, 'open', '2026-11-14T00:00:00Z'); item.pull_request.merged_at = '2026-11-14T00:00:00Z'; return json(page([item])); }, /merged_at/],
  ['an item without merged_at', {}, () => { const item = pr(1, 'closed', '2026-11-14T00:00:00Z'); delete item.pull_request.merged_at; return json(page([item])); }, /merged_at/],
  ['a title over 1024 characters', {}, () => json(page([pr(1, 'open', '2026-11-14T00:00:00Z', 'x'.repeat(1025))])), /title/],
  ['an item by another author', {}, () => { const item = pr(1, 'open', '2026-11-14T00:00:00Z'); item.user = { login: 'someone-else' }; return json(page([item])); }, /author/],
  ['fewer items than total_count', {}, () => json(page([pr(1, 'open', '2026-11-14T00:00:00Z')], 2)), /total_count/],
  ['more results than the search API returns (1000)', {}, () => json(page([pr(1, 'open', '2026-11-14T00:00:00Z')], 1001)), /1000/],
  ['the issue query returning a pull request', {}, routed(() => json(page([])), () => json(page([pr(2, 'open', '2026-11-14T00:00:00Z')]))), /pull request/],
  ['an issue with a pull request url', {}, routed(() => json(page([])), () => { const item = issue(3, 'open', null, '2026-11-14T00:00:00Z'); item.html_url = prLink(3); return json(page([item])); }), /url/],
  ['an issue with an unknown state', {}, routed(() => json(page([])), () => json(page([issue(4, 'merged', null, '2026-11-14T00:00:00Z')]))), /state/],
  ['an issue by another author', {}, routed(() => json(page([])), () => { const item = issue(6, 'open', null, '2026-11-14T00:00:00Z'); item.user = { login: 'someone-else' }; return json(page([item])); }), /author/],
  ['one number both a pull request and an issue', {}, routed(() => json(page([pr(7, 'open', '2026-11-14T00:00:00Z')])), () => json(page([issue(7, 'open', null, '2026-11-14T00:00:00Z')]))), /both/],
];

for (const [name, extra, handler, reason] of failures) {
  test(`${name} keeps the previous file and marks it stale`, async () => {
    const out = await withPrevious();
    const result = await mrs.buildMrs(options({ out, fetch: stubFetch(handler), ...extra }));
    assert.equal(result.stale, true);
    assert.match(result.reason, reason);
    assert.deepEqual(await readDoc(out), { ...previousDoc(), stale: true });
  });
}

test('client errors are not retried; server errors and timeouts are, once', async () => {
  const limited = stubFetch(() => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }));
  await mrs.buildMrs(options({ out: await withPrevious(), fetch: limited }));
  assert.equal(limited.calls.length, 1);

  const flaky = stubFetch(routed((url, init, n) => (n === 1 ? new Response('', { status: 502 }) : json(page([pr(5, 'open', '2026-11-14T00:00:00Z')])))));
  const result = await mrs.buildMrs(options({ out: await withPrevious(), fetch: flaky }));
  assert.equal(result.stale, false);
  assert.deepEqual(flaky.calls.map((c) => queryKind(c.url)), ['pr', 'pr', 'issue'], 'the pull request query retried once, then the issue query');
});

test('with no previous file an API failure writes an empty stale list and the build still succeeds', async () => {
  const out = join(await tempDir(), 'data', 'v1', 'mrs.json');
  const result = await mrs.buildMrs(options({ out, fetch: stubFetch(() => new Response('', { status: 503 })) }));
  assert.equal(result.stale, true);
  const written = await readDoc(out);
  assert.deepEqual(written, {
    schema: 't3cp/mrs/2', fetched_at: null, stale: true, source_queries: QUERIES,
    counts: { pr: { open: 0, merged: 0, closed: 0 }, issue: { open: 0, closed: 0 } }, omitted: 0, items: [],
  });
  assert.deepEqual(mrs.validateSchema(written, await loadSchema()), []);
  assert.match(await renderMrsPart(written), /could not be read/);
});

test('a previous file that is corrupt or fails the schema is ignored', async () => {
  for (const body of ['not json', JSON.stringify({ ...previousDoc(), extra: 1 }), JSON.stringify({ ...previousDoc(), counts: { ...previousDoc().counts, pr: { open: 9, merged: 0, closed: 0 } } })]) {
    const out = join(await tempDir(), 'mrs.json');
    await writeFile(out, body);
    const result = await mrs.buildMrs(options({ out, fetch: stubFetch(() => new Response('', { status: 503 })) }));
    assert.equal(result.stale, true);
    assert.equal((await readDoc(out)).fetched_at, null);
  }
});

test('a previous list from a different query is ignored', async () => {
  const other = { ...previousDoc(), source_queries: ['repo:pingdotgg/t3code author:someone-else type:pr', 'repo:pingdotgg/t3code author:someone-else type:issue'] };
  assert.deepEqual(mrs.validateSchema(other, await loadSchema()), [], 'schema-valid, so only the query check refuses it');
  const out = join(await tempDir(), 'mrs.json');
  await writeFile(out, JSON.stringify(other));
  const site = 'https://t3cp.io/data/v1/mrs.json';
  const fetch = stubFetch((url) => (url === site ? json(other) : new Response('', { status: 503 })));
  const result = await mrs.buildMrs(options({ out, previous: [out, site], fetch }));
  assert.equal(result.stale, true);
  assert.equal(result.source, 'none');
  assert.equal((await readDoc(out)).fetched_at, null);
});

test('the previous list can come from the deployed site when the checkout has none', async () => {
  const out = join(await tempDir(), 'mrs.json');
  const site = 'https://t3cp.io/data/v1/mrs.json';
  const fetch = stubFetch((url) => (url === site ? json(previousDoc()) : new Response('', { status: 503 })));
  const result = await mrs.buildMrs(options({ out, previous: [out, site], fetch }));
  assert.equal(result.stale, true);
  assert.equal(result.source, site);
  assert.deepEqual(await readDoc(out), { ...previousDoc(), stale: true });
});

test('a successful fetch writes pull requests and issues newest first, with counts per kind, the fetch time and both queries', async () => {
  const out = await withPrevious();
  const prs = [
    pr(30, 'closed', '2026-11-03T08:00:00Z'),
    pr(31, 'open', '2026-11-15T08:00:00Z'),
    pr(32, 'merged', '2026-11-14T08:00:00Z'),
    pr(33, 'merged', '2026-11-15T08:00:00Z'),
  ];
  // An open issue, one closed as completed (fixed), one closed as not planned, one closed with no reason given.
  const issues = [
    issue(40, 'open', null, '2026-11-13T08:00:00Z'),
    issue(41, 'closed', 'completed', '2026-11-12T08:00:00Z'),
    issue(42, 'closed', 'not_planned', '2026-11-05T08:00:00Z'),
    issue(43, 'closed', null, '2026-11-01T08:00:00Z'),
  ];
  const fetch = stubFetch(routed(() => json(page(prs)), () => json(page(issues))));
  const result = await mrs.buildMrs(options({ out, fetch }));

  assert.equal(result.stale, false);
  assert.equal(fetch.calls.length, 2);
  assert.ok(fetch.calls[0].url.startsWith(API_PREFIX), fetch.calls[0].url);
  assert.ok(fetch.calls[1].url.startsWith(ISSUE_PREFIX), fetch.calls[1].url);
  for (const { url, init } of fetch.calls) {
    assert.match(url, /[?&]page=1(&|$)/);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), null, 'no token');
    assert.match(headers.get('user-agent') ?? '', /t3cp/);
    assert.equal(headers.get('accept'), 'application/vnd.github+json');
  }

  const written = await readDoc(out);
  const P = (number, state, at) => ({ kind: 'pr', number, title: `perf(server): synthetic change ${number}`, state, closed_as: null, updated_at: at, url: prLink(number) });
  const I = (number, state, closedAs, at) => ({ kind: 'issue', number, title: `perf: synthetic issue ${number}`, state, closed_as: closedAs, updated_at: at, url: issueLink(number) });
  assert.deepEqual(written, {
    schema: 't3cp/mrs/2',
    fetched_at: '2026-11-15T12:34:56Z',
    stale: false,
    source_queries: QUERIES,
    counts: { pr: { open: 1, merged: 2, closed: 1 }, issue: { open: 1, closed: 3 } },
    omitted: 0,
    items: [
      P(33, 'merged', '2026-11-15T08:00:00Z'),
      P(31, 'open', '2026-11-15T08:00:00Z'),
      P(32, 'merged', '2026-11-14T08:00:00Z'),
      I(40, 'open', null, '2026-11-13T08:00:00Z'),
      I(41, 'closed', 'completed', '2026-11-12T08:00:00Z'),
      I(42, 'closed', 'not_planned', '2026-11-05T08:00:00Z'),
      P(30, 'closed', '2026-11-03T08:00:00Z'),
      I(43, 'closed', null, '2026-11-01T08:00:00Z'),
    ],
  });
  assert.deepEqual(mrs.validateDoc(written, await loadSchema()), []);
});

test('a reopened issue is open with no closed_as; a closed issue keeps GitHub\'s completed or not_planned', async () => {
  const fetch = stubFetch(routed(() => json(page([])), () => json(page([issue(50, 'open', 'reopened', '2026-11-14T08:00:00Z'), issue(51, 'closed', 'duplicate', '2026-11-13T08:00:00Z')]))));
  const out = join(await tempDir(), 'mrs.json');
  const result = await mrs.buildMrs(options({ out, fetch }));
  assert.equal(result.stale, false);
  assert.deepEqual(result.doc.items.map((i) => [i.number, i.state, i.closed_as]), [[50, 'open', null], [51, 'closed', null]]);
  assert.deepEqual(result.doc.counts.issue, { open: 1, closed: 1 });
});

test('a t3cp/mrs/1 previous list is read once and kept as t3cp/mrs/2: every item a pull request, issues not read', async () => {
  const v1 = previousDocV1();
  assert.deepEqual(mrs.validateSchema(v1, await loadSchemaV1()), [], 'the fixture is a valid first-version file');
  const out = join(await tempDir(), 'mrs.json');
  await writeFile(out, `${JSON.stringify(v1)}\n`);
  const result = await mrs.buildMrs(options({ out, fetch: stubFetch(() => new Response('', { status: 503 })) }));
  assert.equal(result.stale, true);
  const written = await readDoc(out);
  assert.deepEqual(written, {
    schema: 't3cp/mrs/2',
    fetched_at: v1.fetched_at,
    stale: true,
    source_queries: [QUERY],
    counts: { pr: v1.counts, issue: { open: 0, closed: 0 } },
    omitted: 0,
    items: v1.items.map((i) => ({ kind: 'pr', number: i.number, title: i.title, state: i.state, closed_as: null, updated_at: i.updated_at, url: i.url })),
  });
  assert.deepEqual(mrs.validateDoc(written, await loadSchema()), []);
  // The written file is a t3cp/mrs/2 one now: a second failing build keeps it as it is.
  await mrs.buildMrs(options({ out, fetch: stubFetch(() => new Response('', { status: 503 })) }));
  assert.deepEqual(await readDoc(out), written);
  // A first-version file from another author is still refused.
  const other = { ...v1, source_query: 'repo:pingdotgg/t3code author:someone-else type:pr' };
  const out2 = join(await tempDir(), 'mrs.json');
  await writeFile(out2, JSON.stringify(other));
  const r2 = await mrs.buildMrs(options({ out: out2, fetch: stubFetch(() => new Response('', { status: 503 })) }));
  assert.equal(r2.source, 'none');
});

test('more than 100 pull requests are read page by page', async () => {
  const all = Array.from({ length: 230 }, (_, i) => pr(1000 + i, ['open', 'merged', 'closed'][i % 3], `2026-11-${String(1 + (i % 15)).padStart(2, '0')}T00:00:00Z`, `fix: #${i}`));
  const fetch = stubFetch(routed((url) => {
    const n = Number(new URL(url).searchParams.get('page'));
    return json(page(all.slice((n - 1) * 100, n * 100), all.length));
  }));
  const out = join(await tempDir(), 'mrs.json');
  const result = await mrs.buildMrs(options({ out, fetch }));
  assert.equal(result.stale, false);
  assert.deepEqual(fetch.calls.map((c) => [queryKind(c.url), new URL(c.url).searchParams.get('page')]), [['pr', '1'], ['pr', '2'], ['pr', '3'], ['issue', '1']]);
  const written = await readDoc(out);
  assert.deepEqual(written.counts, { pr: { open: 77, merged: 77, closed: 76 }, issue: { open: 0, closed: 0 } });
  assert.equal(written.items.length + written.omitted, 230);
  assert.equal(new Set(written.items.map((i) => i.number)).size, written.items.length);
});

test('the file stays within 32 KB: the oldest items are left out and counted, the counts cover all', async () => {
  const all = Array.from({ length: 400 }, (_, i) =>
    pr(2000 + i, i % 2 ? 'merged' : 'closed', new Date(Date.UTC(2026, 10, 15) - i * 3600e3).toISOString().replace('.000', ''), `perf(server): ${'a long synthetic title '.repeat(8)}${i}`));
  const fetch = stubFetch(routed((url) => {
    const n = Number(new URL(url).searchParams.get('page'));
    return json(page(all.slice((n - 1) * 100, n * 100), all.length));
  }));
  const out = join(await tempDir(), 'mrs.json');
  const result = await mrs.buildMrs(options({ out, fetch }));
  assert.equal(mrs.MAX_BYTES, 32 * 1024);
  assert.ok((await stat(out)).size <= mrs.MAX_BYTES, `size ${(await stat(out)).size}`);
  assert.equal(result.bytes, (await stat(out)).size);
  const written = await readDoc(out);
  assert.ok(written.omitted > 0);
  assert.equal(written.items.length + written.omitted, 400);
  assert.deepEqual(written.counts, { pr: { open: 0, merged: 200, closed: 200 }, issue: { open: 0, closed: 0 } });
  assert.deepEqual(written.items.map((i) => i.number), all.slice(0, written.items.length).map((i) => i.number), 'the newest are kept');
  assert.deepEqual(mrs.validateSchema(written, await loadSchema()), []);
});

test('the schema and the checks reject extra properties, unknown states, links off the upstream repository and kinds mixed up', async () => {
  const schema = await loadSchema();
  assert.equal(schema.properties.items.items.properties.title.maxLength, mrs.MAX_TITLE_LENGTH, 'toItem refuses what the schema refuses');
  const doc = previousDoc();
  assert.deepEqual(mrs.validateDoc(doc, schema), []);
  const bad = (d) => assert.notDeepEqual(mrs.validateDoc(d, schema), [], JSON.stringify(d).slice(0, 160));
  const item = (k, over) => ({ ...doc, items: doc.items.map((x, i) => (i === k ? { ...x, ...over } : x)) });
  bad({ ...doc, extra: 1 });
  bad({ ...doc, counts: { ...doc.counts, pr: { ...doc.counts.pr, draft: 0 } } });
  bad({ ...doc, counts: { ...doc.counts, issue: { ...doc.counts.issue, merged: 0 } } });
  bad(item(0, { author: 'x' }));
  bad(item(0, { state: 'draft' }));
  bad(item(0, { url: 'https://example.com/pull/12' }));
  bad(item(0, { kind: 'discussion' }));
  bad(item(0, { url: issueLink(12) }), 'a pull request with an issue link');
  bad(item(2, { url: prLink(10) }), 'an issue with a pull request link');
  bad(item(2, { state: 'merged' }), 'an issue is never merged');
  bad(item(0, { closed_as: 'completed' }), 'closed_as belongs to closed issues');
  bad(item(2, { state: 'open' }), 'an open issue has no closed_as');
  bad(item(2, { closed_as: 'wontfix' }));
  bad({ ...doc, source_queries: [QUERIES[1], QUERIES[0]] }, 'the pull request query first');
  bad({ ...doc, source_queries: [...QUERIES, QUERIES[0]] });
  bad({ ...doc, source_queries: ['repo:pingdotgg/t3code author:x type:discussion'] });
  const { fetched_at, ...noTime } = doc;
  bad(noTime);
});

test('the command line exits 0 on a 503, keeps the previous file stale and writes the page part', async () => {
  const out = await withPrevious();
  const part = join(await tempDir(), 'mrs.part.html');
  const { code, stderr } = await runCli(['--out', out, '--part', part, '--retry-delay-ms', '0'], (req, res) => { res.writeHead(503); res.end(); });
  assert.equal(code, 0, stderr);
  assert.match(stderr, /stale/);
  assert.deepEqual(await readDoc(out), { ...previousDoc(), stale: true });
  assert.match(await readFile(part, 'utf8'), /list from 12 Nov 2026/);
});

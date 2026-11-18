// Tests for the MRs page part (site/build/mrs-render.mjs): rendered at build time, no script on the page. The page lists
// the fork author's pull requests and issues on upstream, grouped Open, Merged or fixed, Closed.
import test from 'node:test';
import assert from 'node:assert/strict';

import { previousDoc, previousDocV1, prLink, issueLink, LOGIN, QUERY } from './mrs-testkit.mjs';

const load = () => import('./mrs-render.mjs');
const P = (number, title, state, at) => ({ kind: 'pr', number, title, state, closed_as: null, updated_at: at, url: prLink(number) });
const I = (number, title, state, closedAs, at) => ({ kind: 'issue', number, title, state, closed_as: closedAs, updated_at: at, url: issueLink(number) });
const fresh = () => ({
  ...previousDoc(),
  fetched_at: '2026-11-15T12:34:56Z',
  counts: { pr: { open: 2, merged: 3, closed: 1 }, issue: { open: 1, closed: 3 } },
  items: [
    P(40, 'perf(server): synthetic a', 'open', '2026-11-15T09:00:00Z'),
    P(41, 'perf(server): synthetic b', 'merged', '2026-11-14T23:59:59Z'),
    I(50, 'perf: synthetic issue fixed', 'closed', 'completed', '2026-11-14T10:00:00Z'),
    I(51, 'perf: synthetic issue open', 'open', null, '2026-11-13T10:00:00Z'),
    P(42, 'perf(server): synthetic c', 'merged', '2026-11-06T00:00:00Z'),
    I(52, 'perf: synthetic issue not planned', 'closed', 'not_planned', '2026-11-05T10:00:00Z'),
    P(43, 'perf(server): synthetic d', 'open', '2026-11-04T10:00:00Z'),
    I(53, 'perf: synthetic issue closed, no reason', 'closed', null, '2026-11-03T10:00:00Z'),
    P(44, 'perf(server): synthetic e', 'merged', '2026-10-02T10:00:00Z'),
    P(45, 'perf(server): synthetic f', 'closed', '2026-10-01T10:00:00Z'),
  ],
});
const countLine = (html) => html.match(/<p class="count"[^>]*>([^<]*)<\/p>/)?.[1];
// The table as [group, [title, kind, number, status class, status, last update]] in page order.
function table(html) {
  const out = [];
  for (const m of html.matchAll(/<tr><th colspan="5" class="grp">([^<]+)<\/th><\/tr>|<tr><td class="mrs-t"><a href="([^"]+)">([^<]+)<\/a><\/td><td>(PR|issue)<\/td><td class="n mut">#(\d+)<\/td><td><span class="st st-(\w+)">(\w+)<\/span><\/td><td class="hs mut">([^<]+)<\/td><\/tr>/g)) {
    if (m[1]) out.push([m[1], []]);
    else out.at(-1)[1].push([m[3], m[4], Number(m[5]), m[6], m[7], m[8], m[2]]);
  }
  return out;
}

test('the status line counts pull requests and issues from the file', async () => {
  const { renderMrsPart, statusLine } = await load();
  const doc = fresh();
  const expected = '6 pull requests: 2 open, 3 merged, 1 closed. 4 issues: 1 open, 3 closed.';
  assert.equal(statusLine(doc), expected);
  assert.equal(countLine(renderMrsPart(doc)), expected);
  const one = { ...doc, counts: { pr: { open: 1, merged: 0, closed: 0 }, issue: { open: 0, closed: 0 } }, items: doc.items.slice(0, 1) };
  assert.equal(countLine(renderMrsPart(one)), '1 pull request: 1 open, 0 merged, 0 closed. 0 issues: 0 open, 0 closed.');
});

test('groups Open, Merged or fixed, Closed; pull requests and issues together, newest first in each, with kind and status', async () => {
  const { renderMrsPart } = await load();
  const html = renderMrsPart(fresh());
  assert.match(html, /<h1>MRs\.<\/h1>/);
  assert.match(html, /<p class="lede">Pull requests and issues to upstream\./);
  assert.match(html, /<a class="btn btn-p" href="https:\/\/github\.com\/pingdotgg\/t3code\/discussions\/31002">The upstream discussion<\/a>/);
  assert.match(html, /<thead><tr><th>Item<\/th><th>Kind<\/th><th class="n">Number<\/th><th>Status<\/th><th class="hs">Last update<\/th><\/tr><\/thead>/);
  const t = table(html);
  assert.deepEqual(t.map(([g, rows]) => [g, rows.map((r) => [r[2], r[1], r[4]])]), [
    ['Open', [[40, 'PR', 'open'], [51, 'issue', 'open'], [43, 'PR', 'open']]],
    ['Merged or fixed', [[41, 'PR', 'merged'], [50, 'issue', 'fixed'], [42, 'PR', 'merged'], [44, 'PR', 'merged']]],
    ['Closed', [[52, 'issue', 'closed'], [53, 'issue', 'closed'], [45, 'PR', 'closed']]],
  ]);
  const row = (n) => t.flatMap(([, rows]) => rows).find((r) => r[2] === n);
  assert.deepEqual(row(50), ['perf: synthetic issue fixed', 'issue', 50, 'merged', 'fixed', '14 Nov 2026', issueLink(50)], 'a fixed issue reads fixed, styled as merged');
  assert.deepEqual(row(52), ['perf: synthetic issue not planned', 'issue', 52, 'closed', 'closed', '5 Nov 2026', issueLink(52)]);
  assert.deepEqual(row(40), ['perf(server): synthetic a', 'PR', 40, 'open', 'open', '15 Nov 2026', prLink(40)]);
  assert.match(html, /Read from GitHub on 15 Nov 2026 at 12:34 UTC\./);
});

test('an empty group has no heading', async () => {
  const { renderMrsPart } = await load();
  const doc = { ...fresh(), counts: { pr: { open: 2, merged: 0, closed: 0 }, issue: { open: 1, closed: 0 } } };
  doc.items = doc.items.filter((i) => i.state === 'open');
  assert.deepEqual(table(renderMrsPart(doc)).map(([g]) => g), ['Open']);
});

test('a fresh list has no stale note; a stale one says "list from <date>"', async () => {
  const { renderMrsPart } = await load();
  assert.doesNotMatch(renderMrsPart(fresh()), /mrs-stale|list from/);
  const stale = renderMrsPart({ ...previousDoc(), stale: true });
  assert.match(stale, /<p class="note mrs-stale" role="status">[^<]*list from 12 Nov 2026[^<]*<\/p>/);
  assert.equal(countLine(stale), '3 pull requests: 1 open, 1 merged, 1 closed. 1 issue: 0 open, 1 closed.');
});

test('a list kept from the first page version (pull requests only) does not claim an issue count', async () => {
  const { renderMrsPart } = await load();
  const v1 = previousDocV1();
  const migrated = { schema: 't3cp/mrs/2', fetched_at: v1.fetched_at, stale: true, source_queries: [QUERY], counts: { pr: v1.counts, issue: { open: 0, closed: 0 } }, omitted: 0, items: v1.items.map((i) => ({ kind: 'pr', ...i, closed_as: null })) };
  const html = renderMrsPart(migrated);
  assert.equal(countLine(html), '3 pull requests: 1 open, 1 merged, 1 closed. Issues were not read for this list.');
});

test('no list yet: a missing file (null) or a stale file that was never fetched', async () => {
  const { renderMrsPart } = await load();
  const never = { ...previousDoc(), fetched_at: null, stale: true, counts: { pr: { open: 0, merged: 0, closed: 0 }, issue: { open: 0, closed: 0 } }, items: [] };
  for (const doc of [null, never]) {
    const html = renderMrsPart(doc);
    assert.match(html, /No list yet/);
    assert.match(html, /discussions\/31002/);
    assert.doesNotMatch(html, /<table/);
    assert.equal(countLine(html), undefined);
  }
  assert.match(renderMrsPart(never), /could not be read/);
});

test('items left out for the size budget are counted, with links to the full lists', async () => {
  const { renderMrsPart } = await load();
  const doc = { ...fresh(), counts: { pr: { open: 2, merged: 3, closed: 8 }, issue: { open: 1, closed: 3 } }, omitted: 7 };
  const html = renderMrsPart(doc);
  assert.equal(countLine(html), '13 pull requests: 2 open, 3 merged, 8 closed. 4 issues: 1 open, 3 closed.');
  assert.match(html, /7 older items are not listed here/);
  assert.ok(html.includes(`href="https://github.com/pingdotgg/t3code/pulls?q=is%3Apr+author%3A${LOGIN}"`));
  assert.ok(html.includes(`href="https://github.com/pingdotgg/t3code/issues?q=is%3Aissue+author%3A${LOGIN}"`));
});

test('titles are escaped and the output is the same for the same document', async () => {
  const { renderMrsPart } = await load();
  const doc = fresh();
  doc.items[0].title = 'fix: <b>bold</b> & "quoted" \'single\'';
  const html = renderMrsPart(doc);
  assert.match(html, /fix: &lt;b&gt;bold&lt;\/b&gt; &amp; &quot;quoted&quot; &#39;single&#39;/);
  assert.doesNotMatch(html, /<b>bold/);
  assert.equal(renderMrsPart(structuredClone(doc)), html);
  assert.doesNotMatch(html, /<script|style="/, 'no script and no inline style (CSP)');
});

test('the MRs page fits the 20 KB gzipped page budget with a full 32 KB list', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { gzipSync } = await import('node:zlib');
  const { makeDoc, MAX_BYTES, serialize } = await import('./mrs.mjs');
  const { build } = await import('./build.mjs');
  const { BUDGETS } = await import('./budgets.mjs');
  // Varied made-up titles, so the list compresses no better than a real one would.
  const words = 'cache stream session snapshot reader writer queue turn agent socket index batch flush replay commit lock'.split(' ');
  const title = (i) => `perf(server): ${Array.from({ length: 9 }, (_, k) => words[(i * 7 + k * 13 + (i >> k)) % words.length]).join(' ')} ${i * 37 % 1009}`;
  const items = Array.from({ length: 600 }, (_, i) => (i % 3 === 2
    ? I(900 + i, title(i), i % 2 ? 'closed' : 'open', i % 2 ? (i % 4 === 1 ? 'completed' : 'not_planned') : null, new Date(Date.UTC(2026, 10, 15) - i * 3600e3).toISOString().replace('.000', ''))
    : P(900 + i, title(i), ['open', 'merged', 'closed'][i % 3], new Date(Date.UTC(2026, 10, 15) - i * 3600e3).toISOString().replace('.000', ''))));
  const doc = makeDoc(items, '2026-11-15T12:34:56Z');
  assert.ok(doc.omitted > 0 && Buffer.byteLength(serialize(doc)) <= MAX_BYTES, 'a list trimmed to the 32 KB cap');
  const root = mkdtempSync(join(tmpdir(), 't3cp-mrs-page-'));
  try {
    writeFileSync(join(root, 'mrs.json'), serialize(doc));
    const posts = join(root, 'posts');
    (await import('node:fs')).mkdirSync(posts);
    await build({ out: join(root, 'dist'), in: join(root, 'no-data-yet'), posts, mrs: join(root, 'mrs.json') });
    const html = readFileSync(join(root, 'dist', 'mrs', 'index.html'));
    const gz = gzipSync(html, { level: 9 }).length;
    assert.ok(html.includes('class="grp">Merged or fixed<'), 'the list is on the page');
    assert.ok(gz <= BUDGETS.html, `mrs/index.html ${gz} B gzipped, over ${BUDGETS.html}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

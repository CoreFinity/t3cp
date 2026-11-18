// Tests for the MRs page part (site/build/mrs-render.mjs): rendered at build time, no script on the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { previousDoc, prLink, LOGIN } from './mrs-testkit.mjs';

const load = () => import('./mrs-render.mjs');
const fresh = () => ({
  ...previousDoc(),
  fetched_at: '2026-11-15T12:34:56Z',
  counts: { open: 2, merged: 3, closed: 1 },
  items: [
    { number: 40, title: 'perf(server): synthetic a', state: 'open', updated_at: '2026-11-15T09:00:00Z', url: prLink(40) },
    { number: 41, title: 'perf(server): synthetic b', state: 'merged', updated_at: '2026-11-14T23:59:59Z', url: prLink(41) },
    { number: 42, title: 'perf(server): synthetic c', state: 'merged', updated_at: '2026-11-06T00:00:00Z', url: prLink(42) },
    { number: 43, title: 'perf(server): synthetic d', state: 'open', updated_at: '2026-11-04T10:00:00Z', url: prLink(43) },
    { number: 44, title: 'perf(server): synthetic e', state: 'merged', updated_at: '2026-10-02T10:00:00Z', url: prLink(44) },
    { number: 45, title: 'perf(server): synthetic f', state: 'closed', updated_at: '2026-10-01T10:00:00Z', url: prLink(45) },
  ],
});
const countLine = (html) => html.match(/<p class="count"[^>]*>([^<]*)<\/p>/)?.[1];

test('the status line equals the counts in the file', async () => {
  const { renderMrsPart, statusLine } = await load();
  const doc = fresh();
  const expected = '6 pull requests: 2 open, 3 merged, 1 closed.';
  assert.equal(statusLine(doc), expected);
  assert.equal(countLine(renderMrsPart(doc)), expected);
  const one = { ...doc, counts: { open: 1, merged: 0, closed: 0 }, items: doc.items.slice(0, 1) };
  assert.equal(countLine(renderMrsPart(one)), '1 pull request: 1 open, 0 merged, 0 closed.');
});

test('the upstream discussion is the prominent link; every pull request has title, number, status, last update and link, grouped open, merged, closed', async () => {
  const { renderMrsPart } = await load();
  const doc = fresh();
  const html = renderMrsPart(doc);
  assert.match(html, /<h1>MRs\.<\/h1>/);
  assert.match(html, /<a class="btn btn-p" href="https:\/\/github\.com\/pingdotgg\/t3code\/discussions\/31002">The upstream discussion<\/a>/);
  const rows = [...html.matchAll(/<tr><td class="mrs-t"><a href="([^"]+)">([^<]+)<\/a><\/td><td class="n mut">#(\d+)<\/td><td><span class="st st-(\w+)">(\w+)<\/span><\/td><td class="hs mut">([^<]+)<\/td><\/tr>/g)];
  // As in the mockup: open first, then merged, then closed; newest first within each.
  const order = [40, 43, 41, 42, 44, 45];
  const byNumber = new Map(doc.items.map((i) => [i.number, i]));
  assert.deepEqual(rows.map((m) => m.slice(1)), order.map((n) => byNumber.get(n)).map((i) => [i.url, i.title, String(i.number), i.state, i.state, {
    40: '15 Nov 2026', 41: '14 Nov 2026', 42: '6 Nov 2026', 43: '4 Nov 2026', 44: '2 Oct 2026', 45: '1 Oct 2026',
  }[i.number]]));
  assert.match(html, /Read from GitHub on 15 Nov 2026 at 12:34 UTC\./);
});

test('a fresh list has no stale note; a stale one says "list from <date>"', async () => {
  const { renderMrsPart } = await load();
  assert.doesNotMatch(renderMrsPart(fresh()), /mrs-stale|list from/);
  const stale = renderMrsPart({ ...previousDoc(), stale: true });
  assert.match(stale, /<p class="note mrs-stale" role="status">[^<]*list from 12 Nov 2026[^<]*<\/p>/);
  assert.equal(countLine(stale), '3 pull requests: 1 open, 1 merged, 1 closed.');
});

test('no list yet: a missing file (null) or a stale file that was never fetched', async () => {
  const { renderMrsPart } = await load();
  for (const doc of [null, { ...previousDoc(), fetched_at: null, stale: true, counts: { open: 0, merged: 0, closed: 0 }, items: [] }]) {
    const html = renderMrsPart(doc);
    assert.match(html, /No pull request list yet/);
    assert.match(html, /discussions\/31002/);
    assert.doesNotMatch(html, /<table/);
    assert.equal(countLine(html), undefined);
  }
  assert.match(renderMrsPart({ ...previousDoc(), fetched_at: null, stale: true, counts: { open: 0, merged: 0, closed: 0 }, items: [] }), /could not be read/);
});

test('pull requests left out for the size budget are counted, with a link to the full list', async () => {
  const { renderMrsPart } = await load();
  const doc = { ...fresh(), counts: { open: 2, merged: 3, closed: 8 }, omitted: 7 };
  const html = renderMrsPart(doc);
  assert.equal(countLine(html), '13 pull requests: 2 open, 3 merged, 8 closed.');
  assert.match(html, /7 older pull requests are not listed here/);
  assert.ok(html.includes(`href="https://github.com/pingdotgg/t3code/pulls?q=is%3Apr+author%3A${LOGIN}"`));
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

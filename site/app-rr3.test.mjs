// Red first: the third re-review's minors. A fragment that loads clears a stale error; a fragment 404 (a page left
// open across a deploy) re-reads the fragment version from a fresh /releases/ once, retries once, and otherwise says
// the page is out of date; the crosshair tooltip names the era that starts at a record, so an era whose label was
// left out on a narrow chart is still named.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, level, shard } from './build/lib/test-data.mjs';

const T = loadApp();
const page = hash => `<!doctype html><body data-page="releases" data-mac="0" data-frag="${hash}">`;
function fakeFetch(routes) {
  const calls = [];
  const f = url => { calls.push(url); const r = routes[url]; return Promise.resolve(r ? { ok: r[0] === 200, status: r[0], text: () => Promise.resolve(r[1]) } : { ok: false, status: 404, text: () => Promise.resolve('') }); };
  return { f, calls };
}

test('a fragment that loads comes back with its version', async () => {
  const { f, calls } = fakeFetch({ '/releases/v0.1.9-perf.8/100.aaaaaaaaaaaa.html': [200, '<h1>x</h1><!--body-->y'] });
  const r = await T.loadFragment(f, 'v0.1.9-perf.8', '100', 'aaaaaaaaaaaa');
  assert.equal(r.html, '<h1>x</h1><!--body-->y');
  assert.equal(calls.length, 1);
});

test('a 404 re-reads the version from a fresh /releases/ once and retries once', async () => {
  const { f, calls } = fakeFetch({ '/releases/': [200, page('bbbbbbbbbbbb')], '/releases/v0.1.9-perf.8/100.bbbbbbbbbbbb.html': [200, 'fresh<!--body-->z'] });
  const r = await T.loadFragment(f, 'v0.1.9-perf.8', '100', 'aaaaaaaaaaaa');
  assert.equal(r.html, 'fresh<!--body-->z');
  assert.equal(r.hash, 'bbbbbbbbbbbb');
  assert.deepEqual(calls, ['/releases/v0.1.9-perf.8/100.aaaaaaaaaaaa.html', '/releases/', '/releases/v0.1.9-perf.8/100.bbbbbbbbbbbb.html']);
});

test('a second 404 says the page is out of date; never a loop', async () => {
  const { f, calls } = fakeFetch({ '/releases/': [200, page('bbbbbbbbbbbb')] });
  await assert.rejects(T.loadFragment(f, 'v0.1.9-perf.8', '100', 'aaaaaaaaaaaa'), /out of date.*reload/i);
  assert.equal(calls.length, 3);
});

test('another failure is reported as it is, without a retry', async () => {
  const { f, calls } = fakeFetch({ '/releases/v0.1.9-perf.8/100.aaaaaaaaaaaa.html': [503, ''] });
  await assert.rejects(T.loadFragment(f, 'v0.1.9-perf.8', '100', 'aaaaaaaaaaaa'), /HTTP 503/);
  assert.equal(calls.length, 1);
});

test('the error box: shown with a message, cleared when the next load succeeds', () => {
  const box = { hidden: true, textContent: '' };
  T.errBox(box, 'release v0.1.9-perf.7: HTTP 503');
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /HTTP 503/);
  T.errBox(box, null);
  assert.equal(box.hidden, true);
  assert.equal(box.textContent, '');
});

test('the tooltip names the era that starts at a record', () => {
  const S = shard('turn_p50_ms', { 100: level(Array.from({ length: 10 }, () => 400), {}, 22.5) });
  S.eras = [{ date: '2026-10-20', kind: 'compaction', label: 'compaction schedule era' }, { date: '2026-10-24', kind: 'fixture', label: 'large-76' }];
  const M = T.model(S, { ...META.elu, id: 'turn_p50_ms' }, '100', 30);
  assert.match(T.tipHTML(M, 3), /compaction schedule changes here/);
  assert.match(T.tipHTML(M, 7), /New era from this record: large-76/);
  assert.doesNotMatch(T.tipHTML(M, 5), /era/i);
});

test('a run with an unknown compaction schedule is named where it starts and where a known schedule resumes', () => {
  const S = shard('turn_p50_ms', { 100: level(Array.from({ length: 10 }, () => 400), {}, 22.5) });
  S.eras = [{ date: '2026-10-20', kind: 'compaction', label: 'compaction schedule era' }, { date: '2026-10-22', kind: 'compaction', label: 'compaction schedule unknown' }, { date: '2026-10-24', kind: 'compaction', label: 'compaction schedule era' }];
  const M = T.model(S, { ...META.elu, id: 'turn_p50_ms' }, '100', 30);
  assert.match(T.tipHTML(M, 3), /compaction schedule changes here/);
  assert.match(T.tipHTML(M, 5), /compaction schedule unknown from this record/);
  assert.match(T.tipHTML(M, 7), /compaction schedule known again from this record/);
  const { html } = T.tsSVG(M, 1200, 320);
  assert.ok((html.match(/>early compaction</g) || []).length <= 1, 'only the first boundary closes the early era');
  assert.doesNotMatch(html.split('2026-10-24')[0] && html, />early compaction<\/text>[\s\S]*>early compaction</);
});

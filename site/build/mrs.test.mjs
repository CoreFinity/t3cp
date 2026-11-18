// Tests for the MRs build step (site/build/mrs.mjs). Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapState, toItem } from './mrs.mjs';
import { LOGIN } from './mrs-testkit.mjs';

// One item as the GitHub search API returns it (only the fields the build reads, plus a few it ignores).
const searchItem = (over = {}) => ({
  number: 101,
  title: 'perf(server): a synthetic pull request title',
  state: 'closed',
  updated_at: '2026-11-15T09:12:44Z',
  created_at: '2026-11-01T10:00:00Z',
  html_url: 'https://github.com/pingdotgg/t3code/pull/101',
  user: { login: LOGIN },
  pull_request: {
    url: 'https://api.github.com/repos/pingdotgg/t3code/pulls/101',
    html_url: 'https://github.com/pingdotgg/t3code/pull/101',
    merged_at: null,
  },
  ...over,
});

test('a search item with pull_request.merged_at set maps to merged', () => {
  const item = searchItem({ pull_request: { ...searchItem().pull_request, merged_at: '2026-11-15T09:12:40Z' } });
  assert.equal(mapState(item), 'merged');
});

test('an open search item maps to open', () => {
  assert.equal(mapState(searchItem({ state: 'open' })), 'open');
});

test('a closed search item with merged_at null maps to closed', () => {
  assert.equal(mapState(searchItem({ state: 'closed' })), 'closed');
});

// merged_at is either null (state from item.state) or a real UTC timestamp on a closed item (merged).
// Anything else is a bad response: it must throw, so the build keeps the previous list, marked stale.
const withMergedAt = (state, mergedAt) => searchItem({ state, pull_request: { ...searchItem().pull_request, merged_at: mergedAt } });

test('a missing merged_at is rejected, not read as closed', () => {
  const { merged_at, ...noMergedAt } = searchItem().pull_request;
  assert.throws(() => mapState(searchItem({ state: 'closed', pull_request: noMergedAt })), /merged_at/);
  assert.throws(() => mapState(searchItem({ state: 'open', pull_request: noMergedAt })), /merged_at/);
});

test('a merged_at that is not a real UTC timestamp is rejected', () => {
  const bad = ['not-a-date', '', false, true, 0, 1794787200000, {}, [], '2026-13-45T99:99:99Z', '2026-02-30T00:00:00Z',
    '2026-11-15T24:00:00Z', '2026-11-15', '2026-11-15T10:00:00+01:00', ' 2026-11-15T10:00:00Z'];
  for (const value of bad) {
    assert.throws(() => mapState(withMergedAt('closed', value)), /merged_at/, JSON.stringify(value));
  }
});

test('an open item with merged_at set is rejected', () => {
  assert.throws(() => mapState(withMergedAt('open', '2026-11-15T09:12:40Z')), /merged_at/);
});

test('an updated_at that is not a real UTC timestamp is rejected', () => {
  for (const value of ['2026-02-30T00:00:00Z', '2026-11-15T24:00:00Z', '2026-11-15', 1794787200000]) {
    assert.throws(() => toItem(searchItem({ updated_at: value })), /updated_at/, JSON.stringify(value));
  }
  assert.equal(toItem(searchItem({ updated_at: '2026-11-15T09:12:44.123Z' })).updated_at, '2026-11-15T09:12:44.123Z');
});

test('toItem keeps number, title, state, updated_at and the pull request link, nothing else', () => {
  const item = toItem(searchItem({ number: 202, state: 'open', html_url: 'https://github.com/pingdotgg/t3code/pull/202' }));
  assert.deepEqual(item, {
    number: 202,
    title: 'perf(server): a synthetic pull request title',
    state: 'open',
    updated_at: '2026-11-15T09:12:44Z',
    url: 'https://github.com/pingdotgg/t3code/pull/202',
  });
});

test('an item that is not a pull request, or has an unknown state, is rejected', () => {
  const { pull_request, ...issue } = searchItem();
  assert.throws(() => mapState(issue), /not a pull request/);
  assert.throws(() => mapState(searchItem({ state: 'draft' })), /state/);
});

test('an item whose link is not a pull request on the upstream repository is rejected', () => {
  assert.throws(() => toItem(searchItem({ html_url: 'https://example.com/pull/101' })), /url/);
  assert.throws(() => toItem(searchItem({ html_url: 'https://github.com/pingdotgg/t3code/pull/999' })), /url/);
});

test('a title longer than the schema allows (1024 characters) is rejected, so the build goes stale', () => {
  assert.equal(toItem(searchItem({ title: 'x'.repeat(1024) })).title.length, 1024);
  const astral = '\u{1F600}'.repeat(1024); // 1024 characters, 2048 UTF-16 units: counted as the schema counts
  assert.equal(toItem(searchItem({ title: astral })).title, astral);
  assert.throws(() => toItem(searchItem({ title: 'x'.repeat(1025) })), /title/);
});

test("an item whose author is not the fork's owner is an inconsistent result and is rejected", () => {
  assert.equal(toItem(searchItem()).number, 101);
  assert.equal(toItem(searchItem({ user: { login: LOGIN.toUpperCase() } })).number, 101, 'logins compare without case');
  for (const user of [{ login: 'someone-else' }, { login: `${LOGIN}x` }, { login: '' }, { login: 7 }, {}, null, 'x']) {
    assert.throws(() => toItem(searchItem({ user })), /author/, JSON.stringify(user));
  }
  const { user, ...noUser } = searchItem();
  assert.throws(() => toItem(noUser), /author/);
});

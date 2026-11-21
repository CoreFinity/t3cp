// Shared fixtures for the MRs tests: synthetic search responses, a recording fetch stub and temp directories.
// Every title here is made up; nothing comes from a real response.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NOW = new Date('2026-11-15T12:34:56.789Z');
// The fork's owner, from the fork URL (public files carry the login only there and in the author query).
export const LOGIN = 'https://github.com/navidnadali/t3code'.split('/')[3];
export const API_PREFIX = `https://api.github.com/search/issues?q=repo:pingdotgg/t3code+author:${LOGIN}+type:pr&per_page=100`;
export const ISSUE_PREFIX = `https://api.github.com/search/issues?q=repo:pingdotgg/t3code+author:${LOGIN}+type:issue&per_page=100`;
export const QUERY = `repo:pingdotgg/t3code author:${LOGIN} type:pr`;
export const ISSUE_QUERY = `repo:pingdotgg/t3code author:${LOGIN} type:issue`;
export const QUERIES = [QUERY, ISSUE_QUERY];
export const prLink = (n) => `https://github.com/pingdotgg/t3code/pull/${n}`;
export const issueLink = (n) => `https://github.com/pingdotgg/t3code/issues/${n}`;
// Which query a search URL (or a request path) asks: 'issue' or 'pr'.
export const queryKind = (url) => (decodeURIComponent(String(url)).replaceAll('+', ' ').includes('type:issue') ? 'issue' : 'pr');

// A pull request as the search API returns it. state: open | merged | closed.
export function pr(number, state, updatedAt, title = `perf(server): synthetic change ${number}`) {
  return {
    number,
    title,
    state: state === 'open' ? 'open' : 'closed',
    updated_at: updatedAt,
    created_at: '2026-10-01T00:00:00Z',
    html_url: prLink(number),
    user: { login: LOGIN },
    pull_request: {
      url: `https://api.github.com/repos/pingdotgg/t3code/pulls/${number}`,
      html_url: prLink(number),
      merged_at: state === 'merged' ? updatedAt : null,
    },
  };
}

// An issue as the search API returns it: no pull_request key. state: open | closed; reason: GitHub's state_reason.
export function issue(number, state, reason, updatedAt, title = `perf: synthetic issue ${number}`) {
  return {
    number,
    title,
    state,
    state_reason: reason,
    updated_at: updatedAt,
    created_at: '2026-10-01T00:00:00Z',
    html_url: issueLink(number),
    user: { login: LOGIN },
  };
}

export const page = (items, total = items.length, incomplete = false) => ({ total_count: total, incomplete_results: incomplete, items });

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

// A fetch stand-in that records every call and answers through handler(url, init, callNumber).
export function stubFetch(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  fetch.calls = calls;
  return fetch;
}

// A fetch handler that answers the pull request query and the issue query apart (the issue query: no issues by default).
export const routed = (prs, issues = () => json(page([]))) => (url, init, n) => (queryKind(url) === 'issue' ? issues(url, init, n) : prs(url, init, n));

// The list a previous build wrote (fetched 12 Nov 2026): three pull requests and an issue fixed upstream.
export const previousDoc = () => ({
  schema: 't3cp/mrs/2',
  fetched_at: '2026-11-12T06:00:00Z',
  stale: false,
  source_queries: [...QUERIES],
  counts: { pr: { open: 1, merged: 1, closed: 1 }, issue: { open: 0, closed: 1 } },
  omitted: 0,
  items: [
    { kind: 'pr', number: 12, title: 'fix(server): synthetic open change', state: 'open', closed_as: null, updated_at: '2026-11-11T10:00:00Z', url: prLink(12) },
    { kind: 'pr', number: 11, title: 'perf(server): synthetic merged change', state: 'merged', closed_as: null, updated_at: '2026-11-10T10:00:00Z', url: prLink(11) },
    { kind: 'issue', number: 10, title: 'perf: synthetic issue fixed upstream', state: 'closed', closed_as: 'completed', updated_at: '2026-11-08T10:00:00Z', url: issueLink(10) },
    { kind: 'pr', number: 9, title: 'perf(shared): synthetic closed change', state: 'closed', closed_as: null, updated_at: '2026-11-02T10:00:00Z', url: prLink(9) },
  ],
});

// The same kind of list as the first page version wrote it (t3cp/mrs/1: pull requests only), for the one-time migration.
export const previousDocV1 = () => ({
  schema: 't3cp/mrs/1',
  fetched_at: '2026-11-12T06:00:00Z',
  stale: false,
  source_query: QUERY,
  counts: { open: 1, merged: 1, closed: 1 },
  omitted: 0,
  items: [
    { number: 12, title: 'fix(server): synthetic open change', state: 'open', updated_at: '2026-11-11T10:00:00Z', url: prLink(12) },
    { number: 11, title: 'perf(server): synthetic merged change', state: 'merged', updated_at: '2026-11-10T10:00:00Z', url: prLink(11) },
    { number: 9, title: 'perf(shared): synthetic closed change', state: 'closed', updated_at: '2026-11-02T10:00:00Z', url: prLink(9) },
  ],
});

// Temporary directories, removed by removeTempDirs (each test file that uses them registers it with after()).
const made = new Set();
export async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 't3cp-mrs-test-'));
  made.add(dir);
  return dir;
}
export async function removeTempDirs() {
  const dirs = [...made];
  made.clear();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

// The command line, against a local stand-in for the API (no network). The stand-in listens on the IPv4 loopback and the
// command line is given that address, never "localhost": where localhost resolves to ::1 for the server and to
// 127.0.0.1 for the client, the two would not meet. mrs.mjs accepts a loopback address as --api-base.
const CLI = fileURLToPath(new URL('./mrs.mjs', import.meta.url));

export async function runCli(args, respond, env = {}) {
  const server = createServer((req, res) => respond(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const child = spawn(process.execPath, [CLI, '--api-base', base, ...args], { env: { ...process.env, GITHUB_ACTIONS: '', T3CP_PRIVATE_PATTERNS: '', ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    return { code, stdout, stderr };
  } finally {
    server.close();
  }
}

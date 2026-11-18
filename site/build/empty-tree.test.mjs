// Red first: before the first record, data/v1 can hold the pipeline's status.json and nothing else. The build then
// makes the empty-state site; a tree with any record, fork or base file still goes through the aggregator, whose
// errors fail the build. The two output gates refuse a missing or empty tree: a build that wrote nothing is never
// "identical" or "within budget".
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const here = f => fileURLToPath(new URL(f, import.meta.url));
const cli = (script, ...args) => spawnSync(process.execPath, [here(script), ...args], { encoding: 'utf8' });

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 't3cp-empty-'));
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(root, 'in', rel, '..'), { recursive: true }); writeFileSync(join(root, 'in', rel), text); }
  return { root, in: join(root, 'in'), out: join(root, 'dist'), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a data tree holding only status.json builds the empty-state site and says so', async () => {
  // A valid status-1 document: a records-less build checks and publishes it.
  const t = tree({ 'status.json': JSON.stringify({ schema: 't3cp/status/1', generated_at: '2026-11-17T01:33:04.746Z', platforms: { 'linux-x64': { latest_record_id: null, latest_date: null, latest_status: null, queue: { pending: 0, active: 0 }, last_failure: null, heartbeat_at: null } } }) + '\n' });
  const lines = [], log = console.log;
  console.log = s => { lines.push(String(s)); };
  try {
    await build({ out: t.out, in: t.in, posts: 'news/posts' });
    console.log = log;
    assert.ok(existsSync(join(t.out, 'index.html')), 'the site is built');
    assert.ok(!existsSync(join(t.out, 'data/v1/index.json')), 'no aggregate output');
    assert.match(readFileSync(join(t.out, 'records/index.html'), 'utf8'), /No records yet\./);
    assert.ok(lines.some(l => /^data: .* holds no records yet; building the site with empty states$/.test(l)), lines.join('\n'));
  } finally { console.log = log; t.done(); }
});

test('a data tree with one malformed record still fails the build', async () => {
  const t = tree({ 'status.json': '{}\n', 'records/linux-x64/2026-11-20.v0.1.10-nightly.20261120.5850.json': '{"schema": "t3cp/record/1",' });
  try {
    await assert.rejects(build({ out: t.out, in: t.in, posts: 'news/posts' }), /aggregate/);
  } finally { t.done(); }
});

test('a fork or base file alone also goes through the aggregator', async () => {
  for (const rel of ['fork/v0.1.9-perf.9.linux-x64.json', 'base/0123456789ab.linux-x64.json']) {
    const t = tree({ 'status.json': '{}\n', [rel]: 'not json' });
    try {
      await assert.rejects(build({ out: t.out, in: t.in, posts: 'news/posts' }), /aggregate/, rel);
    } finally { t.done(); }
  }
});

test('same-tree and budgets refuse a missing or an empty tree', () => {
  const root = mkdtempSync(join(tmpdir(), 't3cp-gates-'));
  try {
    const empty = join(root, 'empty'), empty2 = join(root, 'empty2'), missing = join(root, 'missing'), full = join(root, 'full');
    mkdirSync(empty); mkdirSync(empty2); mkdirSync(full); writeFileSync(join(full, 'index.html'), '<!doctype html>\n');
    for (const [a, b] of [[empty, empty2], [missing, join(root, 'missing2')], [full, empty], [empty, full], [full, missing]]) {
      const r = cli('./same-tree.mjs', a, b);
      assert.notEqual(r.status, 0, `same-tree ${a} ${b}: ${r.stdout}${r.stderr}`);
      assert.doesNotMatch(r.stdout, /identical/);
    }
    for (const d of [empty, missing]) {
      const r = cli('./budgets.mjs', d);
      assert.notEqual(r.status, 0, `budgets ${d}: ${r.stdout}${r.stderr}`);
      assert.doesNotMatch(r.stdout, /passed/);
      assert.match(r.stderr, /missing|empty|no such/);
    }
    assert.equal(cli('./same-tree.mjs', full, full).status, 0, 'a tree is identical to itself');
    assert.equal(cli('./budgets.mjs', full).status, 0, 'a small tree passes');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

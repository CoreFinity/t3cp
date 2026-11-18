// Red first: the budget check fails the build when app.js is over its budget (21 KB gzipped since the launch-gaps
// budget decision; 20 KB before).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkBudgets, BUDGETS } from './budgets.mjs';

// Text that barely compresses, grown until its gzip size reaches `kb` KiB.
function incompressible(kb) {
  let s = '', x = 2463534242;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  while (gzipSync(s, { level: 9 }).length < kb * 1024) for (let i = 0; i < 512; i++) s += String.fromCharCode(33 + (next() % 94));
  return s;
}

function site(jsKb) {
  const dir = mkdtempSync(join(tmpdir(), 't3cp-budget-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title><p>ok</p>');
  writeFileSync(join(dir, 'assets', 'app.0123456789.css'), 'body{margin:0}');
  writeFileSync(join(dir, 'assets', 'app.0123456789.js'), incompressible(jsKb));
  return dir;
}

test('the budgets are the design figures (HTML 20, CSS 10, JS 21 KB gzipped)', () => {
  assert.deepEqual({ html: BUDGETS.html, css: BUDGETS.css, js: BUDGETS.js }, { html: 20 * 1024, css: 10 * 1024, js: 21 * 1024 });
});

test('a 22 KB gzipped app.js fails the check', () => {
  const dir = site(22);
  try {
    const r = checkBudgets(dir);
    assert.equal(r.ok, false);
    assert.deepEqual(r.over.map(o => [o.path, o.kind]), [['assets/app.0123456789.js', 'js']]);
    assert.ok(r.over[0].gz >= 22 * 1024);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the command fails the build (exit 1) on the same tree, and passes at 19 KB', () => {
  const cli = fileURLToPath(new URL('./budgets.mjs', import.meta.url));
  const big = site(22), small = site(19);
  try {
    const bad = spawnSync(process.execPath, [cli, big], { encoding: 'utf8' });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout + bad.stderr, /assets\/app\.0123456789\.js.*OVER/);
    const ok = spawnSync(process.execPath, [cli, small], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  } finally { rmSync(big, { recursive: true, force: true }); rmSync(small, { recursive: true, force: true }); }
});

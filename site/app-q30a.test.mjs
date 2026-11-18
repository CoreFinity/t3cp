// Red first: saturation has three kinds only (agents not served, calls timed out, MCP not ready by the start of the
// window), counted only when the server's own event loop is near fully busy. The driver falling behind is a defect
// that invalidates the attempt, never a saturation symptom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApp } from './build/lib/app-vm.mjs';
import { build } from './build/build.mjs';

const T = loadApp();

test('the three saturation kinds in plain words; the driver falling behind is not one of them', () => {
  assert.equal(T.satWords(['sessions_starved', 'call_timeouts', 'session_mcp_missing']), 'agents not served; calls timed out; MCP not ready by the start of the window');
  assert.equal(T.satWords(['driver_saturated']), '');
  assert.doesNotMatch(T.satWords(['call_timeouts', 'driver_saturated']), /driver/);
});

test('Methodology says saturation counts only when the server itself is near fully busy, and never names the driver', async () => {
  const out = mkdtempSync(join(tmpdir(), 't3cp-q30a-'));
  try {
    await build({ out, in: join(out, 'no-data-yet'), posts: 'news/posts' });
    const html = readFileSync(join(out, 'methodology/index.html'), 'utf8');
    assert.match(html, /only when the server's own event loop was at least 95% busy/);
    assert.doesNotMatch(html, /driver (fell|falls) behind/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

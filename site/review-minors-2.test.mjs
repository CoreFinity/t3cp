// Red first: the re-review's minors. No nightly wording for the fork's base; the publish build itself checks
// _headers against Appendix C; DEPLOY_ENABLED stays "false" until the reviewed go-live commit flips it with this
// test; the overview follows the selected level.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../tools/audit/lib/yaml-lite.mjs';
import { loadApp } from './build/lib/app-vm.mjs';
import { META, level, shard } from './build/lib/test-data.mjs';
import { build } from './build/build.mjs';

const T = loadApp();
const wf = parseYaml(readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'));

test('the built site never calls the fork\'s base a nightly', async () => {
  const out = mkdtempSync(join(tmpdir(), 't3cp-wording-'));
  try {
    await build({ out, in: join(out, 'no-data-yet'), posts: 'news/posts' });
    for (const p of ['about/index.html', 'releases/index.html', 'methodology/index.html']) {
      const html = readFileSync(join(out, p), 'utf8');
      assert.doesNotMatch(html, /nightl(y|ies) (it is|they are) based on/, p);
    }
    assert.match(readFileSync(join(out, 'about/index.html'), 'utf8'), /upstream base<\/b>: the upstream code at the commit the fork release is based on, built from source/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('the publish build job checks dist/_headers against Appendix C, and the check fails on a drift', async () => {
  const runs = wf.jobs.build.steps.map(s => s.run || '').join('\n');
  assert.match(runs, /node site\/build\/check-headers\.mjs dist/);
  const out = mkdtempSync(join(tmpdir(), 't3cp-hdr-'));
  try {
    await build({ out, in: join(out, 'no-data-yet'), posts: 'news/posts' });
    const cli = fileURLToPath(new URL('./build/check-headers.mjs', import.meta.url));
    assert.equal(spawnSync(process.execPath, [cli, out]).status, 0, 'the built _headers passes');
    writeFileSync(join(out, '_headers'), readFileSync(join(out, '_headers'), 'utf8').replace('max-age=300', 'max-age=31536000'));
    assert.equal(spawnSync(process.execPath, [cli, out]).status, 1, 'a drifted _headers fails the build');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('the public repository has no deploy flag at all (the deploy lives in the ops repository)', () => {
  assert.ok(!wf.env || !('DEPLOY_ENABLED' in wf.env), 'no DEPLOY_ENABLED');
  assert.ok(!('deploy' in wf.jobs), 'no deploy job');
});

test('the overview follows the selected level', () => {
  const lv = k => level(Array.from({ length: 10 }, () => k));
  const S = shard('elu', { 1: lv(0.1), 100: lv(0.5), 250: lv(0.9) });
  const val = L => T.lastPt(T.overviewModels(['elu'], { elu: S }, { elu: META.elu }, L, 30)[0]).v;
  assert.deepEqual(['1', '100', '250'].map(val), [0.1, 0.5, 0.9]);
});

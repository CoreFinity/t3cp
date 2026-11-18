// The posts scripts run their command line however they are reached: through a symlinked directory (on macOS,
// /var is one, to /private/var) or a path with a space. A script that compared argv[1] with its own path
// without resolving links did nothing there and exited 0 (fail open).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const SCRIPTS = ['news/check.mjs', 'site/build/release-post.mjs', 'site/build/release-bundle.mjs', 'site/build/release-build.mjs'];

// With no arguments each script prints its usage and exits 2: proof that its command line ran.
const run = (file) => spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 60000 });

test('each posts script runs its command line from its real path (control)', () => {
  for (const s of SCRIPTS) {
    const r = run(path.join(ROOT, s));
    assert.equal(r.status, 2, `${s}: ${r.stderr}`);
    assert.match(r.stderr, /usage: node /, s);
  }
});

test('each posts script runs its command line through a symlinked directory with a space in its name', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'posts-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'via link');
  symlinkSync(ROOT, link, 'dir');
  for (const s of SCRIPTS) {
    const r = run(path.join(link, s));
    assert.equal(r.status, 2, `${s} through a symlink: exit ${r.status}, ${r.stderr}`);
    assert.match(r.stderr, /usage: node /, s);
  }
});

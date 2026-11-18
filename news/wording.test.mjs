// The posts files never use the word "lead" (the agent-role pattern of the private gate): the headline level is
// the overview's 1 | 100 | 250 switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function files(dir, keep) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, keep));
    else if (keep(path.relative(ROOT, p))) out.push(p);
  }
  return out;
}

test('no posts file says "lead" (headline level instead)', () => {
  const mine = [
    ...files(path.join(ROOT, 'news'), () => true),
    ...files(path.join(ROOT, 'site', 'build'), (rel) => /site\/build\/release-/.test(rel)),
    path.join(ROOT, 'schema', 'release-1.json'),
  ];
  const re = new RegExp(['\\b', 'lead', '(?:s|_levels?|Row|_LEVELS)?\\b'].join(''), 'i');
  const hits = mine.filter((f) => !f.endsWith('wording.test.mjs')).flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l]))
    .filter(([, , l]) => re.test(l) || /LEAD_LEVELS|lead_level/.test(l)).map(([f, n]) => `${path.relative(ROOT, f)}:${n}`);
  assert.deepEqual(hits, []);
});

test('no posts file names the private ops repository or its documents', () => {
  const mine = [
    ...files(path.join(ROOT, 'news'), () => true),
    ...files(path.join(ROOT, 'site', 'build'), (rel) => /site\/build\/release-/.test(rel)),
    path.join(ROOT, 'schema', 'release-1.json'),
  ].filter((f) => !f.endsWith('wording.test.mjs'));
  const re = new RegExp(['t3cp', '-ops|INTER', 'FACES'].join(''));
  const hits = mine.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l])).filter(([, , l]) => re.test(l)).map(([f, n]) => `${path.relative(ROOT, f)}:${n}`);
  assert.deepEqual(hits, []);
});

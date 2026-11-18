// The public repository holds no deploy path: publish.yml only builds the site and checks it (twice and compared,
// budgets, _headers, the synthetic gate, the whole-output scan). The deploy runs from the private ops repository,
// which holds the Pages token; nothing here names a secret, an environment or a wrangler deploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml } from '../../tools/audit/lib/yaml-lite.mjs';

const text = readFileSync(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8');
const wf = parseYaml(text);

test('no deploy path: one build job, no secret, no environment, no wrangler deploy, no deploy flag', () => {
  assert.deepEqual(Object.keys(wf.jobs), ['build'], 'only the build job');
  assert.doesNotMatch(text, /secrets\./, 'no secret reference');
  assert.doesNotMatch(text, /^\s*environment:/m, 'no deployment environment');
  assert.doesNotMatch(text, /wrangler\s+pages\s+(deploy|project)/, 'no wrangler deploy or project call');
  assert.ok(!wf.env || !('DEPLOY_ENABLED' in wf.env || 'DEPLOY_BRANCH' in wf.env), 'no deploy flag or branch');
  assert.deepEqual(wf.permissions, { contents: 'read' });
  assert.ok(!('pull_request_target' in wf.on));
});

test('the build job runs every check, bounded, on main only', () => {
  const b = wf.jobs.build;
  assert.match(String(b.if), /github\.ref == 'refs\/heads\/main'/);
  assert.ok(Number(b['timeout-minutes']) > 0);
  const runs = b.steps.map(s => s.run || '').join('\n');
  for (const want of [/npm ci --ignore-scripts/, /build\.mjs[^\n]*--out dist /, /build\.mjs[^\n]*--out "\$RUNNER_TEMP\/dist-2"/, /same-tree\.mjs dist/, /budgets\.mjs dist/, /check-headers\.mjs dist/, /synthetic\.mjs check dist/, /scan-tree\.mjs dist/]) assert.match(runs, want);
  for (const s of b.steps) if (s.uses) assert.match(s.uses, /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/, `only checkout and setup-node: ${s.uses}`);
});

// The built site is scanned by scan-tree.mjs only. The public audit reads the repository (tracked files, diffs,
// messages), never dist/: run over a built site it reports the configured Plausible pa- script URL in every page's
// head, by design, and dist/ gets no exception in its patterns. Both places a maintainer looks say so.
test('the docs name scan-tree as the only scan of dist/, and the public audit as never run over it', () => {
  const prePush = readFileSync(new URL('../../tools/audit/pre-push.sh', import.meta.url), 'utf8');
  const head = s => s.split('\n').filter(l => l.startsWith('#')).join('\n');
  for (const [name, doc] of [['publish.yml', head(text)], ['pre-push.sh', head(prePush)]]) {
    assert.match(doc, /scan-tree\.mjs is the only scan of the built site/, name);
    assert.match(doc, /pa- script URL[^.]*every page/, name);
    assert.match(doc, /no exception for dist\//, name);
  }
});

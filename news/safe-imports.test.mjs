// The structural guard for news/ and site/build/: only tools/t3cp/lib/safe-errors.mjs reads the validator and the
// strict JSON parser, so every other file gets schema errors with safe paths and JSON errors as a kind and an
// offset. A print-pattern check is the second line of defence. And the strict parser's errors (whose text carries
// the document's keys) never reach a terminal: a duplicate key, a bad escape or an unterminated string under an
// invented-name key prints its kind and offset only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources() {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'node_modules') walk(p);
      else if (e.isFile() && /\.m?js$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'news'));
  walk(path.join(ROOT, 'site', 'build'));
  return files;
}
// Comments removed (a file may name the modules in prose).
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

test('no file in news/ or site/build/ imports the validator or the strict JSON parser: only safe-errors.mjs does', () => {
  const offenders = sources().filter((f) => /['"`][^'"`\n]*\b(?:validate|json)\.mjs['"`]/.test(code(readFileSync(f, 'utf8')))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(offenders, []);
});

// The second line of defence: a print of a validator path or of whole error objects, in any of the forms that
// slipped past a first, narrower check.
const RAW_PRINT = [
  /\$\{\s*[A-Za-z_$][\w$]*\.path\s*\}/,
  /(?:\b(?:e|err|error|issue)\b|\b\w*[Ee]rr(?:or)?s?\b(?:\[\d+\])?)(?:\?)?\.path\b/,
  /\b\w*[Ee]rr(?:or)?s?\b\s*\.map\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.path\b/,
  /\(\s*\{\s*path\b[^}]*\}\s*\)\s*=>/,
  /JSON\.stringify\(\s*\w*[Ee]rr(?:or)?s?\b/,
  /console\.\w+\(\s*\w*[Ee]rr(?:or)?s\b/,
  /\bformatErrors\s*\(/,
];
const rawPrints = (text) => code(text).split('\n').map((l, i) => [l, i + 1]).filter(([l]) => RAW_PRINT.some((re) => re.test(l))).map(([, n]) => n);

test('the print-pattern check catches every form that slipped past it before, and the ones it caught', () => {
  const forms = [
    'msg(`${errors[0].path}`);',
    'const s = e.path + " " + e.message;',
    'msg(`${errors[0].path.slice(1)}`);',
    'const s = [e.path, e.message].join(" ");',
    'out.write(JSON.stringify(errors));',
    'const lines = errors.map(({ path: p }) => `${p}`);',
    'console.error(errors);',
    'msg(`${errors.map((e) => e.path)}`);',
    'errors.map((e) => `${e.path} ${e.message}`);',
    'throw new Error(formatErrors(errors));',
  ];
  for (const f of forms) assert.deepEqual(rawPrints(f), [1], f);
  for (const ok of ['const s = formatSafeErrors(errors, schema, 5);', 'lines.push(`${x.path.padEnd(44)}`);', 'const file = join(out, f.path);', '.map((rel) => ({ path: rel, bytes: 1 }));']) {
    assert.deepEqual(rawPrints(ok), [], ok);
  }
});

test('no file in news/ or site/build/ prints a validator path or whole error objects', () => {
  const offenders = sources().flatMap((f) => rawPrints(readFileSync(f, 'utf8')).map((n) => `${path.relative(ROOT, f)}:${n}`));
  assert.deepEqual(offenders, []);
});

// A strict-JSON error under an invented-name key: the duplicate key, the bad escape, the unterminated string.
const BROKEN = {
  'a duplicate key': '{"zorblaxhost": 1, "zorblaxhost": 2}',
  'a bad escape': '{"zorblax host 4321": "a\\qb"}',
  'an unterminated string': '{"zorblaxhost": "4321',
};
const leaks = (s) => /zorblax|4321/i.test(String(s));

test('the aggregator reports a strict-JSON error in a record by kind and offset only', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = mkdtempSync(path.join(tmpdir(), 'safe-imports-data-'));
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 't3cp', 'dev', 'synth-data.mjs'), '--out', out], { stdio: 'ignore' });
  const inDir = path.join(out, 'input', 'v1');
  const recDir = path.join(inDir, 'records', 'linux-x64');
  const victim = readdirSync(recDir).filter((f) => f.endsWith('.json')).sort()[0];
  for (const [what, text] of Object.entries(BROKEN)) {
    const copy = mkdtempSync(path.join(tmpdir(), 'safe-imports-copy-'));
    cpSync(inDir, copy, { recursive: true });
    writeFileSync(path.join(copy, 'records', 'linux-x64', victim), text);
    // The output directory is its own temporary directory: never inside the input (the aggregator refuses that).
    const outDir = path.join(mkdtempSync(path.join(tmpdir(), 'safe-imports-out-')), 'out');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'site', 'build', 'aggregate.mjs'), '--in', copy, '--out', outDir, '--dev'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, what);
    assert.match(r.stderr, /not valid JSON \([a-z ',:{}\]]+, offset \d+\)/, `${what}: ${r.stderr}`);
    assert.equal(leaks(r.stderr + r.stdout), false, `${what}: ${r.stderr}`);
  }
});

test('the safe JSON reader gives the kind and the offset for each strict-JSON error, never the path', async () => {
  const { parseJsonStrict } = await import('../tools/t3cp/lib/safe-errors.mjs');
  for (const [what, text] of Object.entries(BROKEN)) {
    assert.throws(() => parseJsonStrict(text), (e) => /^not valid JSON \([a-z ',:{}\]]+, offset \d+\)$/.test(e.message) && !leaks(e.message), what);
  }
});

test('the site build reports a strict-JSON error in status.json or bands.json by kind and offset only', async () => {
  const { publishInput } = await import('../site/build/build.mjs');
  for (const rel of ['status.json', 'bands.json']) {
    for (const [what, text] of Object.entries(BROKEN)) {
      assert.throws(() => publishInput(rel, text), (e) => /not valid JSON \([a-z ',:{}\]]+, offset \d+\)/.test(e.message) && !leaks(e.message), `${rel}, ${what}`);
    }
  }
});

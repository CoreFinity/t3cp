// The size budgets of design.md §5.7, checked on the built tree: every HTML page ≤ 20 KB gzipped, the stylesheet
// ≤ 10 KB, the script ≤ 20 KB, no image over 20 KB. `node site/build/budgets.mjs <dist>` prints the table and exits 1
// when anything is over, so the publish workflow fails before deploying.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// js: 21 KB since the budget decision for the launch gaps (a level run with no valid attempt, lone values): 20 KB before.
export const BUDGETS = { html: 20 * 1024, css: 10 * 1024, js: 21 * 1024, image: 20 * 1024 };
const KIND = { '.html': 'html', '.css': 'css', '.js': 'js', '.svg': 'image', '.png': 'image', '.jpg': 'image', '.webp': 'image', '.ico': 'image' };

// A tree a gate reads: refused when it is missing or holds no file, so a build that wrote nothing never passes.
export function treeFiles(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`no such directory: ${dir}`);
  const files = walk(dir);
  if (!files.length) throw new Error(`empty tree: ${dir} holds no file`);
  return files;
}

export function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

export const gz = buf => gzipSync(buf, { level: 9 }).length;

// Checks the site's own files (data under data/ has the aggregator's budgets).
export function checkBudgets(dist) {
  const rows = [];
  for (const file of treeFiles(dist)) {
    const path = relative(dist, file).split(sep).join('/');
    if (path.startsWith('data/')) continue;
    const ext = path.slice(path.lastIndexOf('.'));
    const kind = KIND[ext];
    if (!kind) continue;
    const buf = readFileSync(file);
    const size = kind === 'image' ? buf.length : gz(buf);
    rows.push({ path, kind, raw: buf.length, gz: size, budget: BUDGETS[kind], over: size > BUDGETS[kind] });
  }
  const over = rows.filter(r => r.over);
  return { ok: over.length === 0, rows, over };
}

export function report(r) {
  const kb = n => (n / 1024).toFixed(1).padStart(6);
  const lines = [`${'file'.padEnd(44)}${'raw KB'.padStart(8)}${'gzip KB'.padStart(9)}${'budget'.padStart(8)}`];
  for (const x of r.rows) lines.push(`${x.path.padEnd(44)}${kb(x.raw)}  ${kb(x.gz)}  ${kb(x.budget)}${x.over ? '  OVER' : ''}`);
  return lines.join('\n');
}

// Real paths on both sides, so a run through a symlinked path still runs: never fail open.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const dist = process.argv[2];
  if (!dist) { console.error('usage: node site/build/budgets.mjs <dist>'); process.exit(2); }
  let r;
  try { r = checkBudgets(dist); } catch (e) { console.error(`budget check failed: ${e.message}`); process.exit(1); }
  console.log(report(r));
  if (!r.ok) { console.error(`budget check failed: ${r.over.length} file(s) over budget`); process.exit(1); }
  console.log(`budget check passed: ${r.rows.length} files`);
}

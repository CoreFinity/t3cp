// Byte-for-byte comparison of two built trees. The publish workflow builds the site twice and refuses to deploy
// unless both are identical: `node site/build/same-tree.mjs <a> <b>` exits 1 and names every differing file.
import { readFileSync, realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeFiles } from './budgets.mjs';

// A missing or empty tree is refused (treeFiles throws): two builds that wrote nothing are not identical.
const list = dir => treeFiles(dir).map(f => relative(dir, f).split(sep).join('/'));

export function compareTrees(a, b) {
  const la = list(a), lb = list(b), sb = new Set(lb), sa = new Set(la);
  const differ = la.filter(p => sb.has(p) && !readFileSync(`${a}/${p}`).equals(readFileSync(`${b}/${p}`)));
  return { files: la.length, differ, onlyA: la.filter(p => !sb.has(p)), onlyB: lb.filter(p => !sa.has(p)) };
}

// Real paths on both sides, so a run through a symlinked path still runs: never fail open.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) { console.error('usage: node site/build/same-tree.mjs <tree a> <tree b>'); process.exit(2); }
  let r;
  try { r = compareTrees(a, b); } catch (e) { console.error(`the two builds cannot be compared: ${e.message}`); process.exit(1); }
  r.differ.forEach(p => console.log(`differ: ${p}`));
  r.onlyA.forEach(p => console.log(`only in ${a}: ${p}`));
  r.onlyB.forEach(p => console.log(`only in ${b}: ${p}`));
  if (r.differ.length || r.onlyA.length || r.onlyB.length) { console.error('the two builds differ: refusing to deploy a non-deterministic build'); process.exit(1); }
  console.log(`the two builds are identical: ${r.files} files`);
}

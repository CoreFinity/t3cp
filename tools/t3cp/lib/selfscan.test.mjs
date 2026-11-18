// The repository's own tracked files pass the public scanner (the private list of concrete names runs in the
// private ops CI on the same commits). Files of the data workstream must be clean; findings in other paths are
// listed as diagnostics for their owners until the whole tree is clean, when OWNED can become every file.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "./repo.mjs";
import { scanText } from "./scan.mjs";

const OWNED = [/^catalogue\//, /^schema\/(record|attempt|extras|facts|series|index|bands|changes|compare|release-bundle)-1\.json$/, /^schema\/schemas\.test\.mjs$/, /^tools\/t3cp\/(export|export-review|merge|bands|scan-tree)(\.test)?\.mjs$/, /^site\/build\/aggregate-review\.test\.mjs$/, /^tools\/t3cp\/lib\//, /^tools\/t3cp\/dev\//, /^site\/build\/aggregate(\.test)?\.mjs$/];

test("self-scan: tracked files pass the public scanner", (t) => {
  let files;
  try {
    files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  } catch {
    return; // not a git checkout (an unpacked tarball): nothing to scan here
  }
  const owned = [];
  for (const rel of files) {
    const full = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(full) || fs.statSync(full).size > 2_000_000) continue;
    const bytes = fs.readFileSync(full);
    if (bytes.includes(0)) continue; // binary
    const text = bytes.toString("utf8");
    for (const hit of scanText(text, { env: false })) {
      const finding = `${rel}:${text.slice(0, hit.index).split("\n").length} ${hit.pattern}`;
      if (OWNED.some((re) => re.test(rel))) owned.push(finding);
      else t.diagnostic(`public-scan finding outside data's paths: ${finding}`);
    }
  }
  assert.deepEqual(owned, []);
});

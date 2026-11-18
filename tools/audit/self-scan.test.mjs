// The repository passes its own public scan: every tracked file, as it is on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { auditRepoFiles, formatHit } from "./audit-public-tree.mjs";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: fileURLToPath(new URL(".", import.meta.url)),
  encoding: "utf8",
}).trim();

test("self-scan: every tracked file of the repository passes audit-public-tree", () => {
  const { files, hits } = auditRepoFiles(ROOT);
  assert.ok(files > 0, "no tracked files found");
  assert.deepEqual(hits.map(formatHit), [], "public-scan hits in the repository");
});

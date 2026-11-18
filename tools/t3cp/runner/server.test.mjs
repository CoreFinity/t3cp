// The working copies the extras start a server on must be writable, whatever the source fixture's mode (the
// published fixture image ships it read-only, 0444).
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { cloneFile } from "./server.mjs";

const root = mkdtempSync(join(tmpdir(), "t3cp-clone-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("a copy of a read-only fixture is writable by its owner", () => {
  const src = join(root, "fixture.sqlite");
  writeFileSync(src, "not really a database\n");
  chmodSync(src, 0o444);
  const dst = join(root, "copy.sqlite");
  cloneFile(src, dst);
  assert.equal(statSync(dst).mode & 0o200, 0o200, "owner write bit");
  assert.equal(statSync(src).mode & 0o777, 0o444, "the source is left as it was");
});

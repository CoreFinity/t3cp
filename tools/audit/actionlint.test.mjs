// actionlint.sh: the pinned, sha256-verified actionlint over a repository's workflows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./actionlint.sh", import.meta.url));
const HEADER = "on: push\npermissions:\n  contents: read\njobs:\n";

const repoWith = (workflows) => {
  const root = mkdtempSync(join(tmpdir(), "t3cp-actionlint-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const [name, text] of Object.entries(workflows)) writeFileSync(join(root, ".github", "workflows", name), text);
  return root;
};

const lint = (root, env = {}) => {
  try {
    const out = execFileSync("bash", [SCRIPT, root], { encoding: "utf8", stdio: "pipe", env: { ...process.env, ...env } });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status, out: String(error.stdout) + String(error.stderr) };
  }
};

test("actionlint: secrets in a step-level or job-level if: fails the check", () => {
  const root = repoWith({
    "ci.yml": `${HEADER}  t:\n    if: \${{ secrets.TOKEN != '' }}\n    runs-on: ubuntu-24.04\n    steps:\n      - if: \${{ secrets.TOKEN != '' }}\n        run: echo ok\n`,
  });
  const result = lint(root);
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /ci\.yml:6:\d+: context "secrets" is not allowed here/);
  assert.match(result.out, /ci\.yml:9:\d+: context "secrets" is not allowed here/);
});

test("actionlint: an unquoted run: value holding ': ' is not YAML and fails the check", () => {
  const root = repoWith({
    "publish.yml": `${HEADER}  p:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo "::notice title=x::Deploy skipped: no token"\n`,
  });
  const result = lint(root);
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /publish\.yml:8:\d+: could not parse as YAML/);
});

test("actionlint: a valid workflow passes, secrets in a job-level env: included", () => {
  const root = repoWith({
    "ci.yml": `${HEADER}  t:\n    runs-on: ubuntu-24.04\n    env:\n      TOKEN: \${{ secrets.TOKEN }}\n    steps:\n      - run: 'echo "::notice::a: b"'\n`,
  });
  const result = lint(root);
  assert.equal(result.code, 0, result.out);
});

test("actionlint: a cached binary that is not the pinned build is never run", () => {
  const cache = mkdtempSync(join(tmpdir(), "t3cp-actionlint-cache-"));
  const fake = join(cache, "actionlint-1.7.12", "actionlint");
  mkdirSync(join(fake, ".."), { recursive: true });
  writeFileSync(fake, "#!/bin/sh\necho FAKE-ACTIONLINT\nexit 0\n");
  chmodSync(fake, 0o755);
  const root = repoWith({
    "ci.yml": `${HEADER}  t:\n    runs-on: ubuntu-24.04\n    steps:\n      - if: \${{ secrets.TOKEN != '' }}\n        run: echo ok\n`,
  });
  const result = lint(root, { T3CP_TOOLS_CACHE: cache });
  assert.equal(result.code, 2, result.out);
  assert.doesNotMatch(result.out, /FAKE-ACTIONLINT/);
  assert.notEqual(readFileSync(fake, "utf8").includes("FAKE-ACTIONLINT"), true, "the impostor is replaced");
});

test("actionlint: a repository without workflows fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "t3cp-actionlint-none-"));
  assert.equal(lint(root).code, 1);
});

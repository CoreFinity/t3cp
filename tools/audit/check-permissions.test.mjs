// Workflow permissions match design Appendix D; write-all and read-all never pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MATRIX, checkWorkflow } from "./check-permissions.mjs";

const CLI = fileURLToPath(new URL("./check-permissions.mjs", import.meta.url));

const repoWith = (files) => {
  const root = mkdtempSync(join(tmpdir(), "t3cp-perms-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

const run = (root) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, "--root", root], { encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    return { code: error.status, out: String(error.stdout) + String(error.stderr) };
  }
};

const ci = (permissions, jobExtra = "") =>
  `name: ci\non:\n  pull_request:\n  push:\n    branches: [main]\n${permissions}jobs:\n  test:\n    runs-on: ubuntu-24.04\n${jobExtra}    steps:\n      - run: node --test\n`;

const reasons = (name, text) => checkWorkflow(name, text).map((f) => f.reason);

test("permissions: a workflow given permissions: write-all fails the permissions check", () => {
  const root = repoWith({ ".github/workflows/ci.yml": ci("permissions: write-all\n") });
  const result = run(root);
  assert.equal(result.code, 2);
  assert.match(result.out, /\.github\/workflows\/ci\.yml: permissions-shorthand/);
});

test("permissions: ci with contents: read at the top passes", () => {
  const root = repoWith({ ".github/workflows/ci.yml": ci("permissions:\n  contents: read\n") });
  assert.equal(run(root).code, 0);
  assert.deepEqual(reasons("ci", ci("permissions: {}\n")), []);
});

test("permissions: read-all and a job-level write-all fail too", () => {
  assert.deepEqual(reasons("ci", ci("permissions: read-all\n")), ["permissions-shorthand"]);
  assert.deepEqual(
    reasons("ci", ci("permissions: {}\n", "    permissions: write-all\n")),
    ["permissions-shorthand"],
  );
});

test("permissions: a missing top-level permissions block fails", () => {
  assert.deepEqual(reasons("ci", ci("")), ["missing-top-level-permissions"]);
});

test("permissions: the top level grants read at most", () => {
  assert.deepEqual(
    reasons("publish", "on: push\npermissions:\n  contents: write\njobs:\n  p:\n    environment: production\n    steps: []\n"),
    ["top-level-permissions-too-broad"],
  );
});

test("permissions: a job may not exceed its workflow's row of the matrix", () => {
  assert.deepEqual(
    reasons("ci", ci("permissions: {}\n", "    permissions:\n      contents: write\n")),
    ["permission-exceeds-matrix"],
  );
  assert.deepEqual(
    reasons("ci", ci("permissions: {}\n", "    permissions:\n      id-token: write\n")),
    ["permission-exceeds-matrix"],
  );
  // Appendix D: publish commits nothing, so its jobs read contents at most (the review found write allowed).
  const publish = (level) =>
    `on:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  deploy:\n    environment: production\n    permissions:\n      contents: ${level}\n    steps: []\n`;
  assert.deepEqual(reasons("publish", publish("read")), []);
  assert.deepEqual(reasons("publish", publish("write")), ["permission-exceeds-matrix"]);
  const freshness =
    "on:\n  schedule:\n    - cron: '0 6 * * *'\npermissions:\n  contents: read\njobs:\n  check:\n    permissions: { issues: write, contents: read }\n    steps: []\n";
  assert.deepEqual(reasons("freshness", freshness), []);
});

test("permissions: environments follow the matrix", () => {
  const publish = (env) =>
    `on:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  deploy:\n    environment: ${env}\n    steps: []\n`;
  assert.deepEqual(reasons("publish", publish("production")), []);
  assert.deepEqual(reasons("publish", publish("\n      name: production")), []);
  assert.deepEqual(reasons("publish", publish("news")), ["environment-not-allowed"]);
  assert.deepEqual(reasons("ci", ci("permissions: {}\n", "    environment: production\n")), ["environment-not-allowed"]);
});

test("permissions: publish's deploy job alone runs in production and alone takes secrets", () => {
  const two =
    "on:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  build:\n    environment: production\n    steps: []\n  deploy:\n    environment: production\n    steps: []\n";
  assert.deepEqual(reasons("publish", two), ["environment-not-alone"]);
  const leaky =
    "on:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  build:\n    steps:\n      - run: echo ${{ secrets.CLOUDFLARE_API_TOKEN }}\n  deploy:\n    environment: production\n    steps:\n      - run: echo ${{ secrets.CLOUDFLARE_API_TOKEN }}\n";
  assert.deepEqual(reasons("publish", leaky), ["secrets-outside-environment"]);
  const ok =
    "on:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  build:\n    steps:\n      - run: npm test\n  deploy:\n    environment: production\n    steps:\n      - run: echo ${{ secrets.CLOUDFLARE_API_TOKEN }}\n";
  assert.deepEqual(reasons("publish", ok), []);
  const workflowEnv = ok.replace("permissions:\n  contents: read\n", "permissions:\n  contents: read\nenv:\n  T: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n");
  assert.deepEqual(reasons("publish", workflowEnv), ["secrets-outside-environment"]);
});

test("permissions: unknown workflows, pull_request_target and secrets in ci fail", () => {
  assert.deepEqual(reasons("deploy-preview", ci("permissions: {}\n")), ["unknown-workflow"]);
  // news is an ops workflow (Appendix D); a t3cp workflow of that name is unknown here.
  assert.deepEqual(reasons("news", ci("permissions: {}\n")), ["unknown-workflow"]);
  assert.deepEqual(
    reasons("ci", "on: pull_request_target\npermissions: {}\njobs:\n  t:\n    steps: []\n"),
    ["pull-request-target"],
  );
  assert.deepEqual(
    reasons("ci", ci("permissions: {}\n").replace("node --test", "echo ${{ secrets.TOKEN }}")),
    ["secrets-not-allowed"],
  );
});

test("permissions: the matrix rows are the design's Appendix D for the public repository", () => {
  assert.deepEqual(Object.keys(MATRIX).sort(), ["ci", "freshness", "publish"]);
  assert.deepEqual(MATRIX.ci.permissions, { contents: "read" });
  assert.deepEqual(MATRIX.publish.permissions, { contents: "read" });
  assert.deepEqual(MATRIX.publish.environments, ["production"]);
  assert.deepEqual(MATRIX.freshness.permissions, { issues: "write", contents: "read" });
});

test("permissions: an unparseable workflow fails closed (exit 1)", () => {
  const root = repoWith({ ".github/workflows/ci.yml": "on: push\npermissions: &p {}\njobs: {}\n" });
  assert.equal(run(root).code, 1);
});

test("permissions: a secrets expression spelled with escapes or in another case is still a secret", () => {
  // s is "s": GitHub reads the decoded scalar, so the check must too.
  const escaped = ci("permissions: {}\n").replace("node --test", '"echo ${{ \\u0073ecrets.TOKEN }}"');
  assert.deepEqual(reasons("ci", escaped), ["secrets-not-allowed"]);
  const upper = ci("permissions: {}\n").replace("node --test", "echo ${{ SECRETS.TOKEN }}");
  assert.deepEqual(reasons("ci", upper), ["secrets-not-allowed"]);
});

test("permissions: a reusable workflow given secrets: inherit outside the environment is refused", () => {
  const publish =
    "on:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  build:\n    steps:\n      - run: npm test\n" +
    "  call:\n    uses: o/r/.github/workflows/deploy.yml@0123456789012345678901234567890123456789\n    secrets: inherit\n";
  assert.deepEqual(reasons("publish", publish), ["secrets-outside-environment"]);
  const mapped = publish.replace("secrets: inherit", "secrets:\n      TOKEN: x");
  assert.deepEqual(reasons("publish", mapped), ["secrets-outside-environment"]);
});

test("permissions: whitespace an escape spells (a tab, a newline, several spaces) before secrets is still a secret", () => {
  for (const space of ["\\t", "\\n", "   ", "\\t \\n"]) {
    // A double-quoted scalar: GitHub resolves the escape, so the expression it reads names the secrets context.
    const run = `"echo \${{${space}secrets.T }}"`;
    assert.deepEqual(reasons("ci", ci("permissions: {}\n").replace("node --test", run)), ["secrets-not-allowed"], space);
    const publish =
      "on:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  build:\n    steps:\n" +
      `      - run: ${run}\n  deploy:\n    environment: production\n    steps:\n      - run: npm test\n`;
    assert.deepEqual(reasons("publish", publish), ["secrets-outside-environment"], space);
  }
});

test("permissions: secrets: inherit is refused outside the environment however its key is written", () => {
  for (const key of ["secrets", '"secrets"', "'secrets'"]) {
    const publish =
      "on:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n" +
      `  call:\n    uses: o/r/.github/workflows/deploy.yml@0123456789012345678901234567890123456789\n    ${key}: inherit\n`;
    assert.deepEqual(reasons("publish", publish), ["secrets-outside-environment"], key);
    assert.deepEqual(reasons("ci", ci("permissions: {}\n").replace("    steps:\n", `    ${key}: inherit\n    steps:\n`)), ["secrets-not-allowed"], key);
  }
});

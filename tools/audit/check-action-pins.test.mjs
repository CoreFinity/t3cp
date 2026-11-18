// Every `uses:` in the repository's workflows and composite actions is pinned by full commit SHA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkActionPins, checkWorkflowText } from "./check-action-pins.mjs";

const CLI = fileURLToPath(new URL("./check-action-pins.mjs", import.meta.url));
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

const repoWith = (files) => {
  const root = mkdtempSync(join(tmpdir(), "t3cp-pins-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

const run = (root) => {
  try {
    const stdout = execFileSync(process.execPath, [CLI, "--root", root], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout) + String(error.stderr) };
  }
};

test("pins: actions/checkout@v4 (a tag, not a SHA) fails the pin check", () => {
  const root = repoWith({
    ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - uses: actions/checkout@v4\n",
  });
  const result = run(root);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /\.github\/workflows\/ci\.yml:4: unpinned-action/);
});

test("pins: a 40-hex SHA with its version comment passes, and the counts agree", () => {
  const root = repoWith({
    ".github/workflows/ci.yml": `jobs:\n  t:\n    steps:\n      - uses: actions/checkout@${SHA} # v7.0.1\n      - name: x\n        uses: "actions/setup-node@${SHA}"\n`,
  });
  const result = checkActionPins(root);
  assert.equal(result.uses, 2);
  assert.equal(result.pinned, 2);
  assert.deepEqual(result.findings, []);
  assert.equal(run(root).code, 0);
});

test("pins: short SHAs, branches, uppercase hex and unpinned docker images fail", () => {
  for (const ref of [
    "actions/checkout@3d3c42e",
    "actions/checkout@main",
    `actions/checkout@${SHA.toUpperCase()}`,
    `actions/checkout@${SHA}0`,
    "docker://alpine:3.20",
    "actions/checkout",
  ]) {
    const { findings } = checkWorkflowText(`steps:\n  - uses: ${ref}\n`, "w.yml");
    assert.equal(findings.length, 1, ref);
  }
});

test("pins: local actions, digest-pinned images and sub-path actions pass", () => {
  const text = [
    "steps:",
    "  - uses: ./.github/actions/setup",
    `  - uses: docker://alpine@sha256:${"a".repeat(64)}`,
    `  - uses: github/codeql-action/init@${SHA}`,
    `  - uses: 'actions/cache@${SHA}' # v4`,
  ].join("\n");
  const result = checkWorkflowText(text, "w.yml");
  assert.equal(result.uses, 4);
  assert.deepEqual(result.findings, []);
});

test("pins: composite actions under .github are checked too", () => {
  const root = repoWith({
    ".github/actions/setup/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n",
  });
  const result = run(root);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /\.github\/actions\/setup\/action\.yml:4: unpinned-action/);
});

test("pins: a repository without workflows passes with zero uses", () => {
  const result = checkActionPins(repoWith({ "README.md": "x\n" }));
  assert.equal(result.uses, 0);
  assert.deepEqual(result.findings, []);
});

test("pins: flow-style steps and quoted uses keys are read too", () => {
  for (const step of ["      - { uses: actions/checkout@v4 }\n", '      - "uses": actions/checkout@v4\n', "      - {'uses': 'actions/checkout@v4', with: {fetch-depth: 0}}\n"]) {
    const root = repoWith({ ".github/workflows/ci.yml": `jobs:\n  t:\n    steps:\n${step}` });
    const result = run(root);
    assert.equal(result.code, 2, `${step.trim()}: ${result.stdout}`);
    assert.match(result.stdout, /unpinned-action/);
  }
  const pinned = repoWith({ ".github/workflows/ci.yml": `jobs:\n  t:\n    steps:\n      - { uses: actions/checkout@${SHA} }\n` });
  assert.equal(run(pinned).code, 0);
});

test("pins: a local composite action outside .github is followed and its uses checked", () => {
  const root = repoWith({
    ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - uses: ./actions/setup\n",
    "actions/setup/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n",
  });
  const result = run(root);
  assert.equal(result.code, 2, result.stdout);
  assert.match(result.stdout, /actions\/setup\/action\.yml:4: unpinned-action/);
  const missing = repoWith({ ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - uses: ./actions/nowhere\n" });
  assert.equal(run(missing).code, 2, "a local action that is not there fails closed");
});

// The YAML subset the workflow checks read, and its fail-closed refusals.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseYaml } from "./yaml-lite.mjs";

test("yaml-lite: block maps, sequences, flow collections and scalars", () => {
  const text = [
    "# a comment",
    "name: ci",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main, 'release/*']",
    "permissions: {}",
    "env:",
    '  A: "x # not a comment"',
    "  B: 'it''s'",
    "  C: 3",
    "  D: true",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-24.04 # trailing",
    "    permissions: { contents: read, issues: write }",
    "    steps:",
    "      - uses: actions/checkout@abc",
    "        with:",
    "          fetch-depth: 0",
    "      - name: run",
    "        run: |",
    "          echo one: two",
    "          # kept",
    "",
    "          echo three",
    "      -",
    "        name: bare dash",
    "list:",
    "- a",
    "- b",
  ].join("\n");
  const doc = parseYaml(text);
  assert.equal(doc.name, "ci");
  assert.deepEqual(doc.on, { pull_request: null, push: { branches: ["main", "release/*"] } });
  assert.deepEqual(doc.permissions, {});
  assert.deepEqual(doc.env, { A: "x # not a comment", B: "it's", C: "3", D: true });
  assert.equal(doc.jobs.test["runs-on"], "ubuntu-24.04");
  assert.deepEqual(doc.jobs.test.permissions, { contents: "read", issues: "write" });
  assert.equal(doc.jobs.test.steps[0].uses, "actions/checkout@abc");
  assert.deepEqual(doc.jobs.test.steps[0].with, { "fetch-depth": "0" });
  assert.equal(doc.jobs.test.steps[1].run, "echo one: two\n# kept\n\necho three\n");
  assert.equal(doc.jobs.test.steps[2].name, "bare dash");
  assert.deepEqual(doc.list, ["a", "b"]);
});

test("yaml-lite: anchors, aliases, tags, complex keys, tabs and duplicate keys are refused", () => {
  for (const text of [
    "a: &x 1\n",
    "a: *x\n",
    "a: !!str 1\n",
    "? a\n: b\n",
    "a:\n\tb: 1\n",
    "a: 1\na: 2\n",
    "a: [1,\n  2]\n",
    "a: b\n  c\n",
    "---\na: 1\n---\nb: 2\n",
  ]) {
    assert.throws(() => parseYaml(text), undefined, JSON.stringify(text));
  }
});

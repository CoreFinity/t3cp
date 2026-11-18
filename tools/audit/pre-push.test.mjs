// pre-push.sh runs what ci.yml runs, so nothing red reaches main.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = new URL(".", import.meta.url);
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, HERE)), "utf8");

/** `node <script> <flags>` and `tools/audit/<name>.sh` invocations in a text: {script, flags}. */
const invocations = (text) =>
  [...text.matchAll(/(?:\bnode\s+(--test\b|tools\/audit\/[a-z-]+\.mjs)|(?<![\w/])(tools\/audit\/(?!pre-push)[a-z-]+\.sh))([^\n]*)/g)].map(
    (match) => ({
      script: match[1] ?? match[2],
      flags: new Set([...match[3].matchAll(/--[a-z-]+/g)].map((flag) => flag[0]).filter((flag) => flag !== "--repo")),
    }),
  );

const label = (call) => `${call.script} ${[...call.flags].sort().join(" ")}`.trim();

test("pre-push: the script exists, is executable and fails on the first error", () => {
  const path = fileURLToPath(new URL("./pre-push.sh", HERE));
  accessSync(path, constants.X_OK);
  assert.match(read("./pre-push.sh"), /set -euo pipefail/);
});

test("pre-push: every check ci.yml runs is in pre-push.sh with the same modes", () => {
  const ci = invocations(read("../../.github/workflows/ci.yml"));
  const local = invocations(read("./pre-push.sh"));
  assert.ok(ci.length >= 6, `ci.yml checks: ${ci.map(label).join("; ")}`);
  for (const check of ci) {
    const covered = local.some(
      (call) => call.script === check.script && [...check.flags].every((flag) => call.flags.has(flag)),
    );
    assert.ok(covered, `pre-push.sh lacks: ${label(check)}`);
  }
});

test("pre-push: a hung test fails after 30 minutes instead of blocking the gate", () => {
  // CI (one runner per job) runs the whole suite in minutes and caps each test file at 10 minutes. The shared
  // development machine runs the slowest file for over 17 minutes when loaded (1,029 s measured), so the local
  // cap is 30 minutes: a hang still fails, a slow but healthy file does not.
  const script = readFileSync(fileURLToPath(new URL("./pre-push.sh", import.meta.url)), "utf8");
  assert.match(script, /^step node --test --test-timeout=1800000$/m);
  assert.doesNotMatch(script, /^step node --test$/m);
});

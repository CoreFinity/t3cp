// ci.yml bills one job per run: main and pull requests to main only, one job, cancelled when
// superseded, bounded, and every check runs even after another one fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseYaml } from "./lib/yaml-lite.mjs";

const ci = parseYaml(readFileSync(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8"));

test("ci: runs on pushes to main and pull requests to main only", () => {
  assert.deepEqual(ci.on, { push: { branches: ["main"] }, pull_request: { branches: ["main"] } });
});

test("ci: a newer run on the same ref cancels the older one", () => {
  assert.deepEqual(ci.concurrency, { group: "ci-${{ github.ref }}", "cancel-in-progress": true });
});

test("ci: one job with a timeout, every check after the setup steps runs whatever failed before", () => {
  const jobs = Object.entries(ci.jobs);
  assert.equal(jobs.length, 1);
  const [, job] = jobs[0];
  assert.equal(job["timeout-minutes"], "20");
  const checks = job.steps.filter((step) => step.run !== undefined);
  assert.ok(checks.length >= 7, `checks: ${checks.length}`);
  for (const step of checks) {
    assert.match(String(step.if ?? ""), /^\$\{\{ (?:!cancelled\(\)|always\(\)) \}\}$/, step.name ?? step.run);
  }
  assert.ok(checks.some((step) => /tools\/audit\/actionlint\.sh/.test(step.run)), "actionlint runs in ci");
});

test("ci: a hung test fails after 10 minutes instead of holding the job until its own timeout", () => {
  const [, job] = Object.entries(ci.jobs)[0];
  const tests = job.steps.filter((step) => /^node --test\b/.test(String(step.run ?? "")));
  assert.equal(tests.length, 1);
  assert.equal(tests[0].run, "node --test --test-timeout=600000");
});

const auditStep = () => {
  const [, job] = Object.entries(ci.jobs)[0];
  const step = job.steps.find((s) => /audit-public-tree\.mjs --diff/.test(String(s.run ?? "")));
  assert.ok(step, "the diff and messages audit step");
  return step;
};

test("ci: every range the audit step scans is also scanned commit by commit (--each)", () => {
  const calls = String(auditStep().run).split("\n").filter((line) => /audit-public-tree\.mjs/.test(line));
  assert.equal(calls.length, 3, calls.join("\n"));
  for (const call of calls) assert.match(call, /--each /, call);
});

test("ci: a push whose before is not in the clone scans every commit of the push, not only the last", () => {
  const j = (...parts) => parts.join("");
  const token = j("gh", "p_", "A1b2".repeat(9));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const root = mkdtempSync(join(tmpdir(), "t3cp-ci-push-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(root, "README.md"), "clean\n");
  git("add", "-A");
  git("commit", "-q", "-m", "a");
  writeFileSync(join(root, "site.js"), `const t = "${token}";\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "b");
  writeFileSync(join(root, "site.js"), "const t = null;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "c");
  const tools = fileURLToPath(new URL(".", import.meta.url));
  const script = String(auditStep().run).replaceAll("tools/audit/", tools);
  const run = (before) =>
    spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, EVENT_NAME: "push", PUSH_BEFORE: before, PUSH_AFTER: git("rev-parse", "HEAD"), PR_BASE: "", PR_HEAD: "" },
    });
  // A force-push's old head, or a new branch's zeros: neither is in the clone.
  for (const before of ["f".repeat(40), "0".repeat(40)]) {
    const result = run(before);
    assert.equal(result.status, 2, `${before.slice(0, 4)}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /site\.js:1: secret-github-token/);
  }
});

test("CODEOWNERS: data/, the automation, the audit and CODEOWNERS itself are owned by an account that exists", () => {
  // The main ruleset requires a code owner's review; an owner that does not exist enforces nothing.
  const text = readFileSync(fileURLToPath(new URL("../../CODEOWNERS", import.meta.url)), "utf8");
  const rules = text.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#")).map((line) => line.trim().split(/\s+/));
  assert.deepEqual(rules.map((rule) => rule[0]).sort(), ["/.github/", "/CODEOWNERS", "/data/", "/tools/audit/"]);
  for (const [path, ...owners] of rules) assert.deepEqual(owners, ["@navidnadali"], path);
});

test("dependabot: no version-update config in the tree (the public repository takes no automated update branches)", () => {
  // After go-live every branch but main is blocked, so version-update pull requests could not work; and a config in
  // the published tree makes GitHub open one at once.
  for (const name of ["dependabot.yml", "dependabot.yaml"]) {
    assert.equal(existsSync(fileURLToPath(new URL(`../../.github/${name}`, import.meta.url))), false, `.github/${name}`);
  }
});

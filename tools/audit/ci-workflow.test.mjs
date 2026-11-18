// ci.yml bills one job per run: main and pull requests to main only, one job, bounded, and every check runs even after
// another one fails. A run on main is never cancelled (every main commit gets a result); on another ref a newer run
// cancels the older one.
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

/**
 * A GitHub Actions expression, `${{ ... }}` or a plain value, evaluated for one context: the subset a concurrency
 * setting uses (string and boolean literals, github.<name>, format(), ==, !=, !, && and || returning an operand as
 * GitHub does, parentheses). Anything else throws, so the test never passes on an expression it cannot read.
 */
function evaluateValue(value, github) {
  if (typeof value === "boolean") return value;
  const m = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(String(value));
  if (!m) {
    // Text with embedded expressions (ci-${{ github.ref }}): each one evaluated and inserted as a string.
    if (/\$\{\{/.test(String(value))) return String(value).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => String(evaluateValue(`\${{${e}}}`, github)));
    return value === "true" ? true : value === "false" ? false : String(value);
  }
  const tokens = m[1].match(/'(?:[^']|'')*'|==|!=|&&|\|\||[!(),]|[A-Za-z_][A-Za-z0-9_.-]*|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const truthy = (v) => v !== false && v !== "" && v !== null && v !== undefined && v !== 0;
  // GitHub compares strings case-insensitively.
  const eq = (a, b) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const primary = () => {
    const t = next();
    if (t === "(") {
      const v = or();
      if (next() !== ")") throw new Error("missing )");
      return v;
    }
    if (t === "!") return !truthy(primary());
    if (/^'/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
    if (t === "true" || t === "false") return t === "true";
    if (t === "format" && peek() === "(") {
      next();
      const args = [or()];
      while (peek() === ",") { next(); args.push(or()); }
      if (next() !== ")") throw new Error("missing ) after format arguments");
      const [fmt, ...rest] = args;
      if (typeof fmt !== "string") throw new Error("format needs a string");
      return fmt.replace(/\{(\d+)\}/g, (_, n) => {
        if (Number(n) >= rest.length) throw new Error(`format {${n}} has no argument`);
        return String(rest[Number(n)]);
      });
    }
    if (/^github\.[a-z_]+$/.test(t)) {
      const key = t.slice("github.".length);
      if (!(key in github)) throw new Error(`unknown context ${t}`);
      return github[key];
    }
    throw new Error(`unsupported token ${t}`);
  };
  const comparison = () => {
    let v = primary();
    while (peek() === "==" || peek() === "!=") {
      const op = next();
      const r = primary();
      v = op === "==" ? eq(v, r) : !eq(v, r);
    }
    return v;
  };
  const and = () => {
    let v = comparison();
    while (peek() === "&&") { next(); const r = comparison(); v = truthy(v) ? r : v; }
    return v;
  };
  const or = () => {
    let v = and();
    while (peek() === "||") { next(); const r = and(); v = truthy(v) ? v : r; }
    return v;
  };
  const v = or();
  if (i !== tokens.length) throw new Error(`trailing tokens in ${m[1]}`);
  return v;
}
const evaluate = (value, github) => {
  const v = evaluateValue(value, github);
  return v !== false && v !== "" && v !== null && v !== undefined && v !== 0;
};

/** ci.yml's concurrency for one push: its group and whether it cancels the group's run in progress. */
const concurrencyOf = (ref, sha) => ({
  group: String(evaluateValue(ci.concurrency.group, { ref, sha })),
  cancel: evaluate(ci.concurrency["cancel-in-progress"], { ref, sha }),
});

/**
 * GitHub's concurrency rule for runs that arrive while the first is still running: a group holds one running run and
 * at most ONE pending run. A new run cancels the group's running one when it cancels in progress; otherwise it waits,
 * and any run already pending in its group is cancelled. Returns the runs that were cancelled.
 */
function cancelledAmong(arrivals) {
  const running = new Map();
  const pending = new Map();
  const cancelled = [];
  for (const run of arrivals) {
    const { group, cancel } = concurrencyOf(run.ref, run.sha);
    if (!running.has(group)) { running.set(group, run); continue; }
    if (cancel) {
      cancelled.push(running.get(group));
      if (pending.has(group)) cancelled.push(pending.get(group));
      pending.delete(group);
      running.set(group, run);
      continue;
    }
    if (pending.has(group)) cancelled.push(pending.get(group));
    pending.set(group, run);
  }
  return cancelled.map((r) => r.sha);
}

const MAIN = "refs/heads/main";
const sha = (c) => c.repeat(40);

test("ci: every main commit has its own group (ci-<ref>-<sha>) and is never cancelled; any other ref shares ci-<ref> and cancels", () => {
  const a = concurrencyOf(MAIN, sha("a"));
  const b = concurrencyOf(MAIN, sha("b"));
  assert.equal(a.group, `ci-${MAIN}-${sha("a")}`);
  assert.notEqual(a.group, b.group, "two main commits, two groups");
  assert.equal(a.cancel, false);
  for (const ref of ["refs/pull/12/merge", "refs/heads/ws/site", "refs/heads/main-old"]) {
    const x = concurrencyOf(ref, sha("a"));
    const y = concurrencyOf(ref, sha("b"));
    assert.equal(x.group, `ci-${ref}`, ref);
    assert.equal(x.group, y.group, `${ref}: one group whatever the commit`);
    assert.equal(x.cancel, true, ref);
  }
});

test("ci: a burst on main (A running, B pending, C arriving) completes every run; on a pull request only the newest survives", () => {
  const burst = (ref) => ["a", "b", "c", "d", "e", "f"].map((c) => ({ ref, sha: sha(c) }));
  assert.deepEqual(cancelledAmong(burst(MAIN)), [], "no main run is cancelled, B included");
  assert.deepEqual(cancelledAmong(burst("refs/pull/7/merge")), ["a", "b", "c", "d", "e"].map(sha));
});

test("ci: the expression reader refuses what it cannot evaluate, and evaluates as GitHub does", () => {
  assert.equal(evaluate("${{ github.ref != 'refs/heads/main' }}", { ref: "refs/heads/MAIN" }), false, "case-insensitive, as GitHub");
  assert.equal(evaluateValue("${{ github.ref == 'x' && format('{0}-{1}', 'p', github.sha) || 'q' }}", { ref: "x", sha: "s" }), "p-s");
  assert.equal(evaluateValue("${{ github.ref == 'x' && format('{0}-{1}', 'p', github.sha) || 'q' }}", { ref: "y", sha: "s" }), "q");
  // The per-ref rule alone (the group shared on main) still loses B: one pending run per group.
  const shared = { ...ci.concurrency, group: "ci-${{ github.ref }}", "cancel-in-progress": "${{ github.ref != 'refs/heads/main' }}" };
  const one = (s) => ({ group: String(evaluateValue(shared.group, { ref: MAIN, sha: s })), cancel: evaluate(shared["cancel-in-progress"], { ref: MAIN }) });
  assert.equal(one(sha("a")).group, one(sha("b")).group);
  assert.throws(() => evaluate("${{ startsWith(github.ref, 'refs/heads/') }}", { ref: "x" }));
  assert.throws(() => evaluate("${{ github.head_ref == 'x' }}", { ref: "x" }), /unknown context/);
  assert.throws(() => evaluateValue("${{ format('{1}', 'a') }}", { ref: "x" }), /no argument/);
  assert.equal(evaluateValue("ci-${{ github.ref }}", { ref: "x" }), "ci-x", "text with an embedded expression");
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

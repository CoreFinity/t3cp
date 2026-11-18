#!/usr/bin/env node
// check-permissions: every workflow's `permissions` stays inside design Appendix D's matrix.
//
// usage: node tools/audit/check-permissions.mjs [--root <repo dir>]
// A workflow is known by its file name (`ci.yml` is `ci`); an unknown one fails. The top level
// must declare `permissions` and grant read at most; a job may not exceed its workflow's row;
// `write-all`/`read-all` never pass; environments follow the row, and a row with an environment
// lets one job alone run in it and take the secrets; `pull_request_target` is refused; `ci` uses
// no secrets. Prints `path: reason[ detail]`; exit 0 clean, 2 findings,
// 1 on an error (an unreadable or unparseable workflow fails closed).
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { EXIT, isMain, parseArgs, runCli } from "./lib/cli.mjs";
import { parseYaml } from "./lib/yaml-lite.mjs";

/**
 * Design Appendix D, the rows for this repository's workflows. publish commits nothing (contents:
 * read); its deploy job alone runs in `production` and alone takes the secrets. news is an ops
 * workflow, so it has no row here.
 */
export const MATRIX = Object.freeze({
  ci: Object.freeze({ permissions: Object.freeze({ contents: "read" }), environments: Object.freeze([]), secrets: false }),
  publish: Object.freeze({
    permissions: Object.freeze({ contents: "read" }),
    environments: Object.freeze(["production"]),
    secrets: "environment",
  }),
  freshness: Object.freeze({
    permissions: Object.freeze({ issues: "write", contents: "read" }),
    environments: Object.freeze([]),
    secrets: true,
  }),
});

const LEVEL = { none: 0, read: 1, write: 2 };
const SCOPES = new Set([
  "actions", "attestations", "checks", "contents", "deployments", "discussions", "id-token", "issues",
  "models", "packages", "pages", "pull-requests", "repository-projects", "security-events", "statuses",
]);

const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A secrets context in an expression, read from decoded YAML values (escapes resolved, as GitHub reads them) and
 * case-insensitively (GitHub's context names are).
 */
const SECRETS_EXPRESSION = /\$\{\{[^}]*\bsecrets\b/i;

/** Every decoded string of a parsed value (keys included), walked directly: no re-encoding hides a character. */
const stringsOf = function* (value) {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* stringsOf(item);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      yield key;
      yield* stringsOf(item);
    }
  }
};
const usesSecrets = (value) => {
  for (const text of stringsOf(value)) if (SECRETS_EXPRESSION.test(text)) return true;
  return false;
};

/** Findings for one permissions value; `ceiling(scope)` is the highest level allowed. */
const permissionFindings = (value, where, ceiling, tooBroad) => {
  if (typeof value === "string") {
    return [{ reason: /^(?:write|read)-all$/.test(value) ? "permissions-shorthand" : "invalid-permissions", detail: `${where}: ${value}` }];
  }
  if (!isMap(value)) return [{ reason: "invalid-permissions", detail: where }];
  const findings = [];
  for (const [scope, level] of Object.entries(value)) {
    if (!SCOPES.has(scope)) findings.push({ reason: "unknown-permission-scope", detail: `${where}: ${scope}` });
    else if (!(level in LEVEL)) findings.push({ reason: "invalid-permission-level", detail: `${where}: ${scope}: ${level}` });
    else if (LEVEL[level] > ceiling(scope)) findings.push({ reason: tooBroad, detail: `${where}: ${scope}: ${level}` });
  }
  return findings;
};

const eventNames = (on) => {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (isMap(on)) return Object.keys(on);
  return [];
};

/** Findings for one workflow, by its name (the file name without the extension). */
export const checkWorkflow = (name, text) => {
  const row = Object.prototype.hasOwnProperty.call(MATRIX, name) ? MATRIX[name] : undefined;
  if (row === undefined) return [{ reason: "unknown-workflow", detail: name }];
  const doc = parseYaml(text);
  if (!isMap(doc)) return [{ reason: "invalid-workflow", detail: "not a mapping" }];
  const findings = [];
  const allowed = (scope) => LEVEL[row.permissions[scope] ?? "none"];

  if (eventNames(doc.on).includes("pull_request_target")) findings.push({ reason: "pull-request-target", detail: "on" });

  if (!Object.prototype.hasOwnProperty.call(doc, "permissions") || doc.permissions === null) {
    findings.push({ reason: "missing-top-level-permissions", detail: "permissions" });
  } else {
    findings.push(
      ...permissionFindings(doc.permissions, "permissions", (scope) => Math.min(LEVEL.read, allowed(scope)), "top-level-permissions-too-broad"),
    );
  }

  const jobs = isMap(doc.jobs) ? doc.jobs : null;
  if (jobs === null) findings.push({ reason: "invalid-workflow", detail: "no jobs mapping" });
  const inEnvironment = [];
  for (const [id, job] of Object.entries(jobs ?? {})) {
    if (!isMap(job)) {
      findings.push({ reason: "invalid-workflow", detail: `jobs.${id}` });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(job, "permissions")) {
      findings.push(...permissionFindings(job.permissions, `jobs.${id}.permissions`, allowed, "permission-exceeds-matrix"));
    }
    if (Object.prototype.hasOwnProperty.call(job, "environment")) {
      const env = isMap(job.environment) ? job.environment.name : job.environment;
      if (typeof env !== "string" || !row.environments.includes(env)) {
        findings.push({ reason: "environment-not-allowed", detail: `jobs.${id}.environment: ${env}` });
      } else {
        inEnvironment.push(id);
      }
    }
    // Secrets in the job's steps, or handed to a reusable workflow (`secrets: inherit` or a map), outside the environment.
    if (row.secrets === "environment" && !inEnvironment.includes(id) &&
        (usesSecrets(job) || Object.prototype.hasOwnProperty.call(job, "secrets"))) {
      findings.push({ reason: "secrets-outside-environment", detail: `jobs.${id}` });
    }
    if (!row.secrets && Object.prototype.hasOwnProperty.call(job, "secrets")) {
      findings.push({ reason: "secrets-not-allowed", detail: `jobs.${id}.secrets` });
    }
  }
  if (row.secrets === "environment" && usesSecrets(doc.env)) {
    findings.push({ reason: "secrets-outside-environment", detail: "env" });
  }
  if (row.environments.length > 0 && inEnvironment.length > 1) {
    findings.push({ reason: "environment-not-alone", detail: inEnvironment.map((id) => `jobs.${id}`).join(", ") });
  }
  if (!row.secrets && (SECRETS_EXPRESSION.test(text) || usesSecrets(doc))) {
    findings.push({ reason: "secrets-not-allowed", detail: "secrets." });
  }
  return findings;
};

/** Every workflow file under <root>/.github/workflows. */
export const checkPermissions = (root) => {
  const dir = join(root, ".github", "workflows");
  let names = [];
  try {
    names = readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).sort();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const findings = [];
  for (const file of names) {
    const path = `.github/workflows/${file}`;
    for (const finding of checkWorkflow(basename(file).replace(/\.ya?ml$/, ""), readFileSync(join(dir, file), "utf8"))) {
      findings.push({ path, ...finding });
    }
  }
  return { files: names.length, findings };
};

if (isMain(import.meta)) {
  runCli("check-permissions", () => {
    const args = parseArgs(process.argv.slice(2), ["--root"]);
    const result = checkPermissions(args["--root"]?.[0] ?? process.cwd());
    for (const f of result.findings) process.stdout.write(`${f.path}: ${f.reason} ${f.detail}\n`);
    process.stdout.write(`check-permissions: ${result.files} workflows, ${result.findings.length} findings\n`);
    return result.findings.length === 0 ? EXIT.clean : EXIT.findings;
  });
}

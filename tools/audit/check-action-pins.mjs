#!/usr/bin/env node
// check-action-pins: every `uses:` in .github (workflows and composite actions) names a full commit SHA.
//
// usage: node tools/audit/check-action-pins.mjs [--root <repo dir>]
// Allowed: `owner/repo[/path]@<40 lower-case hex>`, a local action `./...`, and
// `docker://<image>@sha256:<64 hex>`. Every `uses` value comes from the parsed YAML (flow-style steps
// and quoted keys included; a file that does not parse fails closed), and a local action is followed
// to its action.yml wherever it lives. Prints `path:line: unpinned-action` (or `local-action-missing`)
// per finding and a summary; exit 0 when the pinned count equals the `uses` count, 2 on a finding, 1 on
// an error.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { EXIT, isMain, parseArgs, runCli } from "./lib/cli.mjs";
import { parseYaml } from "./lib/yaml-lite.mjs";

const PINNED = [
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/,
  /^\.\/\S*$/,
  /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/,
];

/** Every `uses` value of a parsed workflow or action, wherever it sits. */
const usesIn = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((item) => usesIn(item, out));
  else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "uses" && typeof value === "string") out.push(value.trim());
      else usesIn(value, out);
    }
  }
  return out;
};

/** The 1-based line a `uses` value sits on (the n-th line naming it), for the report; 0 when it cannot be placed. */
const lineOf = (lines, value, seen) => {
  for (let index = 0; index < lines.length; index++) {
    if (/\buses\b/.test(lines[index]) && lines[index].includes(value) && !seen.has(index)) {
      seen.add(index);
      return index + 1;
    }
  }
  return 0;
};

/** Counts, findings and local actions for one YAML text (the parsed document decides; a line regex never does). */
export const checkWorkflowText = (text, path) => {
  const findings = [];
  const locals = [];
  const values = usesIn(parseYaml(text));
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  let pinned = 0;
  for (const value of values) {
    const line = lineOf(lines, value, seen);
    if (PINNED.some((pattern) => pattern.test(value))) {
      pinned++;
      if (value.startsWith("./")) locals.push({ value, line });
    } else findings.push({ path, line, reason: "unpinned-action" });
  }
  return { uses: values.length, pinned, findings, locals };
};

const yamlFiles = function* (dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* yamlFiles(path);
    else if (/\.ya?ml$/.test(entry.name) && statSync(path).isFile()) yield path;
  }
};

/** Every YAML file under <root>/.github, and every local action they (or their actions) use, wherever it lives. */
export const checkActionPins = (root) => {
  const total = { files: 0, uses: 0, pinned: 0, findings: [] };
  const done = new Set();
  const check = (file) => {
    const path = relative(root, file).split("\\").join("/");
    if (done.has(path)) return;
    done.add(path);
    const result = checkWorkflowText(readFileSync(file, "utf8"), path);
    total.files++;
    total.uses += result.uses;
    total.pinned += result.pinned;
    total.findings.push(...result.findings);
    for (const { value, line } of result.locals) {
      const dir = join(root, value);
      const action = ["action.yml", "action.yaml"].map((name) => join(dir, name)).find((candidate) => existsSync(candidate));
      if (action === undefined || !relative(root, action).split("\\").join("/").startsWith(value.slice(2).replace(/\/+$/, ""))) {
        total.findings.push({ path, line, reason: "local-action-missing" });
      } else check(action);
    }
  };
  for (const file of yamlFiles(join(root, ".github"))) check(file);
  return total;
};

if (isMain(import.meta)) {
  runCli("check-action-pins", () => {
    const args = parseArgs(process.argv.slice(2), ["--root"]);
    const result = checkActionPins(args["--root"]?.[0] ?? process.cwd());
    for (const f of result.findings) process.stdout.write(`${f.path}:${f.line}: ${f.reason}\n`);
    process.stdout.write(
      `check-action-pins: ${result.files} files, ${result.uses} uses, ${result.pinned} pinned, ${result.findings.length} findings\n`,
    );
    return result.findings.length === 0 && result.pinned === result.uses ? EXIT.clean : EXIT.findings;
  });
}

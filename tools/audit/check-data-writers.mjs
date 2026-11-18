#!/usr/bin/env node
// check-data-writers: data/ is written only by the pipeline.
//
// usage: node tools/audit/check-data-writers.mjs --event <event.json> --event-name <pull_request|push> [--repo <dir>]
//        node tools/audit/check-data-writers.mjs --event-name <name> --base <rev> --head <rev> --actor <login> [--repo <dir>]
// A pull request or push whose changes reach data/ fails unless its actor (the pull request's author,
// the push's sender: GitHub's login, which a commit cannot forge) is a pipeline identity, and any
// commit in it that touches data/ must also be authored by one. Paths come NUL-delimited from git, so
// a path git would quote still counts. Renames count on both sides. Exit 0 clean, 2 findings, 1 error.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { EXIT, isMain, parseArgs, runCli } from "./lib/cli.mjs";

/** The identities allowed to write data/: the pipeline's GitHub App (t3cp-pipeline) and the publish workflow's token. */
export const PIPELINE_IDENTITIES = Object.freeze(["t3cp-pipeline[bot]", "github-actions[bot]"]);

const ZERO = /^0{40}$/;
const touchesData = (path) => path === "data" || path.startsWith("data/");
const isPipeline = (identity) => PIPELINE_IDENTITIES.includes(identity);

/**
 * Findings for one event. `commits` are {sha, author, paths}; `netPaths` are the paths the pull
 * request changes overall (from its merge base).
 */
export const checkDataWriters = ({ eventName, actor, commits, netPaths = [] }) => {
  const findings = [];
  const touched = netPaths.some(touchesData) || commits.some((commit) => commit.paths.some(touchesData));
  if ((eventName === "pull_request" || eventName === "push") && touched && !isPipeline(actor)) {
    findings.push({ reason: "human-actor-touches-data", detail: actor });
  }
  for (const commit of commits) {
    if (commit.paths.some(touchesData) && !isPipeline(commit.author)) {
      findings.push({ reason: "human-commit-touches-data", detail: `${commit.sha.slice(0, 12)} ${commit.author}` });
    }
  }
  return findings;
};

const git = (repo, args) =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 256 << 20,
    stdio: ["ignore", "pipe", "pipe"],
  });

const commitOf = (repo, rev) => {
  if (typeof rev !== "string" || !/^[A-Za-z0-9_.][A-Za-z0-9_./~^-]*$/.test(rev)) throw new Error(`bad revision ${rev}`);
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).trim();
  } catch {
    throw new Error(`revision ${rev} is not a commit in ${repo} (fetch the full history)`);
  }
};

/** NUL-separated fields, without the empty tail. */
const nulList = (out) => out.split("\0").filter((item) => item !== "");

/** {sha, author, paths} for every commit in `range` (merges by their combined diff), paths read NUL-delimited. */
export const commitsIn = (repo, range) =>
  nulList(git(repo, ["log", "-z", "--format=%H%n%an", ...range, "--"])).map((record) => {
    const newline = record.indexOf("\n");
    const sha = record.slice(0, newline);
    const author = record.slice(newline + 1);
    const paths = nulList(git(repo, ["diff-tree", "-z", "--no-commit-id", "--no-renames", "--name-only", "-r", "--cc", "--root", sha]));
    return { sha, author, paths };
  });

/** The base, head and actor an event names. */
export const fromEvent = (event, eventName) => {
  if (eventName === "pull_request") {
    const pr = event?.pull_request;
    return { base: pr?.base?.sha, head: pr?.head?.sha, actor: pr?.user?.login };
  }
  if (eventName === "push") return { base: event?.before, head: event?.after, actor: event?.sender?.login };
  throw new Error(`unsupported event ${eventName}`);
};

export const collect = (repo, { eventName, base, head, actor }) => {
  if (eventName !== "pull_request" && eventName !== "push") throw new Error(`unsupported event ${eventName}`);
  if (typeof actor !== "string" || actor === "") throw new Error("no actor in the event");
  const headSha = commitOf(repo, head);
  if (eventName === "pull_request") {
    const baseSha = commitOf(repo, base);
    const mergeBase = git(repo, ["merge-base", baseSha, headSha]).trim();
    const netPaths = nulList(git(repo, ["diff", "-z", "--no-renames", "--name-only", mergeBase, headSha]));
    return { eventName, actor, commits: commitsIn(repo, [`${mergeBase}..${headSha}`]), netPaths };
  }
  if (base === undefined || base === null || ZERO.test(base)) {
    return { eventName, actor, commits: commitsIn(repo, [headSha]), netPaths: [] };
  }
  const baseSha = commitOf(repo, base);
  let from = baseSha;
  try {
    git(repo, ["merge-base", "--is-ancestor", baseSha, headSha]);
  } catch {
    from = git(repo, ["merge-base", baseSha, headSha]).trim();
  }
  return { eventName, actor, commits: commitsIn(repo, [`${from}..${headSha}`]), netPaths: [] };
};

if (isMain(import.meta)) {
  runCli("check-data-writers", () => {
    const args = parseArgs(process.argv.slice(2), ["--repo", "--event", "--event-name", "--base", "--head", "--actor"]);
    const repo = args["--repo"]?.[0] ?? process.cwd();
    const eventName = args["--event-name"]?.[0];
    if (!eventName) throw new Error("--event-name is required");
    const named = args["--event"]
      ? fromEvent(JSON.parse(readFileSync(args["--event"][0], "utf8")), eventName)
      : { base: args["--base"]?.[0], head: args["--head"]?.[0], actor: args["--actor"]?.[0] };
    const input = collect(repo, { eventName, ...named });
    const findings = checkDataWriters(input);
    for (const f of findings) process.stdout.write(`${f.reason}: ${f.detail}\n`);
    process.stdout.write(
      `check-data-writers: ${eventName}, ${input.commits.length} commits, ${findings.length} findings\n`,
    );
    return findings.length === 0 ? EXIT.clean : EXIT.findings;
  });
}

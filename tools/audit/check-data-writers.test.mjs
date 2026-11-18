// data/ is written only by the pipeline: a human pull request or commit that touches it fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PIPELINE_IDENTITIES, checkDataWriters } from "./check-data-writers.mjs";

const CLI = fileURLToPath(new URL("./check-data-writers.mjs", import.meta.url));
const ZERO = "0".repeat(40);
const HUMAN = "some-contributor";
const BOT = "t3cp-pipeline[bot]";
// The writer App's former name, built from parts so no file here spells it.
const OLD_BOT = `${["t3cp", "ops", "writer"].join("-")}[bot]`;

const git = (cwd, args, env = {}) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();

const as = (name) => ({
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: name,
  GIT_COMMITTER_EMAIL: "author@example.com",
});

const newRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "t3cp-data-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "root"], as(HUMAN));
  return dir;
};

const commitFile = (dir, path, text, author) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `change ${path}`], as(author));
  return git(dir, ["rev-parse", "HEAD"]);
};

const run = (dir, event, eventName) => {
  const eventPath = join(dir, "..", `${eventName}-${Date.now()}-${Math.random()}.json`);
  writeFileSync(eventPath, JSON.stringify(event));
  try {
    const out = execFileSync(process.execPath, [CLI, "--repo", dir, "--event", eventPath, "--event-name", eventName], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status, out: String(error.stdout) + String(error.stderr) };
  } finally {
    rmSync(eventPath, { force: true });
  }
};

const pr = (base, head, login) => ({ pull_request: { base: { sha: base }, head: { sha: head }, user: { login } } });

test("data writers: a human pull request adding a file under data/ fails; the pipeline's passes", () => {
  const dir = newRepo();
  const base = git(dir, ["rev-parse", "HEAD"]);
  const human = commitFile(dir, "data/v1/index.json", "{}\n", HUMAN);
  const failed = run(dir, pr(base, human, HUMAN), "pull_request");
  assert.equal(failed.code, 2);
  assert.match(failed.out, /human-actor-touches-data/);
  assert.match(failed.out, /human-commit-touches-data/);

  git(dir, ["reset", "-q", "--hard", base]);
  const pipeline = commitFile(dir, "data/v1/index.json", "{}\n", BOT);
  assert.equal(run(dir, pr(base, pipeline, BOT), "pull_request").code, 0);
});

test("data writers: a human pull request that leaves data/ alone passes", () => {
  const dir = newRepo();
  const base = git(dir, ["rev-parse", "HEAD"]);
  const head = commitFile(dir, "site/index.html", "<p>x</p>\n", HUMAN);
  assert.equal(run(dir, pr(base, head, HUMAN), "pull_request").code, 0);
});

test("data writers: a human commit inside the pipeline's pull request fails", () => {
  const dir = newRepo();
  const base = git(dir, ["rev-parse", "HEAD"]);
  commitFile(dir, "data/v1/index.json", "{}\n", BOT);
  const head = commitFile(dir, "data/v1/index.json", "{\"x\":1}\n", HUMAN);
  const result = run(dir, pr(base, head, BOT), "pull_request");
  assert.equal(result.code, 2);
  assert.match(result.out, /human-commit-touches-data/);
  assert.doesNotMatch(result.out, /human-actor-touches-data/);
});

test("data writers: renaming or deleting a data file counts as touching data/", () => {
  const dir = newRepo();
  commitFile(dir, "data/v1/a.json", "{}\n", BOT);
  const base = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["mv", "data/v1/a.json", "elsewhere.json"]);
  git(dir, ["commit", "-q", "-m", "move"], as(HUMAN));
  const head = git(dir, ["rev-parse", "HEAD"]);
  assert.equal(run(dir, pr(base, head, HUMAN), "pull_request").code, 2);
});

test("data writers: a push range is judged by its commits' authors", () => {
  const dir = newRepo();
  const before = git(dir, ["rev-parse", "HEAD"]);
  const bot = commitFile(dir, "data/v1/index.json", "{}\n", "github-actions[bot]");
  assert.equal(run(dir, { before, after: bot, sender: { login: "github-actions[bot]" } }, "push").code, 0);
  const human = commitFile(dir, "data/v1/index.json", "{\"y\":2}\n", HUMAN);
  const result = run(dir, { before: bot, after: human, sender: { login: HUMAN } }, "push");
  assert.equal(result.code, 2);
  assert.match(result.out, /human-commit-touches-data/);
});

test("data writers: a first push (before is all zeros) checks every commit", () => {
  const dir = newRepo();
  const head = commitFile(dir, "data/v1/index.json", "{}\n", HUMAN);
  assert.equal(run(dir, { before: ZERO, after: head, sender: { login: HUMAN } }, "push").code, 2);
});

test("data writers: the identity list is one constant and the pure check agrees", () => {
  assert.deepEqual([...PIPELINE_IDENTITIES], ["t3cp-pipeline[bot]", "github-actions[bot]"]);
  assert.throws(() => PIPELINE_IDENTITIES.push("x"));
  const commits = [{ sha: "a".repeat(40), author: HUMAN, paths: ["data/v1/x.json"] }];
  assert.deepEqual(
    checkDataWriters({ eventName: "pull_request", actor: HUMAN, commits, netPaths: ["data/v1/x.json"] }).map((f) => f.reason),
    ["human-actor-touches-data", "human-commit-touches-data"],
  );
  assert.deepEqual(checkDataWriters({ eventName: "pull_request", actor: HUMAN, commits: [], netPaths: ["datax/y"] }), []);
});

test("data writers: an unknown event or a missing commit fails closed (exit 1)", () => {
  const dir = newRepo();
  assert.equal(run(dir, {}, "issue_comment").code, 1);
  assert.equal(run(dir, pr("f".repeat(40), "e".repeat(40), HUMAN), "pull_request").code, 1);
});

test("data writers: a push touching data/ by a human pusher fails, whatever author name its commits carry", () => {
  const dir = newRepo();
  const before = git(dir, ["rev-parse", "HEAD"]);
  // The author name is the bot's, but anyone can write that name; the push's sender is the human.
  const forged = commitFile(dir, "data/v1/index.json", "{}\n", "github-actions[bot]");
  const result = run(dir, { before, after: forged, sender: { login: HUMAN } }, "push");
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /human-actor-touches-data/);
  // A human push that leaves data/ alone is fine.
  const docs = commitFile(dir, "docs/notes.md", "x\n", HUMAN);
  assert.equal(run(dir, { before: forged, after: docs, sender: { login: HUMAN } }, "push").code, 0);
});

test("data writers: a data path git would quote (a tab, a newline, a quote) still counts as data/", () => {
  for (const name of ["data/v1/a\tb.json", "data/v1/a\"b.json", "data/v1/a\\b.json"]) {
    const dir = newRepo();
    const base = git(dir, ["rev-parse", "HEAD"]);
    const head = commitFile(dir, name, "{}\n", HUMAN);
    const result = run(dir, pr(base, head, HUMAN), "pull_request");
    assert.equal(result.code, 2, `${JSON.stringify(name)}: ${result.out}`);
    assert.match(result.out, /human-commit-touches-data/);
  }
});

test("data writers: the writer App is t3cp-pipeline[bot]; its former name is refused as actor and as author", () => {
  const dir = newRepo();
  const before = git(dir, ["rev-parse", "HEAD"]);
  const ok = commitFile(dir, "data/v1/index.json", "{}\n", BOT);
  assert.equal(run(dir, { before, after: ok, sender: { login: BOT } }, "push").code, 0);
  const old = commitFile(dir, "data/v1/index.json", "{\"v\":2}\n", OLD_BOT);
  const asAuthor = run(dir, { before: ok, after: old, sender: { login: BOT } }, "push");
  assert.equal(asAuthor.code, 2, asAuthor.out);
  assert.match(asAuthor.out, /human-commit-touches-data/);
  const fresh = commitFile(dir, "data/v1/index.json", "{\"v\":3}\n", BOT);
  const asActor = run(dir, { before: old, after: fresh, sender: { login: OLD_BOT } }, "push");
  assert.equal(asActor.code, 2, asActor.out);
  assert.match(asActor.out, /human-actor-touches-data/);
  assert.ok(!PIPELINE_IDENTITIES.includes(OLD_BOT));
});

test("data writers: no tracked file of the repository names the writer App's former name", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const name = ["t3cp", "ops", "writer"].join("-");
  const named = files.filter((file) => {
    try {
      return readFileSync(join(root, file), "utf8").includes(name);
    } catch {
      return false;
    }
  });
  assert.deepEqual(named, []);
});

test("data writers: the renamed App's real commit shape passes (author t3cp-pipeline[bot], committer GitHub)", () => {
  const dir = newRepo();
  const before = git(dir, ["rev-parse", "HEAD"]);
  mkdirSync(join(dir, "data/v1"), { recursive: true });
  writeFileSync(join(dir, "data/v1/status.json"), "{}\n");
  git(dir, ["add", "-A"]);
  // Built from parts, so this file holds no address.
  const at = "@";
  git(dir, ["commit", "-q", "-m", "data: pipeline status"], {
    GIT_AUTHOR_NAME: "t3cp-pipeline[bot]",
    GIT_AUTHOR_EMAIL: ["357574361+t3cp-pipeline[bot]", "users.noreply.github.com"].join(at),
    GIT_COMMITTER_NAME: "GitHub",
    GIT_COMMITTER_EMAIL: ["noreply", "github.com"].join(at),
  });
  const after = git(dir, ["rev-parse", "HEAD"]);
  const result = run(dir, { before, after, sender: { login: "t3cp-pipeline[bot]" } }, "push");
  assert.equal(result.code, 0, result.out);
});

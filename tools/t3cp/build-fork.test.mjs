import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "build-fork.sh");

const run = (args, opts = {}) =>
  spawnSync("bash", [script, ...args], { encoding: "utf8", timeout: 30_000, ...opts });

test("the script parses", () => {
  const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("no arguments prints usage and exits 2", () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: build-fork\.sh --src <checkout> --out <new-dir>/);
});

test("an unknown argument exits 2", () => {
  const r = run(["--src", ".", "--out", "x", "--frobnicate"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument: --frobnicate/);
});

test("a non-numeric port exits 2", () => {
  const r = run(["--src", ".", "--out", "x", "--port", "abc"]);
  assert.equal(r.status, 2);
});

test("an --archive-name that is a path or not a .tar.gz exits 2", () => {
  for (const name of ["out/t3-x-linux-x64.tar.gz", "t3-x-linux-x64.zip", ".tar.gz", ""]) {
    const r = run(["--src", ".", "--out", "x", "--archive-name", name]);
    assert.equal(r.status, 2, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /--archive-name must be a file name ending in \.tar\.gz/);
  }
});

test("a valid --archive-name is accepted (the run goes on to the checkout check)", () => {
  const dir = mkdtempSync(join(tmpdir(), "build-fork-test-"));
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    const r = run(["--src", dir, "--out", join(dir, "out"), "--archive-name", "t3-0123456789ab-base-linux-x64.tar.gz"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /not a T3 Code checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory that is not a T3 Code checkout is refused before anything is built", () => {
  const dir = mkdtempSync(join(tmpdir(), "build-fork-test-"));
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    const out = join(dir, "out");
    const r = run(["--src", dir, "--out", out]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a T3 Code checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a --node directory without bin/node is refused (exit 3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "build-fork-test-"));
  try {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "package.json"), '{"engines":{"node":"26.0.0"}}');
    writeFileSync(join(dir, "scripts", "build-cli-archive.ts"), "");
    const git = spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    const r = run(["--src", dir, "--out", join(dir, "out"), "--node", join(dir, "no-node")]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--node: no executable bin\/node/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The version the build stamps, as the tree's own server build decides it (apps/server/vite.config.ts): APP_VERSION
// where the tree reads it; else the tree's own scripts/lib/tagged-source-version.ts (upstream #36350, 2026-11-13: a
// commit with exactly one vX.Y.Z tag and unedited release manifests stamps that tag's version); else, for a tree
// older than that resolver, the manifest. The smoke and the --version check expect that version, never a guess.
// --print-version prints it and exits, before the toolchain preflight.
const UPSTREAM_RESOLVER = join(here, "testdata", "tagged-source-version.upstream.ts");

function tree({ manifest = "0.1.9", resolver = "upstream", viteReadsAppVersion = true, tags = [], editManifest = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "build-fork-version-"));
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  write("package.json", "{}\n");
  write("scripts/build-cli-archive.ts", "");
  for (const rel of ["apps/server/package.json", "apps/desktop/package.json", "apps/web/package.json", "packages/contracts/package.json"]) {
    write(rel, `${JSON.stringify({ name: "x", version: manifest })}\n`);
  }
  write("apps/server/vite.config.ts", viteReadsAppVersion ? "const v = process.env.APP_VERSION?.trim();\n" : "const v = packageJson.version;\n");
  if (resolver === "upstream") write("scripts/lib/tagged-source-version.ts", readFileSync(UPSTREAM_RESOLVER, "utf8"));
  else if (resolver !== null) write("scripts/lib/tagged-source-version.ts", resolver);
  const git = (...args) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "tree");
  for (const tag of tags) git("tag", tag);
  if (editManifest !== null) write("apps/server/package.json", `${JSON.stringify({ name: "x", version: editManifest })}\n`);
  return dir;
}

const printVersion = (dir, env = {}) => {
  const base = { ...process.env };
  delete base.APP_VERSION;
  return spawnSync("bash", [script, "--print-version", "--src", dir], { encoding: "utf8", timeout: 30_000, env: { ...base, ...env } });
};
const versionOf = (dir, env) => {
  const r = printVersion(dir, env);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

test("a release commit with one stable tag stamps that tag's version, not its manifest's", () => {
  const dir = tree({ tags: ["v0.1.10", "v0.1.10-nightly.20261116.4800"] });
  try {
    assert.equal(versionOf(dir), "0.1.10");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an untagged commit, or one with only nightly or fork tags, stamps its manifest", () => {
  for (const tags of [[], ["v0.1.10-nightly.20261116.4800"], ["v0.1.9-perf.10"]]) {
    const dir = tree({ tags });
    try {
      assert.equal(versionOf(dir), "0.1.9", tags.join(" "));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("edited release manifests stamp the edited manifest, even at a stable tag", () => {
  const dir = tree({ tags: ["v0.1.10"], editManifest: "0.2.0" });
  try {
    assert.equal(versionOf(dir), "0.2.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("APP_VERSION wins where the tree reads it, and is ignored where it does not", () => {
  const reads = tree({ tags: ["v0.1.10"] });
  const ignores = tree({ tags: ["v0.1.10"], resolver: null, viteReadsAppVersion: false });
  try {
    assert.equal(versionOf(reads, { APP_VERSION: " 2.0.0 " }), "2.0.0");
    assert.equal(versionOf(reads, { APP_VERSION: "   " }), "0.1.10", "a blank APP_VERSION is unset");
    assert.equal(versionOf(ignores, { APP_VERSION: "2.0.0" }), "0.1.9");
  } finally {
    rmSync(reads, { recursive: true, force: true });
    rmSync(ignores, { recursive: true, force: true });
  }
});

test("a tree older than the resolver stamps its manifest, whatever its tags", () => {
  const dir = tree({ tags: ["v0.1.10"], resolver: null, viteReadsAppVersion: false });
  try {
    assert.equal(versionOf(dir), "0.1.9");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tree's own resolver decides; one that cannot run fails closed", () => {
  const own = tree({ resolver: "export function resolveTaggedSourceVersion() { return \"7.7.7\"; }\n" });
  const broken = tree({ resolver: "export function resolveTaggedSourceVersion() { throw new Error(\"no\"); }\n" });
  try {
    assert.equal(versionOf(own), "7.7.7");
    const r = printVersion(broken);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /version/i);
  } finally {
    rmSync(own, { recursive: true, force: true });
    rmSync(broken, { recursive: true, force: true });
  }
});

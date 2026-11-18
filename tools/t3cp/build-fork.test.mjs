import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

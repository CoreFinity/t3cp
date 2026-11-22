import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
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
    // Trimmed as the server trims it (String.prototype.trim): newlines and tabs too, and stdout is exactly the version.
    const padded = printVersion(reads, { APP_VERSION: "\n\t2.0.0 \n" });
    assert.equal(padded.status, 0, padded.stderr);
    assert.equal(padded.stdout, "2.0.0\n");
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

// A record built again (a relaunch, or a preempted lease) must produce the archive an earlier attempt recorded, byte
// for byte: upstream's build-cli-archive.ts tars the staged tree as the build left it (file order, mtimes, owner,
// modes from the umask) and gzip stamps its own header. --normalize-archive repacks the same members with each of
// those fixed (GNU tar, sorted by name, every mtime the source commit's time, owner and group 0, modes 0755 for
// directories and anything executable and 0644 for the rest, GNU gzip -n -9, nothing inherited from the environment),
// and the build runs it on the archive build-cli-archive.ts writes.
const gnuTar = ["tar", "gtar"].find((t) => /GNU tar/.test(spawnSync(t, ["--version"], { encoding: "utf8" }).stdout ?? ""));
const NO_GNU_TAR = gnuTar ? false : "GNU tar is not on PATH (tar or gtar)";
const sh = (cmd, cwd) => {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
  return r.stdout;
};
const sha = (file) => sh(`(sha256sum "${file}" 2>/dev/null || shasum -a 256 "${file}") | cut -d' ' -f1`).trim();
const normalizeWith = (env, ...args) =>
  spawnSync("bash", [script, "--normalize-archive", ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });
const normalize = (...args) => normalizeWith({}, ...args);

/** One release tree, staged and tarred two ways that differ in everything but the members' bytes. */
function twoArchives(dir) {
  const stem = "t3-0.1.9-perf.9-linux-x64";
  const files = [["t3", "#!/bin/sh\necho t3\n", "755"], ["client/index.html", "<html></html>\n", "644"],
    ["node_modules/a/package.json", "{}\n", "644"], ["node_modules/a/lib/x.node", "\u0000\u0001bin", "755"], ["lib/libatomic.so.1", "elf", "644"]];
  const stage = (name, order, mtime, extraMode) => {
    const root = join(dir, name, stem);
    for (const [rel, text, mode] of order === "forward" ? files : [...files].reverse()) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
      sh(`chmod ${mode} "${join(root, rel)}" && chmod ${extraMode} "${join(root, rel)}"`);
    }
    sh(`ln -s t3 "${join(root, "t3-link")}" && find "${join(dir, name)}" -exec touch -h -d "${mtime}" {} +`);
    return join(dir, name);
  };
  const a = stage("a", "forward", "2026-11-01T10:00:00Z", "u+r");
  const b = stage("b", "reverse", "2026-11-20T23:59:59Z", "g+w");
  // A: GNU tar's defaults with gzip from stdin; B: another owner, the tar gzipped as a named file (name and time in
  // its header).
  sh(`${gnuTar} -czf "${join(dir, "A.tar.gz")}" -C "${a}" ${stem}`);
  sh(`${gnuTar} --owner=1234 --group=5678 -cf "${join(dir, "B.tar")}" -C "${b}" ${stem} && gzip -9 "${join(dir, "B.tar")}"`);
  return { stem, A: join(dir, "A.tar.gz"), B: join(dir, "B.tar.gz") };
}

test("--normalize-archive makes the same members byte-identical whatever their order, times, owner, modes and gzip header", { skip: NO_GNU_TAR }, () => {
  const dir = mkdtempSync(join(tmpdir(), "build-fork-normalize-"));
  try {
    const { stem, A, B } = twoArchives(dir);
    assert.notEqual(sha(A), sha(B), "the inputs differ");
    const epoch = "1795132800";
    for (const [i, o] of [[A, join(dir, "nA.tar.gz")], [B, join(dir, "nB.tar.gz")]]) {
      const r = normalize(i, o, epoch);
      assert.equal(r.status, 0, r.stderr);
    }
    assert.equal(sha(join(dir, "nA.tar.gz")), sha(join(dir, "nB.tar.gz")), "the same members give the same bytes");
    // Every member: sorted, the commit's time, owner 0:0, a normalised mode; the bytes and the link kept.
    const listing = sh(`${gnuTar} --numeric-owner --full-time -tvzf "${join(dir, "nA.tar.gz")}"`).trim().split("\n");
    const names = listing.map((l) => l.split(/\s+/)[5]);
    assert.deepEqual(names, [...names].sort());
    for (const line of listing) {
      const [mode, owner, , day, time] = line.split(/\s+/);
      assert.equal(owner, "0/0", line);
      assert.equal(`${day}T${time}Z`, new Date(Number(epoch) * 1000).toISOString().replace(".000", ""), line);
      // Directories and executables 0755, other files 0644; a link's mode is meaningless but fixed too.
      assert.match(mode, /^(drwxr-xr-x|-rwxr-xr-x|-rw-r--r--|lrwxr-xr-x)$/, line);
    }
    assert.match(listing.join("\n"), new RegExp(`${stem}/t3-link -> t3`));
    const out = join(dir, "x");
    mkdirSync(out);
    sh(`${gnuTar} -xzf "${join(dir, "nB.tar.gz")}" -C "${out}"`);
    assert.equal(readFileSync(join(out, stem, "node_modules/a/lib/x.node"), "utf8"), "\u0000\u0001bin");
    assert.equal(sh(`stat -c %a "${join(out, stem, "t3")}" 2>/dev/null || stat -f %Lp "${join(out, stem, "t3")}"`).trim(), "755");
    // gzip's header carries no name and no time.
    const head = readFileSync(join(dir, "nA.tar.gz"));
    assert.equal(head[3] & 0x08, 0, "no file name in the gzip header");
    assert.equal(head.readUInt32LE(4), 0, "no time in the gzip header");
    // Another commit time is another archive.
    assert.equal(normalize(A, join(dir, "other.tar.gz"), "1795219200").status, 0);
    assert.notEqual(sha(join(dir, "other.tar.gz")), sha(join(dir, "nA.tar.gz")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--normalize-archive refuses bad arguments, and an archive that is not one top directory", { skip: NO_GNU_TAR }, () => {
  const dir = mkdtempSync(join(tmpdir(), "build-fork-normalize-"));
  try {
    assert.equal(normalize().status, 2);
    assert.equal(normalize(join(dir, "in.tar.gz"), join(dir, "out.tar.gz")).status, 2);
    assert.equal(normalize(join(dir, "in.tar.gz"), join(dir, "out.tar.gz"), "yesterday").status, 2);
    mkdirSync(join(dir, "s", "one"), { recursive: true });
    mkdirSync(join(dir, "s", "two"));
    writeFileSync(join(dir, "s", "one", "f"), "x");
    writeFileSync(join(dir, "s", "two", "g"), "y");
    sh(`${gnuTar} -czf "${join(dir, "two.tar.gz")}" -C "${join(dir, "s")}" one two`);
    const r = normalize(join(dir, "two.tar.gz"), join(dir, "out.tar.gz"), "1795132800");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /one top directory/);
    assert.equal(normalize(join(dir, "missing.tar.gz"), join(dir, "out.tar.gz"), "1795132800").status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--normalize-archive clears setuid, setgid and sticky bits: only the executable bit of a member reaches the archive", { skip: NO_GNU_TAR }, () => {
  const dir = mkdtempSync(join(tmpdir(), "build-fork-normalize-"));
  try {
    const stem = "t3-0.1.9-perf.9-linux-x64";
    const build = (name, dirMode, subMode, exeMode) => {
      const root = join(dir, name, stem);
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(join(root, "t3"), "#!/bin/sh\n");
      writeFileSync(join(root, "lib", "a.so"), "elf");
      sh(`chmod ${dirMode} "${root}" && chmod ${subMode} "${join(root, "lib")}" && chmod ${exeMode} "${join(root, "t3")}" && chmod 644 "${join(root, "lib", "a.so")}"`);
      sh(`${gnuTar} -czf "${join(dir, `${name}.tar.gz`)}" -C "${join(dir, name)}" ${stem}`);
      return join(dir, `${name}.tar.gz`);
    };
    const plain = build("plain", "755", "755", "755");
    const special = build("special", "2755", "1777", "4755");
    for (const [i, o] of [[plain, join(dir, "np.tar.gz")], [special, join(dir, "ns.tar.gz")]]) {
      const r = normalize(i, o, "1795132800");
      assert.equal(r.status, 0, r.stderr);
    }
    const listing = sh(`${gnuTar} --numeric-owner -tvzf "${join(dir, "ns.tar.gz")}"`).trim().split("\n");
    for (const line of listing) assert.match(line.split(/\s+/)[0], /^(drwxr-xr-x|-rwxr-xr-x|-rw-r--r--)$/, line);
    assert.equal(sha(join(dir, "np.tar.gz")), sha(join(dir, "ns.tar.gz")), "special bits do not reach the archive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--normalize-archive ignores TAR_OPTIONS and GZIP in its environment", { skip: NO_GNU_TAR }, () => {
  const dir = mkdtempSync(join(tmpdir(), "build-fork-normalize-"));
  try {
    const { A } = twoArchives(dir);
    assert.equal(normalize(A, join(dir, "clean.tar.gz"), "1795132800").status, 0);
    for (const env of [{ TAR_OPTIONS: "--blocking-factor=1" }, { GZIP: "-1" }, { TAR_OPTIONS: "--format=posix", GZIP: "--rsyncable" }]) {
      const r = normalizeWith(env, A, join(dir, "env.tar.gz"), "1795132800");
      assert.equal(r.status, 0, `${JSON.stringify(env)}: ${r.stderr}`);
      assert.equal(sha(join(dir, "env.tar.gz")), sha(join(dir, "clean.tar.gz")), JSON.stringify(env));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--normalize-archive writes only a scratch file of its own, and refuses an output that is a directory", { skip: NO_GNU_TAR }, () => {
  const dir = mkdtempSync(join(tmpdir(), "build-fork-normalize-"));
  try {
    const { A } = twoArchives(dir);
    // A directory, then a symlink to someone else's file, at the old fixed scratch name: both untouched.
    const out = join(dir, "out.tar.gz");
    mkdirSync(`${out}.repack`);
    writeFileSync(join(`${out}.repack`, "keep"), "kept");
    let r = normalize(A, out, "1795132800");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(`${out}.repack`, "keep"), "utf8"), "kept");
    const out2 = join(dir, "out2.tar.gz");
    writeFileSync(join(dir, "victim"), "victim");
    symlinkSync(join(dir, "victim"), `${out2}.repack`);
    r = normalize(A, out2, "1795132800");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, "victim"), "utf8"), "victim");
    assert.equal(readlinkSync(`${out2}.repack`), join(dir, "victim"));
    assert.equal(sha(out2), sha(out));
    // An output that is a directory is refused, and the directory is left as it was.
    const outDir = join(dir, "outdir.tar.gz");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "keep"), "kept");
    r = normalize(A, outDir, "1795132800");
    assert.equal(r.status, 1, r.stderr);
    assert.equal(readFileSync(join(outDir, "keep"), "utf8"), "kept");
    // No scratch file is left beside the outputs.
    assert.deepEqual(sh(`ls -A "${dir}"`).trim().split("\n").filter((n) => /repack/.test(n) && !/^out2?\.tar\.gz\.repack$/.test(n)), []);
    assert.ok(lstatSync(out).isFile() && existsSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--normalize-archive refuses a gzip that is not GNU gzip: another implementation compresses differently", { skip: NO_GNU_TAR }, () => {
  const dir = mkdtempSync(join(tmpdir(), "build-fork-normalize-"));
  try {
    const { A } = twoArchives(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gzip"), '#!/bin/sh\nif [ "$1" = --version ]; then echo "Apple gzip 487.0.1"; exit 0; fi\nexec /bin/gzip "$@"\n');
    sh(`chmod 755 "${join(bin, "gzip")}"`);
    const r = normalizeWith({ PATH: `${bin}:${process.env.PATH}` }, A, join(dir, "out.tar.gz"), "1795132800");
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /GNU gzip/);
    assert.ok(!existsSync(join(dir, "out.tar.gz")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the build fixes SOURCE_DATE_EPOCH to the commit's time and normalises the archive build-cli-archive.ts writes", () => {
  const text = readFileSync(script, "utf8");
  const epoch = text.indexOf('SOURCE_DATE_EPOCH=$(git -C "$SRC" log -1 --format=%ct HEAD)');
  const exported = text.indexOf("export SOURCE_DATE_EPOCH");
  const install = text.indexOf("step install ");
  const archive = text.indexOf("step archive node scripts/build-cli-archive.ts");
  const norm = text.indexOf('normalize_archive "$OUT/$BUILT_NAME" "$OUT/$BUILT_NAME" "$SOURCE_DATE_EPOCH"');
  const hashed = text.indexOf('ARCHIVE_SHA256=$(sha256 "$ARCHIVE")');
  assert.ok(epoch > 0 && exported > epoch && exported < install, "SOURCE_DATE_EPOCH is the commit time, exported before the build");
  assert.ok(norm > archive && norm < hashed, "the archive is normalised after build-cli-archive.ts and before it is hashed");
  assert.match(text, /^m source_date_epoch "\$SOURCE_DATE_EPOCH"$/m);
});

test("the manifest names the GNU tar and GNU gzip the archive was repacked with, and the repack's mode rule", () => {
  const text = readFileSync(script, "utf8");
  assert.match(text, /^m archive_tools "\$\(archive_tools\)"$/m);
  assert.match(text, /^ARCHIVE_MODE='a-st,u=rwX,go=rX'$/m);
  assert.match(text, /^m archive_normalized ".*--mode=\$ARCHIVE_MODE; gzip -n -9"$/m);
});

// The spawner helper (t3-process-spawner, the fork's own process-spawner-sea.ts) is built by `node --build-sea` from a
// random temporary directory, whose path the executable embeds: two builds of one source differ in it. Nothing
// patches a built binary, so its sha256 goes in the manifest beside t3's, where such a difference is visible.
test("the manifest records the archive's t3-process-spawner sha256 beside t3's, or none when the archive has none", () => {
  const text = readFileSync(script, "utf8");
  const t3 = text.indexOf('m extracted_t3_sha256 "$(sha256 "$T3")"');
  const spawner = text.indexOf("m extracted_process_spawner_sha256");
  assert.ok(t3 > 0 && spawner > t3, "recorded after t3's, from the extracted archive");
  assert.match(text, /^m extracted_process_spawner_sha256 "\$\(if \[ -f "\$ROOT\/t3-process-spawner" \]; then sha256 "\$ROOT\/t3-process-spawner"; else echo none; fi\)"$/m);
});

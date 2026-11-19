// audit-public-tree: the generic public pattern list over a tree, a diff and commit messages.
// Planted values are built from parts at run time, so this file passes the scan it tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { auditTree, loadPatterns, scanLine } from "./audit-public-tree.mjs";

const CLI = fileURLToPath(new URL("./audit-public-tree.mjs", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));
const j = (...parts) => parts.join("");

const dirWith = (files) => {
  const root = mkdtempSync(join(tmpdir(), "t3cp-audit-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

const cli = (args, cwd) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    return { code: error.status, out: String(error.stdout) + String(error.stderr) };
  }
};

const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

const ids = (path, line) => scanLine(path, line).map((hit) => hit.id);

test(j("audit: a planted /Us", "ers/ path in a comment fails audit-public-tree"), () => {
  const root = dirWith({ "site/app.js": j("// built on /Us", "ers/someone/project\nconst a = 1;\n") });
  const result = cli(["--tree", root]);
  assert.equal(result.code, 2);
  assert.match(result.out, /site\/app\.js:1: path-users/);
});

test("audit: the same plant fails in a git revision", () => {
  const root = dirWith({ "README.md": j("see /Us", "ers/someone\n") });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "x"]);
  const result = cli(["--repo", root, "--rev", "HEAD"]);
  assert.equal(result.code, 2);
  assert.match(result.out, /README\.md:1: path-users/);
});

test("audit: every generic pattern fires on its plant", () => {
  const cases = [
    [j("w", "s1 is up"), "host-ws-n"],
    [j("http://dashboard", ".lo", "cal/"), "host-dot-local"],
    [j("/Us", "ers/someone"), "path-users"],
    [j("/ho", "me/someone"), "path-home"],
    [j("/mn", "t/data"), "path-mnt"],
    [j("/Vol", "umes/disk"), "path-volumes"],
    [j("cd ", "~", "/project"), "path-tilde"],
    [j("asia", "-east1"), "cloud-region"],
    [j("southamerica-ea", "st1-b"), "cloud-region"],
    [j("10.", "20.30.40"), "ipv4"],
    [j("8.", "8.4.4"), "ipv4"],
    [j("P1", "-000"), "id-task"],
    [j("W99", "-999"), "id-workstream"],
    [j("A9", "99"), "id-decision"],
    [j("Q", "99"), "id-question"],
    [j("XY-0", "99"), "id-registry"],
    [j("long-thread-xyz-0", "99"), "id-registry"],
    [j("someone", "@", "corp.io"), "email"],
  ];
  for (const [line, id] of cases) assert.ok(ids("site/x.js", line).includes(id), `${id}: ${line}`);
});

test("audit: the registry id shape spares a standard's name and other digit counts", () => {
  for (const line of ["SHA-256", "sha-512", "AES-128", "ISO-639", "UTF-016", "XY-99", "XY-0999", "abcd-123", "lt-1", "v0.1.9-perf.12"]) {
    assert.ok(!ids("site/x.js", line).includes("id-registry"), line);
  }
});

test("audit: the public list holds generic shapes only (concrete names live in the private gate)", () => {
  const raw = JSON.parse(readFileSync(join(HERE, "patterns.json"), "utf8"));
  const generic = [
    "host-ws-n", "host-dot-local", "path-users", "path-home", "path-mnt", "path-volumes", "path-tilde",
    "path-var", "path-tmp", "path-root", "cloud-region", "ipv4", "ipv6", "ipv6-compressed", "bucket-url", "vm-name",
    "host-field", "id-task", "id-workstream", "id-decision", "id-question", "id-registry", "evidence-dir", "node-options-value",
    "harness-ref-field", "email",
  ];
  const nonSecret = raw.patterns.map((pattern) => pattern.id).filter((id) => !id.startsWith("secret-"));
  assert.deepEqual(nonSecret, generic);
  assert.equal(raw.patterns.filter((pattern) => pattern.id.startsWith("secret-")).length, 24);
  for (const exception of raw.exceptions) {
    assert.equal(exception.applies_to, undefined, "a public exception names no pattern id");
    if (exception.path !== undefined) {
      assert.ok(["site/config.json", "tools/t3cp/run-record.sh", "tools/t3cp/runner/run-record.test.mjs"].includes(exception.path), exception.path);
    }
    assert.ok(
      /^Run and funded by /.test(exception.string) ||
        /^https:\/\/[a-z]+\.com$/.test(exception.string) ||
        /^github\.com\/[a-z]+\/t3code$/.test(exception.string) ||
        (/^Co-Authored-By: /.test(exception.string) && exception.scope === "messages") ||
        (/^"https:\/\/plausible\.io\/js\/pa-[A-Za-z0-9]+\.js"$/.test(exception.string) && exception.path === "site/config.json") ||
        (exception.string === j('"NODE_OPTIONS=--max-old-space-si', 'ze=8192"') && /^tools\/t3cp\/(?:runner\/run-record\.test\.mjs|run-record\.sh)$/.test(exception.path)),
      "exceptions are the credit, its link, the fork URL, the co-author trailer, the analytics script in site/config.json and the runner's chosen heap parameter only",
    );
  }
});

test("audit: near misses stay quiet", () => {
  for (const line of [
    j(".env", ".local and .env.production", ".local"),
    "http://localhost:3000 and 127.0.0.1 and 0.0.0.0",
    "docs use 192.0.2.10, 198.51.100.7 and 203.0.113.9",
    "version 1.2.3 and node 26.13.1",
    "user@example.com and someone@host.test",
    "us-east and europe",
    "wsx ws10 news1",
    "home page and /homepage",
    "3d3c42e5aac5ba805825da76410c181273ba90b1",
  ]) {
    assert.deepEqual(ids("site/x.js", line), [], line);
  }
});

test("audit: secret patterns fire without echoing the secret", () => {
  const token = j("gh", "p_", "A1b2".repeat(9));
  const cases = [
    [token, "secret-github-token"],
    [j("AK", "IA", "ABCDEFGHIJKLMNOP"), "secret-aws-access-key"],
    [j("-----BEGIN ", "RSA PRIVATE KEY-----"), "secret-private-key"],
    [j("https://", "user:", "hunter2pass", "@host.test/x"), "secret-url-credentials"],
    [j("sk-", "ant-", "abcdEFGH1234", "ijklMNOP5678"), "secret-anthropic-key"],
    [j("key = ", "Zx9Qw7Lm3Np8Rt2Vb6Kc4", "Hd1Fg5Js0Yu7Ie3Oa9Pw2"), "secret-high-entropy"],
  ];
  for (const [line, id] of cases) assert.ok(ids("site/x.js", line).includes(id), `${id}`);
  const root = dirWith({ "a.txt": `${token}\n` });
  const result = cli(["--tree", root]);
  assert.equal(result.code, 2);
  assert.match(result.out, /a\.txt:1: secret-github-token/);
  assert.ok(!result.out.includes(token), "the token must not be printed");
});

test("audit: assignments and paths in source are not keys; keys with slashes or padding still are", () => {
  assert.deepEqual(ids("tools/x.sh", 'EXE="$SRC/apps/server/dist-exe/t3"'), []);
  assert.deepEqual(ids("tools/x.sh", "env -i T3CODE_TELEMETRY_ENABLED=false node x"), []);
  assert.deepEqual(ids("x.txt", "  migration: 88_TurnItemTypeStatusIndex"), []);
  assert.deepEqual(ids("x.txt", "  migration: 92_QueuedTurnInputIndexJSONValid2"), []);
  assert.deepEqual(ids("x.txt", j("Zx9Qw7Lm3Np8", "Rt2Vb6Kc4Hd1")), ["secret-high-entropy"]);
  const key = j("Zx9Qw7Lm3Np8", "/Rt2Vb6Kc4Hd1Fg5Js0", "Yu7Ie3Oa9Pw2");
  assert.deepEqual(ids("x.env", `TOKEN_VALUE_FOR_TESTS=${key}`), ["secret-high-entropy"]);
  assert.deepEqual(ids("x.txt", j(key, "==")), ["secret-high-entropy"]);
});

test("audit: digests and ids are not keys", () => {
  assert.deepEqual(ids("package-lock.json", j('"integrity": "sha512-', "Zx9Qw7Lm3Np8Rt2Vb6Kc4", "Hd1Fg5Js0Yu7Ie3Oa9Pw2==", '"')), []);
  assert.deepEqual(ids("x.json", '"sha": "8f14e45fceea167a5a36dedd4bea2543f0e6a1b2"'), []);
  assert.deepEqual(ids("x.json", '"id": "0b9c7f1e-4a2d-4c6e-9f3a-1d2e3f4a5b6c"'), []);
});

test("audit: an exception permits only a match wholly inside its exact string, in its scope", () => {
  const trailer = j("Co-Authored-By: Claude Opus 5.5 <noreply", "@", "anthropic.com>");
  const cfg = loadPatterns();
  assert.deepEqual(scanLine("commit:x", trailer, { scope: "messages", cfg }), []);
  assert.deepEqual(ids("site/x.md", trailer), ["email"]);
  const near = j("Co-Authored-By: Claude Opus 5.5 <other", "@", "anthropic.com>");
  assert.deepEqual(scanLine("commit:x", near, { scope: "messages", cfg }).map((hit) => hit.id), ["email"]);
});

test("audit: file refusals", () => {
  const root = dirWith({
    "big.json": "x".repeat(1_000_001),
    "fine.json": "x".repeat(1_000_000),
    "run/server.trace.ndjson": "{}\n",
    "run/db.sqlite": "x",
    "run/server.log": "x",
    "run/cpu.cpuprofile": "x",
    "run/heap.heapsnapshot": "x",
    "run/creds/token.json": "{}\n",
    "fixture-bench/settings.json": "{}\n",
    "site/settings.json": "{}\n",
    "plans/notes.md": "x\n",
    "site/image.bin": Buffer.from([0x89, 0x50, 0x00, 0x01]),
  });
  const { hits } = auditTree(root);
  const got = hits.map((hit) => `${hit.path} ${hit.id}`).sort();
  assert.deepEqual(got, [
    "big.json file-too-large",
    "fixture-bench/settings.json bench-settings",
    "plans/notes.md path-plans",
    "run/cpu.cpuprofile file-type",
    "run/creds/token.json path-creds",
    "run/db.sqlite file-type",
    "run/heap.heapsnapshot file-type",
    "run/server.log file-type",
    "run/server.trace.ndjson file-type",
    "site/image.bin binary-not-allowed",
  ]);
});

test("audit: path names are scanned", () => {
  const { hits } = auditTree(dirWith({ [j("notes/w", "s1-setup.md")]: "x\n" }));
  assert.deepEqual(hits.map((hit) => hit.id), ["host-ws-n"]);
});

test("audit: a diff reports only added lines and new paths", () => {
  const root = dirWith({ "a.md": j("old /ho", "me/x line\n") });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "one"]);
  writeFileSync(join(root, "a.md"), j("old /ho", "me/x line\nclean line\n"));
  git(root, ["commit", "-q", "-am", "two"]);
  assert.equal(cli(["--repo", root, "--diff", "HEAD~1..HEAD"]).code, 0);
  writeFileSync(join(root, "a.md"), j("old /ho", "me/x line\nclean line\nnew ", "Q", "9 line\n"));
  writeFileSync(join(root, j("w", "s2.md")), "x\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "three"]);
  const result = cli(["--repo", root, "--diff", "HEAD~1..HEAD"]);
  assert.equal(result.code, 2);
  assert.match(result.out, /a\.md:3: id-question/);
  assert.match(result.out, new RegExp(j("w", "s2\\.md: host-ws-n")));
  assert.doesNotMatch(result.out, /a\.md:1:/);
});

test("audit: commit messages are scanned; only the permitted co-author trailer passes", () => {
  const trailer = j("Co-Authored-By: Claude Opus 5.5 <noreply", "@", "anthropic.com>");
  const root = dirWith({ "a.md": "x\n" });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", j("Add a\n\n", trailer)]);
  assert.equal(cli(["--repo", root, "--messages", "HEAD"]).code, 0);
  writeFileSync(join(root, "a.md"), "y\n");
  git(root, ["commit", "-q", "-am", j("Fix ", "P1", "-000\n\nCo-Authored-By: Some Reviewer <r", "@", "corp.io>")]);
  const result = cli(["--repo", root, "--messages", "HEAD~1..HEAD"]);
  assert.equal(result.code, 2);
  assert.match(result.out, /commit [0-9a-f]{12}:1: id-task/);
  assert.match(result.out, /commit [0-9a-f]{12}:3: email/);
  assert.deepEqual(ids("site/x.md", trailer), ["email"]);
});

test("audit: --repo-files scans tracked files as they are on disk, not untracked ones", () => {
  const root = dirWith({ "a.md": "clean\n", "b.md": "clean\n" });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "x"]);
  assert.equal(cli(["--repo", root, "--repo-files"]).code, 0);
  writeFileSync(join(root, "a.md"), j("edited /Vol", "umes/disk\n"));
  writeFileSync(join(root, "untracked.md"), j("/Vol", "umes/disk\n"));
  const result = cli(["--repo", root, "--repo-files"]);
  assert.equal(result.code, 2);
  assert.match(result.out, /a\.md:1: path-volumes/);
  assert.doesNotMatch(result.out, /untracked/);
});

test("audit: errors fail closed (exit 1)", () => {
  assert.equal(cli(["--repo", tmpdir(), "--rev", "no-such-rev"]).code, 1);
  assert.equal(cli(["--tree", join(tmpdir(), "no-such-dir-t3cp")]).code, 1);
  assert.equal(cli([]).code, 1);
});

test("audit: patterns.json is well-formed and tools/audit passes its own scan", () => {
  const config = loadPatterns();
  const raw = JSON.parse(readFileSync(join(HERE, "patterns.json"), "utf8"));
  assert.equal(config.patterns.length, raw.patterns.length);
  const seen = new Set();
  for (const pattern of raw.patterns) {
    assert.match(pattern.id, /^[a-z0-9-]+$/);
    assert.ok(!seen.has(pattern.id), pattern.id);
    seen.add(pattern.id);
    assert.equal(typeof pattern.description, "string");
    assert.match(pattern.flags, /^i?$/);
  }
  for (const exception of raw.exceptions) {
    assert.ok((exception.applies_to ?? []).every((id) => seen.has(id)), exception.string);
  }
  const { hits } = auditTree(HERE);
  assert.deepEqual(hits, []);
});

test("audit: --each scans every commit's own diff, so a value one commit adds and a later one removes is found", () => {
  const token = j("gh", "p_", "A1b2".repeat(9));
  const root = dirWith({ "README.md": "clean\n" });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "a"]);
  const a = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "site.js"), `const t = "${token}";\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "b"]);
  const b = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "site.js"), "const t = null;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "c"]);
  // The range's net diff no longer holds the value...
  assert.equal(cli(["--diff", `${a}..HEAD`], root).code, 0);
  // ...but the commit that added it is public history: --each reads every commit of the range.
  const each = cli(["--each", `${a}..HEAD`], root);
  assert.equal(each.code, 2, each.out);
  assert.match(each.out, new RegExp(`${b.slice(0, 12)} site\\.js:1: secret-github-token`));
  assert.ok(!each.out.includes(token), "the token must not be printed");
  // A single rev means its whole history, the root commit included (every file of it).
  const whole = cli(["--each", "HEAD"], root);
  assert.equal(whole.code, 2, whole.out);
  const rootOnly = dirWith({ "a.txt": `${token}\n` });
  git(rootOnly, ["init", "-q"]);
  git(rootOnly, ["add", "-A"]);
  git(rootOnly, ["commit", "-q", "-m", "root"]);
  assert.equal(cli(["--each", "HEAD"], rootOnly).code, 2);
});

test("audit: the project's runner VM names are host names", () => {
  for (const name of [j("t3cp", "-r-20261116154108-0"), j("t3cp", "-r-x-0")]) {
    assert.ok(ids("site/x.js", `// ran on ${name} overnight`).includes("vm-name"), name);
  }
  for (const line of ["the t3cp-runner image", "t3cp-r is a prefix", "see t3cp-validate.md"]) {
    assert.deepEqual(ids("site/x.js", line).filter((id) => id === "vm-name"), [], line);
  }
});

test("audit: private and link-local IPv4 addresses are found; loopback and documentation ranges are not", () => {
  // Built from parts, so this file passes the scan it tests.
  for (const ip of [j("10.128", ".0.7"), j("172.20", ".1.5"), j("172.31", ".255.1"), j("192.168", ".1.20"), j("169.254", ".169.254")]) {
    assert.ok(ids("site/x.js", `"url": "http://${ip}:45217"`).includes("ipv4"), ip);
  }
  for (const ip of ["127.0.0.1", "192.0.2.10", "198.51.100.7", "203.0.113.9", "0.0.0.0"]) {
    assert.deepEqual(ids("site/x.js", `"url": "http://${ip}:45217"`).filter((id) => id === "ipv4"), [], ip);
  }
});

test("audit: a host field is found unless its value is a placeholder", () => {
  const h = (key, value, quote = '"') => j(quote, key, quote, ": ", '"', value, '"');
  for (const line of [h("host", "build-box-7"), j("  ho", 'st: "worker42.internal",'), h("hostname", "my-vm"), j("hostna", "me = 'ci-runner-3'")]) {
    assert.ok(ids("site/x.js", line).includes("host-field"), line);
  }
  for (const line of [
    h("host", "localhost"), h("host", "127.0.0.1"), h("hostname", "example.com"), h("host", "api.example.org"),
    h("host", "<host>"), h("host", ""), '"host": {', "const facts = { host: meta.host };", 'connect({ host: "127.0.0.1", port })',
    h("host", "${HOST}"), h("host", "box.test"),
    // A description is not a host name.
    h("host", "a cloud VM"), h("host", "Mac mini (Apple silicon)"),
  ]) {
    assert.deepEqual(ids("site/x.js", line).filter((id) => id === "host-field"), [], line);
  }
});

test("audit: a recorded driver.json's host, VM name and private address fail the public audit", () => {
  const vm = j("t3cp", "-r-20261116154108-0");
  const driver = JSON.stringify(
    {
      driver: { host: vm, pid: 9875 },
      server: { url: j("http://10.128", ".0.9:45217"), pid: 9779, serverVersion: "0.1.10-nightly.20261115.4749" },
      out: "/t3cp/work/record/run/attempt-1/driver",
    },
    null,
    2,
  );
  const root = dirWith({ "tools/t3cp/runner/testdata/run/driver/driver.json": `${driver}\n` });
  const result = cli(["--tree", root]);
  assert.equal(result.code, 2, result.out);
  for (const id of ["host-field", "vm-name", "ipv4"]) assert.match(result.out, new RegExp(`driver\\.json:\\d+: ${id}`), id);
});

test("audit: the analytics script URL passes only as site/config.json's exact value", () => {
  // Built at run time, so this file holds no literal id and passes both scanners.
  const url = j("https://plausible.io/js/pa-", "Azz1Gvoc", "rwyJk70JclINr", ".js");
  const line = (value) => `    "plausible_script": "${value}",`;
  const entropy = (path, text) => ids(path, text).includes("secret-high-entropy");
  assert.ok(!entropy("site/config.json", line(url)), "the exact value in site/config.json passes");
  assert.ok(entropy("site/app.js", line(url)), "the same value in another path still hits");
  assert.ok(entropy("site/config.json.bak", line(url)), "a path that only starts with site/config.json still hits");
  assert.ok(entropy("site/config.json", line(j("https://plausible.io/js/pa-", "Bqq7Hxpd", "smzLk81KdjOPs", ".js"))), "another pa- id still hits");
  assert.ok(entropy("site/config.json", line(`${url}x9Kq`)), "the value inside a longer token still hits");
  assert.ok(entropy("site/config.json", j('    "token": "Zx9Qw7Lm3Np8Rt2Vb6Kc4', 'Hd1Fg5Js0Yu7Ie3Oa9Pw2",')), "another random run in site/config.json still hits");
  const root = dirWith({ "site/config.json": `{\n  "analytics": {\n${line(url)}\n    "plausible_domain": "t3cp.io"\n  }\n}\n` });
  const result = cli(["--tree", root]);
  assert.equal(result.code, 0, result.out);
});

test("audit: the repository audit has rule 3's generic shapes the data scanner has (M8)", () => {
  // Planted values are built from parts, so this file passes the scan it tests.
  const cases = [
    [j("served from /va", "r/www/vhosts/site"), "path-var"],
    [j("state in /va", "r/lib/thing"), "path-var"],
    [j("see /tm", "p/run-1/out"), "path-tmp"],
    [j("as /roo", "t/.config/x"), "path-root"],
    [j("fd00", ":1234", ":5678", ":9abc", "::1"), "ipv6-compressed"],
    [j("2001", ":0db8", ":85a3", ":0000", ":0000", ":8a2e", ":0370", ":7334"), "ipv6"],
    [j("upload to g", "s://bucket/x"), "bucket-url"],
    [j("copy to s", "3://bucket/x"), "bucket-url"],
    [j("see p9-99", "9-evidence/run"), "evidence-dir"],
    [j("in in", "v-scaling/notes"), "evidence-dir"],
    [j("NODE_OPTIONS=--max-old-space-si", "ze=4096"), "node-options-value"],
    [j("NODE_OPTIONS=--requi", "re=/opt/x.cjs"), "node-options-value"],
    [j('"server_re', 'f": "x"'), "harness-ref-field"],
  ];
  for (const [line, id] of cases) assert.ok(ids("site/x.md", line).includes(id), `${id}: ${line}`);
  // Not identifying: the IPv6 loopback, a clock time, a version, the bare var directory word in prose.
  for (const line of ["listen on ::1", "at 12:30:45", "version 1.2.3", "the /var directory"]) {
    assert.deepEqual(ids("site/x.md", line).filter((id) => /^(ipv6|path-var)/.test(id)), [], line);
  }
});

test("audit: every public shape of the data scanner has a repository-audit twin (no drift, M8)", async () => {
  const { PUBLIC_PATTERNS } = await import("../t3cp/lib/scan.mjs");
  const twin = {
    host_ws: "host-ws-n", host_local: "host-dot-local", path_users: "path-users", path_home: "path-home",
    path_mnt: "path-mnt", path_volumes: "path-volumes", path_var: "path-var", path_tmp: "path-tmp",
    path_root: "path-root", path_tilde: "path-tilde", ip_v4: "ipv4", ip_v6: "ipv6", ip_v6_compressed: "ipv6-compressed",
    email: "email", gcp_region: "cloud-region", bucket_url: "bucket-url", task_id: "id-task",
    fleet_task_id: "id-workstream", decision_id: "id-decision", question_id: "id-question",
    evidence_dir: "evidence-dir", node_options_value: "node-options-value", harness_ref_field: "harness-ref-field",
    secret_token: "secret-github-token",
  };
  // Shapes the repository audit covers otherwise, with the reason.
  const otherwise = {
    path_private: "a macOS system root that code comments name; machines' home paths are path-users",
    creds: "a creds/ directory is a path refusal (path-creds) for every file",
  };
  const ids = new Set(loadPatterns().patterns.map((pattern) => pattern.id));
  for (const { id } of PUBLIC_PATTERNS) {
    if (id in otherwise) continue;
    assert.ok(id in twin && ids.has(twin[id]), `the data scanner's ${id} has no repository-audit twin`);
  }
});

test("audit: a commit message's control characters cannot hide the rest of it", () => {
  const root = dirWith({ "README.md": "x\n" });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  const planted = j("see /Us", "ers/someone/notes");
  for (const message of [`subject\x02 ${planted}`, `subject\x01\x02\n\n${planted}`]) {
    execFileSync("git", ["commit", "-q", "--allow-empty", "-F", "-"], {
      cwd: root, input: message,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
    });
    const result = cli(["--messages", "HEAD~1..HEAD"], root);
    assert.equal(result.code, 2, `${JSON.stringify(message.slice(0, 12))}: ${result.out}`);
    assert.match(result.out, /path-users/);
  }
});

test("audit: a long run of digits is judged quickly (the identifier test does not backtrack)", () => {
  for (const n of [28, 40, 200]) {
    const started = process.hrtime.bigint();
    scanLine("site/x.js", `v = ${"1".repeat(n)}x`);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 250, `${n} digits took ${ms.toFixed(0)} ms`);
  }
  // The identifier shapes still read as identifiers, not random runs.
  for (const id of ["88_TurnItemTypeStatusIndex", "HTMLParserFactory2Builder", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"]) {
    assert.deepEqual(ids("site/x.js", `const x = ${id};`).filter((i) => i === "secret-high-entropy"), [], id);
  }
});

test("audit: the bench's chosen heap parameter passes only as the runner's exact quoted value", () => {
  // Built at run time, so this file holds no NODE_OPTIONS value.
  const value = j('"NODE_OPTIONS=--max-old-space-si', 'ze=8192"');
  const hit = (path, text) => ids(path, text).includes("node-options-value");
  assert.ok(!hit("tools/t3cp/run-record.sh", `  --server-env ${value})`), "the runner's own line");
  assert.ok(!hit("tools/t3cp/runner/run-record.test.mjs", `        ${value},`), "the runner test that pins it");
  assert.ok(hit("tools/t3cp/other.sh", `  --server-env ${value})`), "the same value in another path still hits");
  assert.ok(hit("tools/t3cp/run-record.sh", `  --server-env ${value.replace("8192", "4096")})`), "another heap size still hits");
  assert.ok(hit("tools/t3cp/run-record.sh", `  --server-env ${value.replace('"', "")}`), "the unquoted value still hits");
});

// The forbidden-pattern scanner: a public list of generic shapes plus a private list of concrete names read from
// the file named by T3CP_PRIVATE_PATTERNS. Every planted string is built from fragments at run time, so this file
// itself contains none of them and passes the self-scan.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanText, scanValue, loadPrivatePatterns, PUBLIC_PATTERNS } from "./scan.mjs";

const j = (...parts) => parts.join("");
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const hits = (text, opts = {}) => scanText(text, { env: false, ...opts }).map((h) => h.pattern);
const flagged = (text, opts) => hits(text, opts).length > 0;

test("scan: clean public numbers, tags, SHAs, metric names, loopback and documentation addresses pass", () => {
  for (const text of [
    "v0.1.10-nightly.20261115.4749 295a0a7332aa1b0cc2f737dae71bd5e607a6ebb9",
    "Turn end to end p50 fell 23.4 % to 9,257 ms at 100 agents on a cloud VM (n2d-standard-16, AMD EPYC 7B13, spot)",
    "2026-11-16T12:00:00Z 6.12.48+deb13-cloud-amd64 Debian 13 t3cp-harness/1.0.0",
    "T3 Code, ms/s, pages/min, 0–1, /proc/stat, .env.local, a bare /tmp/ ignore rule",
    "listen on 127.0.0.1 and 0.0.0.0; docs use 192.0.2.10; mail someone@example.com",
  ]) {
    assert.deepEqual(hits(text), [], text);
  }
});

test("scan: host-name shapes", () => {
  assert.ok(hits(j("ran on w", "s3")).includes("host_ws"));
  assert.ok(hits(j("W", "S4 down")).includes("host_ws"));
  assert.ok(hits(j("ws", "4-other")).includes("host_ws"));
  assert.ok(hits(j("boxes", ".local")).includes("host_local"));
});

test("scan: absolute paths of machines", () => {
  for (const top of ["Users", "home", "mnt", "Volumes", "var", "private", "tmp", "root"]) {
    assert.ok(hits(`at /${top}/x`).includes(`path_${top.toLowerCase()}`), top);
  }
  assert.ok(hits(j("see ~", "/notes")).includes("path_tilde"));
  assert.ok(hits(j("cre", "ds/token.json")).includes("creds"));
});

test("scan: IP addresses", () => {
  assert.ok(hits(j("10.", "199.0.12")).includes("ip_v4"));
  assert.ok(hits(j("connect 34.", "89.1.2:443")).includes("ip_v4"));
  assert.ok(hits(["fe80", "0", "0", "0", "1", "2", "3", "4"].join(":")).includes("ip_v6"));
});

test("scan: any cloud region or zone shape and bucket URLs", () => {
  for (const text of [j("europe", "-west9"), j("us", "-east7-b"), j("asia", "-southeast3"), j("gs", "://bucket"), j("s3", "://bucket")]) {
    assert.ok(flagged(text), text);
  }
});

test("scan: emails, task, decision and question ids, evidence directories", () => {
  for (const text of [j("someone", "@corp.io"), j("P", "1-007"), j("P", "2-004"), j("W", "14-013"), j("A", "152"), j("Q", "11"), j("p1", "-007-evidence"), j("in", "v-livestream")]) {
    assert.ok(flagged(text), text);
  }
});

test("scan: internal knob values and the harness reference field", () => {
  for (const text of [j("--max-old", "-space-size=4321"), j("--req", "uire=bench-preload.cjs"), j("server", "_ref")]) {
    assert.ok(flagged(text), text);
  }
});

test("scan: secret token shapes, not their regex sources", () => {
  for (const text of [j("gh", "p_", "a".repeat(36)), j("sk", "-ant-api03-abcdefgh"), j("-----BEGIN ", "PRIVATE KEY-----"), j("AK", "IA", "A".repeat(16)), j("github", "_pat_", "b".repeat(30))]) {
    assert.ok(flagged(text), text);
  }
  assert.deepEqual(hits(j("github", "_pat_[A-Za-z0-9_]{22,}")), []);
});

test("scan: the public list holds no concrete names; they come from the private list", () => {
  const concrete = [j("work", "-station-3"), j("Core", "finity"), j("cf", "stack"), j("Lon", "don"), j("na", "vid"), j("He", "rmes")];
  for (const text of concrete) assert.deepEqual(hits(text), [], `${text} must not be on the public list`);
  const privatePatterns = [new RegExp(j("work-?", "station"), "giu"), new RegExp(j("core", "finity"), "giu"), new RegExp(j("\\bna", "vid"), "giu")];
  assert.deepEqual(hits(j("work", "-station-3"), { privatePatterns }), ["private_1"]);
  assert.deepEqual(hits(j("Core", "finity data"), { privatePatterns }), ["private_2"]);
});

test("scan: allowed public uses pass both lists: the fork URL, the MRs author query, the sponsor credit", () => {
  const handle = j("navid", "nadali");
  const sponsor = j("Core", "finity");
  const privatePatterns = [new RegExp(j("na", "vid|na", "dali"), "giu"), new RegExp(sponsor.toLowerCase(), "giu")];
  for (const text of [
    `https://github.com/${handle}/t3code/releases`,
    `repo:pingdotgg/t3code author:${handle} type:pr`,
    `https://github.com/pingdotgg/t3code/pulls?q=is%3Apr+author%3A${handle}`,
    `Run and funded by ${sponsor}`,
    `Run and funded by [${sponsor}](https://${sponsor.toLowerCase()}.com)`,
    `<a href="https://${sponsor.toLowerCase()}.com">`,
  ]) {
    assert.deepEqual(hits(text, { privatePatterns }), [], text);
  }
  assert.ok(flagged(`author:${handle}x`, { privatePatterns }));
  assert.ok(flagged(`github.com/${handle}/other`, { privatePatterns }));
  assert.ok(flagged(`${sponsor} project`, { privatePatterns }));
});

test("scan: private patterns from the T3CP_PRIVATE_PATTERNS file apply too, and an unreadable file throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-scan-"));
  temps.push(dir);
  const file = path.join(dir, "private.txt");
  fs.writeFileSync(file, "# comment\n\nsecret-project-[0-9]+\nvm-name-x\n");
  const privatePatterns = loadPrivatePatterns(file);
  assert.equal(privatePatterns.length, 2);
  assert.deepEqual(hits("ran in secret-project-42", { privatePatterns }), ["private_1"]);
  assert.throws(() => loadPrivatePatterns(path.join(dir, "missing.txt")), /cannot read/);
  fs.writeFileSync(file, "bad[regex\n");
  assert.throws(() => loadPrivatePatterns(file), /line 1/);
});

test("scan: scanValue covers keys and nested strings", () => {
  assert.ok(scanValue({ ok: 1, nested: [{ [j("/ho", "me/x")]: 2 }] }, { env: false }).length > 0);
  assert.ok(scanValue({ a: ["fine", { b: j("w", "s1") }] }, { env: false }).length > 0);
  assert.deepEqual(scanValue({ a: 1.5, b: "fine" }, { env: false }), []);
});

test("scan: every public pattern has an id and a regex", () => {
  for (const p of PUBLIC_PATTERNS) {
    assert.match(p.id, /^[a-z0-9_]+$/);
    assert.ok(p.re instanceof RegExp);
  }
});

test("m2: compressed IPv6 forms are addresses too; loopback is not", () => {
  for (const text of [j("fe80", "::1"), j("2001:db8", "::8a2e", ":370:7334"), j("fd00", ":1::"), j("::ffff:", "10.0", ".0.1")]) {
    assert.ok(flagged(text), text);
  }
  for (const text of ["::1", "ws://[::1]:3000", "std::string", "a::b", "12:00:00"]) assert.deepEqual(hits(text), [], text);
});

test("m3: a private pattern file with no patterns is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-scan-empty-"));
  temps.push(dir);
  const file = path.join(dir, "private.txt");
  fs.writeFileSync(file, "# only a comment\n\n");
  assert.throws(() => loadPrivatePatterns(file), /no patterns/);
});

test("the ws<N> host shape is caught when joined by underscores, not inside longer words or numbers", () => {
  for (const text of [j("host_w", "s4_down"), j("w", "s3_east"), j("ran-w", "s1")]) assert.ok(hits(text).includes("host_ws"), text);
  for (const text of [j("ws", "2812"), "news1", j("rows", "2")]) assert.ok(!hits(text).includes("host_ws"), text);
});

// startup.mjs against a fake server that never becomes ready: every mark is null with a reason, never 0.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "t3cp-startup-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("a server that never reaches ready within the budget records null marks with the reason", { timeout: 60_000 }, () => {
  const t3 = join(root, "t3");
  writeFileSync(t3, "#!/bin/sh\nexec sleep 600\n");
  chmodSync(t3, 0o755);
  const out = join(root, "startup.json");
  const result = spawnSync(
    process.execPath,
    [join(here, "startup.mjs"), "--t3", t3, "--work", join(root, "work"), "--out", out, "--runs", "1", "--budget-s", "1"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr);
  const startup = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(startup.starts.length, 2);
  for (const start of startup.starts) {
    assert.equal(start.fixture, "empty");
    for (const key of ["listening_ms", "accept_ms", "db_ready_ms"]) {
      assert.equal(start[key], null);
      assert.equal(start.reasons[key], "not_reached_within_budget");
    }
  }
  assert.equal(startup.summary.empty.cold.db_ready_ms.median, null);
  assert.equal(startup.summary.empty.cold.db_ready_ms.n, 0);
});

test("a server that exits before it is ready says so", { timeout: 60_000 }, () => {
  const t3 = join(root, "t3-exits");
  writeFileSync(t3, "#!/bin/sh\nexit 3\n");
  chmodSync(t3, 0o755);
  const out = join(root, "startup-exits.json");
  spawnSync(process.execPath, [join(here, "startup.mjs"), "--t3", t3, "--work", join(root, "work2"), "--out", out, "--runs", "1"], {
    encoding: "utf8",
  });
  const startup = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(startup.starts[0].db_ready_ms, null);
  assert.equal(startup.starts[0].reasons.db_ready_ms, "server_exited");
});

/** A fake t3 that listens and accepts on its --port and says so, but never writes a database setup span. */
function listeningT3(name) {
  const script = join(root, `${name}.mjs`);
  writeFileSync(
    script,
    [
      'import { createServer } from "node:net";',
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      'createServer((s) => s.destroy()).listen(port, "127.0.0.1", () => console.log(`Listening on http://127.0.0.1:${port}`));',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const t3 = join(root, name);
  writeFileSync(t3, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(t3, 0o755);
  return t3;
}

test("a release that never writes a setup span: db_ready is null with no_setup_span after a short grace, not the whole budget", { timeout: 120_000 }, () => {
  const t3 = listeningT3("t3-no-span");
  const out = join(root, "startup-no-span.json");
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [join(here, "startup.mjs"), "--t3", t3, "--work", join(root, "work3"), "--out", out, "--runs", "1", "--budget-s", "300"],
    { encoding: "utf8", timeout: 90_000, killSignal: "SIGKILL" },
  );
  assert.notEqual(result.status, null, "startup.mjs waited out its budget for a mark the release never writes");
  assert.ok(Date.now() - started < 60_000, `took ${Date.now() - started} ms`);
  const startup = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(startup.starts.length, 2);
  for (const start of startup.starts) {
    assert.ok(Number.isFinite(start.listening_ms) && Number.isFinite(start.accept_ms), JSON.stringify(start));
    assert.equal(start.db_ready_ms, null);
    assert.equal(start.reasons.db_ready_ms, "no_setup_span");
  }
});

test("--total-budget-s caps every start together: a start it leaves no time for records extra_timeout, never 0", { timeout: 120_000 }, () => {
  // The fake server notes each start, so the test counts the starts the budget let begin: what the cap decides. A
  // wall-clock bound on the whole process would also count what the budget does not bound, the process's start-up and
  // the stop and file writes after its last start (run-record.sh keeps its hard stop 30 s past the budget for them),
  // which a loaded host stretches: one such run took 31 s.
  const begun = join(root, "t3-hangs.starts");
  const t3 = join(root, "t3-hangs");
  writeFileSync(t3, `#!/bin/sh\necho start >> "${begun}"\nexec sleep 600\n`);
  chmodSync(t3, 0o755);
  const out = join(root, "startup-total.json");
  const result = spawnSync(
    process.execPath,
    [join(here, "startup.mjs"), "--t3", t3, "--work", join(root, "work4"), "--out", out, "--runs", "3", "--budget-s", "2", "--total-budget-s", "3"],
    { encoding: "utf8", timeout: 90_000, killSignal: "SIGKILL" },
  );
  assert.notEqual(result.status, null, "startup.mjs did not end within 90 s");
  assert.equal(result.status, 1, result.stderr);
  // Each start waits its whole 2 s for a server that never becomes ready: 3 s leave room for two at most, the second
  // cut short; without the cap all six would run. (A server stopped before its shell ran is not noted, so no lower
  // bound: the rows say the other four were never begun.)
  const starts = existsSync(begun) ? readFileSync(begun, "utf8").split("\n").filter(Boolean).length : 0;
  assert.ok(starts <= 2, `${starts} servers started`);
  const startup = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(startup.starts.length, 6, "every planned start has a row");
  const timedOut = startup.starts.filter((s) => s.reasons.listening_ms === "extra_timeout");
  assert.ok(timedOut.length >= 4, JSON.stringify(startup.starts.map((s) => s.reasons)));
  for (const start of startup.starts.slice(2)) assert.equal(start.reasons.listening_ms, "extra_timeout", "a start the budget left no time for");
  for (const start of timedOut) {
    for (const key of ["listening_ms", "accept_ms", "db_ready_ms"]) {
      assert.equal(start[key], null);
      assert.equal(start.reasons[key], "extra_timeout");
    }
  }
  assert.equal(startup.timed_out, true);
});

test("startup.json is written after every start, so a stop keeps the starts that finished", { timeout: 120_000 }, async () => {
  const t3 = join(root, "t3-hangs-2");
  writeFileSync(t3, "#!/bin/sh\nexec sleep 600\n");
  chmodSync(t3, 0o755);
  const out = join(root, "startup-partial.json");
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    [join(here, "startup.mjs"), "--t3", t3, "--work", join(root, "work5"), "--out", out, "--runs", "1", "--budget-s", "3"],
    { stdio: "ignore" },
  );
  const exited = new Promise((resolve) => child.on("exit", resolve));
  let seenWhileRunning = false;
  while (child.exitCode === null && !seenWhileRunning) {
    try {
      seenWhileRunning = JSON.parse(readFileSync(out, "utf8")).starts.length === 1;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await exited;
  assert.ok(seenWhileRunning, "startup.json held the first start while the second ran");
  assert.equal(JSON.parse(readFileSync(out, "utf8")).starts.length, 2);
});

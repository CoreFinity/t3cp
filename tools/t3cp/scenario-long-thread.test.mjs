// The row long-thread-turn-start@1, as measured on validation runs of the newest and the oldest release of its era:
// one cell "lt" on the published fixture long-thread-1 (a 600 s window: the oldest release's 10th turn start ends past
// 300 s), publishing the turn-start block, the turn start and the shell read on the long thread. The shell read has its
// own era (thread_shell_span, 2026-10-26): before it the value is null with no_shell_span, while the turn-start values
// (from 2026-10-20) publish. A release before the compaction span era reports maintenance unobserved_no_span, which
// exports as a valid attempt (the cell is seeded). Synthetic inputs only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { exportAttempt } from "./export.mjs";
import { fakeScenarioSpec, writeRawScenarioAttempt } from "./lib/fake-raw.mjs";
import { loadCatalogue, loadScenarios } from "./lib/repo.mjs";
import { checkRepo } from "./scenarios-check.mjs";

const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const row = () => loadScenarios().rows.find((r) => r.id === "long-thread-turn-start" && r.version === 1);

test("red first: scenarios.json has long-thread-turn-start@1, its one cell as measured, on the published fixture, locked", () => {
  const r = row();
  assert.ok(r, "the row is in scenarios.json");
  assert.deepEqual(
    { suite: r.suite, status: r.status, harness: r.harness, fixture: r.fixture, attempts: r.attempts, platforms: r.platforms },
    { suite: "long-thread-turn-start@1", status: "active", harness: "t3cp-harness/2.0.2", fixture: "long-thread-1", attempts: 3, platforms: ["linux-x64", "darwin-arm64"] },
  );
  assert.deepEqual(r.metrics, ["turn_start_history_gap_ms", "turn_start_long_thread_ms", "get_thread_shell_long_thread_ms"]);
  assert.deepEqual(r.cells, [{ name: "lt", mode: "history", sessions: 1, subscribers: 0, pollers: 0, turn_gap: "20s", warmup_s: 30, window_s: 600, seed_compacted_at: true, post: "turn-start-gap" }]);
  const shell = loadCatalogue().metrics.find((m) => m.id === "get_thread_shell_long_thread_ms");
  assert.deepEqual([shell.era, shell.era_start], ["thread_shell_span", "2026-10-26"]);
  assert.deepEqual(checkRepo().problems, [], "the catalogue, its lock and the published fixture agree");
});

function exportLt(date, { metrics, shell, edit } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3cp-long-thread-"));
  temps.push(root);
  const r = row();
  const tag = `v0.1.1-nightly.${date.replaceAll("-", "")}.3438`;
  const spec = fakeScenarioSpec(r, { record_id: `${date}.linux-x64.nightly`, release: { tag, version: tag.slice(1), date }, fixture: { id: "long-thread-1", sha256: "a".repeat(64), migration: 63 } });
  const dir = writeRawScenarioAttempt(root, { row: r, cell: "lt", metrics, shell, spec, edit });
  return exportAttempt(dir, spec, { privatePatterns: [] });
}
const ok = (value) => ({ value, reason: null });

test("before the shell span's era (2026-10-26): the shell read is null with no_shell_span; the turn-start values publish", () => {
  const a = exportLt("2026-10-20", { metrics: { turn_start_history_gap_ms: ok(724.6), turn_start_long_thread_ms: ok(2729.3) }, shell: null });
  assert.equal(a.attempt.valid, true, a.attempt.problems.join(","));
  // Rounded as every published value is (3 decimals under 100, 1 above).
  assert.deepEqual(a.metrics, { turn_start_history_gap_ms: 724.6, turn_start_long_thread_ms: 2729.3, get_thread_shell_long_thread_ms: null });
  assert.deepEqual(a.attempt.metric_reasons, { get_thread_shell_long_thread_ms: "no_shell_span" });
  const later = exportLt("2026-10-27", { metrics: { turn_start_history_gap_ms: ok(120), turn_start_long_thread_ms: ok(1110) }, shell: { count: 280, p95_ms: 28 } });
  assert.deepEqual(later.metrics, { turn_start_history_gap_ms: 120, turn_start_long_thread_ms: 1110, get_thread_shell_long_thread_ms: 28 });
});

test("a release before the compaction span reports maintenance unobserved_no_span, which exports as a valid attempt", () => {
  const a = exportLt("2026-10-20", { metrics: { turn_start_history_gap_ms: ok(724.6), turn_start_long_thread_ms: ok(2729.3) }, shell: null, edit: (f) => (f.meta.maintenance_in_window = "unobserved_no_span") });
  assert.equal(a.attempt.valid, true, a.attempt.problems.join(","));
  assert.equal(a.attempt.maintenance_in_window, "unobserved_no_span");
});

// Synthetic scenario records for tests: t3cp/scenario-attempt/1 attempts of one scenarios.json row, built by hand
// (every value invented), folded by the merge into a t3cp/scenario-record/1 record.
import { mergeScenarioRecord } from "../merge.mjs";
import { FAKE_CODE, FAKE_PUBLIC_REFS, HARNESS, fakeIdentity, hex } from "./fake.mjs";
import { scenarioLoad } from "./scenarios.mjs";

export { scenarioLoad };

/**
 * One record of `row`: kind nightly (date), fork (tag, base) or base (sha, tag, date), every cell's attempts with
 * `value(metric, cell, n)` (a number, or null with `reason(metric, cell, n)`), valid unless `invalid(cell, n)`.
 */
export function fakeScenarioRecord({ row, date, kind = "nightly", tag, sha, base, harness = HARNESS, value = () => 1, reason = () => undefined, invalid = () => false, synthetic = false }) {
  const identity = fakeIdentity({ date, kind, tag, sha, base, harness });
  const fixture =
    row.fixture === "none"
      ? { id: "none", sha256: null, bytes: null, migration: null, recipe_sha256: null }
      : { id: row.fixture, sha256: hex(`fixture-${row.fixture}`), bytes: 1_000_000, migration: 76, recipe_sha256: null };
  const workload = { suite: row.suite, scenario: { id: row.id, version: row.version }, attempts_per_cell: row.attempts, seed: "1", now: `${date}T00:00:00Z` };
  const attempts = [];
  for (let n = 1; n <= row.attempts; n++) {
    for (const c of row.cells) {
      const bad = invalid(c.name, n);
      const metrics = {};
      const reasons = {};
      for (const id of row.metrics) {
        const v = bad ? null : value(id, c.name, n);
        metrics[id] = v;
        if (v === null && !bad) {
          const r = reason(id, c.name, n);
          if (r) reasons[id] = r;
        }
      }
      attempts.push({
        schema: "t3cp/scenario-attempt/1",
        ...(synthetic ? { synthetic: true } : {}),
        record_id: identity.record_id,
        kind: identity.kind,
        release: identity.release,
        base: identity.base,
        platform: identity.platform,
        harness: identity.harness,
        fixture,
        workload,
        era: identity.era,
        cell: c.name,
        n,
        load: scenarioLoad(row, c),
        host_guard: { busy_pct_max: 30 + n, steal_pct_max: 0.2, iowait_pct_max: 0.5, foreign_pct_mean: 0.5 },
        attempt: { valid: !bad, problems: bad ? ["scenario_unmeasured"] : [], started_at: `${date}T0${n}:00:00Z`, cycle_s: 478, contaminated: false, maintenance_in_window: 0, metric_reasons: reasons },
        metrics,
        pipeline: { exported_at: `${date}T12:00:00Z`, ...FAKE_CODE },
      });
    }
  }
  const record = mergeScenarioRecord({ attempts, scenarios: { schema: "t3cp/scenarios/1", rows: [row] }, publicRefs: FAKE_PUBLIC_REFS, generatedAt: `${date}T18:00:00Z` });
  return synthetic ? { ...record, synthetic: true } : record;
}

/** The published path of a scenario record under data/v1 (prefix scenarios/<id>/<version>/ + the ladder's own path). */
export function scenarioRecordPath(r) {
  const prefix = `scenarios/${r.workload.scenario.id}/${r.workload.scenario.version}/`;
  if (r.kind === "nightly") return `${prefix}records/${r.platform.id}/${r.release.date}.${r.release.tag}.json`;
  if (r.kind === "fork") return `${prefix}fork/${r.release.tag}.${r.platform.id}.json`;
  return `${prefix}base/${r.release.sha.slice(0, 12)}.${r.platform.id}.json`;
}

// What the exporter, the merge and the aggregator share about scenarios.json rows: the load a row's cell runs, and
// which feature eras are the ladder's.

/** A driver duration (5s, 300ms, 2m) in seconds. */
export const durationS = (d) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(d);
  if (!m) throw new Error(`not a duration: ${JSON.stringify(d)}`);
  return Number(m[1]) * (m[2] === "ms" ? 0.001 : m[2] === "m" ? 60 : 1);
};

/** The load a row's cell runs, as a scenario attempt and record publish it (the record's workload.cells entry). */
export function scenarioLoad(row, c) {
  const rate = c.poll_rate === undefined ? null : Number(c.poll_rate);
  return {
    sessions: c.sessions,
    subscribers: c.subscribers,
    pollers: c.pollers,
    mode: c.mode,
    turn_gap_s: durationS(c.turn_gap),
    switch_interval_s: c.switch_interval === undefined ? null : durationS(c.switch_interval),
    poll_interval_s: rate === null ? null : Math.round((1 / rate) * 1000) / 1000,
    fixture: c.fixture === "none" || row.fixture === "none" ? "none" : "era",
    warmup_s: c.warmup_s,
    window_s: c.window_s,
    seed_compacted_at: c.seed_compacted_at,
    post: c.post,
    mark_age_days: c.mark_age_days ?? null,
  };
}

/**
 * The feature eras of the ladder: the catalogue's, less those only scenario-lane metrics use (a scenario row's era
 * belongs to its own records and outputs, never to the ladder's attempts, records, index or series).
 */
export function ladderFeatureEras(catalogue) {
  const ladderEras = new Set(catalogue.metrics.filter((m) => m.lane !== "scenario").map((m) => m.era));
  const scenarioOnly = new Set(catalogue.metrics.filter((m) => m.lane === "scenario" && !ladderEras.has(m.era)).map((m) => m.era));
  return catalogue.feature_eras.filter((e) => !scenarioOnly.has(e.id));
}

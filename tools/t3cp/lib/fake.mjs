// Hand-made synthetic building blocks for tests and tools/t3cp/dev/synth-data.mjs: identities, attempts and
// extras that validate against the data schemas. Nothing here is measured; every value is invented.
import { createHash } from "node:crypto";
import { BUILD_REPOS, levelMetricIds } from "./schemas.mjs";
import { cellProfile, loadProfiles, metaProfile } from "../runner/profiles.mjs";

const PROFILES = loadProfiles();

export const hex = (seed, length = 64) => {
  let out = "";
  for (let i = 0; out.length < length; i++) out += createHash("sha256").update(`${seed}:${i}`).digest("hex");
  return out.slice(0, length);
};

/** A deterministic PRNG (mulberry32) in [0, 1). */
export function prng(seed) {
  let a = typeof seed === "number" ? seed >>> 0 : Number.parseInt(hex(seed, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const nightlyTag = (date, build = 4000) => {
  const ymd = date.replaceAll("-", "");
  const day = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse("2026-10-01T00:00:00Z")) / 86400000);
  const minor = day < 20 ? 1 : day < 40 ? 9 : 10;
  return `v0.1.${minor}-nightly.${ymd}.${build + day * 37}`;
};

const FEATURE_ERAS = [
  ["effect_queue_wait", "2026-10-02"],
  ["lock_wait", "2026-10-14"],
  ["gauges", "2026-10-20"],
  ["run_metrics", "2026-10-21"],
];
export const eraFor = (date) => ({
  has: FEATURE_ERAS.filter(([, from]) => date >= from).map(([id]) => id),
  missing: FEATURE_ERAS.filter(([, from]) => date < from).map(([id]) => id),
});

export const fixtureFor = (date) =>
  date <= "2026-10-30"
    ? { id: "large-63", sha256: hex("fixture-large-63"), bytes: 25_100_000_000, migration: 63, recipe_sha256: hex("recipe") }
    : { id: "large-76", sha256: hex("fixture-large-76"), bytes: 26_260_000_000, migration: 76, recipe_sha256: hex("recipe") };

export const PLATFORM = {
  id: "linux-x64",
  machine: "n2d-standard-16",
  cpu_model: "AMD EPYC 7B13",
  cores: 16,
  memory_gib: 64,
  os: "Debian 13",
  kernel: "6.12.48+deb13-cloud-amd64",
  provisioning: "spot",
  runtime_node: "26.1.0",
};

export const HARNESS = {
  version: "t3cp-harness/1.0.0",
  sha: hex("harness-sha", 40),
  files_sha256: hex("harness-files"),
  driver_sha256: hex("driver"),
  fakes_sha256: hex("fakes"),
  preload_sha256: hex("preload"),
};

/**
 * The public references the merge maps and checks against (the shape of tools/t3cp/public-refs.json), for the fakes:
 * the fake harness's public commit (its files_sha256 unchanged by the scrub), and every fake fork tag's commit.
 */
/** A second fake harness (another version, other content), for tests of a harness change. */
export const HARNESS_B = {
  version: "t3cp-harness/1.0.1",
  sha: hex("harness-b-sha", 40),
  files_sha256: hex("harness-b-files"),
  driver_sha256: hex("driver-b"),
  fakes_sha256: hex("fakes-b"),
  preload_sha256: hex("preload-b"),
};
export const FAKE_PUBLIC_REFS = {
  schema: "t3cp/public-refs/1",
  harness: Object.fromEntries(
    [[HARNESS, "harness-public-sha"], [HARNESS_B, "harness-b-public-sha"]].map(([h, seed]) => [
      h.version,
      { sha: hex(seed, 40), files_sha256: h.files_sha256, driver_sha256: h.driver_sha256, fakes_sha256: h.fakes_sha256, preload_sha256: h.preload_sha256 },
    ]),
  ),
  fork: Object.fromEntries(
    [6, 7, 8, 9, 10].flatMap((minor) => Array.from({ length: 20 }, (_, i) => `v0.1.${minor}-perf.${i + 1}`)).map((tag) => [tag, hex(`sha-${tag}`, 40)]),
  ),
};

/** A record's harness block as merge publishes it for a fake harness: the pinned public commit and the hashes. */
export const publicHarness = (h) => ({ ...h, sha: FAKE_PUBLIC_REFS.harness[h.version].sha });

/** The t3cp code identity of fake attempts and extras: versions and content hashes, never a commit. */
export const FAKE_CODE = { exporter_version: "1.0.0", exporter_files_sha256: hex("exporter-files"), runner_version: "t3cp-runner/1.0.0", runner_files_sha256: hex("runner-files") };

export const WORKLOAD = {
  profile: "real3",
  suite: "ladder-1",
  warmup_s: 60,
  window_s: 300,
  levels: [1, 50, 100, 150, 200, 250],
  empty_cell: true,
  attempts_per_level: 3,
  seed: "1",
  now: "2026-11-16T00:00:00Z",
};

/**
 * The identity block of a record or attempt. Nightly: {date}. Fork: {kind: "fork", tag: "v0.1.9-perf.7",
 * date, base: {tag, date, sha}}. Base: {kind: "base", sha: <merge-base SHA>, tag: "v0.1.9", date}.
 */
export function fakeIdentity({ date = "2026-11-15", kind = "nightly", tag, sha, base = null, harness = HARNESS, fixture, platform = PLATFORM } = {}) {
  const releaseTag = tag ?? nightlyTag(date);
  const version = releaseTag.slice(1);
  const releaseSha = sha ?? hex(`sha-${releaseTag}`, 40);
  const recordId =
    kind === "nightly" ? `${date}.${platform.id}.nightly` : kind === "fork" ? `${version}.${platform.id}.fork` : `${releaseSha.slice(0, 12)}.${platform.id}.base`;
  return {
    record_id: recordId,
    kind,
    release: {
      tag: releaseTag,
      sha: releaseSha,
      date,
      version,
      archive: { name: `t3-${version}-${platform.id}.tar.gz`, sha256: hex(`archive-${releaseTag}`), bytes: 182_979_000 },
      binary_sha256: hex(`binary-${releaseTag}`),
      build: kind === "nightly" ? null : { source_repo: kind === "fork" ? BUILD_REPOS[0] : BUILD_REPOS[1], script_sha256: hex("build-script") },
    },
    base: kind === "fork" ? base : null,
    platform: { ...platform },
    harness: { ...harness },
    fixture: { ...(fixture ?? fixtureFor(date)) },
    workload: { ...WORKLOAD, levels: [...WORKLOAD.levels] },
    era: eraFor(kind === "fork" && base ? base.date : date),
  };
}

/** Plausible invented magnitudes per unit, so charts look like charts. */
export function baseValue(metric, level) {
  if (metric.counter) return 0; // event counters are zero on a healthy run
  const r = prng(`base-${metric.id}`)();
  const agents = level === "1e" ? 1 : Number(level);
  const load = 1 + agents / 120;
  switch (metric.unit) {
    case "n":
      if (metric.id === "turns_completed") return Math.round(agents === 1 ? 52 : agents * 3.1);
      if (metric.id === "client_errors" || metric.id === "client_unfinished") return 0;
      return Math.round((5 + r * 40) * load);
    case "ms":
      return (20 + r * 400) * load;
    case "% of one core":
    case "%":
      return (10 + r * 60) * load;
    case "MiB":
      return (600 + r * 1500) * load;
    case "0–1":
      return Math.min(0.97, (0.2 + r * 0.3) * load);
    case "/s":
      return (50 + r * 600) * load;
    case "ms/s":
      return (5 + r * 60) * load;
    case "s":
      return 2 + r * 4;
    default:
      return (10 + r * 90) * load;
  }
}

const round = (v) => (Math.abs(v) < 100 ? Math.round(v * 1000) / 1000 : Math.round(v * 10) / 10);

/**
 * The load arguments of one cell as the runner records them for WORKLOAD.profile (real3) from profiles.json, plus the
 * cell's fixture (agents = sessions).
 */
export function fakeProfile(cell) {
  const p = cellProfile(PROFILES, WORKLOAD.profile, cell, "large-76");
  return { ...metaProfile(p), fixture: p.fixture };
}

/**
 * One attempt (schema t3cp/attempt/1). `value(metricId, cell)` overrides a metric's value (return undefined
 * to keep the default, null for "missing"); `jitter` is the relative noise (0.02 = ±2 %).
 */
export function fakeAttempt(catalogue, { identity, cell, n, valid = true, problems = [], contaminated = false, value, jitter = 0.02, startedAt }) {
  const rand = prng(`${identity.record_id}-${cell}-${n}`);
  const ids = levelMetricIds(catalogue);
  const byId = new Map(catalogue.metrics.map((m) => [m.id, m]));
  const date = identity.kind === "fork" && identity.base ? identity.base.date : identity.release.date;
  const metrics = {};
  for (const id of ids) {
    const metric = byId.get(id);
    let v = baseValue(metric, cell);
    if (metric.era_start === null && identity.kind !== "fork") v = null; // fork-only rows
    else if (metric.era_start !== null && date < metric.era_start) v = null; // before the metric's era
    else if (metric.source.file === "none") v = null; // no harness source yet
    if (v !== null && metric.unit !== "n") v = round(v * (1 + (rand() * 2 - 1) * jitter));
    if (id === "agents_served") v = fakeProfile(cell).sessions; // every agent served: not saturated
    const override = value?.(id, cell, v);
    metrics[id] = override === undefined ? v : override;
  }
  return {
    schema: "t3cp/attempt/1",
    ...structuredClone(identity),
    cell,
    n,
    profile: fakeProfile(cell),
    host_guard: { busy_pct_max: 30 + n, steal_pct_max: 0.2, iowait_pct_max: 0.5, foreign_pct_mean: 0.5 },
    attempt: {
      valid,
      problems,
      started_at: startedAt ?? `${identity.release.date}T0${Math.min(9, n)}:00:00Z`,
      cycle_s: 478,
      contaminated,
      maintenance_in_window: 0,
      saturated: false,
      saturated_by: [],
      agents_total: identity.workload ? fakeProfile(cell).sessions : null,
      // The driver's distribution check: none on the empty database, a passing one elsewhere.
      distribution: cell === "1e" ? null : { test: "binomial", p50_ratio: 1.02, p95_ratio: 0.97, passed: !problems.includes("distribution_mismatch") },
      metric_reasons: {},
      stop_forced: false,
    },
    metrics,
    pipeline: { exported_at: `${identity.release.date}T12:00:00Z`, ...FAKE_CODE },
  };
}

/** Every attempt of a full record: 6 levels x 3 plus 3 on the empty database. */
export function fakeAttempts(catalogue, identity, options = {}) {
  const cells = [...identity.workload.levels.map(String), ...(identity.workload.empty_cell ? ["1e"] : [])];
  const out = [];
  for (let n = 1; n <= identity.workload.attempts_per_level; n++) {
    for (const cell of cells) out.push(fakeAttempt(catalogue, { identity, cell, n, ...(options.attempt?.(cell, n) ?? {}), value: options.value, jitter: options.jitter }));
  }
  return out;
}

/** The record extras (schema t3cp/extras/1), one document with every part. */
export function fakeExtras(catalogue, identity, { value } = {}) {
  // Byte counts are integers, like the exporter's.
  let integer = false;
  const r = (v) => (integer ? Math.round(v) : round(v));
  const stat = (v) => {
    if (v === null) return { median: null, min: null, max: null, n: 0, values: [] };
    const mid = r(v);
    return { median: mid, min: r(v * 0.97), max: r(v * 1.03), n: 3, values: [r(v * 0.97), mid, r(v * 1.03)] };
  };
  const fixture = {};
  const empty = {};
  for (const m of catalogue.metrics.filter((x) => x.scope === "record" && x.lane === "record")) {
    if (m.id === "migration_s") continue;
    integer = m.unit === "bytes" || m.unit === "n";
    let v = round(m.unit === "bytes" ? 48_000_000 : baseValue(m, "100") * 3);
    if (m.source.file === "first-turn.json") v = round(1200 + baseValue(m, "1") );
    const o = value?.(m.id, "once", v);
    fixture[m.id] = stat(o === undefined ? v : o);
    if (m.empty_cell) {
      const e = value?.(m.id, "1e", round(v / 4));
      empty[m.id] = stat(e === undefined ? round(v / 4) : e);
    }
  }
  return {
    schema: "t3cp/extras/1",
    record_id: identity.record_id,
    fixture: { metrics: fixture },
    empty: { metrics: empty },
    migration: { per_migration: Array.from({ length: 4 }, (_, i) => ({ id: identity.fixture.migration + 1 + i, s: round(0.5 + i * 0.7) })) },
    pipeline: { exported_at: `${identity.release.date}T12:00:00Z`, ...FAKE_CODE },
  };
}

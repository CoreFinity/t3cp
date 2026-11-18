// The exporter's mapping table (design Appendix A, in full): harness output field -> catalogue metric id.
// Each extractor reads only the numbers it names and returns a finite number or null:
//  - a missing field (a renamed span, an absent gauge, a metric before its era) is null, never 0;
//  - a statistic of an entry with no samples (count 0, or lock_wait_n 0 for the lock fields) is null, never 0;
//  - a consumed field that is present but not a finite number throws MappingError (the export refuses).
import { roundValue } from "./repo.mjs";

export class MappingError extends Error {}

const isTree = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The value at a path, or null when any step is missing. */
export function at(tree, ...keys) {
  let node = tree;
  for (const key of keys) {
    if (!isTree(node) || !Object.hasOwn(node, key)) return null;
    node = node[key];
  }
  return node === undefined ? null : node;
}

/** A required finite number. */
const num = (value, what) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new MappingError(`${what}: not a finite number`);
  return value;
};
/** An optional finite number: null when absent. */
const opt = (value, what) => (value === null || value === undefined ? null : num(value, what));

/**
 * One statistic of a span, call or SQL entry: null when the entry is absent or had no samples
 * (entry[countKey] === 0), otherwise the field as a finite number (or null when the field is absent).
 */
function statOf(entry, field, what, countKey = "count") {
  if (entry === null || entry === undefined) return null;
  if (!isTree(entry)) throw new MappingError(`${what}: not an object`);
  const n = num(entry[countKey], `${what}.${countKey}`);
  if (n === 0) return null;
  return opt(entry[field], `${what}.${field}`);
}
/** A sample count itself (0 is a measurement). */
const countOf = (entry, what) => (entry === null || entry === undefined ? null : num(isTree(entry) ? entry.count : undefined, `${what}.count`));

const call = (s, type, field) => statOf(at(s.metrics, "driver", "calls", type), field, `calls["${type}"]`);
const span = (s, name, field) => statOf(at(s.metrics, "spans", name), field, `spans["${name}"]`);
const sql = (s, key, field) =>
  statOf(at(s.metrics, "sql", key), field, `sql["${key}"]`, /lock_wait/.test(field) ? "lock_wait_n" : "count");
const gauge = (s, ...keys) => opt(at(s.metrics, ...keys), keys.join("."));

/**
 * Rates over the measured window from procmon's 1 Hz cumulative /proc series (summarise.py proc_window,
 * ported). `lines` are parsed proc-1hz.ndjson records; `window` is {startMs, endMs}. Every field it consumes
 * must be a finite number; an optional per-thread field that is absent gives null for its metric.
 */
export function procWindow(lines, window) {
  if (!window) return {};
  const metaLine = lines.find((l) => isTree(l.meta));
  const meta = metaLine?.meta ?? {};
  const data = lines.filter((l) => !isTree(l.meta));
  for (const [i, l] of data.entries()) num(l?.t, `proc-1hz.ndjson sample ${i + 1}: t`);
  const rows = data.filter((l) => l.t >= window.startMs && l.t <= window.endMs);
  if (rows.length < 2) return {};
  const clk = meta.clk_tck === undefined ? 100 : num(meta.clk_tck, "proc-1hz.ndjson meta.clk_tck");
  const pid = meta.pid === undefined ? null : num(meta.pid, "proc-1hz.ndjson meta.pid");
  const a = rows[0];
  const b = rows.at(-1);
  const dt = (b.t - a.t) / 1000;
  if (!(dt > 0)) return {};
  const out = {};
  const where = (r, what) => `proc-1hz.ndjson at t=${r.t}: ${what}`;
  const thread = (r) => {
    if (r.threads === undefined || r.threads === null) return undefined;
    if (!Array.isArray(r.threads)) throw new MappingError(where(r, "threads is not a list"));
    return r.threads.find((t) => num(t?.tid, where(r, "threads[].tid")) === pid);
  };
  if (pid !== null) {
    const ma = thread(a);
    const mb = thread(b);
    if (ma && mb) {
      const delta = (key) => {
        if (ma[key] === undefined && mb[key] === undefined) return null;
        return num(mb[key], where(b, `main thread ${key}`)) - num(ma[key], where(a, `main thread ${key}`));
      };
      const per = (d, scale = 1) => (d === null ? undefined : roundValue(d / scale / dt));
      out.main_minflt_per_s = per(delta("minflt"));
      out.main_vcs_per_s = per(delta("vcs"));
      out.main_nvcs_per_s = per(delta("nvcs"));
      out.main_runq_wait_ms_per_s = per(delta("wait_ns"), 1e6);
    }
  }
  const kids = (r) => {
    if (!isTree(r.proc)) throw new MappingError(where(r, "proc is not an object"));
    let total = num(r.proc.cutime, where(r, "proc.cutime")) + num(r.proc.cstime, where(r, "proc.cstime"));
    const byComm = r.children?.by_comm ?? {};
    if (!isTree(byComm)) throw new MappingError(where(r, "children.by_comm is not an object"));
    for (const [comm, g] of Object.entries(byComm)) {
      for (const k of ["u", "s", "cu", "cs"]) total += num(g?.[k], where(r, `children.by_comm[${JSON.stringify(comm).slice(0, 40)}].${k}`));
    }
    return total;
  };
  const cpu = (r) => {
    const c = r.host?.cpu;
    if (!isTree(c)) throw new MappingError(where(r, "host.cpu is not an object"));
    for (const k of ["idle", "iowait", "steal"]) num(c[k], where(r, `host.cpu.${k}`));
    let total = 0;
    for (const [k, v] of Object.entries(c)) total += num(v, where(r, `host.cpu.${k}`));
    return { ...c, total };
  };
  // Every window row's consumed fields must be numbers, not only the two ends the rates are taken from.
  for (const r of rows) {
    if (r.proc !== undefined) kids(r);
    if (r.host?.cpu !== undefined) cpu(r);
    const main = pid === null ? undefined : thread(r);
    if (main) for (const k of ["minflt", "vcs", "nvcs", "wait_ns"]) if (main[k] !== undefined) num(main[k], where(r, `main thread ${k}`));
  }
  if (a.proc !== undefined || b.proc !== undefined) {
    out.children_cpu_pct = roundValue(((kids(b) - kids(a)) / clk / dt) * 100);
    if (b.children !== undefined) out.children_n = num(b.children?.n, where(b, "children.n"));
  }
  if (a.host?.cpu !== undefined || b.host?.cpu !== undefined) {
    const ha = cpu(a);
    const hb = cpu(b);
    const tot = hb.total - ha.total;
    if (tot > 0) {
      out.host_busy_pct = roundValue(100 * (1 - (hb.idle + hb.iowait - ha.idle - ha.iowait) / tot));
      out.host_steal_pct = roundValue((100 * (hb.steal - ha.steal)) / tot);
      out.host_iowait_pct = roundValue((100 * (hb.iowait - ha.iowait)) / tot);
    }
  }
  const wal = [];
  for (const r of rows) if (r.wal_bytes !== undefined && r.wal_bytes !== null) wal.push(num(r.wal_bytes, where(r, "wal_bytes")));
  if (wal.length > 0) {
    const sorted = [...wal].sort((x, y) => x - y);
    out.wal_max_mib = roundValue(sorted.at(-1) / 1048576);
    out.wal_median_mib = roundValue(sorted[Math.floor(sorted.length / 2)] / 1048576);
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** One preload histogram field from the attempt's one loop source: metrics.loop when present, else loop-window.json. */
function preloadLoop(s, field, windowField) {
  if (isTree(at(s.metrics, "loop"))) return opt(at(s.metrics, "loop", field), `metrics.loop.${field}`);
  return opt(at(s.loopWindow, "delay", windowField), `loop-window.json delay.${windowField}`);
}

/** Share (percent) of the window's 1 s preload lines whose loop delay max reached `ms`. */
function stallShare(loopLines, window, ms) {
  if (!window || loopLines.length === 0) return null;
  const inWindow = loopLines.filter((l, i) => {
    const t = num(l?.t, `loop-1hz.ndjson line ${i + 1}: t`);
    return t >= window.startMs && t <= window.endMs;
  });
  if (inWindow.length === 0) return null;
  const maxima = inWindow.map((l) => num(l.delay?.max_ms, `loop-1hz.ndjson at t=${l.t}: delay.max_ms`));
  return roundValue((100 * maxima.filter((v) => v >= ms).length) / maxima.length);
}

const count = (text, needle) => (typeof text === "string" ? text.split(needle).length - 1 : null);
const sumOver = (entries, field, what) => {
  if (!isTree(entries)) return null;
  let total = 0;
  for (const [k, v] of Object.entries(entries)) {
    if (!isTree(v)) throw new MappingError(`${what}["${k}"]: not an object`);
    total += opt(v[field], `${what}["${k}"].${field}`) ?? 0;
  }
  return total;
};

/**
 * Every daily, per-level catalogue metric from one valid run. `src` is:
 *   {metrics: result.json metrics, driverRaw: driver.json, window: {startMs, endMs}, windowS, proc: procWindow(..),
 *    loopWindow: loop-window.json, loopLines: loop-1hz.ndjson records, serverLog: text,
 *    shutdownS: number|null, kind: "nightly"|"fork"|"base"}
 */
export const MAPPING = {
  // The harness lists a call type when any session started such a call in the window: a row of count 0 when only
  // unserved sessions did, no row when none did. In a measured window with a call table, no row is 0 turns completed.
  turns_completed: (s) => {
    const calls = at(s.metrics, "driver", "calls");
    if (isTree(calls) && !Object.hasOwn(calls, "session.turn") && s.window !== null) return 0;
    return countOf(at(calls, "session.turn"), 'calls["session.turn"]');
  },
  agents_served: (s) => s.sessionsServed ?? null,
  turn_p50_ms: (s) => call(s, "session.turn", "p50_ms"),
  turn_p95_ms: (s) => call(s, "session.turn", "p95_ms"),
  dispatch_p50_ms: (s) => call(s, "session.dispatch", "p50_ms"),
  dispatch_p95_ms: (s) => call(s, "session.dispatch", "p95_ms"),
  first_item_p50_ms: (s) => call(s, "session.firstItem", "p50_ms"),
  push_p95_ms: (s) => call(s, "push.threadEvent", "p95_ms"),
  switch_open_p50_ms: (s) => call(s, "subscribe.httpThreadBounded", "p50_ms"),
  switch_sync_p95_ms: (s) => call(s, "subscribe.threadSync", "p95_ms"),
  shell_sync_p95_ms: (s) => call(s, "subscribe.shellSync", "p95_ms"),
  poll_thread_read_p95_ms: (s) => call(s, "poll.mcp.t3_thread_read", "p95_ms"),
  poll_project_list_p95_ms: (s) => call(s, "poll.mcp.t3_project_list", "p95_ms"),
  poll_http_bounded_p95_ms: (s) => call(s, "poll.http.threadBounded", "p95_ms"),
  session_mcp_p95_ms: (s) => {
    const calls = at(s.metrics, "driver", "calls");
    if (!isTree(calls)) return null;
    const values = Object.keys(calls)
      .filter((k) => k.startsWith("session.mcp."))
      .map((k) => statOf(calls[k], "p95_ms", `calls["${k}"]`))
      .filter((v) => v !== null);
    return values.length === 0 ? null : Math.max(...values);
  },
  thread_events_per_s: (s) => gauge(s, "driver", "thread_events_per_s"),
  shell_events_per_s: (s) => gauge(s, "driver", "shell_events_per_s"),
  client_errors: (s) => sumOver(at(s.metrics, "driver", "calls"), "errors", "calls"),
  client_unfinished: (s) => {
    const raw = at(s.driverRaw, "calls");
    return isTree(raw) ? sumOver(raw, "unfinished", "driver.json calls") : sumOver(at(s.metrics, "driver", "calls"), "unfinished", "calls");
  },

  main_busy_pct: (s) => gauge(s, "cpu", "main", "busy_pct"),
  main_user_pct: (s) => gauge(s, "cpu", "main", "user_pct"),
  main_sys_pct: (s) => gauge(s, "cpu", "main", "sys_pct"),
  proc_cpu_pct: (s) => gauge(s, "cpu", "process", "busy_pct"),
  workers_cpu_pct: (s) => gauge(s, "cpu", "worker_threads", "busy_pct"),
  children_cpu_pct: (s) => s.proc.children_cpu_pct ?? null,
  children_n: (s) => s.proc.children_n ?? null,
  elu: (s) => gauge(s, "otlp", "elu_mean"),
  elu_max: (s) => gauge(s, "otlp", "elu_max"),
  // The preload's 10 ms histogram: run.json/result.json metrics.loop when the run has that block, else loop-window.json;
  // the source is chosen once per attempt for every field (a field the chosen source lacks is n/a, never the other's).
  eld_p50_ms: (s) => preloadLoop(s, "eld_p50_ms", "p50_ms"),
  eld_p99_ms: (s) => preloadLoop(s, "eld_p99_ms", "p99_ms"),
  eld_max_ms: (s) => preloadLoop(s, "eld_max_ms", "max_ms"),
  // The server's own gauge: a different source, published apart.
  server_eld_max_ms: (s) => gauge(s, "otlp", "event_loop_delay_max_ms"),
  gc_ms_per_s: (s) => {
    if (isTree(at(s.metrics, "loop"))) return opt(at(s.metrics, "loop", "gc_ms_per_s"), "metrics.loop.gc_ms_per_s");
    const gc = at(s.loopWindow, "gc");
    if (!isTree(gc)) return null;
    const start = num(at(s.loopWindow, "start"), "loop-window.json start");
    const end = num(at(s.loopWindow, "end"), "loop-window.json end");
    if (end <= start) return null;
    return roundValue(sumOver(gc, "ms", "loop-window.json gc") / ((end - start) / 1000));
  },
  stall_share_40ms: (s) => stallShare(s.loopLines, s.window, 40),
  stall_share_100ms: (s) => stallShare(s.loopLines, s.window, 100),
  stall_share_500ms: (s) => stallShare(s.loopLines, s.window, 500),
  main_busy_1s_p95: (s) => gauge(s, "cpu", "main_busy_1s", "p95_pct"),
  main_runq_wait_ms_per_s: (s) => s.proc.main_runq_wait_ms_per_s ?? null,
  main_minflt_per_s: (s) => s.proc.main_minflt_per_s ?? null,
  main_vcs_per_s: (s) => s.proc.main_vcs_per_s ?? null,
  main_nvcs_per_s: (s) => s.proc.main_nvcs_per_s ?? null,
  main_syscr_per_s: (s) => gauge(s, "io", "main", "syscr_per_s"),
  main_syscw_per_s: (s) => gauge(s, "io", "main", "syscw_per_s"),
  proc_syscr_per_s: (s) => gauge(s, "io", "process", "syscr_per_s"),

  rss_peak_mib: (s) => gauge(s, "mem", "rss_peak_mib"),
  heap_peak_mib: (s) => gauge(s, "otlp", "heap_used_peak_mib"),
  heap_floor_mib: () => null, // harness addition pending
  wal_max_mib: (s) => s.proc.wal_max_mib ?? null,
  wal_median_mib: (s) => s.proc.wal_median_mib ?? null,

  reader_tx_avg_ms: (s) => sql(s, "sql.transaction|reader", "avg_ms"),
  reader_tx_p95_ms: (s) => sql(s, "sql.transaction|reader", "p95_ms"),
  reader_tx_wait_avg_ms: (s) => sql(s, "sql.transaction|reader", "avg_lock_wait_ms"),
  reader_tx_wait_p95_ms: (s) => sql(s, "sql.transaction|reader", "p95_lock_wait_ms"),
  reader_stmt_p95_ms: (s) => sql(s, "sqlite|reader", "p95_ms"),
  writer_tx_avg_ms: (s) => sql(s, "sql.transaction|writer", "avg_ms"),
  writer_tx_p95_ms: (s) => sql(s, "sql.transaction|writer", "p95_ms"),
  writer_tx_wait_p95_ms: (s) => sql(s, "sql.transaction|writer", "p95_lock_wait_ms"),
  reader_tx_per_s: (s) => {
    const n = countOf(at(s.metrics, "sql", "sql.transaction|reader"), 'sql["sql.transaction|reader"]');
    return n === null || !s.windowS ? null : roundValue(n / s.windowS);
  },
  writer_tx_per_s: (s) => {
    const n = countOf(at(s.metrics, "sql", "sql.transaction|writer"), 'sql["sql.transaction|writer"]');
    return n === null || !s.windowS ? null : roundValue(n / s.windowS);
  },
  reader_pool_occupancy: () => null, // harness addition pending
  reader_free_while_waiting_s: () => null, // harness addition pending
  sql_time_ms_per_s: (s) => {
    const parts = ["sqlite|reader", "sqlite|writer"]
      .map((k) => {
        const entry = at(s.metrics, "sql", k);
        return entry === null ? null : countOf(entry, `sql["${k}"]`) === 0 ? null : num(entry.total_ms, `sql["${k}"].total_ms`);
      })
      .filter((v) => v !== null);
    return parts.length === 0 || !s.windowS ? null : roundValue(parts.reduce((x, y) => x + y, 0) / s.windowS);
  },

  get_thread_shell_p95_ms: (s) => span(s, "OrchestratorV2.getThreadShell", "p95_ms"),
  snapshot_window_p95_ms: (s) => span(s, "OrchestratorV2.getThreadSnapshotWindow", "p95_ms"),
  mcp_auth_p95_ms: (s) => span(s, "McpHttpServer.authenticateRequest", "p95_ms"),
  turn_start_p50_ms: (s) => span(s, "ProviderTurnStartService.start", "p50_ms"),
  handle_run_update_p95_ms: (s) => span(s, "Orchestrator.handleRunUpdate", "p95_ms"),
  effect_queue_wait_p50_ms: () => null, // harness addition pending
  effect_queue_wait_p90_ms: () => null, // harness addition pending
  spans_in_window: (s) => gauge(s, "trace", "spans"),
  trace_dropped: () => null, // harness addition pending

  git_commands_per_turn: () => null, // harness addition pending
  git_ms_per_turn: () => null, // harness addition pending

  shutdown_s: (s) => s.shutdownS,

  buffer_full_warnings: (s) => count(s.serverLog, "live event buffer is full"),
  server_warn_lines: (s) => count(s.serverLog, "] WARN "),
  server_error_lines: (s) => count(s.serverLog, "] ERROR "),
  stream_resyncs: (s) =>
    s.kind !== "fork" || typeof s.serverLog !== "string"
      ? null
      : count(s.serverLog, "shell stream resynchronized after a live buffer overflow") + count(s.serverLog, "thread stream resynchronized after a live buffer overflow"),
  host_busy_pct: (s) => s.proc.host_busy_pct ?? null,
  host_steal_pct: (s) => s.proc.host_steal_pct ?? null,
  host_iowait_pct: (s) => s.proc.host_iowait_pct ?? null,

  fork_effect_queue_wait_p95_ms: () => null, // harness addition pending
  fork_run_effect_p95_ms: (s) => (s.kind === "fork" ? span(s, "EffectWorker.runEffect", "p95_ms") : null),
  fork_decode_projection_p95_ms: (s) => (s.kind === "fork" ? span(s, "ProjectionStore.decodeCanonicalProjection", "p95_ms") : null),
  fork_admission_changes: (s) => (s.kind === "fork" ? count(s.serverLog, "Orchestration effect admission changed") : null),
};

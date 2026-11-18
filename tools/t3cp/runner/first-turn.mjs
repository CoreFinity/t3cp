// The first turn after a cold start (record extras), timed by the runner itself rather than read from a driver key.
//
// The extras run's driver runs one history session (mode mixed on the era fixture). The driver marks warm-up
// (driver.json timeline.warmup) and at once dispatches that session's first turn on a fixture thread; the session
// counts the turn done when the thread's shell shows a new run in a terminal status. Before the driver starts, the
// runner's extras driver (extras-driver.mjs) opens its own shell stream on the server and records every thread
// update (wall time, thread, latest run, status). Afterwards the first thread whose latest run changes after the
// warm-up mark is the session's, and the turn runs from the mark to that run's first terminal status: end to end,
// as the client saw it. What could not be timed is null with a reason, never 0.

export const SCHEMA = "t3cp/first-turn-timed/1";
const TERMINAL = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const iso = (ms) => new Date(ms).toISOString();

/**
 * initial: Map threadId -> {latestRunId, itemCount} from the stream's starting snapshot; events: [{t (epoch ms), id,
 * latestRunId, status}] in arrival order; warmup: the driver's warm-up mark (ISO).
 */
export function firstTurnFrom({ initial, events, warmup }) {
  const record = { schema: SCHEMA, ms: null, started_at: null, ended_at: null, run_status: null, thread_turn_items: null, reasons: {} };
  const start = Date.parse(warmup ?? "");
  if (!Number.isFinite(start)) {
    record.reasons.ms = "no_warmup_mark";
    return record;
  }
  record.started_at = iso(start);
  // A thread's latest run as the stream last showed it before the mark (a run already there is not the session's).
  const before = new Map([...initial].map(([id, shell]) => [id, shell?.latestRunId ?? null]));
  let thread = null;
  let run = null;
  for (const e of events) {
    if (thread === null) {
      if (e.t < start) {
        before.set(e.id, e.latestRunId ?? null);
        continue;
      }
      if (e.latestRunId === null || e.latestRunId === undefined || e.latestRunId === (before.get(e.id) ?? null)) continue;
      thread = e.id;
      run = e.latestRunId;
    }
    if (e.id !== thread || e.latestRunId !== run || !TERMINAL.has(e.status)) continue;
    record.thread_turn_items = initial.get(thread)?.itemCount ?? null;
    record.run_status = e.status;
    record.ended_at = iso(e.t);
    if (e.status === "completed") record.ms = e.t - start;
    else record.reasons.ms = `first_turn_${e.status}`;
    return record;
  }
  if (thread !== null) record.thread_turn_items = initial.get(thread)?.itemCount ?? null;
  record.reasons.ms = thread === null ? "no_first_turn_seen" : "first_turn_unfinished";
  return record;
}

/**
 * Opens a shell stream on the server with the harness's own client (driver/protocol.ts, from the driver's
 * directory) and records thread updates until stop(). Resolves once the stream is open.
 */
export async function recordShell({ driverPath, url, token, timeoutMs = 60_000 }) {
  const { pathToFileURL } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const { RpcSocket, httpJson } = await import(pathToFileURL(join(dirname(driverPath), "driver", "protocol.ts")).href);
  const env = await fetch(new URL("/.well-known/t3/environment", url), { signal: AbortSignal.timeout(timeoutMs) }).then((r) => r.json());
  const protocolVersion = env?.orchestrationProtocolVersion ?? 2;
  const http = { origin: url, token, timeoutMs, protocolVersion };
  const snapshot = (await httpJson(http, "/api/orchestration/shell")).value;
  const initial = new Map((snapshot?.threads ?? []).map((t) => [t.id, { latestRunId: t.latestRunId ?? null, itemCount: t.itemCount ?? null }]));
  const ticket = (await httpJson(http, "/api/auth/websocket-ticket", { method: "POST" })).value.ticket;
  const wsUrl = new URL("/ws", url);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("orchestrationProtocol", String(protocolVersion));
  wsUrl.searchParams.set("wsTicket", ticket);
  const socket = await RpcSocket.open(wsUrl.href, timeoutMs);
  const events = [];
  let ended = null;
  const stopStream = socket.stream(
    "orchestration.subscribeShell",
    { afterSequence: snapshot?.snapshotSequence ?? 0, requestCompletionMarker: true },
    {
      onValues: (values) => {
        const t = Date.now();
        for (const value of values ?? []) {
          const threads = value?.kind === "snapshot" ? (value.snapshot?.threads ?? []) : value?.kind === "thread.updated" && value.thread ? [value.thread] : [];
          for (const th of threads) events.push({ t, id: th.id, latestRunId: th.latestRunId ?? null, status: th.status ?? null });
        }
      },
      onEnd: (error) => {
        ended = error?.message ?? "completed";
      },
    },
  );
  return {
    initial,
    events,
    stop() {
      try {
        stopStream();
        socket.close?.();
      } catch {
        // the server may be gone already
      }
      return ended;
    },
  };
}

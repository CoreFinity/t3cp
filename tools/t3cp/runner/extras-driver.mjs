#!/usr/bin/env node
// t3cp record extras: run.ts's --driver for the extras run only (never a ladder attempt). It runs the harness's
// driver ($T3CP_DRIVER_TS) with every argument run.ts passes, unchanged, and relays its output. When the driver
// has finished (its window, drain and teardown are over) and T3CP_SNAPSHOT_LARGEST=1, it makes one full snapshot
// GET of the largest fixture thread (most turn items in the server's shell snapshot, archive included) while the
// server is still up, reads the whole body, and writes <runDir>/snapshot-after.json: ms from request to last
// byte, wire bytes (as sent, content-encoded) and body bytes (decoded), status, and the request's start and end
// times, so a reader can check it came after the window. With T3CP_FIRST_TURN=1 it also times the first turn after
// the cold start itself (first-turn.mjs): before the driver starts it opens its own shell stream on the server, and
// when the driver is done it writes <runDir>/first-turn.json from the driver's warm-up mark (when its history session
// dispatches that turn) to the turn's settled run. Then it exits with the driver's code.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createGunzip, createInflate } from "node:zlib";

import { firstTurnFrom, recordShell, SCHEMA as FIRST_TURN_SCHEMA } from "./first-turn.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = flag("--out");
const url = flag("--url");
const driver = process.env.T3CP_DRIVER_TS;
if (!out || !url || !driver) {
  process.stderr.write("extras-driver: --out, --url and T3CP_DRIVER_TS are required\n");
  process.exit(2);
}
const runDir = dirname(resolve(out));
const token = process.env.T3_BENCH_TOKEN ?? "";

function get(path, { protocol, timeoutMs, decode }) {
  return new Promise((done) => {
    const started = new Date();
    const t0 = performance.now();
    const target = new URL(path, url);
    const req = request(
      target,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "accept-encoding": "gzip, deflate",
          "x-t3-orchestration-protocol": String(protocol),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let wire = 0;
        let body = 0;
        const chunks = [];
        const encoding = res.headers["content-encoding"] ?? null;
        const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : null;
        const sink = decoder ?? res;
        if (decoder) {
          res.on("data", (c) => {
            wire += c.length;
          });
          res.pipe(decoder);
        }
        sink.on("data", (c) => {
          if (!decoder) wire += c.length;
          body += c.length;
          if (decode) chunks.push(c);
        });
        sink.on("end", () =>
          done({
            ok: res.statusCode === 200,
            status: res.statusCode,
            ms: Math.round((performance.now() - t0) * 10) / 10,
            wire_bytes: wire,
            body_bytes: body,
            content_encoding: encoding,
            started_at: started.toISOString(),
            ended_at: new Date().toISOString(),
            text: decode ? Buffer.concat(chunks).toString("utf8") : null,
          }),
        );
        sink.on("error", (error) => done({ ok: false, status: res.statusCode, error: String(error?.message ?? error) }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => done({ ok: false, status: null, error: String(error?.message ?? error) }));
    req.end();
  });
}

async function snapshotLargest() {
  const record = { schema: "t3cp/snapshot-after/1", reasons: {} };
  let protocol = 2;
  const env = await get("/.well-known/t3/environment", { protocol, timeoutMs: 30_000, decode: true });
  try {
    protocol = JSON.parse(env.text ?? "{}").orchestrationProtocolVersion ?? 2;
  } catch {
    // default protocol 2
  }
  const shell = await get("/api/orchestration/shell", { protocol, timeoutMs: 120_000, decode: true });
  if (!shell.ok) {
    record.reasons.ms = `shell_status_${shell.status ?? "error"}`;
    return record;
  }
  let threads = [];
  try {
    const parsed = JSON.parse(shell.text);
    threads = [...(parsed.threads ?? []), ...(parsed.archivedThreads ?? [])];
  } catch {
    record.reasons.ms = "shell_unreadable";
    return record;
  }
  const largest = threads.reduce((a, b) => ((b?.itemCount ?? -1) > (a?.itemCount ?? -1) ? b : a), undefined);
  if (!largest?.id) {
    record.reasons.ms = "no_thread";
    return record;
  }
  record.thread_turn_items = largest.itemCount ?? null;
  const full = await get(`/api/orchestration/threads/${encodeURIComponent(largest.id)}`, {
    protocol,
    timeoutMs: 300_000,
    decode: false,
  });
  Object.assign(record, {
    status: full.status ?? null,
    ms: full.ok ? full.ms : null,
    wire_bytes: full.ok ? full.wire_bytes : null,
    body_bytes: full.ok ? full.body_bytes : null,
    content_encoding: full.content_encoding ?? null,
    started_at: full.started_at ?? null,
    ended_at: full.ended_at ?? null,
  });
  if (!full.ok) record.reasons.ms = full.error === "timeout" ? "snapshot_timeout" : `snapshot_status_${full.status ?? "error"}`;
  return record;
}

/** The first turn after the cold start, from this process's own shell stream and the driver's warm-up mark. */
function firstTurnRecord(shell, shellError) {
  const result = (() => {
    try {
      return JSON.parse(readFileSync(join(resolve(out), "driver.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  const nothing = (reason) => ({ schema: FIRST_TURN_SCHEMA, ms: null, started_at: null, ended_at: null, run_status: null, thread_turn_items: null, reasons: { ms: reason } });
  if (shell === null) return { ...nothing("shell_stream_failed"), error: shellError };
  if (result === null) return nothing("no_driver_result");
  if (!((result.workload?.historySessions ?? 0) >= 1)) return nothing("no_history_session");
  return firstTurnFrom({ initial: shell.initial, events: shell.events, warmup: result.timeline?.warmup ?? null });
}

let shell = null;
let shellError = null;
if (process.env.T3CP_FIRST_TURN === "1") {
  try {
    shell = await recordShell({ driverPath: resolve(driver), url: new URL(url).origin, token, timeoutMs: 120_000 });
  } catch (error) {
    shellError = String(error?.message ?? error).slice(0, 300);
  }
}

const child = spawn(process.execPath, [driver, ...args], { stdio: ["ignore", "inherit", "inherit"] });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", async (code, signal) => {
  if (process.env.T3CP_FIRST_TURN === "1") {
    const streamEnd = shell?.stop() ?? null;
    const record = firstTurnRecord(shell, shellError);
    if (streamEnd !== null) record.stream_end = String(streamEnd).slice(0, 300);
    record.driver_exit = code;
    writeFileSync(join(runDir, "first-turn.json"), `${JSON.stringify(record)}\n`);
  }
  if (process.env.T3CP_SNAPSHOT_LARGEST === "1") {
    let record;
    try {
      record = await snapshotLargest();
    } catch (error) {
      record = { schema: "t3cp/snapshot-after/1", reasons: { ms: "snapshot_error" }, error: String(error?.message ?? error) };
    }
    record.driver_exit = code;
    writeFileSync(join(runDir, "snapshot-after.json"), `${JSON.stringify(record)}\n`);
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

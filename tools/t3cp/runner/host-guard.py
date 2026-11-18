#!/usr/bin/env python3
"""t3cp record runner: the host guard, one line per second while an attempt runs (Linux).

From /proc/stat's aggregate cpu line, over the last second, as a share of the whole host (all CPUs):
busy_pct (everything but idle and iowait), steal_pct, iowait_pct. From the cgroup the runner runs in
(cgroup v2 cpu.stat usage_usec: the runner, run.ts, the server, the driver, the fakes, git, even reaped or
re-parented children) own_pct, and foreign_pct = busy_pct - own_pct: CPU the benchmark did not use itself
(another workload, a noisy neighbour inside the VM, kernel work not charged to it). Without a readable cgroup
own_pct and foreign_pct are null.

usage: host-guard.py --out <file.ndjson> --parent-pid <pid> [--cgroup-of <pid>] [--stat /proc/stat]
Stops on SIGTERM or when --parent-pid is gone.
"""
import argparse
import json
import os
import signal
import sys
import time

FIELDS = ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal"]
CLK = os.sysconf("SC_CLK_TCK")


def cpu_line(path):
    try:
        with open(path) as f:
            for line in f:
                if line.startswith("cpu "):
                    return dict(zip(FIELDS, (int(x) for x in line.split()[1:9])))
    except OSError:
        return None
    return None


def cgroup_stat_path(pid):
    """cgroup v2: /proc/<pid>/cgroup has '0::/<path>'; its cpu.stat under /sys/fs/cgroup."""
    try:
        with open(f"/proc/{pid}/cgroup") as f:
            for line in f:
                parts = line.rstrip("\n").split(":", 2)
                if len(parts) == 3 and parts[0] == "0":
                    path = os.path.join("/sys/fs/cgroup", parts[2].lstrip("/"), "cpu.stat")
                    return path if os.access(path, os.R_OK) else None
    except OSError:
        return None
    return None


def usage_usec(path):
    if path is None:
        return None
    try:
        with open(path) as f:
            for line in f:
                key, _, value = line.partition(" ")
                if key == "usage_usec":
                    return int(value)
    except (OSError, ValueError):
        return None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--parent-pid", type=int, required=True)
    ap.add_argument("--cgroup-of", type=int, default=None, help="charge this process's cgroup as own (default: --parent-pid)")
    ap.add_argument("--stat", default="/proc/stat")
    a = ap.parse_args()
    stop = False

    def on_signal(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    cgroup = cgroup_stat_path(a.cgroup_of or a.parent_pid)
    prev = cpu_line(a.stat)
    prev_usage = usage_usec(cgroup)
    with open(a.out, "a", buffering=1) as out:
        out.write(json.dumps({"meta": {"clk_tck": CLK, "ncpu": os.cpu_count(), "cgroup": cgroup is not None}}) + "\n")
        next_tick = time.monotonic() + 1.0
        while not stop:
            time.sleep(max(0.0, next_tick - time.monotonic()))
            next_tick += 1.0
            cur = cpu_line(a.stat)
            usage = usage_usec(cgroup)
            if cur is None or prev is None:
                prev, prev_usage = cur, usage
                continue
            d = {k: cur[k] - prev[k] for k in FIELDS}
            total = sum(d.values())
            if total > 0:
                busy = total - d["idle"] - d["iowait"]
                row = {
                    "t": int(time.time() * 1000),
                    "busy_pct": round(100 * busy / total, 3),
                    "steal_pct": round(100 * d["steal"] / total, 3),
                    "iowait_pct": round(100 * d["iowait"] / total, 3),
                    "own_pct": None,
                    "foreign_pct": None,
                }
                if usage is not None and prev_usage is not None:
                    # total jiffies across all CPUs -> microseconds of CPU capacity in the interval
                    capacity_usec = total * 1_000_000 / CLK
                    own = 100 * (usage - prev_usage) / capacity_usec
                    row["own_pct"] = round(own, 3)
                    row["foreign_pct"] = round(100 * busy / total - own, 3)
                out.write(json.dumps(row, separators=(",", ":")) + "\n")
            prev, prev_usage = cur, usage
            try:
                os.kill(a.parent_pid, 0)
            except OSError:
                break


if __name__ == "__main__":
    sys.exit(main())

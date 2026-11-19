#!/usr/bin/env python3
"""t3cp record runner: the /proc sidecar of one run.ts invocation (Linux only), started on the driver CPUs.

Finds each bench server run.ts starts (`.../t3 serve --base-dir <work>/runs/<label>/attempt-N/base`, or a dist
entry `.../apps/server/dist/bin.mjs serve ...`) and, while it lives, appends one line per second of raw cumulative
/proc counters to <runDir>/proc-1hz.ndjson: the process (stat, status, io), every thread (stat: utime/stime/minflt/
majflt, schedstat: run/wait ns, status: context switches, io), its descendants (fake providers, git) grouped by comm,
the load side (run.ts, driver) grouped by comm, the host (load, /proc/stat cpu, PSI, TLB shootdowns, disk, memory)
and the run database's db/-wal/-shm sizes. Counters, sizes and comm names only.

When the server exits it writes <runDir>/server-exit.json (when it was gone, 1 s resolution), deletes the run's
database copy (nothing reads it afterwards, and its page cache would crowd out the fixture's; with --keep-db it is kept,
for a scenario cell whose post step reads it) and, with
--stats-dir, moves the fakes' stats files into <runDir>/fake-stats/. It touches <runDir>/ctl/window-start and
ctl/window-end on the driver's "phase: window" / "phase: drain" lines (run.ts does the same; both are harmless).

usage: procmon.py --work <run.ts work dir> --parent-pid <pid> --log <file> [--disk <name>] [--stats-dir <dir>]
                  [--keep-db]
"""
import argparse
import json
import os
import re
import shutil
import signal
import sys
import time

CLK = os.sysconf("SC_CLK_TCK")


def read(path):
    try:
        with open(path, "rb") as f:
            return f.read().decode("utf-8", "replace")
    except OSError:
        return None


def parse_stat(text):
    if not text:
        return None
    r = text.rfind(")")
    comm = text[text.find("(") + 1 : r]
    f = text[r + 2 :].split()
    try:
        return {
            "comm": comm,
            "state": f[0],
            "ppid": int(f[1]),
            "minflt": int(f[7]),
            "cminflt": int(f[8]),
            "majflt": int(f[9]),
            "cmajflt": int(f[10]),
            "utime": int(f[11]),
            "stime": int(f[12]),
            "cutime": int(f[13]),
            "cstime": int(f[14]),
            "num_threads": int(f[17]),
            "starttime": int(f[19]),
            "rss_pages": int(f[21]),
            "processor": int(f[36]),
            "blkio_ticks": int(f[39]) if len(f) > 39 else None,
        }
    except (IndexError, ValueError):
        return None


def parse_kv(text, keys):
    out = {}
    if not text:
        return out
    for line in text.splitlines():
        k, _, v = line.partition(":")
        if k in keys:
            out[keys[k]] = int(v.split()[0])
    return out


STATUS_KEYS = {
    "VmRSS": "rss_kb",
    "VmHWM": "hwm_kb",
    "VmSwap": "swap_kb",
    "RssAnon": "rss_anon_kb",
    "RssFile": "rss_file_kb",
    "RssShmem": "rss_shmem_kb",
    "voluntary_ctxt_switches": "vcs",
    "nonvoluntary_ctxt_switches": "nvcs",
}
TASK_STATUS_KEYS = {"voluntary_ctxt_switches": "vcs", "nonvoluntary_ctxt_switches": "nvcs"}
IO_KEYS = {
    "rchar": "rchar",
    "wchar": "wchar",
    "syscr": "syscr",
    "syscw": "syscw",
    "read_bytes": "rb",
    "write_bytes": "wb",
}


def parse_io(text):
    if not text:
        return None
    out = {}
    for line in text.splitlines():
        k, _, v = line.partition(":")
        if k in IO_KEYS:
            out[IO_KEYS[k]] = int(v)
    return out


def schedstat(path):
    text = read(path)
    if not text:
        return None
    try:
        run, wait, slices = (int(x) for x in text.split()[:3])
        return {"run_ns": run, "wait_ns": wait, "slices": slices}
    except ValueError:
        return None


def host_sample(disk):
    out = {}
    la = read("/proc/loadavg")
    if la:
        out["load1"] = float(la.split()[0])
        out["running"] = la.split()[3]
    st = read("/proc/stat") or ""
    for line in st.splitlines():
        if line.startswith("cpu "):
            v = [int(x) for x in line.split()[1:9]]
            out["cpu"] = dict(zip(["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal"], v))
        elif line.startswith("ctxt "):
            out["ctxt"] = int(line.split()[1])
        elif line.startswith("procs_running"):
            out["procs_running"] = int(line.split()[1])
    psi = {}
    for res in ("cpu", "io", "memory"):
        text = read(f"/proc/pressure/{res}")
        if text:
            for line in text.splitlines():
                kind = line.split()[0]
                total = re.search(r"total=(\d+)", line)
                if total:
                    psi[f"{res}_{kind}_us"] = int(total.group(1))
    out["psi"] = psi
    irq = read("/proc/interrupts") or ""
    for line in irq.splitlines():
        if line.strip().startswith("TLB:"):
            out["tlb"] = sum(int(x) for x in line.split()[1:] if x.isdigit())
    vm = read("/proc/vmstat") or ""
    for line in vm.splitlines():
        k, _, v = line.partition(" ")
        if k in ("pgfault", "pgmajfault", "pswpin", "pswpout", "pgscan_kswapd", "pgsteal_kswapd"):
            out[k] = int(v)
    ds = read("/proc/diskstats") or ""
    for line in ds.splitlines():
        f = line.split()
        if len(f) > 13 and f[2] == disk:
            out["disk"] = {"rd_ios": int(f[3]), "rd_sect": int(f[5]), "wr_ios": int(f[7]), "wr_sect": int(f[9]), "io_ms": int(f[12])}
    # Host memory (kB): whether the fixture still fits the page cache next to the server, fakes and driver.
    mi = read("/proc/meminfo") or ""
    mem = {}
    for line in mi.splitlines():
        k, _, v = line.partition(":")
        if k in ("MemTotal", "MemAvailable", "Cached", "Dirty", "AnonPages", "Shmem", "Active(file)", "Inactive(file)"):
            mem[k] = int(v.split()[0])
    if mem:
        out["mem_kb"] = mem
    return out


def all_stats():
    stats = {}
    for name in os.listdir("/proc"):
        if name.isdigit():
            s = parse_stat(read(f"/proc/{name}/stat"))
            if s:
                stats[int(name)] = s
    return stats


def descendants(root, stats):
    children = {}
    for pid, s in stats.items():
        children.setdefault(s["ppid"], []).append(pid)
    out, stack = [], list(children.get(root, []))
    while stack:
        pid = stack.pop()
        out.append(pid)
        stack.extend(children.get(pid, []))
    return out


def sample_server(pid, stats, disk):
    stat = stats.get(pid) or parse_stat(read(f"/proc/{pid}/stat"))
    if stat is None:
        return None
    proc = dict(stat)
    proc.update(parse_kv(read(f"/proc/{pid}/status"), STATUS_KEYS))
    proc["io"] = parse_io(read(f"/proc/{pid}/io"))
    threads = []
    try:
        tids = os.listdir(f"/proc/{pid}/task")
    except OSError:
        return None
    for tid in tids:
        ts = parse_stat(read(f"/proc/{pid}/task/{tid}/stat"))
        if ts is None:
            continue
        row = {
            "tid": int(tid),
            "comm": ts["comm"],
            "start": ts["starttime"],
            "u": ts["utime"],
            "s": ts["stime"],
            "minflt": ts["minflt"],
            "majflt": ts["majflt"],
            "cpu": ts["processor"],
            "state": ts["state"],
        }
        row.update(parse_kv(read(f"/proc/{pid}/task/{tid}/status"), TASK_STATUS_KEYS))
        sch = schedstat(f"/proc/{pid}/task/{tid}/schedstat")
        if sch:
            row.update(sch)
        row["io"] = parse_io(read(f"/proc/{pid}/task/{tid}/io"))
        threads.append(row)
    kids = descendants(pid, stats)
    by_comm = {}
    for k in kids:
        s = stats.get(k)
        if s is None:
            continue
        g = by_comm.setdefault(s["comm"], {"n": 0, "u": 0, "s": 0, "cu": 0, "cs": 0, "rss_pages": 0, "minflt": 0, "majflt": 0,
                                           "of_server": 0})
        g["n"] += 1
        # Created by the server itself (its direct child) or further down (e.g. by a process spawner).
        if s["ppid"] == pid:
            g["of_server"] += 1
        g["u"] += s["utime"]
        g["s"] += s["stime"]
        g["cu"] += s["cutime"]
        g["cs"] += s["cstime"]
        g["rss_pages"] += s["rss_pages"]
        g["minflt"] += s["minflt"]
        g["majflt"] += s["majflt"]
    return {"proc": proc, "threads": threads, "children": {"n": len(kids), "by_comm": by_comm}, "host": host_sample(disk)}


def driver_sample(parent_pid, server_pid, stats):
    """CPU and RSS of the load side: every process under the runner's attempt that is not the server or its children
    (run.ts, the driver, this sidecar excluded), summed by comm (ticks, pages)."""
    exclude = {server_pid, *descendants(server_pid, stats), os.getpid()}
    by_comm = {}
    for pid in descendants(parent_pid, stats):
        if pid in exclude:
            continue
        st = stats.get(pid)
        if st is None:
            continue
        g = by_comm.setdefault(st["comm"], {"n": 0, "u": 0, "s": 0, "rss_pages": 0, "threads": 0})
        g["n"] += 1
        g["u"] += st["utime"]
        g["s"] += st["stime"]
        g["rss_pages"] += st["rss_pages"]
        g["threads"] += st.get("num_threads", 0)
    return by_comm


def server_runs(work):
    """pid -> runDir for live bench servers under <work>/runs."""
    found = {}
    prefix = os.path.join(work, "runs") + os.sep
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        raw = read(f"/proc/{name}/cmdline")
        if not raw or "serve" not in raw:
            continue
        args = raw.split("\0")
        if "serve" not in args or "--base-dir" not in args:
            continue
        i = args.index("--base-dir")
        is_dist = any(a.endswith("apps/server/dist/bin.mjs") for a in args)
        is_sea = args[0].endswith("/t3") or args[0] == "t3"
        if i + 1 >= len(args) or not (is_dist or is_sea):
            continue
        base = os.path.realpath(args[i + 1])
        if base.startswith(prefix):
            found[int(name)] = os.path.dirname(base)
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--parent-pid", type=int, required=True)
    ap.add_argument("--stats-dir", default=None, help="the fakes' stats directory, moved into each run's fake-stats/")
    ap.add_argument("--disk", default="sda", help="block device name for /proc/diskstats (the one holding --work)")
    ap.add_argument("--log", required=True)
    ap.add_argument("--keep-db", action="store_true", help="keep the run's database when the server is gone (a post step reads it)")
    a = ap.parse_args()
    work = os.path.realpath(a.work)
    logf = open(a.log, "a")

    def log(msg):
        logf.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
        logf.flush()

    stop = False

    def on_signal(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    def server_gone(cur):
        log(f"server {cur['pid']} gone")
        cur["out"].close()
        with open(os.path.join(cur["run_dir"], "server-exit.json"), "w") as f:
            json.dump({"gone_ms": int(time.time() * 1000), "resolution_ms": 1000}, f)
        for suffix in ("", "-wal", "-shm") if not a.keep_db else ():
            try:
                os.remove(os.path.join(cur["run_dir"], "base", "userdata", "statev2.sqlite" + suffix))
            except OSError:
                pass
        if a.stats_dir and os.path.isdir(a.stats_dir):
            dest = os.path.join(cur["run_dir"], "fake-stats")
            os.makedirs(dest, exist_ok=True)
            time.sleep(1)  # let stopped fakes flush their last lines
            for name in os.listdir(a.stats_dir):
                try:
                    shutil.move(os.path.join(a.stats_dir, name), os.path.join(dest, name))
                except OSError as e:
                    log(f"move {name}: {e}")

    current = None
    log(f"procmon start clk={CLK} disk={a.disk} keep_db={1 if a.keep_db else 0}")
    next_tick = time.monotonic()
    while not stop:
        now_mono = time.monotonic()
        if current is None:
            for pid, run_dir in server_runs(work).items():
                os.makedirs(os.path.join(run_dir, "ctl"), exist_ok=True)
                current = {
                    "pid": pid,
                    "run_dir": run_dir,
                    "out": open(os.path.join(run_dir, "proc-1hz.ndjson"), "a"),
                    "driver_pos": 0,
                    "window": False,
                    "drain": False,
                }
                current["out"].write(json.dumps({"meta": {"pid": pid, "clk_tck": CLK, "page_size": os.sysconf("SC_PAGE_SIZE"), "nproc": os.cpu_count()}}) + "\n")
                log(f"server {pid} found")
                break
        if current is not None:
            stats = all_stats()
            sample = sample_server(current["pid"], stats, a.disk)
            if sample is None:
                server_gone(current)
                current = None
            else:
                sample["load_driver"] = driver_sample(a.parent_pid, current["pid"], stats)
                sample["t"] = int(time.time() * 1000)
                sample["mono"] = round(now_mono, 3)
                db = os.path.join(current["run_dir"], "base", "userdata", "statev2.sqlite")
                for suffix, key in (("-wal", "wal_bytes"), ("-shm", "shm_bytes"), ("", "db_bytes")):
                    try:
                        sample[key] = os.stat(db + suffix).st_size
                    except OSError:
                        sample[key] = None
                current["out"].write(json.dumps(sample, separators=(",", ":")) + "\n")
                current["out"].flush()
                try:
                    with open(os.path.join(current["run_dir"], "driver.log"), "rb") as f:
                        f.seek(current["driver_pos"])
                        chunk = f.read().decode("utf-8", "replace")
                        current["driver_pos"] = f.tell()
                except OSError:
                    chunk = ""
                ctl = os.path.join(current["run_dir"], "ctl")
                if not current["window"] and "phase: window" in chunk:
                    current["window"] = True
                    open(os.path.join(ctl, "window-start"), "a").close()
                    log("window start")
                if current["window"] and not current["drain"] and "phase: drain" in chunk:
                    current["drain"] = True
                    open(os.path.join(ctl, "window-end"), "a").close()
                    log("window end")
        try:
            os.kill(a.parent_pid, 0)
        except OSError:
            if current is None:
                break
        next_tick += 1.0
        delay = next_tick - time.monotonic()
        if delay < 0:
            next_tick = time.monotonic()
            delay = 0
        time.sleep(delay)
    # Stopped while a server was still followed (run.ts exits within the second its last server stops): wait up to
    # 15 s for the server to go, then finish the run as above; a server still alive then is logged and left alone.
    if current is not None:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and sample_server(current["pid"], all_stats(), a.disk) is not None:
            time.sleep(0.5)
        if sample_server(current["pid"], all_stats(), a.disk) is None:
            server_gone(current)
        else:
            log(f"server {current['pid']} still alive at procmon stop; run not finished")
            current["out"].close()
    log("procmon stop")


if __name__ == "__main__":
    sys.exit(main())

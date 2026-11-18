#!/usr/bin/env python3
"""Scalability benchmark: gateway CPU / RAM / latency as simulated devices grow 0 -> 100.

For every step N (default 0,10,25,50,75,100 simulated devices, spread over HTTP/CoAP/MQTT):
  1. start more simulated devices so that N are registered (each emits a `tick` event every --tick s)
  2. wait until the gateway has created a proxy for every device   -> proxy sync time
  3. settle, then for --duration s sample once per second:
       gateway process CPU % and RSS (psutil), system CPU / memory,
       while reading every device's `value` THROUGH THE GATEWAY once per --load-period s
                                                                     -> read latency under load
  4. gateway event throughput from the gateway's own `proxies` statistics

    .venv/bin/python bench/scalability.py [--steps 0,10,25,50,75,100] [--duration 30] [--tick 5] [--load-period 5]

Output: results/scalability-<ts>.csv, results/scalability-latest.{csv,md}
"""
import argparse
import asyncio
import csv
import os
import signal
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
import psutil

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "devices"))
from wotdev.config import load_config  # noqa: E402

GATEWAY_ID = "urn:wot:gateway"
RUN_TAG = "sc" + format(int(time.time()) % 46656, "x")  # unique per run -> stale TDs of old runs never count
SIM_PROXY_PREFIX = f"urn:wot:gateway:urn:wot:sim:{RUN_TAG}"


def pct(values, p):
    if not values:
        return float("nan")
    s = sorted(values)
    return s[min(len(s) - 1, max(0, int(round(p / 100 * len(s) + 0.5)) - 1))]


def first_href(td, group, name, op):
    for f in td[group][name]["forms"]:
        ops = f.get("op", [])
        ops = [ops] if isinstance(ops, str) else ops
        if op in ops and f["href"].startswith("http"):
            return f["href"]
    raise KeyError(f"no http {op} form for {name}")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", default="0,10,25,50,75,100")
    ap.add_argument("--duration", type=int, default=30)
    ap.add_argument("--settle", type=int, default=10)
    ap.add_argument("--tick", type=float, default=5.0)
    ap.add_argument("--load-period", type=float, default=5.0)
    args = ap.parse_args()
    steps = [int(s) for s in args.steps.split(",")]

    cfg = load_config()
    directory = cfg.DIRECTORY_URL.rstrip("/")
    session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10))

    async def get_json(url):
        async with session.get(url) as r:
            r.raise_for_status()
            return await r.json(content_type=None)

    gw_td = await get_json(f"{directory}/things/{GATEWAY_ID}")
    status_url = first_href(gw_td, "properties", "status", "readproperty")
    proxies_url = first_href(gw_td, "properties", "proxies", "readproperty")
    status = await get_json(status_url)
    gw = psutil.Process(status["pid"])
    base_proxies = sum(1 for p in await get_json(proxies_url) if not p["id"].startswith("urn:wot:gateway:urn:wot:sim:"))
    ncpu = psutil.cpu_count() or 1
    print(f"gateway pid {gw.pid}, {base_proxies} proxies before test, {ncpu} CPU cores")

    sims, popens = [], []
    (ROOT / "results").mkdir(exist_ok=True)
    sim_log = open(ROOT / "results" / "scalability-sims.log", "w")
    current = 0
    rows = []
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    try:
        for k, n in enumerate(steps):
            # -------------------------------------------------- grow fleet
            add = n - current
            t_spawn = time.time()
            if add > 0:
                p = subprocess.Popen(
                    [sys.executable, str(ROOT / "devices" / "sim_devices.py"), "--count", str(add),
                     "--tick", str(args.tick), "--prefix", f"{RUN_TAG}s{k}", "--port-offset", str(k + 1)],
                    cwd=str(ROOT), stdout=sim_log, stderr=subprocess.STDOUT,
                )
                popens.append(p)
                sims.append(psutil.Process(p.pid))
            current = n
            while True:
                plist = await get_json(proxies_url)
                ready = sum(1 for p in plist if p["id"].startswith(SIM_PROXY_PREFIX))
                if ready >= n:
                    break
                if time.time() - t_spawn > 120 + n:
                    print(f"  ! only {ready}/{n} proxies after timeout - see results/scalability-sims.log")
                    break
                await asyncio.sleep(0.5)
            sync_s = time.time() - t_spawn
            print(f"[{n:>3} sim devices] all proxies up after {sync_s:.1f}s; settling {args.settle}s")
            await asyncio.sleep(args.settle)

            # -------------------------------------------------- read load through the gateway
            tds = await get_json(f"{directory}/things")
            read_urls = [first_href(td, "properties", "value", "readproperty")
                         for td in tds if td.get("id", "").startswith(SIM_PROXY_PREFIX)]
            latencies, errors = [], 0
            stop = asyncio.Event()

            async def reader(url, offset):
                nonlocal errors
                await asyncio.sleep(offset)
                while not stop.is_set():
                    t0 = time.perf_counter()
                    try:
                        async with session.get(url) as r:
                            await r.read()
                            if r.status != 200:
                                raise RuntimeError(r.status)
                        latencies.append((time.perf_counter() - t0) * 1000)
                    except Exception:
                        errors += 1
                    try:
                        await asyncio.wait_for(stop.wait(), args.load_period)
                    except asyncio.TimeoutError:
                        pass

            readers = [asyncio.create_task(reader(u, i * args.load_period / max(1, len(read_urls))))
                       for i, u in enumerate(read_urls)]

            # -------------------------------------------------- sample resources
            def total_events(plist):
                return sum(p["stats"]["events"] for p in plist if p["id"].startswith(SIM_PROXY_PREFIX) or not p["id"].startswith("urn:wot:gateway:urn:wot:sim:"))

            ev0 = total_events(await get_json(proxies_url))
            gw.cpu_percent(None)
            def sim_cpu_now():
                total = 0.0
                for s in sims:
                    try:
                        total += s.cpu_percent(None)
                    except psutil.Error:
                        pass
                return total

            sim_cpu_now()
            psutil.cpu_percent(None)
            cpu, rss, sys_cpu, sim_cpu, heap = [], [], [], [], []
            t0 = time.time()
            for _ in range(args.duration):
                await asyncio.sleep(1)
                cpu.append(gw.cpu_percent(None))
                rss.append(gw.memory_info().rss / 1048576)
                sys_cpu.append(psutil.cpu_percent(None))
                sim_cpu.append(sim_cpu_now())
            heap.append((await get_json(status_url))["heapUsedMB"])
            ev1 = total_events(await get_json(proxies_url))
            elapsed = time.time() - t0
            stop.set()
            await asyncio.gather(*readers, return_exceptions=True)

            vm = psutil.virtual_memory()
            row = {
                "sim_devices": n,
                "total_proxies": len(await get_json(proxies_url)),
                "proxy_sync_s": round(sync_s, 2),
                "gw_cpu_mean_pct": round(statistics.mean(cpu), 2),
                "gw_cpu_p95_pct": round(pct(cpu, 95), 2),
                "gw_cpu_max_pct": round(max(cpu), 2),
                "gw_rss_mean_mb": round(statistics.mean(rss), 1),
                "gw_rss_max_mb": round(max(rss), 1),
                "gw_heap_mb": heap[-1],
                "sys_cpu_mean_pct": round(statistics.mean(sys_cpu), 2),
                "sys_mem_used_mb": round((vm.total - vm.available) / 1048576),
                "sim_cpu_mean_pct": round(statistics.mean(sim_cpu), 2) if sims else 0,
                "reads": len(latencies),
                "read_errors": errors,
                "read_p50_ms": round(pct(latencies, 50), 2) if latencies else "",
                "read_p95_ms": round(pct(latencies, 95), 2) if latencies else "",
                "gw_events_per_s": round((ev1 - ev0) / elapsed, 2),
                "cpu_cores": ncpu,
            }
            rows.append(row)
            print(f"  gw CPU mean {row['gw_cpu_mean_pct']}% (p95 {row['gw_cpu_p95_pct']}%), RSS {row['gw_rss_mean_mb']} MB, "
                  f"read p50/p95 {row['read_p50_ms']}/{row['read_p95_ms']} ms ({row['reads']} reads, {errors} errors), "
                  f"{row['gw_events_per_s']} events/s")
    finally:
        for p in popens:  # SIGTERM -> sims unregister their TDs from the directory
            try:
                p.kill() if os.name == "nt" else p.send_signal(signal.SIGTERM)
            except Exception:
                pass
        for p in popens:
            try:
                p.wait(timeout=15)
            except Exception:
                p.kill()
        await session.close()

    if not rows:
        return
    out = ROOT / "results"
    out.mkdir(exist_ok=True)
    for name in (f"scalability-{stamp}.csv", "scalability-latest.csv"):
        with open(out / name, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    md = [
        "# Scalability: gateway resources vs. number of devices",
        "",
        f"Run {stamp} | {ncpu} cores | {args.duration}s per step | each sim device: tick event every {args.tick}s, "
        f"`value` read through the gateway every {args.load_period}s | +{base_proxies} real-device proxies always present",
        "",
        "| sim devices | proxy sync (s) | gateway CPU mean % | CPU p95 % | RSS mean MB | RSS max MB | heap MB | read p50 ms | read p95 ms | read errors | events/s | system CPU % |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        md.append(f"| {r['sim_devices']} | {r['proxy_sync_s']} | {r['gw_cpu_mean_pct']} | {r['gw_cpu_p95_pct']} | {r['gw_rss_mean_mb']} | "
                  f"{r['gw_rss_max_mb']} | {r['gw_heap_mb']} | {r['read_p50_ms']} | {r['read_p95_ms']} | {r['read_errors']} | "
                  f"{r['gw_events_per_s']} | {r['sys_cpu_mean_pct']} |")
    md += ["", "CPU % is per core (100 % = one full core). The simulated devices run on the same Pi; their own CPU use is in the CSV (sim_cpu_mean_pct)."]
    (out / "scalability-latest.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print("\n" + "\n".join(md))


if __name__ == "__main__":
    asyncio.run(main())

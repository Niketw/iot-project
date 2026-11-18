#!/usr/bin/env python3
"""Turn benchmark results into figures + one combined report.

Reads (whatever exists):
    results/latency-latest.json, results/scalability-latest.csv,
    results/td-validation.md, results/swap-test-latest.md
Writes:
    results/plots/latency_p50_p95.png, added_latency.png,
    scalability_cpu.png, scalability_ram.png, scalability_latency.png
    results/REPORT.md
"""
import csv
import json
from datetime import datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "results"
PLOTS = RES / "plots"

# Reference palette (validated categorical slots 1-3, light mode) + text tokens
C_DIRECT, C_GATEWAY, C_WS = "#2a78d6", "#eb6834", "#1baf7a"
TEXT, TEXT2, GRID, SURFACE = "#0b0b0b", "#52514e", "#e4e3df", "#ffffff"

plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "axes.edgecolor": GRID, "axes.labelcolor": TEXT2, "xtick.color": TEXT2, "ytick.color": TEXT2,
    "text.color": TEXT, "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8,
    "axes.spines.top": False, "axes.spines.right": False, "font.size": 10,
    "axes.titlesize": 12, "axes.titleweight": "bold", "axes.titlelocation": "left", "legend.frameon": False,
})


def save(fig, name):
    PLOTS.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(PLOTS / name, dpi=160)
    plt.close(fig)
    return f"plots/{name}"


def latency_plots(data):
    rows = data["summary"]
    order = {"read": 0, "action": 1, "event": 2}
    rows = sorted(rows, key=lambda r: (order.get(r["interaction"], 9), r["target"]))
    labels = [f"{r['target']} · {r['interaction']}" for r in rows]
    figs = []

    # 1) p50 bars with p95 whiskers, direct vs gateway (vs gateway-ws for events)
    fig, ax = plt.subplots(figsize=(9, 0.42 * len(rows) + 1.6))
    h = 0.26
    paths = [("direct", C_DIRECT, "direct (native protocol)"), ("gateway", C_GATEWAY, "via gateway (HTTP)"),
             ("gateway-ws", C_WS, "via gateway (WebSocket, events)")]
    for k, (p, color, label) in enumerate(paths):
        ys, p50, err = [], [], []
        for i, r in enumerate(rows):
            s = r.get(p)
            if s and s.get("n"):
                ys.append(i + (k - 1) * h)
                p50.append(s["p50"])
                err.append(max(0.0, s["p95"] - s["p50"]))
        if ys:
            ax.barh(ys, p50, height=h - 0.04, color=color, label=label,
                    xerr=[[0] * len(err), err], error_kw={"ecolor": TEXT2, "elinewidth": 1, "capsize": 2})
    ax.set_yticks(range(len(rows)))
    ax.set_yticklabels(labels)
    ax.invert_yaxis()
    ax.set_xlabel("latency (ms) — bar = median, whisker = 95th percentile")
    ax.set_title("Interaction latency: direct vs. through the WoT gateway")
    ax.legend(loc="lower right")
    ax.grid(axis="y", visible=False)
    figs.append(save(fig, "latency_p50_p95.png"))

    # 2) added latency (gateway - direct)
    rr = [r for r in rows if r.get("addedP50") is not None]
    fig, ax = plt.subplots(figsize=(9, 0.36 * len(rr) + 1.6))
    y = range(len(rr))
    ax.barh([i - 0.18 for i in y], [r["addedP50"] for r in rr], height=0.34, color=C_GATEWAY, label="added median")
    ax.barh([i + 0.18 for i in y], [r["addedP95"] for r in rr], height=0.34, color=C_DIRECT, label="added p95")
    ax.axvline(0, color=TEXT2, linewidth=0.8)
    ax.set_yticks(list(y))
    ax.set_yticklabels([f"{r['target']} · {r['interaction']} ({r['protocol']})" for r in rr])
    ax.invert_yaxis()
    ax.set_xlabel("added latency = gateway − direct (ms)")
    ax.set_title("Overhead added by the gateway layer")
    ax.legend(loc="lower right")
    ax.grid(axis="y", visible=False)
    figs.append(save(fig, "added_latency.png"))
    return figs


def scalability_plots(rows):
    n = [int(r["sim_devices"]) for r in rows]
    f = lambda k: [float(r[k]) if r[k] not in ("", None) else float("nan") for r in rows]  # noqa: E731
    figs = []

    def line(ax, y, color, label, marker="o"):
        ax.plot(n, y, color=color, linewidth=2, marker=marker, markersize=6, label=label)

    fig, ax = plt.subplots(figsize=(7, 4))
    line(ax, f("gw_cpu_mean_pct"), C_DIRECT, "mean")
    line(ax, f("gw_cpu_p95_pct"), C_GATEWAY, "95th percentile", "s")
    ax.set_xlabel("simulated devices proxied (plus 3 real devices)")
    ax.set_ylabel("gateway CPU (% of one core)")
    ax.set_title("Gateway CPU vs. number of devices")
    ax.set_ylim(bottom=0)
    ax.legend()
    figs.append(save(fig, "scalability_cpu.png"))

    fig, ax = plt.subplots(figsize=(7, 4))
    line(ax, f("gw_rss_mean_mb"), C_DIRECT, "RSS mean")
    line(ax, f("gw_heap_mb"), C_GATEWAY, "JS heap used", "s")
    ax.set_xlabel("simulated devices proxied (plus 3 real devices)")
    ax.set_ylabel("memory (MB)")
    ax.set_title("Gateway memory vs. number of devices")
    ax.set_ylim(bottom=0)
    ax.legend()
    figs.append(save(fig, "scalability_ram.png"))

    fig, ax = plt.subplots(figsize=(7, 4))
    line(ax, f("read_p50_ms"), C_DIRECT, "median")
    line(ax, f("read_p95_ms"), C_GATEWAY, "95th percentile", "s")
    ax.set_xlabel("simulated devices proxied (plus 3 real devices)")
    ax.set_ylabel("readProperty via gateway (ms)")
    ax.set_title("Read latency under load vs. number of devices")
    ax.set_ylim(bottom=0)
    ax.legend()
    figs.append(save(fig, "scalability_latency.png"))
    return figs


def main():
    sections = [f"# WoT Smart-Building Gateway — results report\n\nGenerated {datetime.now().isoformat(timespec='seconds')}\n"]
    for name, title in (("swap-test-latest.md", None), ("td-validation.md", None)):
        p = RES / name
        if p.exists():
            sections.append(p.read_text(encoding="utf-8").replace("\n# ", "\n## ").replace("# ", "## ", 1))
    lat = RES / "latency-latest.json"
    if lat.exists():
        figs = latency_plots(json.loads(lat.read_text(encoding="utf-8")))
        md = (RES / "latency-latest.md").read_text(encoding="utf-8").replace("# ", "## ", 1)
        sections.append(md + "\n" + "\n".join(f"![{f}]({f})" for f in figs) + "\n")
    sc = RES / "scalability-latest.csv"
    if sc.exists():
        with open(sc, newline="") as fh:
            rows = list(csv.DictReader(fh))
        if rows:
            figs = scalability_plots(rows)
            md = (RES / "scalability-latest.md").read_text(encoding="utf-8").replace("# ", "## ", 1)
            sections.append(md + "\n" + "\n".join(f"![{f}]({f})" for f in figs) + "\n")
    (RES / "REPORT.md").write_text("\n\n".join(sections), encoding="utf-8")
    print(f"wrote {RES / 'REPORT.md'} and plots in {PLOTS}")


if __name__ == "__main__":
    main()

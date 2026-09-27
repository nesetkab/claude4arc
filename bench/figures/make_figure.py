import json
from pathlib import Path

import matplotlib.pyplot as plt

HERE = Path(__file__).resolve().parent
RESULTS = HERE.parent / "results"

COLORS = {"arc": "#0072B2", "ego": "#D55E00", "cic": "#009E73"}
HATCHES = {"arc": "", "ego": "//", "cic": ".."}
NAMES = {"arc": "claude4arc", "ego": "ego-lite", "cic": "Claude for Chrome"}


def load(run):
    meta = json.loads((RESULTS / f"{run}.meta.json").read_text())
    return {"seconds": meta["duration_ms"] / 1000, "calls": meta["tool_uses"], "read": meta["tokens_read"]}


ARC_RUNS = {run: load(run) for run in ("arc10", "arc11")}
SINGLE = {"ego": load("ego"), "cic": load("cic")}


def summary(metric):
    runs = [run[metric] for run in ARC_RUNS.values()]
    mean = sum(runs) / len(runs)
    rows = [("arc", mean, (mean - min(runs), max(runs) - mean))]
    rows += [(key, SINGLE[key][metric], None) for key in ("ego", "cic")]
    return rows


def style():
    plt.rcParams.update(
        {
            "font.family": "serif",
            "font.serif": ["STIXGeneral", "Times New Roman", "DejaVu Serif"],
            "mathtext.fontset": "stix",
            "font.size": 9,
            "axes.titlesize": 9.5,
            "axes.labelsize": 9,
            "xtick.labelsize": 8.5,
            "ytick.labelsize": 8.5,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.linewidth": 0.8,
            "xtick.major.width": 0.8,
            "ytick.major.width": 0.8,
            "hatch.linewidth": 0.6,
            "savefig.bbox": "tight",
        }
    )


def bar_panel(axis, metric, xlabel, title, formatter, scale=1.0, names=True):
    rows = summary(metric)
    positions = list(range(len(rows)))[::-1]
    for position, (key, value, spread) in zip(positions, rows):
        axis.barh(
            position,
            value / scale,
            height=0.62,
            color=COLORS[key],
            hatch=HATCHES[key],
            edgecolor="black",
            linewidth=0.7,
            zorder=2,
        )
        if spread:
            axis.errorbar(value / scale, position, xerr=[[spread[0] / scale], [spread[1] / scale]], fmt="none", ecolor="black", elinewidth=0.8, capsize=2.5, zorder=3)
        axis.annotate(formatter(value), (value / scale, position), xytext=(4, 0), textcoords="offset points", ha="left", va="center", fontsize=8.5)
    axis.set_yticks(positions, [NAMES[key] for key, _, _ in rows] if names else [])
    axis.tick_params(axis="y", length=0)
    axis.set_xlabel(xlabel)
    axis.set_title(title, loc="left")
    axis.set_xlim(0, max(value for _, value, _ in rows) / scale * 1.3)
    axis.xaxis.grid(True, linewidth=0.4, color="#d0d0d0", zorder=0)
    axis.set_axisbelow(True)


def main():
    style()
    figure, axes = plt.subplots(1, 3, figsize=(7.2, 2.1), gridspec_kw={"wspace": 0.12})
    bar_panel(axes[0], "seconds", "Wall-clock time (s)", "(a) Time to finish", lambda value: f"{value:.1f}")
    bar_panel(axes[1], "calls", "Tool calls", "(b) Tool calls", lambda value: f"{value:.0f}", names=False)
    bar_panel(axes[2], "read", "Input tokens read (millions)", "(c) Tokens read", lambda value: f"{value / 1e6:.2f}M", scale=1e6, names=False)
    for suffix in ("pdf", "png", "svg"):
        figure.savefig(HERE / f"benchmark.{suffix}", dpi=300)


if __name__ == "__main__":
    main()

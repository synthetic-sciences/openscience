# Benchmark comparisons and ablations

## Contents

- Grouped bars across benchmarks
- Ablations: plot the difference
- When the figure should be a table
- Traps
- Template — grouped benchmark bars
- Template — ablation deltas
- Checklist

**Answers:** which method wins — across a suite of benchmarks, or across the
components you ablated.

Two questions that look alike and want different figures:

| The comparison is | Use | Because |
| --- | --- | --- |
| Several methods across several benchmarks, scores measured from zero | **Grouped bars** — the headline figure of an evaluation paper | Length is an honest encoding when the axis starts at zero, and the grouping lets a reader scan one method across every benchmark |
| One metric, differences small relative to seed noise | **Dot-and-whisker on the difference** | Position encodes value, so the axis can span only the interesting range without lying |

The rule underneath both: **a bar's length is a promise that the axis starts at
zero.** Truncating a bar axis to make a 0.4-point gap look decisive is the most
common dishonest figure in ML. That is an argument against truncation, not
against bars — accuracy, pass@k, win rate, and counts all start at zero
legitimately, and a bar is the right mark for them.

## Grouped bars across benchmarks

**Hue is the method family, shade is the variant.** Grey for the untuned base
model, one hue for prior work, one hue for yours, shaded light-to-dark within
each (`family()` in the style module). A reader separates "theirs" from "ours"
before reading a single legend entry. Seven arbitrary colors communicate
nothing.

**Keep the method order identical in every group,** and keep it in the legend
order. The figure is read by scanning one method's bar position across groups;
re-sorting per group destroys that.

**Label every bar with its value.** It makes the figure do the results table's
job as well, and a reader quoting your numbers does not have to squint at the
axis. This is the one place type may go below the 7pt tick size, down to the
5pt floor: the label
is redundant with the bar's height, so a reader who cannot read it still
recovers the value from the axis. Around 5pt at full text width; if bars get
so dense the labels collide, that is the signal to drop a method or split the
figure, not to shrink further.

**Order the benchmark groups deliberately** — by difficulty, by size, or to
match the results table. Alphabetical is a missed opportunity.

**Frame the legend when it sits over the plot area** and place it where the
bars are shortest. The house style leaves legends unframed, which is right when
they sit outside the axes; a legend floating over data needs an opaque box so
it does not read as part of the chart.

A grouped chart tops out around 6 methods × 6 groups. Past that, no amount of
styling saves it — use a table.

## Ablations: plot the difference

When the claim is "this component matters", plot `variant − baseline` with a
line at zero, sorted by effect. The reader sees sign, size, and whether the
interval crosses zero, which is the entire question.

Show the interval **of the difference** (`diff_ci`). Two overlapping
per-variant intervals do **not** mean the difference is indistinguishable from
zero — a widely repeated error. If a variant's interval crosses zero, the
honest reading is "no detectable effect at this seed count".

With one seed per variant there is no interval. Say "single seed" in the
caption and do not draw whiskers that imply otherwise.

## When the figure should be a table

If the reader needs exact numbers, or there are more than ~8 variants, or the
differences are within noise, a `booktabs` table communicates better than any
chart. See the paper-writing skill for table formatting.

## Traps

| Trap | Fix |
| --- | --- |
| Bar chart with a truncated y-axis | Start at zero, or switch to a delta dot plot |
| Every method a different hue | Grey base, one hue per family, shade within |
| Method order varies per group | Fix the order; match the legend |
| Error bars of unstated meaning | State it: "95% CI over 5 seeds". SD, SEM, and CI differ by large factors |
| Rotated 45° tick labels | Horizontal dots with left-aligned names, or a wider figure |
| "Ours" first regardless of score | Sort honestly; losing on a subset is a result |
| Bar labels colliding | Fewer methods or a split figure — not smaller type |

## Template — grouped benchmark bars

`figs/benchmarks.py`, reading `figs/benchmarks.csv` (`benchmark,method,score`):

```python
"""Accuracy across benchmarks. Regenerate: python figs/benchmarks.py"""

import csv
import math
from collections import defaultdict

import numpy as np
from figstyle import MUTED, WIDE, family, figure, save, use_style

DATA = "figs/benchmarks.csv"

# Fixed order everywhere, and the family each method belongs to. Grey for the
# untuned model, blue for prior work, red for ours.
METHODS = [
    ("Qwen2.5-Math-7B", "base"),
    ("SimpleRL-Zero-7B (GRPO)", "prior"),
    ("OpenReasoner-Zero-7B (PPO)", "prior"),
    ("Oat-Zero-7B (Dr.GRPO)", "prior"),
    (r"ES$_\mathrm{CHKPT-1}$", "ours"),
    (r"ES$_\mathrm{CHKPT-2}$", "ours"),
    (r"ES$_\mathrm{CHKPT-3}$", "ours"),
]
BENCHMARKS = ["AIME 2024", "Minerva Math", "OlympiadBench", "AMC", "MATH500"]


def method_colors():
    members = defaultdict(list)
    for name, group in METHODS:
        members[group].append(name)
    shades = {
        "base": [MUTED] * len(members["base"]),
        "prior": family("blue", len(members["prior"])),
        "ours": family("red", len(members["ours"])),
    }
    return {
        name: shades[group][members[group].index(name)] for name, group in METHODS
    }


def load(path):
    scores = defaultdict(dict)
    with open(path) as handle:
        for row in csv.DictReader(handle):
            scores[row["method"]][row["benchmark"]] = float(row["score"])
    return scores


def main():
    use_style()
    scores = load(DATA)
    colors = method_colors()

    fig, ax = figure(width=WIDE, ratio=0.28)
    x = np.arange(len(BENCHMARKS))
    # Near-touching bars inside a group; the gap between groups does the separating.
    width = 0.9 / len(METHODS)

    for i, (name, _) in enumerate(METHODS):
        offset = (i - (len(METHODS) - 1) / 2) * width
        bars = ax.bar(
            x + offset,
            [scores[name][benchmark] for benchmark in BENCHMARKS],
            width,
            label=name,
            color=colors[name],
            edgecolor="black",
            linewidth=0.4,
        )
        # Redundant with the bar height, so it may sit at the 5pt floor.
        ax.bar_label(bars, fmt="%.1f", fontsize=5, padding=1.5)

    ax.set_xticks(x, BENCHMARKS)
    ax.set_ylabel("Accuracy (%)")
    # Derived, never hardcoded: a bar clipped at the axes edge no longer
    # encodes its value, which is the failure this whole reference is about.
    highest = max(v for row in scores.values() for v in row.values())
    top = max(10, 10 * math.ceil(highest * 1.12 / 10))
    ax.set_ylim(0, top)
    ax.set_yticks(range(0, top + 1, 10))
    ax.tick_params(axis="x", length=0)
    ax.legend(
        ncol=2, loc="upper left", fontsize=6.5,
        frameon=True, framealpha=1.0, edgecolor="black", borderpad=0.5,
    )

    save(fig, "figs/benchmarks")


if __name__ == "__main__":
    main()
```

## Template — ablation deltas

`figs/ablation.py`, reading `figs/ablation.csv` (`variant,seed,value`):

```python
"""Accuracy change vs. the baseline. Regenerate: python figs/ablation.py"""

import csv
from collections import defaultdict

import numpy as np
from figstyle import BASELINE, COLUMN, PALETTE, diff_ci, figure, save, use_style

DATA = "figs/ablation.csv"
REFERENCE = "baseline"
HIGHLIGHT = "ours"


def load(path):
    runs = defaultdict(list)
    with open(path) as handle:
        for row in csv.DictReader(handle):
            runs[row["variant"]].append(float(row["value"]))
    return {variant: np.array(values) for variant, values in runs.items()}


def main():
    use_style()
    runs = load(DATA)
    reference = runs[REFERENCE]
    n_seeds = min(len(values) for values in runs.values())

    effects = [
        (variant, *diff_ci(values, reference))
        for variant, values in runs.items()
        if variant != REFERENCE
    ]
    effects.sort(key=lambda row: row[1])  # ascending: best ends up on top

    fig, ax = figure(width=COLUMN, ratio=0.1 + 0.16 * len(effects))
    ax.axvline(0, color=BASELINE, linewidth=0.8, zorder=1)

    for y, (variant, delta, lo, hi) in enumerate(effects):
        color = PALETTE["blue"] if variant == HIGHLIGHT else "#4D4D4D"
        ax.plot([lo, hi], [y, y], color=color, linewidth=1.0, solid_capstyle="round", zorder=2)
        ax.plot([delta], [y], "o", color=color, zorder=3)
        # Sign included: a delta figure is read for direction first.
        ax.annotate(
            f"{delta:+.2f}",
            xy=(hi, y), xytext=(4, 0), textcoords="offset points",
            va="center", fontsize=7, color=color,
        )

    ax.set_yticks(range(len(effects)), [variant for variant, *_ in effects])
    ax.set_ylim(-0.6, len(effects) - 0.4)
    ax.set_xlabel(f"Accuracy vs. {REFERENCE} (points)")
    ax.grid(axis="x")
    ax.grid(axis="y", visible=False)
    ax.tick_params(axis="y", length=0)
    ax.margins(x=0.18)
    print(f"n={n_seeds} seeds per variant — state this in the caption")

    save(fig, "figs/ablation")


if __name__ == "__main__":
    main()
```

## Checklist

- [ ] Bars start at zero; nothing is truncated.
- [ ] Hue is the method family, shade the variant; grey for the base model.
- [ ] Method order identical across groups and matching the legend.
- [ ] Every bar labelled, and no labels collide.
- [ ] Deltas: intervals are *of the difference*, with n and their meaning in the caption.
- [ ] Legend framed only where it sits over data, placed clear of the tallest bars.
- [ ] More than ~8 variants, or numbers needed exactly? Table instead.

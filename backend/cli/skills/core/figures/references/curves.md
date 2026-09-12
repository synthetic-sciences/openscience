# Learning and training curves

## Contents

- Choose the x-axis before anything else
- Aggregate seeds, never pick one
- Smoothing is a claim about the data
- Traps
- Template
- Checklist

**Answers:** how a metric moves over training, and whether the gap between two
runs is bigger than the noise between seeds.

This is the figure most often wrong in a submitted paper, because the two ways
it misleads are invisible once it is drawn: the wrong x-axis, and a single
seed.

## Choose the x-axis before anything else

The x-axis decides what the comparison means. Optimizer **steps** are only a
fair axis when every run does the same work per step. The moment batch size,
sequence length, model size, or hardware differs between the curves, steps stop
being comparable and you must plot against what actually differs:

| Comparing | Plot against |
| --- | --- |
| The same config, different seeds or a code change | Optimizer steps |
| Different batch size or sequence length | Tokens (or examples) seen |
| Different model sizes | FLOPs, or tokens with the size stated per curve |
| A speed or efficiency claim | Wall-clock time, and say on what hardware |

A method that "converges in half the steps" while taking twice as long per step
is not faster, and a steps-axis figure hides exactly that.

## Aggregate seeds, never pick one

Run at least 3 seeds — 5 if the effect is small. Plot the mean as the line and
the 95% interval as a band in the same color at low alpha (`band()` in the
style module). State n in the caption.

- A band of ±1 standard deviation answers "how spread are the seeds", not "how
  well is the mean resolved". Use the interval.
- If seeds disagree qualitatively — one diverges, the others do not — that is
  the result. Show the individual runs as thin lines instead of hiding the
  disagreement inside a wide band.
- Seeds rarely log on identical step grids. Interpolate onto a common grid
  before averaging; averaging ragged arrays silently truncates to the shortest.

## Smoothing is a claim about the data

Training loss is noisy and an unsmoothed curve can be unreadable, but smoothing
is a transformation of the evidence:

- State the smoothing in the caption ("EMA, α=0.1"), always.
- Draw the raw series faintly underneath the smoothed line. A smoothed line
  alone lets a reader believe the run was that stable.
- Never smooth an evaluation metric that is already sparse — you are inventing
  points between real measurements.

## Traps

| Trap | Fix |
| --- | --- |
| Y-axis truncated so a small gap looks decisive | Include the range that matters; if you zoom, say so in the caption |
| Log-scale axis without saying so | Say so on the label. Use log-y when the metric spans more than an order of magnitude or the claim is about a ratio; a bounded loss that moves from 4.7 to 1.6 reads better linear |
| Legend covering the region of interest | Direct-label the lines at their right end (`label_ends`); a legend is a lookup table |
| Too many curves in one panel | Show the 4 that carry the claim; the rest belong in an appendix table |
| The baseline drawn in a palette color | Baselines and chance level are grey (`BASELINE`) — color is for the things being compared |
| Curves cut at different x extents without comment | Say why one stopped early (diverged, out of budget) |

## Template

`figs/loss_curve.py`, reading a tidy CSV exported with the experiments tool (`experiments series`) or read from the run's own CSV
(`variant,seed,step,value`):

```python
"""Validation loss over training. Regenerate: python figs/loss_curve.py"""

import csv
from collections import defaultdict

import numpy as np
from figstyle import BASELINE, COLUMN, band, figure, label_ends, save, si_ticks, use_style

DATA = "figs/loss_curve.csv"


def load(path):
    """-> {variant: (steps, runs)} with runs shaped (n_seeds, n_steps)."""
    raw = defaultdict(lambda: defaultdict(list))
    with open(path) as handle:
        for row in csv.DictReader(handle):
            raw[row["variant"]][row["seed"]].append((float(row["step"]), float(row["value"])))

    series = {}
    for variant, seeds in raw.items():
        curves = [sorted(points) for points in seeds.values()]
        grid = np.array([step for step, _ in curves[0]])
        # Seeds log on slightly different grids, so interpolate before
        # averaging — but only across the range every seed actually reached.
        # np.interp clamps outside its input, which would invent a flat tail
        # for a run that stopped early and narrow the band around it.
        first = max(curve[0][0] for curve in curves)
        last = min(curve[-1][0] for curve in curves)
        if first > last:
            raise ValueError(f"{variant}: seeds cover no common range of steps")
        grid = grid[(grid >= first) & (grid <= last)]
        runs = np.stack([
            np.interp(grid, [s for s, _ in curve], [v for _, v in curve]) for curve in curves
        ])
        series[variant] = (grid, runs)
    return series


def main():
    use_style()
    series = load(DATA)

    fig, ax = figure(width=COLUMN, ratio=0.72)
    lines, labels = [], []
    for variant, (steps, runs) in series.items():
        color = BASELINE if variant == "baseline" else None
        lines.append(band(ax, steps, runs, color=color))
        labels.append(f"{variant} (n={runs.shape[0]})")

    ax.set_xlabel("Tokens seen")
    ax.set_ylabel("Validation loss")
    label_ends(ax, lines, labels)
    si_ticks(ax, "x")  # after label_ends, which moves the right limit

    save(fig, "figs/loss_curve")


if __name__ == "__main__":
    main()
```

## Checklist

- [ ] The x-axis is fair for the runs being compared, and labelled with units.
- [ ] Mean over ≥3 seeds with a 95% band, and n is in the caption.
- [ ] Any smoothing is named in the caption and the raw series is visible.
- [ ] The baseline is grey; at most 4 colored curves.
- [ ] The y-range is honest, or the zoom is declared.

# Trade-off and Pareto frontiers

## Contents

- The frontier is the claim; the runs are the evidence
- Make the good corner obvious
- Sweep budget is part of the result
- Encoding
- Traps
- Template
- Checklist

**Answers:** what you give up to get what you gained — reward against KL
divergence, accuracy against latency, quality against parameters or cost.

Use this when a method has a knob that moves it along a curve rather than to a
point. Reporting one operating point per method is then a choice of knob
setting dressed up as a result: pick a different β and the ranking flips. The
frontier is the honest object, and it is the figure.

## The frontier is the claim; the runs are the evidence

Plot **every run** as a faded marker, then connect each method's non-dominated
points (`pareto_front` in the style module) as a solid line. The comparison a
reader makes is whether one method's frontier sits above and to the left of the
other's across the range — not whether one dot beats another dot.

Hiding the dominated runs makes a cleaner picture and a worse figure: the
scatter is what shows a method is unstable, or that half its settings are
wasted.

**A frontier line is a guide, not an interpolation.** You did not measure the
points between two settings, and for a discrete knob they may not be
reachable. Say so in the caption when it matters.

## Make the good corner obvious

Two axes, one of which is better low and the other better high, is a figure
readers routinely misread. Name the direction in both axis labels — "KL
divergence (lower is better)" — which always works and costs nothing.

A small "better ↖" arrow in the winning corner reads faster, but only when the
data leaves that corner empty, and in a figure whose point is that your method
reaches the good corner, it usually does not. Check the rendered figure before
committing to one.

Better where the plot area is crowded: tint the good and bad regions instead of
labelling a point in them — `ax.axhspan`/`axvspan`, or a faint diagonal wash at
very low alpha behind the data. A background carries the direction without
competing for space with the markers, and it cannot collide with anything.

Cost-like axes — FLOPs, latency, parameters, tokens — are usually log; a linear
cost axis crushes the cheap end where the interesting trade-offs live.

## Sweep budget is part of the result

A method swept over 12 settings will appear to have a better frontier than one
swept over 3, because it had more chances to be non-dominated. State the number
of settings per method in the legend or caption, and give each method a
comparable budget. This is the single most common way a trade-off figure
flatters the authors' method without anyone lying.

## Encoding

- **Shape for the method, hue for the method** — redundant on purpose, so the
  figure survives greyscale printing and a colorblind reader.
- **Color by knob setting instead** only when the setting's *effect* is the
  story ("β controls how far the policy drifts"). It costs you one legend entry
  per value, which past about six becomes a lookup table nobody reads —
  direct-label the two or three settings that carry the argument and drop the
  rest from the legend.
- **Shape for the method, shade for an ordinal knob** is a good pair when the
  sweep value is itself ordered: distinct markers separate the methods, a
  single-hue light-to-dark ramp (`family()`) orders the settings within each.
  Two channels for two variables reads cleanly. What does not work is three —
  shape, hue, *and* a colorbar for two variables.

## Traps

| Trap | Fix |
| --- | --- |
| Points connected in sweep order | Connect the frontier, not the run index |
| Only the frontier plotted | Show dominated runs faded; the spread is a result |
| Unequal sweep budgets, uncompared | State n per method; match budgets |
| Neither axis says which way is better | Arrow in the good corner, or put it in the label |
| Linear axis on a cost that spans decades | Log the cost axis |
| One legend entry per hyperparameter value | Direct-label the few that matter |
| Seeds collapsed to a mean before the frontier | Take the frontier over settings, and show seed spread within a setting |

## Template

`figs/pareto.py`, reading `figs/pareto.csv` (`method,setting,seed,kl,reward`):

```python
"""Reward against KL divergence. Regenerate: python figs/pareto.py"""

import csv
from collections import defaultdict

import numpy as np
from figstyle import PALETTE, TEXT, figure, pareto_front, save, use_style

DATA = "figs/pareto.csv"

# Shape and hue both carry the method: redundant so the figure survives
# greyscale and a colorblind reader.
METHODS = {"GRPO": ("blue", "o"), "ES": ("red", "D")}


def load(path):
    runs = defaultdict(lambda: ([], [], set()))
    with open(path) as handle:
        for row in csv.DictReader(handle):
            kl, reward, settings = runs[row["method"]]
            kl.append(float(row["kl"]))
            reward.append(float(row["reward"]))
            settings.add(row["setting"])
    return {
        method: (np.array(kl), np.array(reward), len(settings))
        for method, (kl, reward, settings) in runs.items()
    }


def main():
    use_style()
    runs = load(DATA)

    fig, ax = figure(width=TEXT, ratio=0.62)
    for method, (color_name, marker) in METHODS.items():
        kl, reward, n_settings = runs[method]
        color = PALETTE[color_name]
        # Every run, faded: the spread is part of the result.
        ax.scatter(kl, reward, marker=marker, s=16, color=color, alpha=0.35, linewidth=0)
        front = pareto_front(kl, reward, minimize_x=True, maximize_y=True)
        ax.plot(
            kl[front], reward[front],
            marker=marker, markersize=4, color=color, linewidth=1.1, zorder=3,
            label=f"{method} ({n_settings} settings)",
        )

    ax.set_xlabel("KL divergence from the base model (lower is better)")
    ax.set_ylabel("Reward (higher is better)")
    ax.grid(True, axis="both")
    ax.legend(loc="lower right", frameon=True, framealpha=1.0, edgecolor="black")

    save(fig, "figs/pareto")


if __name__ == "__main__":
    main()
```

## Checklist

- [ ] Dominated runs shown, faded; frontier drawn through non-dominated points only.
- [ ] Number of settings per method stated, and budgets comparable.
- [ ] Both axis labels say which direction is better.
- [ ] Cost axes on a log scale where they span decades.
- [ ] Shape and hue both encode the method; no third encoding.
- [ ] The caption says the frontier line is a guide, not measured interpolation.

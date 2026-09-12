# Heatmaps, sweeps, and confusion matrices

## Contents

- First, check a heatmap is the right figure
- Colormap is a decision, not a default
- The colorbar is an axis
- Confusion matrices
- Traps
- Template — hyperparameter sweep
- Template — confusion matrix
- Checklist

**Answers:** what a 2D grid of measurements looks like — a hyperparameter
sweep, a confusion matrix, a correlation structure, a layerwise diagnostic.

A heatmap encodes value as color, and color is the least precise channel a
reader has. That buys you pattern recognition across a whole grid at once, and
it costs you the ability to compare two nearby cells accurately. Use it when
the *shape* of the grid is the finding.

## First, check a heatmap is the right figure

A 3×4 grid is not a heatmap; it is four lines with three points each, and a
line plot lets the reader read values off an axis instead of a color ramp.
Reach for a heatmap at roughly 5×5 and up, or when the two axes are genuinely
symmetric (a confusion or correlation matrix at any size).

## Colormap is a decision, not a default

| The data is | Use | Because |
| --- | --- | --- |
| A magnitude with a natural low end (loss, accuracy, count) | `viridis` (`SEQUENTIAL`) | Perceptually uniform: equal color steps mean equal value steps, and it survives greyscale |
| A signed difference, correlation, or delta to a baseline | `RdBu_r` (`DIVERGING`) with limits symmetric about zero | The midpoint color must land on zero, or the sign is unreadable |
| Anything at all | Never `jet`, `rainbow`, `hsv` | They have bright bands at arbitrary values, inventing edges the data does not have |

For a diverging map, set the limits yourself — `vmin=-max|x|`, `vmax=+max|x|`.
Letting matplotlib autoscale puts the neutral color at the data midpoint, which
is not zero, and the figure then claims sign changes that are not there.

## The colorbar is an axis

Label it with the quantity and its units, exactly as you would label an x-axis.
An unlabelled colorbar is the heatmap equivalent of an unlabelled axis. Keep it
the height of the plot, and if several panels share a scale, give them one
shared colorbar rather than one each — separate colorbars invite the reader to
compare panels that are not on the same scale.

## Confusion matrices

- **Normalize, and say how.** Raw counts under class imbalance make the largest
  class look like the model's whole behavior. Row-normalized gives recall per
  true class; column-normalized gives precision. Name which one in the caption.
- **Annotate the cells.** Up to about 12×12 the numbers fit; past that, drop the
  annotations and let the colorbar carry it.
- **Order the classes meaningfully** — by frequency, by semantic grouping, or
  identically to a matrix you are comparing against. Alphabetical order
  scatters the block structure that is often the finding.
- **Keep it square** (`aspect="equal"`); a stretched confusion matrix reads as
  if the classes were of different importance.

## Traps

| Trap | Fix |
| --- | --- |
| Cells smoothed into each other | `interpolation="nearest"` — a heatmap is not an image |
| Sweep axes labelled `0,1,2` | Label with the actual values; mark log-spaced axes as log |
| Annotations invisible on dark cells | Pick text color per cell by luminance (`annotate_matrix`) |
| Best cell left for the reader to find | Outline it, or mark it |
| NaNs rendered as the lowest color | Give failed runs an explicit color and say what it means |
| Two panels, two autoscaled colorbars | One shared normalization, one colorbar |

## Template — hyperparameter sweep

`figs/sweep.py`, reading `figs/sweep.csv` (`lr,batch_size,loss`):

```python
"""Final loss over the lr x batch-size sweep. Regenerate: python figs/sweep.py"""

import csv

import matplotlib as mpl
import numpy as np
from matplotlib.patches import Rectangle
from figstyle import COLUMN, MUTED, SEQUENTIAL, annotate_matrix, figure, save, use_style

DATA = "figs/sweep.csv"


def load(path):
    with open(path) as handle:
        rows = list(csv.DictReader(handle))
    lrs = sorted({float(row["lr"]) for row in rows}, reverse=True)
    batches = sorted({int(row["batch_size"]) for row in rows})
    grid = np.full((len(lrs), len(batches)), np.nan)
    for row in rows:
        loss = row["loss"].strip()
        # A run with no loss diverged or never finished; NaN keeps it out of
        # the color scale instead of pinning it to the worst value.
        grid[lrs.index(float(row["lr"])), batches.index(int(row["batch_size"]))] = (
            float(loss) if loss else np.nan
        )
    return lrs, batches, grid


def main():
    use_style()
    lrs, batches, grid = load(DATA)

    # A diverged or OOM run is not "the worst loss"; it is a different outcome.
    cmap = mpl.colormaps[SEQUENTIAL].with_extremes(bad=MUTED)

    fig, ax = figure(width=COLUMN, ratio=0.85)
    image = ax.imshow(grid, cmap=cmap, interpolation="nearest", aspect="auto")
    annotate_matrix(ax, grid, fmt="{:.3f}")

    if np.isnan(grid).all():
        raise ValueError("every cell is empty: nothing to plot")
    row, col = np.unravel_index(np.nanargmin(grid), grid.shape)
    ax.add_patch(
        Rectangle((col - 0.5, row - 0.5), 1, 1, fill=False, edgecolor="white", linewidth=1.4)
    )

    ax.set_xticks(range(len(batches)), [str(b) for b in batches])
    ax.set_yticks(range(len(lrs)), [f"{lr:.1e}" for lr in lrs])
    ax.set_xlabel("Batch size")
    ax.set_ylabel("Learning rate")
    ax.grid(visible=False)
    fig.colorbar(image, ax=ax, label="Final validation loss", fraction=0.046, pad=0.03)

    save(fig, "figs/sweep")


if __name__ == "__main__":
    main()
```

## Template — confusion matrix

Same style module, row-normalized and square:

```python
import matplotlib as mpl
import numpy as np
from figstyle import COLUMN, MUTED, SEQUENTIAL, annotate_matrix, figure, save, use_style

counts = np.load("figs/confusion.npy")  # (n_classes, n_classes), true x predicted
classes = ["ent", "neut", "contra"]

use_style()
support = counts.sum(axis=1, keepdims=True)
# A class with no examples is undefined, not zero recall.
recall = np.divide(counts, support, out=np.full(counts.shape, np.nan), where=support > 0)

fig, ax = figure(width=COLUMN, ratio=0.95)
cmap = mpl.colormaps[SEQUENTIAL].with_extremes(bad=MUTED)
image = ax.imshow(recall, cmap=cmap, vmin=0, vmax=1, interpolation="nearest", aspect="equal")
annotate_matrix(ax, recall, fmt="{:.2f}")
ax.set_xticks(range(len(classes)), classes)
ax.set_yticks(range(len(classes)), classes)
ax.set_xlabel("Predicted")
ax.set_ylabel("True")
ax.grid(visible=False)
fig.colorbar(image, ax=ax, label="Fraction of true class", fraction=0.046, pad=0.03)
save(fig, "figs/confusion")
```

The caption says row-normalized, and gives the support per class — a 1.00 over
three examples is not the same result as a 1.00 over three thousand.

## Checklist

- [ ] The grid is big enough that a heatmap beats a line plot.
- [ ] Sequential map for magnitudes, diverging *centered on zero* for signed data.
- [ ] Colorbar labelled with quantity and units; shared across panels on one scale.
- [ ] Axis ticks show real values, not indices.
- [ ] `interpolation="nearest"`; no smoothing between cells.
- [ ] Confusion matrix: normalization named in the caption, support reported.
- [ ] Failed or missing runs are visually distinct from bad-but-real values.

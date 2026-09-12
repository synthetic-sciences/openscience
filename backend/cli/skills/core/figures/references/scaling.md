# Scaling laws

## Contents

- Fit the form the field uses
- What belongs in the fit
- Extrapolation must look like extrapolation
- Traps
- Template
- Checklist

**Answers:** how a metric changes with model size, data, or compute — and what
the trend predicts at a scale you did not run.

The figure is a log-log scatter of measured runs with a fitted power law
through them. Its whole value is the fit, so the fit has to be defensible: a
straight line drawn through four points on log axes will look convincing
whether or not it means anything.

## Fit the form the field uses

For a metric with a floor — loss, error — the two-parameter power law
`L = A·N^(-α)` is wrong at large N, because it goes to zero and real loss does
not. Fit the three-parameter form:

```
L(N) = E + A · N^(-α)
```

`E` is the irreducible loss (entropy of the data, Bayes error). Forcing `E = 0`
bends the fit and flattens `α`, which is exactly the parameter you are
reporting. Fit `E` too — and fit the error on `L`, not on `log(L - E)`, which
is dominated by whichever runs sit closest to the floor. If the fitted `E`
comes out at zero or at `min(L)`, the runs do not constrain the floor: say so
rather than reporting the boundary as a measurement.

Report `α` with an interval — a bootstrap over the runs is enough — and put it
in the figure, not only the prose. A scaling exponent with no uncertainty
invites a reviewer to ask how many points it came from.

## What belongs in the fit

- **One regime only.** Runs that are under-trained, warmup-limited, or hitting
  a different bottleneck are a different law. Plot them if they are
  interesting, but exclude them from the fit and say which points were fit.
- **At least 4 points, ideally spanning a decade or more.** Fewer than 4, or
  all within a factor of 3, is a trend line, not a scaling law — label it that
  way.
- **Comparable runs.** Same data, same tokenizer, same evaluation. A scaling
  plot silently comparing two eval sets is a broken figure that looks fine.

## Extrapolation must look like extrapolation

If the point of the figure is a prediction at a scale you did not run, draw the
fit solid over the fitted range and dashed beyond it, and shade the
extrapolated region. A solid line running off the right of the plot claims
measurement where there is none.

## Traps

| Trap | Fix |
| --- | --- |
| Tick labels reading `10^8`, `10^9` | Powers of ten are right for the grid; label them `100M`, `1B` (`si_ticks`) |
| Fit line drawn but residuals hidden | Add a residual strip under the main panel — curvature there means the form is wrong |
| Points shown without which were fit | Fitted points filled, excluded points hollow, and say so in the caption |
| Both axes log but only one labelled as such | Log axes are conventional here; still name the units |
| `α` in the caption only | Print the fitted equation in the panel — it is the result |
| Different model families in one color | One marker shape per family; the law may differ between them |

## Template

`figs/scaling.py`, reading `figs/scaling.csv` (`family,n_params,loss,fit`)
where `fit` is `1` for points included in the fit:

```python
"""Loss vs. parameters with a fitted power law. Regenerate: python figs/scaling.py"""

import csv

import numpy as np
from figstyle import BASELINE, PALETTE, TEXT, figure_grid, save, si_ticks, use_style

DATA = "figs/scaling.csv"
PREDICT_TO = 1e11  # extrapolate the fit out to this many parameters


def load(path):
    n, loss, fitted, family = [], [], [], []
    with open(path) as handle:
        for row in csv.DictReader(handle):
            n.append(float(row["n_params"]))
            loss.append(float(row["loss"]))
            fitted.append(row["fit"] == "1")
            family.append(row["family"])
    return np.array(n), np.array(loss), np.array(fitted), np.array(family)


def fit_power_law(n, loss, alphas=np.linspace(0.02, 1.5, 800)):
    """Least squares for L = E + A*N^-alpha.

    For a fixed alpha the model is linear in (E, A), so scanning alpha and
    solving each slice exactly needs no nonlinear optimizer. It also fits the
    error on L rather than on log(L - E), which is dominated by whichever runs
    sit closest to the floor and collapses the fit to E = 0.
    """
    best = None
    for alpha in alphas:
        design = np.stack([np.ones_like(n), n**-alpha], axis=1)
        coef, *_ = np.linalg.lstsq(design, loss, rcond=None)
        if coef[0] < 0 or coef[1] <= 0:
            continue  # a negative floor or amplitude is not a scaling law
        sse = float(((design @ coef - loss) ** 2).sum())
        if best is None or sse < best[0]:
            best = (sse, float(coef[0]), float(coef[1]), float(alpha))
    if best is None:
        raise ValueError("no fit with a non-negative irreducible term")
    _, e, a, alpha = best
    return e, a, alpha


def bootstrap_alpha(n, loss, draws=200, seed=0):
    rng = np.random.default_rng(seed)
    alphas = []
    for _ in range(draws):
        idx = rng.integers(0, len(n), len(n))
        if len(set(idx.tolist())) < 3:
            continue
        try:
            alphas.append(fit_power_law(n[idx], loss[idx])[2])
        except ValueError:
            continue  # a degenerate resample is not a reason to lose the figure
    if len(alphas) < draws // 4:
        raise ValueError(f"only {len(alphas)}/{draws} resamples fit; too few runs for an interval")
    return np.percentile(alphas, [2.5, 97.5])


def main():
    use_style()
    n, loss, fitted, family = load(DATA)
    e, a, alpha = fit_power_law(n[fitted], loss[fitted])
    lo, hi = bootstrap_alpha(n[fitted], loss[fitted])

    fig, (ax, res) = figure_grid(
        nrows=2, ncols=1, width=TEXT, ratio=0.62,
        sharex=True, gridspec_kw={"height_ratios": [3, 1]},
    )

    def curve(x):
        return e + a * x**-alpha

    measured = np.geomspace(n[fitted].min(), n[fitted].max(), 100)
    beyond = np.geomspace(n[fitted].max(), PREDICT_TO, 100)

    ax.plot(measured, curve(measured), color=BASELINE, zorder=1)
    ax.plot(beyond, curve(beyond), color=BASELINE, linestyle="--", zorder=1)
    ax.axvspan(n[fitted].max(), PREDICT_TO, color=BASELINE, alpha=0.08, linewidth=0)

    markers = ("o", "s", "^", "v", "P", "X")
    families = sorted(set(family))
    if len(families) > len(markers):
        raise ValueError(f"{len(families)} families, {len(markers)} markers: add more")
    for marker, name in zip(markers, families):
        pick = family == name
        ax.scatter(n[pick & fitted], loss[pick & fitted], marker=marker,
                   color=PALETTE["blue"], label=name, zorder=2)
        ax.scatter(n[pick & ~fitted], loss[pick & ~fitted], marker=marker,
                   facecolor="none", edgecolor=PALETTE["blue"], linewidth=0.7, zorder=2)

    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_ylabel("Validation loss")
    ax.set_xlim(right=PREDICT_TO)
    ax.text(
        0.03, 0.06,
        rf"$L = {e:.2f} + {a:.1f}\,N^{{-{alpha:.3f}}}$" "\n"
        rf"$\alpha \in [{lo:.3f},\ {hi:.3f}]$, {int(fitted.sum())} runs",
        transform=ax.transAxes, va="bottom", fontsize=7,
    )
    if len(set(family)) > 1:
        ax.legend(loc="upper right")

    res.axhline(0, color=BASELINE, linewidth=0.6)
    res.scatter(n[fitted], 100 * (loss[fitted] - curve(n[fitted])) / loss[fitted],
                color=PALETTE["blue"], s=8)
    res.set_ylabel("Resid. (%)")
    res.set_xlabel("Non-embedding parameters")
    si_ticks(ax, "y")
    si_ticks(res, "x")

    save(fig, "figs/scaling")


if __name__ == "__main__":
    main()
```

## Checklist

- [ ] The fitted form has an irreducible term, and `E` is reported.
- [ ] `α` carries an interval, and the number of fitted runs is stated.
- [ ] Excluded points are visually distinct and the exclusion is justified.
- [ ] Extrapolation is dashed and shaded; nothing solid leaves the data range.
- [ ] A residual panel shows the fit is not systematically curved.
- [ ] Axis ticks read as `100M` / `1B`, not `10^8`.

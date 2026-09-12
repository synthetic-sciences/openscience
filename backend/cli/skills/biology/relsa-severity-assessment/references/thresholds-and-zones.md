# Severity zones on the RELSA scale via kernel density estimation

A RELSA score of 0.55 is only interpretable once you know where the cut-points lie. Lutscher
et al. (2026) derive candidate cut-points from the data itself: estimate the probability
density of all RELSA scores observed in a model, and take the **minima** of that density —
the sparsely populated valleys between clusters of scores. `scripts/kde_thresholds.py`
implements this.

## Method

For each observation a Gaussian kernel of bandwidth `h` is placed; averaging them yields the
density estimate, and interior local minima mark low-occurrence regions that can serve as
thresholds (Korneev et al., 2022; Gilles & Heal, 2014).

Two minima split the scale into three zones:

| Zone | Meaning |
| --- | --- |
| normal | below the lower minimum — within the range the model's animals mostly occupy |
| attention | between the minima — flag the animal for closer monitoring |
| danger | above the upper minimum — approaching or at the individual endpoint |

The implementation reproduces R's `stats::density` defaults, because that is what the paper
used: Gaussian kernel, Silverman's `bw.nrd0` bandwidth
(`0.9 * min(sd, IQR/1.349) * n^(-1/5)`), and a 512-point grid extended three bandwidths past
the data range. Note that scipy's own `bw_method='silverman'` is a **different formula** and
would shift every threshold, which is why `bw_nrd0()` is implemented explicitly.

Include all animals in the model — those that reached the endpoint *and* the survivors and
sham controls. The zones are meant to separate the trajectories of animals in different
states, which requires all of those states to be represented.

## Published thresholds

| Model | Thresholds | Notes |
| --- | --- | --- |
| Sepsis (CLP) | 0.337 and 0.643 | 7 mice, 239 scores; the paper's Figure 3 |
| DSS + restraint stress | 0.250 | single threshold |
| DSS + blood sampling | 0.649 | single threshold |

The pancreatic cancer and neurosurgery models were excluded from this analysis: with one
animal each, the score distribution is too sparse for a meaningful density.

The abstract of the paper gives the sepsis upper threshold as 0.647 while its Results and
Figure 3 give 0.643 — a reminder of how little separates two runs of this procedure.

## What this port reproduces, and how fragile it is

On the public sepsis data with the paper's four telemetry variables and the CLP animals as
reference set, excluding the baseline time point (where RELSA = 0 by construction):

- **239 scores** — exactly the paper's stated 239 data points from 7 mice.
- Thresholds **0.355 and 0.655** against the published 0.337 and 0.643. Including `bwc` in
  the score gives 0.363 and 0.644.
- At 0.9 × `bw.nrd0` the minima move to **0.335 and 0.633**, essentially the published pair.

That last line is the important one. A bandwidth sensitivity sweep on the same 239 scores:

| Bandwidth (× `bw.nrd0` = 0.0732) | Minima found |
| --- | --- |
| 0.70 | 0.310, 0.630 |
| 0.80 | 0.322, 0.628 |
| 0.90 | 0.335, 0.633 |
| 1.00 | 0.355, 0.655 |
| 1.10 | **none — the density is unimodal** |
| ≥ 1.25 | none |

A 10% change in bandwidth destroys both thresholds. The lower threshold sits in a broad,
shallow valley and moves by 0.045 across a plausible bandwidth range; the upper one is
comparatively stable. Two further sensitivities: dropping one variable from the score can
change the number of minima, and turning off the algorithm's 2-decimal rounding changed this
dataset from two minima to one.

**Therefore:** never report KDE thresholds as a bare pair of numbers. Report the bandwidth,
the number of scores, the variables, the reference set, and a sensitivity sweep. Prefer the
sweep to the point estimate — if a threshold survives only at one bandwidth, you have found a
property of the smoother, not of the animals.

## These are not regulatory severity gradings

EU Directive 2010/63/EU requires prospective assignment of procedures to four categories:
non-recovery, mild, moderate, and severe. **KDE zones on the RELSA scale are not those
categories,** and the paper says so twice: the thresholds "should not be confused with
regulatory severity gradings" and are "neither generalizable nor directly translatable to
severity categories under EU Directive 2010/63/EU".

They are also not comparable between models. Because RELSA is relative to a reference set and
because clinical scoring is not harmonized across laboratories, a threshold of 0.337 in one
model means nothing in another. The paper's own observation that the sepsis (0.337/0.643) and
DSS (0.250, 0.649) thresholds are "fairly close" is offered as a hint about where common
thresholds might eventually lie, not as evidence that they transfer.

What a unified scale would require, per the paper's outlook: the same parameters measured with
harmonized technical and methodological approaches across models — realistically, automated
home-cage monitoring at high frequency.

## Practical use

```bash
# candidate zones for one model, with a figure and a sensitivity check
python scripts/kde_thresholds.py relsa_scores.csv --n-thresholds 2 \
    --plot zones.png --json zones.json --label-out zoned.csv

# does the answer survive a different bandwidth?
for f in 0.8 0.9 1.0 1.1 1.2; do
  python - "$f" <<'PY'
import sys, pandas as pd
sys.path.insert(0, "scripts")
from kde_thresholds import find_thresholds, bw_nrd0
v = pd.read_csv("relsa_scores.csv")["relsa"].dropna()
bw = bw_nrd0(v.to_numpy()) * float(sys.argv[1])
print(sys.argv[1], [round(t, 3) for t in find_thresholds(v, bandwidth=bw).thresholds])
PY
done
```

An empty threshold list is a real answer: this cohort's scores form one cluster, and there is
no data-driven place to cut. Do not lower the bandwidth until minima appear.

### The thin-zone filter

A finite sample's density estimate wiggles in its tails, and a wiggle produces a local minimum
that separates one stray score from the rest. On 300 draws from a single normal distribution
this implementation finds such a minimum, and it isolates exactly **one** observation — a
property of the smoother, not a severity zone. `min_zone_fraction` (default 0.02) therefore
requires every zone to hold at least 2% of the scores, dropping the shallowest threshold
bounding any zone that does not, until all of them do.

This does not touch the published sepsis result: its three zones hold 68.2%, 22.2%, and 9.6%
of the 239 scores. Set `--min-zone-fraction 0` to see the raw minima, and expect tail
artefacts among them.

Two alternatives when KDE gives nothing usable:

- **k-means levels.** The original RELSA package derives `k+1` levels by k-means clustering of
  the reference set's scores (`relsa_levels`, default `k = 4`). Also data-driven, also
  reference-set-specific, and it always returns levels — including when there is no real
  structure to find.
- **The model's own endpoint criterion.** Compute the RELSA score at the time the humane
  endpoint was actually reached in previous animals, and use that value as the line to watch.
  This is directly interpretable and needs no smoother, which is what the "individual
  endpoint" line in the paper's Figure 1 shows.

## Key references

- Rosenblatt, M. (1956). Remarks on some nonparametric estimates of a density function.
  *Ann. Math. Stat.* 27, 832–837.
- Parzen, E. (1962). On estimation of a probability density function and mode.
  *Ann. Math. Stat.* 33, 1065–1076.
- Węglarczyk, S. (2018). Kernel density estimation and its application. *ITM Web Conf.* 23, 37.
- Korneev, A. et al. (2022). Multiclass histogram-based thresholding using kernel density
  estimation and scale-space representations. arXiv:2202.04785.
- EU Commission (2010). Directive 2010/63/EU. *Official Journal of the European Union* 53,
  16–25.

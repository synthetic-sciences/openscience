# The RELSA score: algorithm, decisions, and parity with the R package

RELSA (RELative Severity Assessment) turns several welfare outcome measures into one
interpretable number per animal per time point. It was introduced in Talbot et al. (2022),
*Front. Vet. Sci.* 9:937711, and implemented in the R package
[`mytalbot/RELSA`](https://github.com/mytalbot/RELSA) (GPL-3). `scripts/relsa_score.py` is a
Python port of that implementation.

## The four steps

### 1. Directionality

Every variable must be declared as falling or rising under worsening welfare. The default
assumption is that a *decrease* means a worse outcome (body weight, activity, burrowing,
wheel running, food intake). Variables that *increase* are **turned**: clinical scores,
inflammatory biomarkers, fever, tachycardia.

Directionality is model-specific and getting it wrong silently zeroes a variable's
contribution, because deviations in the "wrong" direction are floored at 0. Body temperature
is the classic trap: it falls in CLP sepsis and endotoxaemia (hypothermia predicts death) and
rises in fever models.

`build_reference()` warns when a variable's *only* observed deviation runs against its declared
direction, and rejects one that never deviates at all. It cannot do better than that: in the
published sepsis data activity swings 530% above baseline and 100% below, so "which direction
is worse" is not recoverable from the data and has to come from the biology of the model.

### 2. Normalization to the individual baseline

Each variable is divided by that animal's own baseline value and expressed as a percentage,
so every trajectory starts at 100%:

```
x_norm(t) = 100 * x(t) / x(baseline)
```

Using each animal's own baseline is what makes RELSA robust to between-animal variation in
absolute values. The baseline may be one time point (the RELSA convention codes it as
`day = -1`) or the mean of a baseline window — pass several times to `--baseline-time`.

Two variable types must **not** be normalized again:

- Variables already expressed as percent change from baseline, such as body weight change
  (`bwc [%]`) in the published datasets.
- Ordinal severity scores whose healthy baseline is 0. `0/0` is undefined, so ratio
  normalization cannot represent them at all. Use `score_to_percent()` /
  `--score-scale COL=MAX`, which maps the score's *scale* instead of its ratio: the healthy
  score becomes 100, the worst possible score becomes 200, and one score point is worth
  `100 / (max - baseline)` percent. The variable is then a turned variable like any other.

  This mapping is this skill's convention, not something the paper specifies. It is a
  choice about how much a score point is worth relative to a percent of body weight, and it
  should be stated in the methods. The defensible alternative is to keep the score out of
  RELSA entirely and use it as an independent endpoint criterion, which is what the DSS
  blood-sampling model in the paper does (its clinical score of 5 is an endpoint trigger,
  while RELSA is computed from `bwc` and wheel running).

### 3. The reference set

The reference set is the cohort assumed to carry the greatest burden in the model, and it
fixes the meaning of the scale. For each variable, RELSA records the most extreme normalized
value reached anywhere in that cohort:

```
maxsev_i  = min over reference set (or max, for turned variables)
maxdelta_i = |100 - maxsev_i|
```

The paper uses "the animal in the treatment group suspected to experience the greatest burden
under the respective model" — e.g. the highest DSS dose with phlebotomy in the DSS blood
sampling dataset.

This is the single most consequential choice in the whole procedure. RELSA is *relative*:
change the reference set and every score changes. A reference cohort that is too mild pushes
scores above 1; one that is too severe compresses everything toward 0. A score is
meaningless without the reference set it came from, which is why `ReferenceModel` carries a
`label` and `--save-reference` writes it to JSON for reuse on later cohorts.

A variable that never deviates in the reference set has `maxdelta = 0`, would divide by zero,
and is rejected with an error rather than silently dropped.

### 4. Weights and the score

```
delta_i(t) = 100 - x_norm,i(t)        (turned: x_norm,i(t) - 100), floored at 0
RW_i(t)    = delta_i(t) / maxdelta_i
RELSA(t)   = sqrt( (1/n) * sum_i RW_i(t)^2 )     over the n variables measured at t
```

The root-mean-square, rather than the arithmetic mean, is deliberate: severity is signalled
by *extremes*, so squaring gives a large deviation in one variable more influence than the
mean would. A single variable at the reference maximum with three others at baseline gives
RELSA = 0.5, not 0.25.

Missing values are dropped from the mean, never imputed and never treated as 0 — treating a
missing measurement as "no deviation" would bias every score downward. This is why a score
is defined whenever at least one variable was measured.

**Interpretation.** RELSA = 0 is baseline; 0.73 means the animal reached 73% of the reference
set's maximum deviation; above 1 means it exceeded the reference set. The score is
dimensionless and comparable *within* a reference frame, not across reference sets or models.

## A trap the published data demonstrates

Because the score averages over whichever variables were measured, **a variable that appears
or disappears mid-trajectory moves the score by itself.** In the published sepsis dataset,
body weight is recorded only on the day of euthanasia. Include `bwc` in that model and mouse
ID_801's endpoint score falls from 0.93 to 0.83 — not because the animal improved, but
because a variable with a low weight (0.16) joined the mean at exactly that time point. The
paper's sepsis model uses only the four telemetry parameters, which are present throughout.

Score the variables measured throughout the trajectory; keep the intermittent ones as
separate endpoint criteria. `relsa_scores()` warns when the composition changes.

## Parity with the R package

`relsa_score.py` reproduces the R package's own published worked example — the `surgery`
dataset, animal `Ca_001`, variables `bwc, burON, hr, hrv, temp, act`, turned `hr, temp` — to
the two decimals the package prints: every normalized value, every weight, and the RELSA
scores 0.00, 0.73, 0.55, 0.44, 0.44, 0.41 for days -1 to 4, including the `NA` weight where
`burON` is missing. The test suite pins this.

Details worth knowing if you compare against R directly:

- **Rounding is part of the algorithm.** R rounds the deltas and the weights to two decimals
  *before* the root-mean-square, so the port does too. `round_digits=None` /
  `--full-precision` skips it, which changes scores in the third decimal — and, because KDE
  minima are sensitive to the granularity of the score distribution, can change the number of
  thresholds found. Keep the default when reproducing published work.
- **`relsa()`'s `wf` column is not the score.** The R function returns both a mean weight
  factor (`wf`) and the root-mean-square (`rms`); the RELSA score is `rms`. In the released
  package `wf` divides the weight sum by the count of *missing* variables rather than the
  count of present ones (the vignette has the intended form), and because `wf` is used to
  mask `rms`, a complete row sitting exactly at baseline is returned as `NA` instead of 0 by
  that code path. The rendered vignette prints 0.00 for the baseline day, so the port
  returns 0.0, matching the published output and the formula.
- Column order does not matter here. The R functions address `set[, 4:ncol]` positionally;
  this port uses named `id` / `time` columns.

## Outcome measures and directionality in the published models

From Lutscher et al. (2026) and the studies it re-analyses. Use it as a template for
declaring your own model, not as a set of defaults to copy.

| Model / intervention | Variables in RELSA | Turned | Humane endpoint criterion |
| --- | --- | --- | --- |
| CLP sepsis (telemetry) | `hr`, `hrv`, `temp`, `act` | none | >25% temperature loss over two consecutive monitoring intervals |
| DSS colitis + restraint stress | `hr`, `hrv`, `temp`, `act`, `bwc` | `hr`, `temp` | 20% body weight loss |
| DSS colitis + facial vein blood sampling | `bwc`, `vwr` (voluntary wheel running) | none | 20% body weight loss or clinical score 5 |
| Pancreatic cancer (6606PDA) | `bwc`, `vwr` | none | 20% body weight loss |
| Neurosurgery (intracranial electrode) | `bwc`, nesting score, Neuro Score (modified Irwin) | nesting, neuro | total clinical score of 7 |

Heart rate, heart rate variability and temperature were averaged per interval; activity was
summed. Clinical scoring differed between laboratories and models, so the paper states
plainly that clinical scores are **not directly comparable** across those studies — one of
its central caveats about a generalized RELSA scale.

## Data for testing against published work

- Sepsis and 1.5% DSS + restraint stress: <https://github.com/mytalbot/RELSA/tree/master/raw_data>
- DSS with repeated facial vein blood sampling: <https://doi.org/10.1371/journal.pbio.2006159.s002>
- Pancreatic cancer: <https://doi.org/10.1371/journal.pone.0261662>
- Neurosurgery: <https://doi.org/10.6084/m9.figshare.26030569>

## Key references

- Talbot, S. R. et al. (2022). RELSA — a multidimensional procedure for the comparative
  assessment of well-being and the quantitative determination of severity in experimental
  procedures. *Front. Vet. Sci.* 9:937711.
- Lutscher, S. et al. (2026). Refining humane endpoint detection by time-series forecasting
  and threshold definition using a multivariate severity score. *Front. Physiol.*
  17:1869563. doi:10.3389/fphys.2026.1869563
- Talbot, S. R. et al. (2020). Defining body-weight reduction as a humane endpoint: a
  critical appraisal. *Lab. Anim.* 54, 99–110.
- Russell, W. M. S. & Burch, R. L. (1959). *The Principles of Humane Experimental Technique.*

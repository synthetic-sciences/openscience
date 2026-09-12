# The Statistics, and Why Each One

Every method in this file is implemented in `scripts/_common.py` using only the standard library.
Distribution functions are computed from the regularised incomplete beta and gamma functions, and the
implementations are checked against published quantiles in `tests/analytical-method-validation/`.

## Calibration response

### r² is not evidence of linearity

The coefficient of determination measures how much of the variance in response the model explains. It
rises with the width of the calibration range and is nearly insensitive to curvature. A quadratic
response measured over a decade of concentration routinely gives r² > 0.99 while the back-calculated
result at the bottom of the range is 10% wrong.

ICH Q2(R2) 3.2.2.1 asks for r or r², the slope, the intercept, the plot, **and an analysis of the
deviation of the actual data points from the regression line**. The last item is the one that
detects a bad model. Report r² because the guideline asks for it, not because it demonstrates
anything.

### Lack-of-fit F test

The correct test of a linear calibration model, and it requires replicates at some levels.

Partition the residual sum of squares into **pure error** (scatter among replicates at the same
level, which no model can explain) and **lack of fit** (systematic deviation of level means from the
line):

```
F = MS_lack-of-fit / MS_pure-error,   df = (k - 2, n - k)
```

for `k` distinct levels and `n` total points. A significant F says the straight line fails to
describe the data beyond what replicate scatter explains. Without replicates the partition is
impossible and no linearity test exists — which is a good reason to replicate at least one level, and
a reason `check_response.py` says so explicitly when it cannot run the test.

### Residual pattern: runs test

Curvature makes residual signs cluster: all negative at the ends and positive in the middle, or the
reverse. The Wald–Wolfowitz runs test counts sign changes and compares against the number expected
if signs were random. Too few runs is evidence of systematic misfit. It complements the F test and
works when replicates are absent, though it needs at least eight points with both signs present.

### Heteroscedasticity and weighting

Chromatographic response variance usually scales with concentration. Unweighted least squares
minimises absolute squared residuals, so the high-concentration points — which have the largest
absolute residuals — dominate the fit. The result is a curve that is accurate at the top of the range
and biased at the bottom, which is exactly where an impurity reporting threshold or an LLOQ sits.

`check_response.py` compares residual variance in the top and bottom thirds of the range. A ratio
above roughly 10× with an unweighted fit is flagged; `1/x` or `1/x²` weighting is the usual remedy.
State the weighting in the protocol before validation — switching to weighting after seeing the data
to make the low end pass is not a statistical decision.

### Back-calculated relative error

The practical criterion: invert the fitted line, compute the concentration each response implies,
and compare against nominal at each level. This is what the procedure will actually report, and it
exposes a bad model in units an analyst and an assessor both understand. Bioanalytical work has
required it for decades; it belongs in small-molecule QC validation too.

## Precision

### Estimate within each level, never pooled across levels

Pooling results from 80%, 100% and 120% levels into one standard deviation makes the range itself
appear as imprecision. The number produced is meaningless and always too large.
`check_accuracy_precision.py` estimates precision within each level, and separately provides a
level-independent view by converting to percent of nominal first.

### Repeatability and intermediate precision are different quantities

A one-way random-effects model on the intermediate-precision factor — day, analyst, or instrument:

```
observation = grand mean + group effect + residual
```

with `MS_within` and `MS_between` from the ANOVA table:

```
s²_repeatability = MS_within
s²_between       = max(0, (MS_between - MS_within) / n_effective)
s²_intermediate  = s²_repeatability + s²_between
```

For a balanced design `n_effective` is the replicates per group; unbalanced designs use the standard
expected-mean-square coefficient, which the script reports when it applies.

The between-group variance is truncated at zero because a negative variance estimate is not
meaningful — it means the data cannot distinguish the groups. The script says so when it happens
rather than silently reporting zero.

Why this matters: a procedure can show 0.07% RSD within a day and 1.65% RSD across days. The
within-day figure is real, and reporting it as the procedure's precision understates routine
performance by more than twenty-fold. Q2(R2) 3.3.2.2 exists precisely because the between-day
component is the one that bites in routine use.

### Confidence intervals on a standard deviation

A precision estimate from six or nine determinations is imprecise, and Q2(R2) 3.3.2.4 asks for an
interval alongside it. For a variance with `ν` degrees of freedom:

```
s · sqrt(ν / χ²_{1-α/2, ν})  <  σ  <  s · sqrt(ν / χ²_{α/2, ν})
```

These intervals are wide, and that is the point. With ν = 5 the upper bound is roughly twice the
point estimate. An RSD that lands just inside a limit on six replicates has not demonstrated that the
procedure meets the limit. For the total (intermediate) SD, which is a sum of variance components,
the effective degrees of freedom come from the Satterthwaite approximation.

## Accuracy

Report mean percent recovery, or the difference from the accepted true value, **with a confidence
interval** — Q2(R2) 3.3.1.4 is explicit, and a bare mean is not sufficient. The interval is
`mean ± t_{1-α/2, n-1} · s/√n` at each level.

The stricter reading, available as `--require-ci-within-limit`, asks that the whole interval sit
inside the acceptance limit rather than just the point estimate. Q2(R2) says the observed interval
should be *compatible with* the criterion. Which reading applies is a decision to make and justify in
the protocol, before the data exist.

### Combined accuracy and precision

Q2(R2) 3.3.3 permits a single combined criterion assessed with a prediction interval, a tolerance
interval, or a confidence interval, instead of separate accuracy and precision criteria. This is
often the more honest framing — what matters is whether a future reportable result will be close
enough to the truth, which is a tolerance-interval question. If you use it, describe the approach and
supply the individual results as supporting information.

## Detection and quantitation limits

The `3.3σ/S` and `10σ/S` formulae are estimates whose value depends entirely on which σ you choose.
On the same calibration data, σ from the residual SD of the regression, from the SD of the
y-intercept, and from the SD of blank responses commonly give limits spanning a factor of two or
more. None is wrong; they answer slightly different questions.

Consequences for practice:

- Report the limit **and the approach**, per Q2(R2) 3.2.3.5. A number alone is not reportable.
- Confirm an estimated limit with real determinations at or near it. `3.2.3.4` allows skipping the
  estimate entirely and validating the QL directly by accuracy and precision, which is cleaner.
- For impurity procedures, the QL must be at or below the reporting threshold.
- Signal-to-noise scaling assumes noise is constant with concentration. It usually is not; confirm at
  the resulting level.
- CLSI's limit of blank / limit of detection / limit of quantitation are defined differently again,
  with their own protocols. Do not translate between the schemes casually.

## Method comparison and transfer

### Ordinary least squares is the wrong regression here

OLS assumes the x values are known without error. In a method comparison both procedures have
measurement error, and ignoring the error in x biases the slope toward zero — a regression-dilution
effect that manufactures apparent proportional bias where none exists.

**Deming regression** accounts for error in both variables given `λ`, the ratio of error variances.
With `λ = 1` (equal precision) it reduces to orthogonal regression. Standard errors here come from a
jackknife, which avoids distributional assumptions about the slope.

**Passing–Bablok** is non-parametric: the slope is a shifted median of all pairwise slopes, with a
rank-based confidence interval. It assumes no distribution, tolerates outliers, and is the usual
choice in clinical method comparison. Its confidence intervals are wider, honestly reflecting what
the data support.

Report both. Agreement between them is reassuring; disagreement points to outliers or to a
distributional problem worth understanding before concluding anything.

### Bland–Altman answers a different question

Regression asks whether the relationship is proportional. Bland–Altman asks how far apart two
procedures are on the same sample: mean difference (bias) and limits of agreement at
`bias ± 1.96·SD`. Both matter, and neither substitutes for the other.

Two cautions. The limits of agreement are themselves estimates with confidence intervals, which are
wide for small n — the script reports the half-width. And if the difference trends with
concentration, a single mean bias and its limits are misleading no matter how tight they look; the
script tests for that trend and flags it.

### Equivalence: TOST, not a t test

The default reflex at a transfer is a two-sample or paired t test, and `p > 0.05` written up as "no
significant difference, methods equivalent". This inverts the logic. A non-significant result means
the data were insufficient to detect a difference — and on a transfer dataset of ten or twenty
samples, that outcome is close to guaranteed regardless of whether the procedures agree. The test
rewards small studies.

**Two one-sided tests** invert the hypotheses to match the question. Given a pre-stated margin `δ`,
test both `H01: difference ≤ -δ` and `H02: difference ≥ +δ`. Rejecting both concludes equivalence.
Operationally: the `(1-2α)` confidence interval on the difference must lie entirely inside `±δ`.

A worked contrast from `compare_methods.py`: a transfer with a consistent +1.46% bias gives a paired
t-test p-value below 0.0001 — a highly significant difference — while TOST establishes equivalence at
a ±2% margin. Both are correct. The difference is real and it is small enough not to matter. Only
TOST answers the question the transfer actually asks.

The margin must be pre-stated, from the specification or the analytical target profile. A margin
chosen after seeing the data is not an acceptance criterion, and this is the single most common way
equivalence testing gets misused.

## What none of this does

These are computations. They do not establish that a procedure is fit for purpose. That conclusion
requires the intended purpose, the specification, product and process knowledge, the laboratory's
history with the technique, and the judgement of people who are accountable for it. A script that
reported "validated" would be lying about what it can know.

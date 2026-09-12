# GUM methodology

The *Guide to the Expression of Uncertainty in Measurement* (JCGM 100:2008, "the GUM")
and its Supplement 1 (JCGM 101:2008, the Monte Carlo method) define how an uncertainty
is evaluated, combined, and reported. This file covers the parts that decide whether a
number is defensible.

## Vocabulary that has to stay straight

| Term | Symbol | Meaning |
| --- | --- | --- |
| Measurand | Y | the quantity intended to be measured |
| Estimate | y | the value obtained for it |
| Standard uncertainty | u(x) | uncertainty of an input, expressed as a standard deviation |
| Combined standard uncertainty | u_c(y) | standard uncertainty of the result |
| Expanded uncertainty | U | k * u_c(y) |
| Coverage factor | k | multiplier chosen for a stated coverage probability |
| Coverage probability | p | probability that the interval contains the measurand |

"Error" and "uncertainty" are not synonyms. An error is a single unknowable difference
from the true value; an uncertainty is a dispersion. "Accuracy" and "precision" are
qualitative words in the GUM's vocabulary and never carry a number.

## Type A and Type B are methods, not qualities

The distinction is only about *how the uncertainty was evaluated*. Neither is more
reliable than the other, and both produce a standard uncertainty on the same footing.

**Type A** — evaluated from a statistical analysis of repeated observations.

For n independent readings with experimental standard deviation s(q):

```text
u(q_bar) = s(q) / sqrt(n)          degrees of freedom: nu = n - 1
```

The standard uncertainty of the *mean* is what enters the budget when the reported
value is a mean. Using s(q) itself overstates it by sqrt(n); using `numpy.std` without
`ddof=1` understates s(q) itself. Both mistakes are common and neither is visible in
the output.

Pooling repeatability across several runs raises the degrees of freedom and is worth
doing when the same instrument and procedure produced them.

**Type B** — evaluated by any other means: a calibration certificate, a manufacturer's
specification, a handbook value, a previous measurement, or documented judgement.

The stated quantity is converted to a standard uncertainty by dividing by a factor that
depends on what the statement means:

| What the source states | Assumed density | Divisor | u |
| --- | --- | --- | --- |
| Expanded uncertainty U with coverage factor k | normal | k | U / k |
| 95% confidence interval, no k given | normal | 1.96 | half-width / 1.96 |
| A standard uncertainty | normal | 1 | as stated |
| Limits ±a, any value equally likely | rectangular | sqrt(3) | a / sqrt(3) |
| Limits ±a, centre far more likely | triangular | sqrt(6) | a / sqrt(6) |
| Limits ±a, extremes more likely (sinusoidal drift, cyclic error) | arcsine | sqrt(2) | a / sqrt(2) |

Rectangular is the default when a specification gives limits and says nothing about the
distribution inside them. Digital resolution of one least significant digit d gives
half-width a = d/2, so u = d / (2 sqrt(3)).

The most frequent Type B error is treating a certificate's expanded uncertainty as a
standard uncertainty: it silently doubles the reported interval.

## Law of propagation of uncertainty

For a model Y = f(X_1, ..., X_N) with uncorrelated inputs (JCGM 100:2008 equation 10):

```text
u_c(y)^2 = sum_i ( df/dx_i )^2 * u(x_i)^2
```

with correlated inputs (equation 13):

```text
u_c(y)^2 = sum_i ( df/dx_i )^2 u(x_i)^2
         + 2 * sum_i sum_{j>i} (df/dx_i)(df/dx_j) u(x_i) u(x_j) r(x_i, x_j)
```

The partial derivatives are the **sensitivity coefficients** c_i. They carry units, and
`c_i * u(x_i)` is the contribution of that input expressed in the units of the result.
Comparing contributions, not raw uncertainties, is what tells you where to spend effort.

Correlation is not exotic. It appears whenever two inputs were calibrated against the
same standard, corrected with the same reference value, measured with the same
instrument, or derived from a common fit. Ignoring a positive correlation understates
u_c; ignoring a negative one overstates it. In a difference of two similar quantities
measured the same way, the correlation is the whole point — it is what makes the
difference more precise than either term.

## Degrees of freedom and the coverage factor

k = 2 is a convention, not a law. It corresponds to p ≈ 95% only when the effective
degrees of freedom are large. The Welch-Satterthwaite formula (JCGM 100:2008 G.2b)
gives them:

```text
nu_eff = u_c(y)^4 / sum_i ( (c_i u(x_i))^4 / nu_i )
```

Components evaluated as Type B from a specification are conventionally assigned
infinite degrees of freedom and drop out of the denominator. A single Type A component
from a handful of readings can pull nu_eff low enough that k rises well above 2:

| nu_eff | k for p = 95% |
| --- | --- |
| 2 | 4.30 |
| 5 | 2.57 |
| 10 | 2.23 |
| 20 | 2.09 |
| 50 | 2.01 |
| infinite | 1.96 |

If the dominant component came from five readings, reporting k = 2 understates the
interval by about a quarter. The formula assumes uncorrelated inputs; with correlation
it is an approximation with no established validity.

## When the GUM framework is not applicable

The framework linearizes f about the estimates. That is fine when the model is close to
linear across the input uncertainties, and wrong when it is not. Specifically, it
breaks down when:

- the model is significantly nonlinear over ±2u of an input — squares, reciprocals,
  ratios of comparable quantities, exponentials;
- a single non-normal component dominates, so the output is not approximately normal
  and k from a t-distribution does not deliver the claimed coverage;
- the output distribution is asymmetric, which the symmetric interval y ± U cannot
  represent;
- an input's relative uncertainty is large (above roughly 20-30%), where the second-order
  terms the expansion drops are no longer negligible;
- the model has a bound the interval crosses — a variance, a concentration, or a
  squared quantity whose GUM interval extends below zero.

## Monte Carlo propagation (JCGM 101:2008)

The supplement propagates the input distributions rather than their standard
deviations. The procedure is:

1. assign a probability density to each input, not merely a standard uncertainty;
2. draw M samples from the joint density, respecting any correlation;
3. evaluate the model for each draw;
4. take the mean as the estimate and the standard deviation as u_c;
5. take a coverage interval from the sorted output.

Two intervals are defined and they differ for an asymmetric output. The
**probabilistically symmetric** interval cuts (1-p)/2 from each tail. The **shortest**
interval is the narrowest one containing the fraction p; it is the honest choice when
the output is skewed, and identical to the other when it is not.

M = 10^6 is the usual starting point for a 95% interval; JCGM 101 also defines an
adaptive procedure that keeps drawing until the results are stable to within the
numerical tolerance below. Fewer than 10^4 trials cannot resolve a 95% interval's
endpoints reliably.

## The validation test that decides which answer to report

JCGM 101 clause 8 is the reason to run both methods rather than choosing one. Write u_c
from the GUM framework to n_dig significant digits (1 or 2) as c × 10^L. The numerical
tolerance is half of that last digit:

```text
delta = 0.5 * 10^L
```

Compare the endpoints of the two coverage intervals:

```text
d_low  = | (y - U)      - y_low_MC  |
d_high = | (y + U)      - y_high_MC |
```

If both are at or below delta, the linearization is validated and the GUM framework
result may be reported. If either exceeds delta, the framework is not validated for
this model, and the Monte Carlo result is what should be reported.

`scripts/propagate_uncertainty.py` runs both methods and applies this test. Two
outcomes worth understanding:

**Rectangular inputs, linear model.** A model dominated by rectangular contributions
fails validation even though it is perfectly linear: the true output distribution is
closer to trapezoidal than normal, and k = 1.96 over-covers. The GUM value and u_c are
right; the interval is too wide.

**Nonlinear model.** For y = x^2 with x = 1.0 ± 0.5, the framework gives y = 1.0,
u_c = 1.0, and a 95% interval of [-0.96, 2.96] — an interval that is largely negative
for a squared quantity. Monte Carlo gives a mean of 1.25, u_c = 1.06, and a shortest
95% interval of [0, 3.32]. The framework result is not merely imprecise; it is outside
the range the model can produce.

## Order of operations

1. Write the measurement model explicitly, including every correction, even those whose
   value is zero. A correction with an estimated value of zero still has an uncertainty,
   and leaving it out of the model leaves its uncertainty out of the budget.
2. Assign each input an estimate, a standard uncertainty, a distribution, and degrees of
   freedom.
3. Identify correlations before combining anything.
4. Compute sensitivity coefficients and the budget.
5. Combine, and check the linearization against Monte Carlo.
6. Choose k from nu_eff, not by habit.
7. Round the uncertainty first, then the value (see `reporting-rules.md`).

## Recurring defects

- Reporting a standard deviation of readings as the uncertainty of their mean.
- Dividing a certificate's expanded uncertainty by nothing, or by 2 when the certificate
  states a different k.
- Omitting a correction from the model because its value is negligible, thereby omitting
  its uncertainty too.
- Combining relative and absolute uncertainties without converting.
- Treating resolution and repeatability as independent when the resolution is what
  limits the repeatability — double counting.
- Quoting k = 2 with an effective degrees of freedom below 10.
- Applying the framework to a strongly nonlinear model and never checking.
- Propagating uncertainty through a fitted model without using the fit's covariance
  matrix, which discards the correlation between the fitted parameters.

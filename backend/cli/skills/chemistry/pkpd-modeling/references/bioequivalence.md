# Bioequivalence

## The ICH M13 series

M13 is the first globally harmonised bioequivalence guidance, replacing a patchwork of regional
requirements.

| Guideline | Scope | Status |
| --- | --- | --- |
| **M13A** | BE for immediate-release solid oral dosage forms: study design and data analysis | Step 4 July 2024; came into effect 25 January 2025 |
| **M13B** | Additional strengths, including additional-strength biowaivers | Endorsed 13 March 2025; Step 2b, public consultation opened 9 April 2025, comments closed 9 July 2025 |
| **M13C** | Data analysis for highly variable drugs, narrow therapeutic index drugs, and complex BE study designs | Follows M13B; **this is where reference-scaling will finally be harmonised** |

Until M13C is adopted, reference-scaled approaches remain **regional and mutually incompatible**.
That is the single most important practical fact about scaled BE: FDA and EMA do not accept each
other's method, and a study must be designed for the criterion of the agency it is going to.

## Average bioequivalence

The default criterion everywhere:

> The 90% confidence interval for the geometric mean ratio (test/reference) of AUC and Cmax must
> lie entirely within **80.00% to 125.00%**.

Computed on **log-transformed** data — the interval is symmetric on the log scale and asymmetric
back-transformed, which is why the limits are 0.80 and 1.25 rather than ±20%.

Narrow therapeutic index drugs are tightened to **90.00-111.11%** in several regions, and the FDA
additionally requires a comparison of within-subject variability between test and reference.

## Designs

| Design | Periods | Gives you |
| --- | --- | --- |
| 2×2 crossover (RT/TR) | 2 | Average BE. Cannot estimate within-subject variability of the reference separately |
| Parallel | 1 | For long half-life drugs; much larger N; only total variability |
| Partial replicate (RRT/RTR/TRR) | 3 | CVwR, so reference-scaling becomes possible |
| Full replicate (RTRT/TRTR or RTR/TRT) | 3-4 | CVwR **and** CVwT; required for the FDA NTI approach |
| Williams design | ≥3 treatments | Balanced for first-order carryover |

A crossover removes between-subject variability, which is why it needs far fewer subjects than a
parallel design. It requires an adequate washout — at least 5 terminal half-lives — and pre-dose
concentrations in later periods should be below 5% of Cmax, or the subject is excluded.

## Reference-scaled approaches for highly variable drugs

A highly variable drug is one with CVwR > 30%. Both approaches require a **replicate design**;
neither can be applied to a 2×2 study however high the observed variability, because without
repeated reference administrations there is no CVwR to scale to.

### EMA: average bioequivalence with expanding limits (ABEL)

```
limits = exp(± 0.760 * swR)      capped at CVwR = 50%  ->  69.84% - 143.19%
```

Conditions: replicate design; the widening must be pre-specified in the protocol with clinical
justification; the point estimate must still fall within 80.00-125.00%; and widening is applied to
Cmax (and for some products AUC, though EMA generally does not permit AUC widening).

### FDA: reference-scaled average bioequivalence (RSABE)

Not an interval criterion at all. The criterion is

```
(mu_T - mu_R)^2 - theta^2 * s2wR  <=  0        with theta = ln(1.25)/0.25 = 0.8926
```

evaluated as a **95% upper confidence bound** using Hyslop's linearised method:

```
E  = (Ybar_T - Ybar_R)^2                    Eh = (|Ybar_T - Ybar_R| + t(0.95,df)*SE)^2
H  = -theta^2 * s2wR                        Hh = -theta^2 * s2wR * df / chi2(0.05, df)
upper bound = E + H + sqrt((Eh-E)^2 + (Hh-H)^2)
```

Pass requires the upper bound ≤ 0 **and** the point estimate within 80-125%. Applied when
CVwR ≥ 30%; below that, unscaled ABE applies. `bioequivalence.py --scaling rsabe` implements this.

The two criteria can disagree on the same dataset. Which applies is a regulatory fact, not a
statistical choice, and must be pre-specified.

## Sample size

Driven by three things, in order of influence: the assumed true GMR, the within-subject CV, and the
target power.

Published values for a 2×2 crossover, GMR 0.95, 80% power, 80-125% limits — reproduced exactly by
`bioequivalence.py --power`:

| CVw | N |
| --- | --- |
| 15% | 12 |
| 20% | 20 |
| 25% | 28 |
| 30% | 40 |
| 35% | 52 |
| 40% | 66 |

**Assuming a GMR of 1.00 rather than 0.95 roughly halves the calculated N**, and is the most common
reason a bioequivalence study comes in underpowered. A GMR of exactly 1.00 is not a realistic
planning assumption for two different formulations.

Power must be computed by integrating over the sampling distribution of the estimated standard
deviation (equivalently, Owen's Q). Treating the standard error as known overstates power at these
sample sizes.

## Common errors

1. **Using a t test.** "p > 0.05, therefore the formulations are equivalent" inverts the hypothesis.
   Failing to detect a difference is not evidence of equivalence, and on a small BE dataset that
   outcome is nearly guaranteed. The 90% CI (equivalently, two one-sided tests at α = 0.05) is the
   test.
2. **Analysing untransformed data.** AUC and Cmax are log-normal; the criterion is defined on the
   log scale.
3. **Scaling from a 2×2 design.** Refused by `bioequivalence.py`, and by regulators.
4. **Post hoc scaling.** Deciding to widen limits after seeing high variability is not
   pre-specification.
5. **Dropping subjects after unblinding** for reasons not defined in the protocol.
6. **Reporting only AUC.** Cmax must meet the criterion too, and it is the more variable of the two.
7. **Ignoring the period effect** by analysing as a paired comparison. `bioequivalence.py` labels
   this explicitly when the sequence column is missing.

## Endogenous compounds and other special cases

- **Endogenous substances** (potassium, iron, hormones) require baseline correction, and the
  baseline-correction method changes the answer. Pre-specify it.
- **Long half-life drugs**: AUC(0-72h) is accepted in place of AUC(0-inf) under M13A for immediate
  release products, avoiding a very long sampling schedule.
- **Highly variable Cmax with acceptable AUC** is the usual pattern that pushes a programme towards
  a replicate design.
- **Fed versus fasted**: both usually required; the food effect study is separate from BE.

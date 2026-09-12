# Population PK: estimation, covariates, BLQ, and diagnostics

## The model has three layers, and they are diagnosed separately

```
Structural:   C_ij = f(theta_i, dose_i, t_ij)
Individual:   theta_i = theta_pop * exp(eta_i),   eta_i ~ N(0, Omega)
Residual:     y_ij = C_ij * (1 + eps_prop) + eps_add,   eps ~ N(0, Sigma)
```

Almost every difficult population model problem is a layer confusion: an extra compartment added to
absorb between-occasion variability, a covariate added to fix a misspecified absorption model, a
proportional error inflated to cover a structural bias at low concentrations. Identify the layer
before changing anything.

Exponential (log-normal) inter-individual variability is the default because clearances and volumes
are positive and right-skewed. `omega` is reported as an approximate CV: `CV ≈ sqrt(exp(omega²)−1)`,
which is close to `omega` itself below about 30%.

## Estimation methods

| Method | Character | When |
| --- | --- | --- |
| FO | First-order linearisation about eta = 0 | Obsolete for final models; biased with large IIV. Still useful for initial estimates |
| FOCE | Linearises about the individual eta | The workhorse |
| FOCE-I (`INTERACTION`) | FOCE with eta-epsilon interaction | **Required whenever the residual error is proportional or combined.** Omitting `INTERACTION` with a proportional error model is a common and consequential mistake |
| Laplace | Second-order expansion | Needed for non-continuous data (categorical, count, time-to-event) and for `LIKELIHOOD`/`-2LL` models |
| SAEM | Stochastic approximation EM | Robust to poor initial estimates and to complex models; less prone to local minima; does not itself give an objective function for comparison — follow with an IMP evaluation |
| Importance sampling (IMP) | Monte Carlo integration | Accurate objective function; usually run after SAEM |
| MCMC / NUTS | Full Bayesian | NONMEM 7.6 adds NUTS; also Stan, Torsten, nlmixr2 |

Compare objective functions only between models fitted with the **same** method on the **same**
records. An OFV drop obtained by switching from FOCE to IMP is not evidence about the model.

## Below the limit of quantification

Beal's methods, and what they actually do:

| Method | Treatment | Verdict |
| --- | --- | --- |
| M1 | Discard all BLQ observations | Biased upward whenever a meaningful fraction is BLQ; acceptable only when that fraction is small |
| M2 | Discard BLQ, condition the likelihood on being above LLOQ | Better than M1, rarely used |
| M3 | **Maximum likelihood: BLQ contributes the probability that the observation is below LLOQ** | The reference method. Needs `F_FLAG=1` and the Laplace method |
| M4 | M3 conditioned on the concentration being positive | Marginal improvement over M3 |
| M5 | Substitute LLOQ/2 | Biased; still common; at least state it |
| M6 | Substitute LLOQ/2 for the first BLQ in a run, discard the rest | Ad hoc |
| M7 | Substitute 0 | Worst; badly biases the terminal phase |

Rule of thumb: below roughly 10% BLQ, M1 is defensible; above that, use M3. The bias from M1 falls
on the terminal phase, so it propagates directly into half-life, Vz and accumulation predictions.

## Covariate model building

Order of operations that avoids the usual traps:

1. **Get the structural and variability models right first.** A covariate added to a misspecified
   structural model can absorb the misspecification and look significant.
2. **Include size and maturation on mechanistic grounds, not on statistical ones.** Allometric
   weight scaling on clearance and volume is a prior, not a hypothesis to test. Fixing the
   exponents at 0.75/1.0 is standard and usually preferable to estimating them.
3. **Screen on eta-covariate plots**, not on the objective function, to generate candidates.
4. **Forward inclusion at p < 0.05 (ΔOFV > 3.84, 1 df), backward elimination at p < 0.001
   (ΔOFV > 10.83).** The asymmetry exists because forward selection on the same data inflates the
   false-positive rate.
5. Prefer full-model or full random-effects approaches when the goal is to *quantify* a covariate
   effect and its uncertainty rather than to *select* covariates. Stepwise selection produces
   biased effect sizes (selection bias towards large effects) and confidence intervals that are too
   narrow.

The likelihood-ratio test relies on the ΔOFV being chi-square distributed, which is only
approximately true, and is **not** true on the boundary — testing whether a variance component is
zero puts the null on the edge of the parameter space, and the nominal p-value is conservative.

Correlated covariates (weight and BMI; age and renal function) cannot both be included informatively.
Collinearity shows up as an inflated condition number and unstable estimates rather than as a
failure.

## Diagnostics

**Goodness-of-fit plots.** DV vs PRED and DV vs IPRED; CWRES vs time and vs PRED; |IWRES| vs IPRED.
Use CWRES, not WRES — WRES is computed under the FO approximation and is misleading for a
FOCE-estimated model. Trends in CWRES against time indicate structural misspecification; a fan
shape against PRED indicates the residual error model.

**Shrinkage.** `eta shrinkage = 1 − SD(eta_i)/omega`. Above roughly 20-30%, individual estimates
have collapsed towards the population mean, and:

- eta-covariate plots become uninformative and can show spurious relationships;
- IPRED-based diagnostics look artificially good, because IPRED is being pulled towards the data;
- individual parameter estimates should not be used for secondary analysis.

Epsilon shrinkage above ~30% makes IWRES-based diagnostics unreliable for the same reason. **FDA's
2022 population pharmacokinetics guidance states that model selection based on shrinkage is not
necessary** — shrinkage is a caveat on how you may interpret diagnostics, not a selection criterion.

**Visual predictive check.** Simulate many replicates of the study design; plot observed percentiles
against the simulated prediction intervals for those percentiles. Use **prediction-corrected VPC**
whenever doses or covariates differ across subjects, otherwise the between-subject spread in
predictions swamps the comparison. A VPC evaluates the whole model — structural, variability and
residual — and is the single most informative diagnostic.

**NPDE** are the recommended numerical counterpart: decorrelated, and should be N(0,1) under a
correct model. Test mean, variance, and normality, and plot against time and predictions.

**Parameter uncertainty.** The `$COVARIANCE` sandwich estimator is standard but fails on
overparameterised models. Alternatives: nonparametric bootstrap (expensive; also fails when the
model is unstable, which is informative in itself), log-likelihood profiling (best for a single
poorly determined parameter), and sampling importance resampling (SIR), which is much cheaper than
bootstrap and works when the covariance step fails.

**Condition number** — the ratio of largest to smallest eigenvalue of the correlation matrix of the
estimates. Above about 1000 indicates ill-conditioning and unreliable standard errors.
`fit_compartmental.py` reports this quantity using the same definition, so the familiar threshold
applies.

## Model evaluation checklist

- Minimisation successful, and the covariance step completed
- Parameter RSEs: fixed effects below ~30%, variance components below ~50%
- No parameter at a bound
- Condition number below 1000
- Eta shrinkage below 30% for any eta used in a covariate plot
- CWRES without trend against time or PRED
- pcVPC with observed percentiles inside the simulated intervals
- The model reproduces the quantity the analysis exists to predict — not just the observations

## What a population analysis has to report

FDA's 2022 guidance expects the analysis plan to be prospective and the report to state: the data
(including exclusions and how BLQ was handled), the structural and statistical models with
justification, the covariate strategy defined *before* analysis, the estimation method and software
version, the diagnostics, and the model's intended use. Deviations from the plan are documented,
not silently absorbed.

# Pharmacodynamics and exposure-response

## Direct effect models

```
Linear          E = E0 + S*C
Log-linear      E = E0 + S*ln(C)                 no plateau; only valid over a narrow range
Emax            E = E0 + Emax*C/(EC50 + C)
Sigmoid Emax    E = E0 + Emax*C^h/(EC50^h + C^h)
Inhibitory      E = E0 * (1 - Imax*C^h/(IC50^h + C^h))
```

The Hill coefficient `h` controls steepness. `h = 1` is simple hyperbolic binding; `h > 1` implies
cooperativity or an amplification step; `h` between 2 and 4 is common for a downstream clinical
endpoint even when the receptor binding itself is 1:1.

**The single most important diagnostic is how far up the curve the data reach.** If the highest
observed exposure produces less than half of the estimated Emax:

- Emax and EC50 are extrapolations, not estimates;
- they are strongly correlated with each other — the data determine their *ratio* (the slope of the
  low-concentration limb, `Emax/EC50`) but not either one;
- a "linear exposure-response" is that same limb. Linear and Emax are not competing models; linear
  is the limit of Emax below EC50.

`exposure_response.py --emax` reports `fraction_of_emax_reached` and raises a finding below 0.5.
When you are in this regime, report the slope, not Emax and EC50.

`Imax` is bounded by 1 for a model that can achieve complete inhibition; estimating `Imax > 1` means
the model is being used outside its structure.

## Indirect response models (Dayneka & Jusko)

Response `R` has its own turnover: production `kin`, first-order loss `kout`, baseline
`R0 = kin/kout`. The drug perturbs one of the two.

| Type | Equation | Drug acts on | Example |
| --- | --- | --- | --- |
| I | `dR/dt = kin*(1 - I) - kout*R` | Inhibits production | Statins on cholesterol synthesis |
| II | `dR/dt = kin - kout*(1 - I)*R` | Inhibits loss | Diuretic effects on sodium |
| III | `dR/dt = kin*(1 + S) - kout*R` | Stimulates production | Erythropoietin on reticulocytes |
| IV | `dR/dt = kin - kout*(1 + S)*R` | Stimulates loss | |

where `I = Imax*C^h/(IC50^h + C^h)` and `S = Emax*C^h/(EC50^h + C^h)`.

Key properties that distinguish IDR from a direct model with an effect compartment:

- **The delay is dose-dependent.** Higher doses reach maximum effect sooner. An effect compartment's
  `ke0` gives a delay that does not change with dose. This is the cleanest way to tell them apart,
  and it requires more than one dose level to see.
- **Return to baseline is governed by `kout`**, not by the drug's half-life. A drug can be
  eliminated completely while the biomarker takes days to recover.
- `kin` and `kout` are not both identifiable from a single-dose experiment with an observed
  baseline: the baseline gives you their ratio, and only the time course of recovery gives you
  `kout` separately.

## Effect compartment (Sheiner link model)

```
dCe/dt = ke0 * (C - Ce),      E = f(Ce)
```

A hypothetical compartment with no mass that collapses counter-clockwise hysteresis. `ke0` sets the
equilibration half-life, `ln(2)/ke0`. Use it when the hysteresis is a distribution delay
(anaesthetics, neuromuscular blockers). Use IDR when the delay is turnover of the measured
response.

`_models.effect_compartment()` solves each interval exactly under a linear interpolation of plasma
concentration, so the result does not depend on grid density; the usual explicit-Euler
implementation understates Ce peaks on sparse grids.

## Tolerance and rebound

- **Counter-regulation**: a second, slower indirect response opposing the first. Produces tolerance
  during dosing and rebound above baseline afterwards.
- **Precursor pool**: a depletable pool feeding the response, giving tolerance that recovers only
  as the pool refills.
- **Down-regulation of receptors**: an effect compartment whose Emax declines with cumulative
  exposure.

If the response drifts back towards baseline during constant exposure, no direct or simple IDR
model will fit, and adding compartments to the PK will not help.

## Disease progression

For a chronic endpoint the placebo/natural-history trajectory must be modelled, or the drug effect
absorbs it:

```
Linear progression      S(t) = S0 + alpha*t
Asymptotic              S(t) = S_ss + (S0 - S_ss)*exp(-k*t)
```

with the drug entering as **symptomatic** (an offset that disappears on withdrawal) or
**disease-modifying** (a change in `alpha` that persists). Distinguishing these requires a
randomised-withdrawal or delayed-start design; no amount of modelling of a parallel-group trial
will separate them.

## Exposure-response analysis for dose selection

The three metrics, and when each is the right one:

| Metric | Right for |
| --- | --- |
| AUC or Cavg | Effects driven by total exposure over time |
| Cmax | Concentration-driven toxicity; some cardiovascular effects |
| Cmin / Ctrough | Effects requiring continuous target coverage; antivirals, antibiotics |

Choose on mechanism before fitting, not by comparing fits. The three are highly correlated within a
single regimen, so the data will rarely discriminate; different regimens (same daily dose, different
interval) are what separate them.

**The confounding problem.** Patients are randomised to dose, not to exposure. Within a dose group,
exposure varies because of clearance, and clearance varies with the same factors that drive outcome
— renal function, hepatic function, albumin, body size, inflammatory status, disease severity. In
oncology this produces a well-documented artefact: an apparent efficacy benefit of higher exposure
that is partly a marker of better baseline health. Mitigations: include the confounders as
covariates in the E-R model, use case-matching, or compare across randomised dose groups rather
than across exposure quantiles.

**Safety and efficacy E-R must both be modelled.** A dose optimal for efficacy alone is not
optimal. FDA's Project Optimus dose-optimisation guidance (final, August 2024) makes this explicit
for oncology: identify a dosage that maximises benefit-risk rather than the maximum tolerated dose,
support it with PK/PD and exposure-response, and use randomised comparison of more than one dosage.
The PK sampling and analysis plan should be in each protocol and sufficient to support population
PK and dose/exposure-response analyses.

## Concentration-QTc

The framework in ICH E14 and its Q&A documents, and ICH S7B:

- The threshold of regulatory concern is an effect on QTc **above 10 ms**, judged by the **upper
  bound of the two-sided 90% confidence interval** of placebo-corrected change from baseline
  (ΔΔQTc) at the clinically relevant exposure.
- A prospective C-QTc analysis on Phase I data can substitute for a dedicated thorough QT study.
  This is now the routine path rather than the exception.
- The 2022 E14/S7B Q&A additions allow an integrated nonclinical risk assessment — a
  "double negative" of a negative hERG assay and a negative in vivo QTc study — as supplementary
  evidence, which relaxes the requirement to attain a high multiple of clinical exposure.
- Correction method matters: **QTcF** (Fridericia) is standard; QTcB (Bazett) over-corrects at high
  heart rates and should not be the primary method. A study-specific correction is preferred when
  heart rate changes substantially.
- The regulatory-grade model is a **linear mixed-effects** model with random intercept and slope per
  subject and a treatment-specific intercept, on time-matched ΔQTc against concentration. The
  linear model in `exposure_response.py --cqtc` is for screening only.

Check the model assumption of linearity and of a zero intercept: a non-zero intercept suggests the
placebo correction or the baseline is wrong, and a nonlinear concentration-effect relationship
invalidates the extrapolation to supratherapeutic exposure.

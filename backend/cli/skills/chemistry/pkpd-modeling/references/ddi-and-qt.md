# Drug interactions (ICH M12) and QT assessment (ICH E14/S7B)

## ICH M12 status

The first globally harmonised guidance on pharmacokinetic drug interactions mediated by metabolic
enzymes and transporters. Step 4 in 2024, then:

| Region | Adoption |
| --- | --- |
| FDA | Adopted 2 August 2024, with an accompanying *M12 Drug Interaction Studies: Questions & Answers* |
| EMA / EU | Effective 30 November 2024 |
| NMPA (China) | Implemented 29 October 2024 |

It replaces the previous FDA in vitro and clinical DDI guidances and EMA's DDI guideline as the
operative framework.

## The stepwise, risk-based approach

1. **In vitro characterisation** — is the drug a substrate, inhibitor or inducer of the major
   enzymes and transporters?
2. **Basic models** with conservative cut-offs — do the in vitro data rule the interaction out?
3. **Mechanistic static or PBPK modelling** — refine a positive basic-model signal.
4. **Clinical study** — where modelling cannot rule it out or the interaction is decision-relevant.
5. **Labelling** — dose adjustment, contraindication, or monitoring.

The basic models are deliberately conservative: they are built to over-predict, so a **negative
result is meaningful** and a positive one is a trigger for further work, never an estimate of
clinical magnitude.

## Basic model cut-offs

| Mechanism | Model | Cut-off |
| --- | --- | --- |
| Reversible inhibition, hepatic | `R1 = 1 + Imax,u / Ki` | R1 ≥ 1.02 |
| Reversible inhibition, intestinal (CYP3A4) | `R1,gut = 1 + Igut / Ki`, `Igut = dose / 250 mL` | R1,gut ≥ 11 |
| Time-dependent inhibition | `R2 = (kobs + kdeg) / kdeg`, `kobs = kinact·I / (KI + I)` at 50 × Imax,u | R2 ≥ 1.25 |
| Induction (basic) | `R3 = 1 / (1 + d·Emax·I / (EC50 + I))` at 10 × Imax,u | R3 ≤ 0.80 |
| Hepatic uptake transporters (OATP1B1/1B3) | `1 + fu·Iin,max / Ki,u` | ≥ 1.1 |
| Intestinal transporters (P-gp, BCRP) | `Igut / IC50` | ≥ 10 |
| Renal transporters (OAT, OCT, MATE) | `Imax,u / Ki` | ≥ 0.1 |

The hepatic inlet concentration for uptake transporters is

```
Iu,inlet,max = fu * (Imax + Fa*Fg*ka*Dose / (Qh * RB))
```

which is higher than systemic Imax and is what the liver actually sees during absorption.

An alternative induction assessment is the **correlation / relative induction score** approach,
calibrated against known inducers, which is less conservative than the basic R3 model.

## Mechanistic static model

```
AUCR = 1 / (Ag·Bg·Cg·(1 - Fg) + Fg)  ×  1 / (Ah·Bh·Ch·fm + (1 - fm))
```

with, at each site,

```
A = 1 / (1 + I/Ki)                                    reversible inhibition
B = kdeg / (kdeg + kinact·I/(KI + I))                 time-dependent inhibition
C = 1 + d·Emax·I/(EC50 + I)                           induction
```

**`fm` and `Fg` dominate the result.** The ceiling on any inhibition of a single pathway is
`1/(1 - fm)`: with `fm = 0.9` no inhibitor can raise AUC more than 10-fold, and with `fm = 0.7`, no
more than 3.3-fold. These two fractions are usually the least well established inputs, and a
sensitivity analysis across their plausible range is more informative than the point prediction.
`ddi_static.py --msm` prints the ceiling alongside the prediction.

## Perpetrator classification

| Class | AUC ratio |
| --- | --- |
| Strong inhibitor | ≥ 5 |
| Moderate inhibitor | ≥ 2 and < 5 |
| Weak inhibitor | ≥ 1.25 and < 2 |
| No relevant effect | > 0.8 and < 1.25 |
| Weak inducer | > 0.5 and ≤ 0.8 |
| Moderate inducer | > 0.2 and ≤ 0.5 |
| Strong inducer | ≤ 0.2 |

## Clinical study design points

- Use **index perpetrators** (itraconazole or clarithromycin for strong CYP3A4 inhibition,
  rifampicin for strong induction, and the corresponding index substrates) so the result is
  interpretable against the classification bands.
- Worst-case first: a study with a strong index perpetrator that shows no interaction removes the
  need for weaker ones.
- Induction requires **multiple-dose** administration of the perpetrator; a single dose can even
  show inhibition from the same compound.
- Timing matters for time-dependent inhibition and for induction, both of which take days to
  develop and days to reverse.
- A **cocktail study** can assess several pathways at once, provided the probes are validated as
  non-interacting.

---

# QT assessment: ICH E14 and S7B

## The framework

- The threshold of regulatory concern is a **QTc effect above 10 ms**, assessed as the **upper bound
  of the two-sided 90% confidence interval** for placebo-corrected change-from-baseline QTc (ΔΔQTc)
  at the clinically relevant high exposure.
- A prospective **concentration-QTc analysis** on Phase I data can substitute for a dedicated
  thorough QT study, and this is now the routine path.
- The **2022 E14/S7B Q&As** introduced the "double negative" integrated nonclinical risk
  assessment — a negative hERG assay plus a negative in vivo QTc study — as supplementary evidence.
  This allows a submission to cover high clinical exposure without attaining a high multiple of
  clinically relevant exposure, and its uptake in FDA reviews rose sharply after 2022.

## Getting a C-QTc analysis right

- **Correction method**: QTcF (Fridericia) is the standard. QTcB (Bazett) over-corrects at high
  heart rates and should not be primary. Where heart rate changes materially with treatment, a
  study-specific or individual correction is preferable.
- **Model**: linear mixed effects on time-matched ΔQTc against plasma concentration, with a random
  intercept and slope per subject and a treatment-specific intercept. Assess the intercept — a
  non-zero one suggests the baseline or the placebo correction is wrong.
- **Linearity**: the extrapolation to supratherapeutic exposure depends on it. Check for curvature,
  and check that the highest observed concentrations actually cover the exposure of interest.
- **Hysteresis**: if the QTc effect lags concentration, a direct model is misspecified and an effect
  compartment is needed. Plot ΔQTc against concentration coloured by time to see it.
- Sample size is driven by the number of subjects **and** the spread of concentrations achieved;
  a study where everyone has similar exposure estimates the slope poorly regardless of N.

`exposure_response.py --cqtc` implements the ordinary linear version for screening and flags
extrapolation beyond the observed concentration range. It is not a substitute for the mixed model
in a submission.

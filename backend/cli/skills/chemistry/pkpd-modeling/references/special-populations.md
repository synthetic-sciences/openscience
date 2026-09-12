# Special populations

## Paediatrics

### Size and maturation are separate

Body size alone explains paediatric clearance well from roughly 2 years upward. Below that, enzyme
and renal maturation dominate, and size-only scaling **overpredicts clearance — in a neonate by
several fold**.

```
CL_child = CL_adult * (WT/70)^0.75 * MF
MF = PMA^Hill / (TM50^Hill + PMA^Hill)              Anderson & Holford
```

Generic clearance values: `TM50 ≈ 54.2 weeks` post-menstrual age, `Hill ≈ 3.92`. Drug-specific
ontogeny is much better where it exists, because individual enzymes mature on very different
schedules.

**Use post-menstrual age (gestational + postnatal), not postnatal age.** A 4-week-old born at 28
weeks and a 4-week-old born at term have very different eliminating capacity.

Enzyme ontogeny, in outline:

| Enzyme | Maturation |
| --- | --- |
| CYP3A7 | High at birth, declines over the first year |
| CYP3A4 | Low at birth, adult levels by ~1 year |
| CYP2D6 | Reaches adult activity within weeks; genotype dominates thereafter |
| CYP1A2 | Slow; adult levels around 4-5 months, and caffeine clearance in neonates is very low |
| UGT2B7, UGT1A1 | Slow; morphine and bilirubin conjugation are limited in neonates |
| Renal (GFR) | ~30% of adult (per surface area) at term birth; adult by 6-12 months |

### ICH E11A pediatric extrapolation

Step 4 adopted **21 August 2024**, effective **25 January 2025**. It formalises a framework for
using adult (or other-population) data to support paediatric conclusions:

- Build a **pediatric extrapolation concept** from the similarity of disease, response to
  treatment, and exposure-response between the source and target populations.
- Quantify the assumptions and the residual uncertainty; the amount of new paediatric data required
  scales inversely with confidence in the extrapolation.
- Where exposure matching is the basis, the standard applies the 90% CI to 80-125% bounds for AUC
  and Cmax — but a model-informed approach using dose-response or exposure-response parameters
  (Emax, EC50, slope) within acceptable limits is an accepted alternative.
- Modelling and simulation, including popPK and PBPK, are central rather than supportive.

The practical consequence: paediatric dose selection is expected to be model-informed, with a
prospective plan, not a mg/kg extrapolation from the adult label.

### Other paediatric points

- Volume of distribution per kg is **higher** in neonates (greater total body water), so a loading
  dose per kg is often larger while maintenance is smaller.
- Protein binding is lower in neonates (less albumin, less alpha-1-acid glycoprotein, and
  competition from bilirubin), raising the unbound fraction.
- Oral absorption differs: higher gastric pH, slower gastric emptying, immature biliary function.

## Renal impairment

Classified by eGFR (mL/min/1.73 m²): normal ≥ 90, mild 60-89, moderate 30-59, severe 15-29, kidney
failure < 15.

- The relevant question is not only whether the **parent** drug is renally cleared, but whether an
  **active or toxic metabolite** is. Morphine-6-glucuronide accumulating in renal failure is the
  standard example.
- Renal impairment also reduces some **non-renal** clearance pathways — uraemic toxins inhibit
  CYP and transporter activity — so a low `fe` does not guarantee no effect.
- Protein binding falls in uraemia for acidic drugs, raising unbound fraction; total concentrations
  then understate the change in unbound exposure.
- **Dialysis is a separate question** with its own study: whether the drug is removed depends on
  molecular size, protein binding and volume of distribution, and the dosing implication is about
  timing relative to the session as much as about dose.
- Cockcroft-Gault (creatinine clearance) versus CKD-EPI (eGFR, normalised to 1.73 m²) matters. For
  dosing, de-normalise eGFR to the individual's body surface area; using a normalised eGFR as if it
  were an individual clearance misdoses people at the extremes of size.

## Hepatic impairment

Child-Pugh A/B/C is the conventional classification, though it is a crude proxy for drug-metabolic
capacity and correlates poorly with any specific enzyme.

- Effects include reduced enzyme content, reduced hepatic blood flow, portosystemic shunting
  (raising oral bioavailability of high-extraction drugs sharply), reduced albumin, and altered
  transporter expression.
- For a **high-extraction** drug given orally, the dominant effect is loss of first-pass
  extraction, and exposure can rise many-fold — much more than clearance alone would suggest.
- Reduced albumin raises the unbound fraction; for a low-extraction, highly bound drug the unbound
  concentration may be nearly unchanged while total concentration falls. Interpreting total
  concentrations alone gives the wrong dose adjustment.

## Obesity

Which size descriptor to scale by depends on the parameter and the drug:

| Descriptor | Use |
| --- | --- |
| Total body weight | Volume of distribution for lipophilic drugs |
| Lean body weight | Clearance, most of the time; the best general-purpose descriptor |
| Fat-free mass + a fraction of fat mass ("normal fat mass") | Where lean weight under-predicts |
| Body surface area | Conventional in oncology; poorly justified for most agents |
| Ideal body weight | Older convention, largely superseded |

Fixed allometric exponents derived across species do not automatically apply within a species
across the obesity range. Fitting the descriptor and letting the data choose is legitimate here.

## Pregnancy

Physiological changes across gestation are large and progressive: plasma volume up ~50%, GFR up
~50%, albumin down, CYP3A4 and CYP2D6 induced, CYP1A2 and CYP2C19 inhibited. A single "pregnancy"
covariate is inadequate — the effect is gestational-age dependent. PBPK with a pregnancy population
model is the usual approach, since dedicated PK studies in pregnancy are rare.

## Geriatric

Age effects are mostly mediated: declining renal function, reduced hepatic blood flow and mass,
changed body composition (less water, more fat), lower albumin. **Include the mediators as
covariates rather than age itself** where possible — a model with age standing in for renal
function will mispredict a fit 80-year-old and a frail 60-year-old in opposite directions.

## Organ impairment study design

Both regulators accept a reduced ("staged") design: study severe impairment first, and if exposure
is unchanged, the intermediate categories can often be waived. A full design covers each category
against matched controls. Match on age, weight and sex; unmatched controls are the usual reason an
organ-impairment study is uninterpretable.

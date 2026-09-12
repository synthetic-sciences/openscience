# Antimicrobial PK/PD and therapeutic drug monitoring

## PK/PD indices

Antimicrobial efficacy correlates with one of three exposure indices, determined by whether killing
is concentration-dependent or time-dependent. The index is a property of the drug class, and using
the wrong one leads to the wrong dosing strategy.

| Index | Killing pattern | Classes | Dosing strategy |
| --- | --- | --- | --- |
| **fT>MIC** — fraction of the interval with free concentration above MIC | Time-dependent, minimal persistent effect | Beta-lactams (penicillins, cephalosporins, carbapenems) | More frequent dosing, or extended/continuous infusion |
| **fAUC/MIC** | Time-dependent with persistent effect | Vancomycin, fluoroquinolones, linezolid, azithromycin, tetracyclines | Total daily dose matters; interval matters less |
| **fCmax/MIC** | Concentration-dependent | Aminoglycosides, daptomycin, colistin, metronidazole | Once-daily, high peak |

Targets commonly cited from preclinical and clinical work — targets, not regulation, and they vary
by organism and endpoint:

| Drug or class | Target |
| --- | --- |
| Penicillins | fT>MIC ≥ 50% (stasis to 1-log kill) |
| Cephalosporins | fT>MIC ≥ 60-70% |
| Carbapenems | fT>MIC ≥ 40% |
| Vancomycin | **AUC₂₄/MIC 400-600** (MIC = 1 mg/L by broth microdilution) |
| Fluoroquinolones | fAUC/MIC ≥ 100-125 for Gram-negatives; ≥ 30-40 for *S. pneumoniae* |
| Aminoglycosides | Cmax/MIC ≥ 8-10 |
| Daptomycin | fAUC/MIC ~ 666 (*S. aureus*) |
| Linezolid | fAUC/MIC 80-120 |

**The free (unbound) fraction is what matters.** For a highly bound agent such as ceftriaxone or
daptomycin, total concentrations overstate the active exposure substantially.

## Probability of target attainment and cumulative fraction of response

- **PTA** — for a *fixed* MIC, the fraction of a simulated population reaching the PK/PD target at
  a given regimen. Plotted against MIC, the PTA curve gives the **PK/PD breakpoint**: the highest
  MIC at which the regimen achieves (conventionally) ≥ 90% attainment.
- **CFR** — PTA integrated over the MIC distribution of the actual pathogen population, giving a
  single expected success probability for empirical therapy against that organism.

Both need a population PK model with realistic variability. `simulate_regimen.py --simulate` with
`--target-auc` or `--target-trough` gives the machinery; note it includes between-subject
variability only, so real attainment is lower once residual and between-occasion variability are
added.

Critically ill patients are the population where this matters most and where standard models fail:
augmented renal clearance (creatinine clearance above 130 mL/min, common in young trauma and
sepsis patients) can put a standard beta-lactam regimen well below target, while acute kidney
injury and renal replacement therapy move it the other way.

## Vancomycin: AUC-guided dosing

The 2020 consensus guideline (ASHP/IDSA/PIDS/SIDP) moved the target from trough-guided to
**AUC₂₄/MIC of 400-600**, assuming an MIC of 1 mg/L, for serious MRSA infections.

Why troughs were abandoned: trough concentration is a poor surrogate for AUC. Achieving the
historical 15-20 mg/L trough target frequently produces AUC₂₄ well above 600 and is associated with
more nephrotoxicity, without better efficacy. Two patients with the same trough can have AUCs
differing by 50% depending on their volume and interval.

Two accepted methods for estimating AUC:

1. **Bayesian estimation** from one or two levels against a population model. Works with a single
   level, tolerates levels drawn at imprecise times, and is the preferred approach.
2. **First-order equations** from a peak and a trough within the same interval, both drawn at
   steady state, with the peak at least 1-2 hours after the end of the infusion so that
   distribution is complete.

`tdm_bayes.py --model vancomycin-adult` implements method 1. Its bundled parameterisation is
explicitly illustrative — substitute a model validated in your population, because vancomycin
population models differ substantially between general ward, ICU, obese, paediatric and dialysis
populations.

## Model-informed precision dosing

MAP Bayesian forecasting combines a population prior with a patient's measured concentrations:

```
minimise   sum_j (obs_j - pred_j)^2 / var_j  +  sum_k (eta_k / omega_k)^2
```

The second term is the prior penalty. Its consequences:

- **A single level is enough to be useful** but cannot separate clearance from volume. Whichever
  parameter the sample is uninformative about returns essentially its population value; the
  reported "individual" estimate for it is the prior.
- **Sample timing determines what is learned.** Troughs are informative about clearance; a peak
  (after distribution) is informative about volume. All-trough sampling leaves volume weakly
  identified.
- **A large eta is a data-quality signal first.** An individual clearance three-fold the population
  value is more often a mis-recorded sampling or infusion time than a genuinely unusual patient.
  Check the times before acting on the estimate.
- The prior must be **appropriate to the patient**. A model built in general medical inpatients
  applied to a patient on continuous renal replacement therapy will shrink towards the wrong place,
  and the fit statistics will not reveal it.

Other drug classes where MIPD is established: aminoglycosides, busulfan (AUC-targeted
conditioning), methotrexate rescue, immunosuppressants (tacrolimus, ciclosporin, mycophenolate),
antiepileptics, infliximab and other anti-TNF biologics, and increasingly beta-lactams in
critical care.

## Reporting a TDM calculation

State the population model and its source, the assay and matrix, the actual (not scheduled) dose
and sampling times, whether steady state was reached, the estimated individual parameters with the
etas, the predicted exposure metric, and the target with its justification. Without the actual
times, the calculation cannot be reproduced or audited.

Any change to a patient's regimen is a clinical decision that depends on the organism, the site of
infection, renal trajectory, concomitant nephrotoxins and local protocol. The model provides an
exposure estimate; it does not provide the decision.

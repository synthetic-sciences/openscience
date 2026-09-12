# Regulatory guidance for PK/PD analyses

Status verified 2026-07-27. ICH guidelines are published openly and their requirements are
summarised directly; always work from the authoritative copy for a submission.

## ICH

| Guideline | Subject | Status |
| --- | --- | --- |
| **M12** | Drug interaction studies | Step 4 in 2024. FDA adopted **2 August 2024** with a Questions & Answers document; effective in the **EU 30 November 2024**; **China 29 October 2024**. First harmonised DDI guidance |
| **M13A** | Bioequivalence for immediate-release solid oral dosage forms | Step 4 **July 2024**, effective **25 January 2025** |
| **M13B** | Additional strengths and additional-strength biowaivers | Endorsed **13 March 2025**, Step 2b; consultation **9 April – 9 July 2025** |
| **M13C** | BE data analysis for highly variable drugs, narrow therapeutic index drugs, and complex designs | Begins after M13B reaches Step 2. **Reference-scaling remains regional until this lands** |
| **E11A** | Pediatric extrapolation | Step 4 **21 August 2024**, effective **25 January 2025** |
| **M10** | Bioanalytical method validation | The assay behind every concentration; see the `analytical-method-validation` skill |
| **E14** | Clinical evaluation of QT/QTc prolongation | With Q&A revisions; the **2022 Q&As** added the double-negative nonclinical pathway |
| **S7B** | Nonclinical evaluation of QT prolongation | Paired with E14 through the joint Q&As |
| **E4** | Dose-response information to support registration | Foundational for exposure-response |
| **E7** | Studies in support of special populations: geriatrics | |

## FDA

| Guidance | Date | What it requires that gets missed |
| --- | --- | --- |
| **Population Pharmacokinetics** | Final, **February 2022** | A prospective analysis plan; explicit BLQ handling; simulation-based diagnostics (VPC, pcVPC, NPC, NPDE). Notably states that **model selection based on parameter shrinkage is not necessary** |
| **Optimizing the Dosage of Human Prescription Drugs and Biological Products for the Treatment of Oncologic Diseases** (Project Optimus) | Final, **August 2024** | Identify a dosage maximising benefit-risk rather than the MTD; compare more than one dosage, randomised; a PK sampling and analysis plan in **each** protocol, sufficient for population PK and dose/exposure-response for safety and efficacy; early evaluation of intrinsic factors and DDIs |
| **Exposure-Response Relationships** | 2003 | Still the reference for E-R study design and analysis |
| **Estimating the Maximum Safe Starting Dose in Initial Clinical Trials for Therapeutics in Adult Healthy Volunteers** | 2005 | The body-surface-area HED conversion table (Km factors) used by `allometry_and_fih.py` |
| **Physiologically Based Pharmacokinetic Analyses — Format and Content** | 2018 | What a PBPK submission must contain |
| **Clinical Pharmacology Considerations for Human Radiolabeled Mass Balance Studies** | | |
| Renal and hepatic impairment guidances | | Study design, including the reduced/staged design |

## EMA

| Guideline | Subject |
| --- | --- |
| Reporting the results of population pharmacokinetic analyses (EMA/CHMP/EWP/185990/2006) | Structure and content of a popPK report |
| Investigation of bioequivalence | Being superseded in scope by ICH M13A; EMA has published implementation considerations |
| Use of PBPK modelling and simulation | Qualification and reporting of PBPK |
| Reporting of physiologically based pharmacokinetic modelling and simulation | |
| Evaluation of anticancer medicinal products | Dose optimisation expectations parallel to Project Optimus |

## What each analysis type has to state

**Non-compartmental analysis.** Trapezoidal rule; BLQ rule at leading, embedded and trailing
positions; the lambda_z selection rule with the window and point count per subject; whether AUCinf
is observed- or predicted-based; exclusion criteria fixed before unblinding; software and version.

**Population PK.** A prospective analysis plan. Data assembly with exclusions and BLQ handling.
Structural, statistical and covariate models with justification. Estimation method and software
version. Diagnostics including a pcVPC. Parameter estimates with uncertainty. The model's intended
use, and its qualification for that use. Deviations from the plan documented rather than absorbed.

**Exposure-response.** The exposure metric and why it is the mechanistically right one. Both
efficacy and safety relationships. Explicit treatment of confounding between exposure and
prognosis. The dose or exposure range covered by the data, and what is extrapolation.

**Bioequivalence.** Design and justification; log-transformed analysis; the 90% CI against
pre-specified limits; the criterion (ABE, ABEL or RSABE) fixed in the protocol; the handling of
dropouts and pre-dose concentrations; sample-size justification with its assumed GMR and CV.

**PBPK.** Platform and version; every drug parameter with its source and whether it was measured,
predicted or optimised; the Kp prediction method; verification against observed clinical data before
the untested application; sensitivity analysis on uncertain inputs; the model files.

**DDI.** The stepwise assessment with the basic-model results and cut-offs; what triggered further
work; the mechanistic static or PBPK refinement with its verification; the clinical studies with
index perpetrators and substrates; the labelling conclusion.

## Model-informed drug development

Both FDA and EMA operate programmes for discussing model-based evidence before submission — FDA's
MIDD Paired Meeting Program and EMA's Qualification of Novel Methodologies. Where a model is
intended to *replace* a study rather than support one, engaging early is what determines whether the
model is accepted. The level of rigour expected scales with what the model is being asked to carry.

## The general principle

Regulators evaluate a model against its **intended use**, not in the abstract. A model adequate for
choosing a Phase II dose is not automatically adequate for waiving a paediatric study or supporting
a labelling claim. State the intended use first; the required evidence, verification and
documentation follow from it.

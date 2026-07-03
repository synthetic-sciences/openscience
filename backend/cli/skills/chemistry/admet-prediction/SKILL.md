---
name: admet-prediction
description: ADMET property prediction for drug candidates. Full pharmacokinetic panel (Caco-2, PPB, clearance, CYP), toxicity (hERG, AMES, DILI), drug-likeness (Lipinski, QED), using RDKit descriptors and TDC models.
category: chemistry
license: MIT
metadata:
    skill-author: Synthetic Sciences
---

# ADMET Property Prediction

## Overview

ADMET (Absorption, Distribution, Metabolism, Excretion, Toxicity) profiling is one of the most critical stages in the drug discovery pipeline. Poor pharmacokinetic and toxicity properties are responsible for roughly 40% of clinical trial failures. Computational ADMET prediction enables medicinal chemists to triage compounds early, prioritize synthesis efforts, and design molecules with improved drug-like profiles before committing to expensive in vitro and in vivo studies.

This skill provides a comprehensive suite of ADMET prediction tools built on RDKit molecular descriptors, validated SMARTS-based structural alert libraries, and established empirical models. Every prediction is accompanied by a traffic-light classification (GREEN / YELLOW / RED) so that results can be interpreted at a glance.

## When to Use This Skill

- **Hit-to-lead optimization**: Rank hits from a high-throughput screen by their predicted ADMET profile.
- **Lead optimization**: Identify liabilities in a lead series and guide structural modifications.
- **Virtual screening triage**: Filter large compound libraries before docking or ML scoring.
- **Candidate comparison**: Compare your candidates head-to-head against each other or against FDA-approved drug statistics.
- **Toxicity flagging**: Run focused toxicity panels before committing to synthesis.
- **Drug-likeness gating**: Evaluate whether a compound class is suitable for oral, CNS, topical, or injectable delivery.

## Installation

### Required dependencies

```bash
pip install rdkit-pypi numpy pandas
```

`rdkit-pypi` provides the pure-Python RDKit wheel. On conda-based environments, use `conda install -c conda-forge rdkit` instead.

### Optional dependencies

```bash
pip install PyTDC deepchem
```

- **PyTDC** (Therapeutics Data Commons): provides access to benchmark ADMET datasets and pre-trained models for endpoints like Caco-2, hERG, CYP inhibition, and clearance.
- **DeepChem**: enables deep-learning-based ADMET models (e.g., graph neural networks for solubility and toxicity).

The core scripts in this skill work with RDKit alone. TDC and DeepChem are used only when available and provide enhanced predictions where noted.

## Core Workflows

### 1. Full ADMET Panel

Run a complete pharmacokinetic, toxicity, and drug-likeness assessment for one or more molecules.

```bash
python scripts/predict_admet.py --input "CC(=O)Oc1ccccc1C(=O)O" --format table
python scripts/predict_admet.py --input candidates.csv --output results.csv --format csv
```

This produces predictions for every ADMET endpoint: absorption (Caco-2 class, HIA, Pgp, solubility), distribution (BBB, PPB, VDss), metabolism (CYP liabilities, soft spots), excretion (clearance class), toxicity (hERG, AMES, DILI, PAINS), and drug-likeness (Lipinski, QED).

### 2. Focused Toxicity Panel

Run a detailed toxicity-only assessment with per-alert breakdowns.

```bash
python scripts/predict_toxicity.py --input "c1ccc2c(c1)cc1ccc3cccc4ccc2c1c34"
python scripts/predict_toxicity.py --input candidates.csv --output tox_results.csv
```

Covers hERG channel liability, AMES mutagenicity (30+ structural alert SMARTS), hepatotoxicity (DILI), skin sensitization, phospholipidosis (CAD), and LD50 class estimation.

### 3. Pharmacokinetic Profiling

The full panel script covers PK endpoints. For PK-focused analysis, run the full panel and inspect the Absorption, Distribution, Metabolism, and Excretion sections of the output.

### 4. Drug-Likeness Comparison

Score compounds against multiple drug-likeness frameworks and compare to approved drug statistics.

```bash
python scripts/drug_likeness.py --input "CC(=O)Oc1ccccc1C(=O)O" --profile oral
python scripts/drug_likeness.py --input candidates.csv --profile cns --output dl_scores.csv
```

Supported profiles: `oral`, `cns`, `topical`, `injectable`.

### 5. Head-to-Head Drug Comparison

Compare your candidates against approved drugs or custom reference compounds.

```bash
python scripts/compare_drugs.py --input candidates.csv --output comparison.csv
python scripts/compare_drugs.py --input candidates.csv --reference approved.csv --output comparison.csv
```

## Script Reference

| Script | Purpose | Key Outputs |
|--------|---------|-------------|
| `predict_admet.py` | Full ADMET panel | All endpoints with traffic lights |
| `predict_toxicity.py` | Focused toxicity | Per-alert breakdown with severity |
| `drug_likeness.py` | Drug-likeness scoring | Lipinski, QED, SA, profile evaluation |
| `compare_drugs.py` | Candidate comparison | Percentile vs approved drugs |

## Interpretation Guide

### Traffic-Light System

Every predicted endpoint is assigned a traffic-light color:

- **GREEN**: Property is within the favorable range for drug development. No action needed.
- **YELLOW**: Property is borderline. Consider optimization if other properties are also marginal.
- **RED**: Property is outside the acceptable range. This is a potential liability that should be addressed.

### Threshold Summary

| Endpoint | GREEN | YELLOW | RED |
|----------|-------|--------|-----|
| QED | > 0.67 | 0.49 -- 0.67 | < 0.49 |
| LogP | -0.4 to 3.5 | 3.5 to 5.0 | > 5.0 or < -0.4 |
| MW (Da) | 150 -- 500 | 500 -- 700 | > 700 |
| TPSA (A^2) | < 90 | 90 -- 140 | > 140 |
| HBD | 0 -- 5 | 6 -- 7 | > 7 |
| HBA | 0 -- 10 | 11 -- 12 | > 12 |
| RotBonds | 0 -- 10 | 11 -- 13 | > 13 |
| LogS (ESOL) | > -4 | -4 to -6 | < -6 |
| Caco-2 class | High | Medium | Low |
| HIA | Likely high | Uncertain | Likely low |
| BBB penetration | Likely | Uncertain | Unlikely |
| hERG liability | No alerts | 1 alert | 2+ alerts |
| AMES alerts | No alerts | -- | Alert(s) present |
| DILI alerts | No alerts | 1 alert | 2+ alerts |
| PAINS alerts | 0 | 1 | 2+ |
| Lipinski violations | 0 | 1 | 2+ |
| SA score | 1 -- 4 | 4 -- 6 | > 6 |

### Important Limitations

1. **These are predictions, not measurements.** Computational ADMET models have limited accuracy (typical AUC 0.7-0.85 for classification tasks). Always confirm critical findings with in vitro assays.
2. **Structural alerts are necessary but not sufficient.** A SMARTS match for hERG or AMES indicates structural similarity to known liabilities, not confirmed activity.
3. **Applicability domain matters.** Predictions are most reliable for drug-like small molecules (MW 150-900, conventional heteroatom composition). Peptides, PROTACs, and inorganic compounds may give unreliable results.
4. **Context is everything.** A RED flag for BBB penetration is desirable for a peripheral drug but problematic for a CNS drug. Interpret results in the context of your therapeutic target.

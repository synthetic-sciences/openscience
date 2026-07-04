---
name: admet-reasoning
description: Interpretable ADMET analysis with mechanistic reasoning. Maps liabilities to structural causes and biological pathways. Based on CoTox (Park 2025) and DrugR (Liu 2026).
category: chemistry
license: MIT
metadata:
    skill-author: Synthetic Sciences
version: 1.0.0
tags: [drug-discovery, ADMET, toxicity, interpretation, reasoning]
dependencies: ["rdkit-pypi", "numpy", "pandas"]
---

# ADMET Reasoning

## Overview

Standard ADMET prediction tools output scores (e.g., "hERG = 0.85") without explaining why. This skill adds mechanistic reasoning — mapping each ADMET liability to its structural cause, the biological mechanism it affects, and a suggested structural fix.

Based on:
- **CoTox** (Park et al., 2025): Chain-of-thought toxicity reasoning with structural + biological context improved F1 from 0.37 to 0.66
- **DrugR** (Liu et al., 2026): Explicit liability reasoning before optimization improved scores 18×

## When to Use This Skill

- **After ADMET prediction**: Interpret flagged liabilities with structural explanations
- **Lead optimization planning**: Understand which structural features to modify and why
- **Toxicity reports**: Generate interpretable toxicity assessments for medicinal chemistry teams
- **Design review**: Evaluate whether proposed modifications address the right liabilities

**Do NOT use this skill for:**
- Raw ADMET score computation (use `admet-prediction` instead)
- Molecular optimization (use `molecular-optimization` instead)

### Related Skills
- **admet-prediction**: Compute ADMET properties (run this first)
- **molecular-optimization**: Iterative optimization using liability analysis
- **rdkit**: Core molecular operations

## Installation

### Required dependencies

```bash
pip install rdkit-pypi numpy pandas
```

## Core Workflows

### 1. Full Liability Report

Generate interpretable ADMET analysis for a molecule:

```bash
python scripts/reason_admet.py --smiles "c1ccc(NC(=O)c2ccccc2Cl)cc1" --output report.json
```

### 2. Batch Liability Analysis

```bash
python scripts/reason_admet.py --input compounds.csv --output liability_report.csv
```

### 3. Targeted Toxicity Reasoning

Focus on specific endpoints:

```bash
python scripts/reason_admet.py --smiles "CCN1CCCC1" --endpoints hERG,DILI,CYP --output tox_report.json
```

## Script Reference

| Script | Purpose | Key Outputs |
|--------|---------|-------------|
| `reason_admet.py` | Full ADMET reasoning with structural explanations | JSON report with liabilities, causes, mechanisms, fixes |

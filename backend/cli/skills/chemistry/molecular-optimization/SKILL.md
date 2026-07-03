---
name: molecular-optimization
description: Iterative lead optimization with analyze-reason-generate-verify-evaluate loop. Paper-backed (MT-Mol, DrugR, MultiMol).
category: chemistry
license: MIT
metadata:
    skill-author: Synthetic Sciences
version: 1.0.0
tags: [drug-discovery, lead-optimization, molecular-design, ADMET]
dependencies: ["rdkit-pypi", "numpy", "pandas"]
---

# Molecular Optimization

## Overview

Lead optimization is the bottleneck of drug discovery — modifying a hit compound to improve potency, selectivity, and ADMET properties without breaking what already works. LLMs frequently generate invalid SMILES or propose modifications that don't appear in the actual structure.

This skill implements an iterative optimization protocol based on three peer-reviewed approaches:
- **MT-Mol** (Kim et al., 2025): Multi-agent tool-based reasoning with verification — SOTA on 17/23 PMO benchmark tasks
- **DrugR** (Liu et al., 2026): Explicit liability reasoning before generation — 18× improvement over blind generation
- **MultiMol** (Yu et al., 2025): Generate-then-rank with scaffold preservation — 82.3% multi-objective success rate

The core loop: **Analyze → Identify Liabilities → Generate Candidates → Verify → Evaluate & Rank → Iterate**.

## When to Use This Skill

- **Lead optimization**: Improve ADMET properties of a hit while preserving potency
- **Scaffold hopping**: Find new scaffolds that maintain key pharmacophoric features
- **Property-driven design**: Generate analogs targeting specific property improvements (lower LogP, reduce hERG, improve solubility)
- **Multi-objective optimization**: Balance multiple properties simultaneously

**Do NOT use this skill for:**
- De novo design from scratch (use `denovo-design` instead)
- Simple property prediction without optimization (use `admet-prediction`)
- Docking or binding affinity estimation (use `molecular-docking`, `binding-affinity`)

### Related Skills
- **admet-prediction**: Compute ADMET properties (this skill uses it internally)
- **admet-reasoning**: Interpretable ADMET analysis with mechanistic explanations
- **smiles-validation**: Strict SMILES parsing and structural verification
- **rdkit**: Core molecular operations
- **medchem**: Medicinal chemistry filters and transformations

## Installation

### Required dependencies

```bash
pip install rdkit-pypi numpy pandas
```

### Optional dependencies

```bash
pip install PyTDC datamol
```

- **PyTDC**: Access to TDC ADMET predictors for enhanced property scoring
- **datamol**: Convenient molecular manipulation utilities

## Core Workflows

### 1. Single-Molecule Optimization

Optimize one molecule for improved properties:

```bash
python scripts/optimize.py \
    --smiles "c1ccc(NC(=O)c2ccccc2Cl)cc1" \
    --targets "LogP<3,hERG<0.3,QED>0.5" \
    --max-iterations 3 \
    --candidates 8 \
    --output results.json
```

### 2. Batch Optimization

Optimize a CSV of molecules:

```bash
python scripts/optimize.py \
    --input leads.csv \
    --smiles-col SMILES \
    --targets "LogP<3,hERG<0.3" \
    --output optimized.csv
```

### 3. Verification Only

Verify a proposed SMILES matches a claimed modification:

```bash
python scripts/verify_smiles.py \
    --original "c1ccccc1" \
    --proposed "c1ccc(O)cc1" \
    --claimed-modification "Added hydroxyl group at para position"
```

### 4. Candidate Comparison

Compare multiple candidates against a reference:

```bash
python scripts/compare_candidates.py \
    --reference "c1ccc(NC(=O)c2ccccc2Cl)cc1" \
    --candidates candidates.csv \
    --output comparison.html
```

## Script Reference

| Script | Purpose | Key Outputs |
|--------|---------|-------------|
| `optimize.py` | Full iterative optimization loop | `results.json` with ranked candidates, descriptor deltas, reasoning |
| `verify_smiles.py` | Validate SMILES and check claimed modifications | Pass/fail report with structural analysis |
| `compare_candidates.py` | Side-by-side descriptor comparison | Comparison table (CSV/HTML) with liability flags |

## Optimization Protocol Detail

### Step 1: ANALYZE
Compute molecular descriptors: MW, LogP, TPSA, HBA, HBD, RotBonds, QED, aromatic rings, Murcko scaffold. Flag properties outside ADMET target thresholds.

### Step 2: IDENTIFY LIABILITIES
Rank flagged properties by severity (hERG > DILI > CYP > solubility). For each, identify the structural feature causing the liability and propose a specific modification.

### Step 3: GENERATE CANDIDATES
Apply proposed modifications via:
- Bioisosteric replacement (e.g., phenyl → pyridine, amide → sulfonamide)
- Functional group addition/removal
- Ring system modification
- Chain length adjustment

Generate 4-8 candidates per iteration.

### Step 4: VERIFY
For each candidate:
1. `Chem.MolFromSmiles()` — discard if None
2. Scaffold preservation: Murcko scaffold match
3. Tanimoto similarity (ECFP4): flag if < 0.4
4. Structural verification: confirm claimed modification exists

### Step 5: EVALUATE & RANK
Recompute descriptors, build comparison table, score by net liability improvement (+1 per fix, -0.5 per new liability).

### Step 6: ITERATE
If no improvement after 3 iterations, return best found with honest assessment.

## ADMET Target Thresholds

| Property | Target | Severity |
|----------|--------|----------|
| hERG inhibition | < 0.3 | Critical |
| DILI | < 0.5 | Critical |
| CYP inhibition | < 0.5 | High |
| LogP | 1.0 – 3.0 | Medium |
| TPSA | 20 – 130 | Medium |
| MW | 150 – 500 | Medium |
| QED | > 0.5 | Low |
| Solubility (LogS) | > -4.0 | Medium |

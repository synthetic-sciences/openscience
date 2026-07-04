---
name: smiles-validation
description: Strict SMILES validation, structural comparison, and modification verification. Catches invalid LLM-generated molecules.
category: chemistry
license: MIT
metadata:
    skill-author: Synthetic Sciences
version: 1.0.0
tags: [cheminformatics, validation, SMILES, quality-control]
dependencies: ["rdkit-pypi"]
---

# SMILES Validation

## Overview

LLMs frequently generate invalid SMILES or produce molecules that don't match their stated reasoning. This skill provides strict validation, structural comparison, and modification verification.

Key checks:
- **Parse validation**: RDKit sanitization, valence checking, parenthesis/bracket balance
- **Structural comparison**: Tanimoto similarity, scaffold preservation, MCS analysis
- **Modification verification**: Confirm claimed structural changes exist in the actual molecule
- **Classification**: Categorize changes as optimization (>0.6 similarity), significant modification (0.4-0.6), or de novo design (<0.4)

## When to Use This Skill

- **After molecule generation**: Validate every SMILES before reporting results
- **Optimization verification**: Confirm proposed modifications match the actual structure
- **Batch validation**: Check a library of generated molecules for validity
- **Quality control**: Ensure reproducibility of molecular designs

## Installation

```bash
pip install rdkit-pypi
```

## Core Workflows

### 1. Validate a Single SMILES

```bash
python scripts/validate.py --smiles "c1ccccc1"
```

### 2. Compare Original vs Modified

```bash
python scripts/validate.py --original "c1ccccc1" --proposed "c1ccc(O)cc1" --check-modification "Added hydroxyl group"
```

### 3. Batch Validation

```bash
python scripts/validate.py --input generated_molecules.csv --output validation_report.json
```

## Script Reference

| Script | Purpose | Key Outputs |
|--------|---------|-------------|
| `validate.py` | SMILES validation, comparison, and modification checking | JSON report with validity, similarity, scaffold match, modification verification |

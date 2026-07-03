---
name: multi-objective-optimization
description: Pareto-aware molecular design balancing multiple ADMET properties simultaneously. Based on MultiMol (Yu 2025) and MOLLM (Ran 2025).
category: coding
license: MIT
metadata:
    skill-author: Synthetic Sciences
version: 1.0.0
tags: [drug-discovery, multi-objective, Pareto, optimization, molecular-design]
dependencies: ["rdkit-pypi", "numpy", "pandas"]
---

# Multi-Objective Molecular Optimization

## Overview

Real drug design is never single-objective. A useful molecule must simultaneously satisfy potency, selectivity, solubility, metabolic stability, and safety constraints. This skill implements Pareto-aware optimization that balances multiple properties without collapsing to a single weighted score.

Based on:
- **MultiMol** (Yu et al., 2025): 82.3% multi-objective success rate with generate-then-rank
- **MOLLM** (Ran et al., 2025): LLMs as genetic operators for multi-objective molecular design
- **DrugR** (Liu et al., 2026): Multi-granular reward balancing across property groups

## When to Use This Skill

- **"Improve potency while keeping hERG safe"** — classic multi-objective lead optimization
- **Balancing ADMET tradeoffs** — LogP vs solubility, BBB penetration vs peripheral safety
- **Pareto analysis** — identify which candidates best balance competing objectives
- **Property-constrained generation** — generate molecules within a defined property box

**Do NOT use this skill for:**
- Single-property optimization (use `molecular-optimization`)
- Property prediction without optimization (use `admet-prediction`)

### Related Skills
- **molecular-optimization**: Single-objective iterative optimization
- **admet-prediction**: Compute properties used as objectives
- **admet-reasoning**: Understand why properties need improvement

## Installation

```bash
pip install rdkit-pypi numpy pandas
```

### Optional

```bash
pip install matplotlib  # For Pareto front visualization
```

## Core Workflows

### 1. Multi-Objective Optimization

```bash
python scripts/pareto_optimize.py \
    --smiles "c1ccc(NC(=O)c2ccccc2Cl)cc1" \
    --objectives "LogP:minimize:3.0,QED:maximize:0.5,TPSA:range:20:130" \
    --candidates 16 \
    --output pareto_results.json
```

### 2. Pareto Analysis of Existing Candidates

```bash
python scripts/pareto_optimize.py \
    --input candidates.csv \
    --objectives "LogP:minimize:3.0,QED:maximize:0.5" \
    --mode analyze \
    --output pareto_front.json
```

### 3. Property Radar Plot

```bash
python scripts/property_radar.py \
    --reference "original_smiles" \
    --candidates optimized.csv \
    --output radar.png
```

## Script Reference

| Script | Purpose | Key Outputs |
|--------|---------|-------------|
| `pareto_optimize.py` | Generate and rank candidates by Pareto dominance | JSON with Pareto front, dominated set, objective scores |
| `property_radar.py` | Multi-property radar visualization | PNG radar plot comparing candidates |

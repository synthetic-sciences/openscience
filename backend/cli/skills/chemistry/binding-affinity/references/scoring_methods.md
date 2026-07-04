# Scoring Methods Reference

## Overview

This document explains the scoring methods available in the binding-affinity skill, their theoretical basis, accuracy expectations, and when to use each.

## Method 1: Empirical Descriptor Scoring (predict.py)

### How It Works

The descriptor method computes a predicted pKd from two types of features:

**Ligand descriptors** (from RDKit):
- Molecular weight (MW)
- LogP (lipophilicity)
- Topological polar surface area (TPSA)
- H-bond donors/acceptors
- Rotatable bonds
- Aromatic rings
- Formal charge

**Contact features** (from protein-ligand complex):
- N_hydrophobic: C-C contacts within 4.5 A
- N_hbond: N/O-N/O contacts within 3.5 A
- N_aromatic: aromatic C-aromatic C contacts within 5.0 A
- N_charged: charged atom contacts within 4.0 A
- Burial fraction: fraction of ligand atoms within 4 A of protein
- Energy proxy: sum of 1/r^6 for close contacts

These features are combined with hardcoded linear coefficients to estimate pKd.

### Accuracy Expectations

- **Typical error**: 1-2 log units pKd (10-100x in Kd)
- **Best for**: Drug-like molecules (MW 200-600, LogP -1 to 5)
- **Worst for**: Peptides, macrocycles, metal chelators, very large molecules
- **Correlation with experiment**: Pearson r ~ 0.5-0.6 on PDBbind benchmarks

This is NOT a trained machine learning model. The coefficients are approximate values derived from published literature on scoring functions (RF-Score, PDBbind analyses). The output should be treated as a rough ranking tool, not a quantitative prediction.

### When to Use
- Quick ranking of docked poses
- Virtual screening to prioritize compounds
- When no experimental data is available for comparison

## Method 2: MM/GBSA Rescoring (rescore.py)

### How It Works

MM/GBSA (Molecular Mechanics / Generalized Born Surface Area) computes binding free energy as:

```
ΔG_bind ≈ ΔG_MMGBSA = E_complex - E_protein - E_ligand
```

Where each energy term includes:
- **E_bond**: Bond, angle, dihedral terms (Amber ff14SB for protein)
- **E_vdW**: Van der Waals interactions (Lennard-Jones)
- **E_elec**: Electrostatic interactions (Coulomb)
- **ΔG_polar**: Polar solvation (Generalized Born model)
- **ΔG_nonpolar**: Nonpolar solvation (proportional to SASA)

### Two Code Paths

**Full path (OpenMM available)**:
- Amber ff14SB force field for protein
- OBC2 Generalized Born implicit solvent
- Optional energy minimization
- Proper energy decomposition

**Fallback path (RDKit only)**:
- MMFF94 force field for ligand
- Crude solvation estimate from TPSA/LogP
- Very approximate — use only for rough ranking

### Accuracy Expectations

| Path | Typical Error | Correlation | Best For |
|------|--------------|-------------|----------|
| Full OpenMM | 2-3 kcal/mol | r ~ 0.5-0.7 | Relative ranking within a congeneric series |
| RDKit fallback | 5-10 kcal/mol | r ~ 0.3-0.4 | Very rough filtering only |

### Known Limitations

1. **No entropy**: MM/GBSA does NOT include conformational entropy loss upon binding. This can be 3-10 kcal/mol.
2. **Single snapshot**: Computed from one docked pose, no conformational sampling.
3. **Implicit solvent**: GB approximates explicit water. Misses specific water-mediated interactions.
4. **Ligand parametrization**: The fallback path doesn't properly parametrize ligands.

### When to Use
- Rescoring a set of docked poses for better relative ranking
- Comparing closely related compounds (congeneric series)
- When OpenMM is available (full path is significantly better)

## Method 3: Consensus Scoring (consensus.py)

### How It Works

Consensus scoring combines multiple scoring methods to reduce individual method biases:

1. **Rank normalization**: Each method's scores are converted to ranks, then normalized to [0, 1]
2. **Weighted combination**: Normalized ranks are combined with weights (default: equal)
3. **Agreement assessment**: Kendall tau correlation between individual rankings measures consistency

### Why Rank-Based Normalization?

Different methods produce scores on different scales:
- Vina: -12 to -2 kcal/mol
- predict.py: pKd 1-12
- rescore.py: -100 to +50 kcal/mol
- score.py: 0-50 interactions

Rank normalization converts all to [0, 1], making combination meaningful regardless of scale.

### Agreement Interpretation

| Kendall τ | Agreement | Meaning |
|-----------|-----------|---------|
| > 0.7 | High | Methods largely agree. Ranking is more trustworthy. |
| 0.4-0.7 | Moderate | Partial agreement. Top and bottom ranks are more reliable than middle. |
| < 0.4 | Low | Methods disagree significantly. Ranking is uncertain. |

### Accuracy Expectations

Consensus scoring generally improves over any single method:
- Wang et al. (2003): consensus of 11 scoring functions improved enrichment by 30%
- Houston & Walkinshaw (2013): rank-by-rank consensus outperformed individual methods

However, combining multiple poor methods does NOT guarantee a good result.

### When to Use
- Always, if multiple scoring sources are available
- Especially valuable when methods disagree on a few compounds (flags uncertainty)
- For virtual screening campaigns where false positive rate matters

## Method Selection Guide

| Scenario | Recommended Approach |
|----------|---------------------|
| Quick virtual screen, no OpenMM | predict.py only |
| Careful study with OpenMM | predict.py + rescore.py + consensus.py |
| Full pipeline with docking | consensus.py with all sources |
| Congeneric series ranking | rescore.py (MM/GBSA) |
| Diverse library screening | batch.py → consensus.py with docking scores |

## Confidence Assessment

The predict.py script includes confidence levels based on applicability domain:

| Level | Criteria | Action |
|-------|----------|--------|
| **High** | MW 200-600, LogP -1 to 5, >30 contacts | Use prediction for ranking |
| **Moderate** | Partially in domain | Use with caution, verify with experiment |
| **Low** | Outside domain (extreme MW, LogP, few contacts) | Do not trust prediction |

## Important Caveats

1. **No method replaces experiments**: All computational affinity predictions are rough estimates. The gold standard is always experimental measurement (ITC, SPR, or biochemical assays).

2. **False precision is dangerous**: A predicted pKd of 7.2 does NOT mean the true value is 7.2. It means the true value is likely somewhere between 5.7 and 8.7 (Kd between ~2 nM and 2 uM).

3. **Relative ranking > absolute values**: These methods are much better at ranking a set of compounds than predicting any individual compound's exact affinity.

4. **Training domain matters**: The empirical coefficients were derived from drug-like protein-ligand complexes. Peptides, metal chelators, covalent binders, and macrocycles will get unreliable predictions.

## References

- Wang, R. et al. "The PDBbind database." J. Med. Chem. 47, 2977-2980 (2004).
- Ballester, P.J. & Mitchell, J.B.O. "A machine learning approach to predicting protein-ligand binding affinity." Bioinformatics 26, 1169-1175 (2010).
- Hou, T. et al. "Assessing the performance of the MM/PBSA and MM/GBSA methods." J. Chem. Inf. Model. 51, 69-82 (2011).
- Houston, D.R. & Walkinshaw, M.D. "Consensus docking: improving the reliability of docking in a virtual screening context." J. Chem. Inf. Model. 53, 384-390 (2013).
- Wang, R. et al. "Further development and validation of empirical scoring functions for structure-based binding affinity prediction." J. Comput. Aided Mol. Des. 16, 11-26 (2003).
- Li, H. et al. "Improving AutoDock Vina Using Random Forest." J. Chem. Inf. Model. 55, 1291-1299 (2015).

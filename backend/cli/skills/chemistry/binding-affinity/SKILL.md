---
name: binding-affinity
description: Hybrid ML + physics binding affinity prediction. Empirical scoring, MM/GBSA rescoring, multi-method consensus, and batch virtual screening for protein-ligand complexes.
category: chemistry
license: MIT
metadata:
    skill-author: Synthetic Sciences
version: 1.0.0
author: Synthetic Sciences
tags: [Binding Affinity, Drug Discovery, Scoring, MM/GBSA, Virtual Screening]
dependencies: ["rdkit-pypi", "biopython>=1.84", "numpy", "scipy"]
---

# Binding Affinity Prediction

## Overview

This skill predicts protein-ligand binding affinity from docked poses — converting structural information into estimated ΔG (kcal/mol), pKd, and Kd (nM). It complements the `molecular-docking` skill's interaction analysis (`score.py`) which counts contacts but does NOT predict binding strength in energy units.

**Key capabilities:**
- **Empirical scoring**: descriptor + contact-based affinity prediction using RDKit and BioPython
- **MM/GBSA rescoring**: physics-based energy decomposition with OpenMM (or RDKit fallback)
- **Consensus scoring**: combine multiple scoring methods with rank-based normalization
- **Batch virtual screening**: efficiently score large compound libraries

## Validation Warning

**All predictions from this skill are computational estimates, NOT experimentally validated measurements.**

- Empirical scoring (predict.py): typical error is 1-2 log units pKd (~10-100x in Kd)
- MM/GBSA rescoring: useful for relative ranking, not absolute binding energies
- Use for **prioritizing compounds for experimental testing**, not for making clinical claims

The scripts include uncertainty ranges and confidence flags to help calibrate expectations.

### Output Integrity

Script outputs are RAW computational estimates. The agent MUST NOT:
- Apply "calibration" or scaling to raw pKd/Kd values
- Adjust values to match known experimental data
- Add fields like "calibrated_pKd" not produced by the script
- Present approximate methods (simplified MM/GBSA) as full implementations

The raw output IS the prediction. Report it exactly as produced.

All script invocations are automatically logged to `_script_manifest.jsonl`. The critique
agent uses this manifest to verify that every number in the final report traces to a real
script output.

## When to Use This Skill

Use the `binding-affinity` skill when you need to:

- **Predict how tightly a ligand binds** to a protein (after docking)
- **Rank docked poses** by estimated binding affinity
- **Rescore poses** using physics-based MM/GBSA energy decomposition
- **Screen compound libraries** for binding potential
- **Combine multiple scoring methods** into a consensus ranking

Trigger phrases: "predict binding affinity", "estimate Kd", "score binding strength", "rescore with MM/GBSA", "rank compounds by affinity", "virtual screening"

**Do NOT use this skill for:**
- Finding binding pockets (use `pocket-detection`)
- Generating docked poses (use `molecular-docking`)
- Predicting ADMET properties (use `admet-prediction`)
- Free energy perturbation (requires specialized MD simulations)

### Related Skills
- **molecular-docking**: Generate docked poses first. This skill scores them.
- **pocket-detection**: Find binding pockets before docking.
- **admet-prediction**: Filter affinity hits by drug-likeness and safety.

## Installation

### Required Dependencies

```bash
# Core (required for all modes)
pip install rdkit-pypi biopython numpy scipy
```

### Optional Dependencies

```bash
# MM/GBSA rescoring (full physics-based path)
pip install openmm openmmforcefields openff-toolkit

# If OpenMM is not available, rescore.py falls back to RDKit MMFF
```

### Quick Verification

```bash
python -c "from rdkit import Chem; print('RDKit OK')"
python -c "from Bio.PDB import PDBParser; print('BioPython OK')"
python -c "import numpy; print('NumPy OK')"
python -c "import openmm; print('OpenMM OK')"  # optional
```

## Core Workflows

### Workflow 1: Predict Binding Affinity

Score docked poses using the empirical descriptor-based model.

```bash
python scripts/predict.py \
    --protein prepared_protein.pdb \
    --poses docking_results/poses.sdf \
    --output affinity.json
```

### Workflow 2: MM/GBSA Rescoring

Physics-based rescoring for more accurate relative ranking.

```bash
# Full MM/GBSA (requires OpenMM)
python scripts/rescore.py \
    --protein prepared_protein.pdb \
    --poses poses.sdf \
    --output mmgbsa.json \
    --minimize-steps 100

# RDKit fallback (no OpenMM needed)
python scripts/rescore.py \
    --protein prepared_protein.pdb \
    --poses poses.sdf \
    --output mmgbsa.json
```

### Workflow 3: Consensus Scoring

Combine multiple scoring methods for robust ranking.

```bash
python scripts/consensus.py \
    --scores affinity.json mmgbsa.json \
    --docking-scores docking_results/scores.csv \
    --interactions interactions.json \
    --output consensus.json \
    --top-n 10
```

### Workflow 4: Batch Virtual Screening

Screen a compound library against a target.

```bash
python scripts/batch.py \
    --protein prepared_protein.pdb \
    --library compounds.sdf \
    --output screening_hits.csv \
    --top-n 50 \
    --threshold 6.0
```

### Workflow 5: Full Pipeline

```bash
# 1. Detect pockets
python ../pocket-detection/scripts/detect.py \
    --input protein.pdb --output pockets.json

# 2. Dock ligand
python ../molecular-docking/scripts/dock.py \
    --protein protein.pdb --ligand ligand.sdf \
    --output-dir dock_results/ --method vina \
    --center_x 10 --center_y 20 --center_z 15

# 3. Interaction analysis
python ../molecular-docking/scripts/score.py \
    --protein protein.pdb --poses dock_results/poses.sdf \
    --output interactions.json

# 4. Predict affinity
python scripts/predict.py \
    --protein protein.pdb --poses dock_results/poses.sdf \
    --output affinity.json

# 5. MM/GBSA rescore
python scripts/rescore.py \
    --protein protein.pdb --poses dock_results/poses.sdf \
    --output mmgbsa.json

# 6. Consensus
python scripts/consensus.py \
    --scores affinity.json mmgbsa.json \
    --docking-scores dock_results/scores.csv \
    --interactions interactions.json \
    --output final_ranking.json --top-n 5
```

## Script Reference

| Script | Purpose | Key Inputs | Key Outputs |
|--------|---------|------------|-------------|
| `scripts/predict.py` | Empirical affinity prediction | Protein PDB + Poses SDF | Affinity JSON |
| `scripts/rescore.py` | MM/GBSA rescoring | Protein PDB + Poses SDF | Energy JSON |
| `scripts/consensus.py` | Multi-method consensus | Multiple score JSONs | Consensus JSON |
| `scripts/batch.py` | Batch virtual screening | Protein PDB + Library SDF | Hits CSV |

## Output Format

### Affinity JSON (from predict.py)

```json
{
  "protein": "protein.pdb",
  "method": "descriptor",
  "n_poses": 5,
  "note": "Empirical estimate. Typical error: 1-2 log units pKd (~10-100x in Kd). Use for relative ranking only.",
  "predictions": [
    {
      "pose_id": 1,
      "pose_name": "ligand_pose_1",
      "predicted_pKd": 7.2,
      "pKd_uncertainty": 1.5,
      "pKd_range": [5.7, 8.7],
      "predicted_dG_kcal": -9.8,
      "predicted_Kd_nM": 60,
      "confidence": "moderate",
      "features": {
        "mw": 342.4,
        "logp": 2.1,
        "n_hbonds": 4,
        "n_hydrophobic": 12,
        "burial_fraction": 0.65
      }
    }
  ]
}
```

### Consensus JSON (from consensus.py)

```json
{
  "n_poses": 5,
  "sources": ["predict.py", "rescore.py", "dock.py", "score.py"],
  "agreement_tau": 0.72,
  "agreement_class": "high",
  "rankings": [
    {
      "pose_id": 1,
      "pose_name": "ligand_pose_1",
      "consensus_score": 0.85,
      "consensus_rank": 1,
      "individual_ranks": {"predict": 1, "rescore": 2, "docking": 1, "interactions": 3}
    }
  ]
}
```

## Output Interpretation

### pKd Values

| pKd | Kd (approx) | Interpretation |
|-----|-------------|----------------|
| > 9 | < 1 nM | Very potent (clinical candidate range) |
| 7-9 | 1-100 nM | Potent (lead compound range) |
| 5-7 | 100 nM - 10 uM | Moderate (hit range) |
| 3-5 | 10 uM - 10 mM | Weak (fragment range) |
| < 3 | > 10 mM | Very weak / non-binder |

**Critical:** These are computational estimates with ~1-2 log unit uncertainty. A predicted pKd of 7.2 means the true value is likely somewhere between 5.7 and 8.7 (Kd between ~2 nM and 2 uM).

### Confidence Levels

| Level | Criteria | Meaning |
|-------|----------|---------|
| High | MW 200-600, LogP -1 to 5, >30 contacts | Within training domain, estimate more reliable |
| Moderate | Partially within domain | Use with caution |
| Low | MW <200 or >600, extreme LogP, few contacts | Outside training domain, estimate unreliable |

### MM/GBSA Energies

- More negative = stronger predicted binding
- Useful for relative ranking within a series, not absolute binding energies
- ΔG_MMGBSA does NOT equal experimental ΔG_binding (missing entropy, sampling)

## Troubleshooting

- **All poses get similar scores**: The ligands may be too similar, or the scoring function may not discriminate well for this target class.
- **Negative confidence**: Check if molecules are drug-like (MW 200-600, LogP -1 to 5). Non-drug-like molecules get unreliable scores.
- **OpenMM not available**: rescore.py falls back to RDKit MMFF energies. Install OpenMM for better physics-based scoring.
- **Very large library (>10K molecules)**: Use batch.py with `--threshold` to filter early.

## References

- Wang, R. et al. "The PDBbind database." J. Med. Chem. 47, 2977-2980 (2004).
- Ballester, P.J. & Mitchell, J.B.O. "A machine learning approach to predicting protein-ligand binding affinity." Bioinformatics 26, 1169-1175 (2010).
- Hou, T. et al. "Assessing the performance of the MM/PBSA and MM/GBSA methods." J. Chem. Inf. Model. 51, 69-82 (2011).
- Li, H. et al. "Improving AutoDock Vina Using Random Forest." J. Chem. Inf. Model. 55, 1291-1299 (2015).

---
name: molecular-docking
description: End-to-end molecular docking pipeline. Target preparation, pocket detection, protein-ligand docking (DiffDock/Vina), scoring, interaction analysis, and pose ranking.
category: chemistry
license: MIT
metadata:
    skill-author: Synthetic Sciences
---

# Molecular Docking Pipeline

## Overview

This skill provides a complete end-to-end molecular docking workflow covering every stage from raw protein structure to ranked, annotated binding poses. It integrates classical physics-based docking (AutoDock Vina) with modern deep-learning approaches (DiffDock), and includes protein-ligand interaction fingerprinting for downstream analysis.

**Pipeline Stages:**

1. **Target Preparation** -- Clean PDB structures, remove waters, add hydrogens, detect binding pockets
2. **Ligand Preparation** -- Convert SMILES to 3D, generate conformers, assign charges
3. **Docking** -- Run Vina or DiffDock to generate binding poses
4. **Scoring & Interaction Analysis** -- Identify hydrogen bonds, hydrophobic contacts, pi-stacking, salt bridges
5. **Ranking** -- Combine docking scores with interaction quality into a composite ranking

## When to Use This Skill

Use this skill when the user requests any of the following:

- "Dock this ligand to a protein" or "predict how a molecule binds"
- "Prepare a protein for docking" or "clean this PDB file"
- "Find binding pockets" or "detect active sites"
- "Run virtual screening against a compound library"
- "Score docked poses" or "analyze protein-ligand interactions"
- "Rank docking results" or "find the best binders"
- Any structure-based drug design task involving PDB files and small molecules
- Lead optimization where binding pose context is needed

**Do NOT use this skill for:**
- Binding affinity prediction (use MM/GBSA or free energy perturbation tools)
- Protein-protein docking (use HDOCK or ClusPro)
- Covalent docking (requires specialized workflows)
- Homology modeling (use AlphaFold or ESMFold first, then dock)


### Related Skills
- **diffdock**: For DiffDock-specific deep learning docking with all configuration options. This pipeline skill already calls DiffDock internally.
- **denovo-design**: For generating novel molecules to dock. Combine with this skill for a complete design-dock workflow.
- **admet-prediction**: For filtering docking hits by ADMET properties before experimental testing.

## Installation

**Python version:** Python 3.11 required. `rdkit-pypi` has no wheels for Python 3.12+. Create your venv with `uv venv --python 3.11` or `python3.11 -m venv .venv`.

### Required Dependencies

```bash
# Core (required for all stages) — pin numpy<2 for rdkit-pypi compatibility
pip install rdkit-pypi biopython "numpy<2" scipy

# PDBQT conversion — OpenBabel provides reliable Gasteiger charge computation.
# Recommended: install openbabel-wheel for best docking accuracy.
pip install openbabel-wheel

# Target preparation
pip install biopython

# Ligand preparation
pip install rdkit-pypi

# Docking -- Vina pathway
# Note: meeko 0.7.x requires rdkit >= 2023.x. If using rdkit-pypi 2022.9.5,
# install meeko 0.5.x instead: pip install "meeko<0.6"
pip install meeko vina

# Docking -- DiffDock pathway (optional, GPU recommended)
# See https://github.com/gcorso/DiffDock for installation

# Interaction analysis
pip install prolif

# Recommended extras
pip install pandas
```

### Quick Verification

```bash
python -c "from rdkit import Chem; print('RDKit OK')"
python -c "from Bio.PDB import PDBParser; print('BioPython OK')"
python -c "from vina import Vina; print('Vina OK')"
python -c "import meeko; print('Meeko OK')"
python -c "import prolif; print('ProLIF OK')"
python -c "import shutil; print('OpenBabel:', 'OK' if shutil.which('obabel') else 'not found (fallback charges used)')"
```

## Core Workflows

### Workflow 1: Single Ligand Docking

Dock one ligand to one protein target from start to finish.

```bash
# Step 1: Prepare target
python scripts/prepare_target.py \
    --input protein.pdb \
    --output prepared_protein.pdb \
    --detect-pockets

# Step 2: Prepare ligand
python scripts/prepare_ligands.py \
    --input "CCO" \
    --output ligand.sdf

# Step 3: Dock
python scripts/dock.py \
    --protein prepared_protein.pdb \
    --ligand ligand.sdf \
    --output-dir docking_results/ \
    --method vina \
    --center_x 10.0 --center_y 20.0 --center_z 15.0

# Step 4: Score and analyze interactions
python scripts/score.py \
    --protein prepared_protein.pdb \
    --poses docking_results/poses.sdf \
    --output interactions.json

# Step 5: Rank
python scripts/rank.py \
    --scores docking_results/scores.csv \
    --interactions interactions.json \
    --output ranked_results.csv \
    --top-n 5
```

### Workflow 2: Virtual Screening

Screen a library of compounds against a single target.

```bash
# Prepare target once
python scripts/prepare_target.py \
    --input target.pdb \
    --output prepared_target.pdb \
    --detect-pockets

# Prepare compound library (CSV with name,smiles columns)
python scripts/prepare_ligands.py \
    --input compounds.csv \
    --output library.sdf

# Dock entire library
python scripts/dock.py \
    --protein prepared_target.pdb \
    --ligand library.sdf \
    --output-dir vs_results/ \
    --method vina \
    --exhaustiveness 32 \
    --num-poses 5

# Score all results
python scripts/score.py \
    --protein prepared_target.pdb \
    --poses vs_results/poses.sdf \
    --output vs_interactions.json

# Rank and get top hits
python scripts/rank.py \
    --scores vs_results/scores.csv \
    --interactions vs_interactions.json \
    --output vs_ranked.csv \
    --top-n 20
```

### Workflow 3: Rescoring Existing Poses

Rescore and re-rank poses from a previous docking run or from an external tool.

```bash
# Score existing poses
python scripts/score.py \
    --protein protein.pdb \
    --poses existing_poses.sdf \
    --output rescored.json

# Rank with interaction data
python scripts/rank.py \
    --scores original_scores.csv \
    --interactions rescored.json \
    --output reranked.csv
```

### Workflow 4: Zero-Config Pipeline with Pocket Detection

Use `--pockets` or `--auto-detect-pockets` for automatic pocket-aware docking without manually specifying box coordinates.

```bash
# Option A: Use pre-computed pockets from pocket-detection skill
python ../pocket-detection/scripts/detect.py \
    --input protein.pdb --output pockets.json

python scripts/dock.py \
    --protein protein.pdb \
    --ligand ligand.sdf \
    --output-dir results/ \
    --pockets pockets.json

# Option B: Auto-detect pockets on the fly
python scripts/dock.py \
    --protein protein.pdb \
    --ligand ligand.sdf \
    --output-dir results/ \
    --auto-detect-pockets
```

**Pocket discovery priority:** `--pockets` flag > `protein_pockets.json` > `pockets.json` > `druggability.json` > auto-detect > geometric center.

## Script Reference

| Script | Purpose | Key Inputs | Key Outputs |
|--------|---------|------------|-------------|
| `scripts/prepare_target.py` | Clean protein, detect pockets | PDB file | Prepared PDB + pocket JSON |
| `scripts/prepare_ligands.py` | SMILES/SDF to 3D conformers | SMILES, CSV, or SDF | Multi-molecule SDF |
| `scripts/dock.py` | Run docking (Vina/DiffDock) | Protein PDB + Ligand SDF | Poses SDF + scores CSV |
| `scripts/score.py` | Interaction fingerprinting | Protein PDB + Poses SDF | Interaction JSON/CSV |
| `scripts/rank.py` | Composite ranking | Scores CSV + Interactions JSON | Ranked summary CSV |

## Output Interpretation

### Docking Scores (Vina)

- **Score (kcal/mol):** More negative = stronger predicted binding. Typical drug-like: -6 to -12 kcal/mol.
- **RMSD Lower Bound:** Deviation from the best pose. Poses with RMSD < 2.0 A from reference are considered accurate.
- Scores below -7.0 kcal/mol are generally considered promising hits.

### Interaction Analysis

- **Hydrogen Bonds:** Distance < 3.5 A between donor-acceptor, angle > 120 degrees. Key for specificity.
- **Hydrophobic Contacts:** Non-polar atoms within 4.5 A. Contribute to binding entropy.
- **Pi-Stacking:** Aromatic ring centroids within 5.5 A, angle < 30 degrees (parallel) or > 60 degrees (T-shaped).
- **Salt Bridges:** Charged groups within 4.0 A. Strong electrostatic contribution.
- **Halogen Bonds:** C-X...Y angle ~165 degrees, distance < 3.5 A.

### Composite Ranking

The ranking script combines docking score (normalized) with interaction quality metrics. A compound ranking highly should have both a favorable docking score AND meaningful protein-ligand interactions -- this reduces false positives from scoring function artifacts.

## Pocket Detection

See `references/pocket_detection.md` for detailed guidance on interpreting detected pockets, druggability assessment, and manual pocket specification strategies.

## Troubleshooting

- **Vina fails with "atom type not found"**: Ensure the protein PDB has no exotic elements. Run `prepare_target.py` first.
- **RDKit embedding fails**: The SMILES may represent a molecule that is hard to embed in 3D. Try adding `--ph 7.0` or check SMILES validity.
- **DiffDock not found**: DiffDock requires a separate installation with PyTorch Geometric. Fall back to `--method vina`.
- **No pockets detected**: The protein may lack a clear cavity. Provide manual coordinates via `--center_x/y/z` in the docking step.
- **ProLIF import error**: Install with `pip install prolif`. Requires RDKit and MDAnalysis.

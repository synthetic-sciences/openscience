---
name: structure-prediction
description: Protein structure prediction from sequence. ESMFold-based, single GPU, no MSA needed. Predicts 3D structures with pLDDT confidence scores for drug discovery targets.
category: chemistry
license: MIT
metadata:
    skill-author: Synthetic Sciences
version: 1.0.0
author: Synthetic Sciences
tags: [Protein Structure, ESMFold, Bioinformatics, Deep Learning]
dependencies: ["fair-esm", "torch>=1.12.0", "biopython>=1.84"]
---

# Structure Prediction (ESMFold)

## Overview

This skill provides protein 3D structure prediction from amino acid sequences using **ESMFold** (Evolutionary Scale Modeling Fold). ESMFold is a single-sequence protein structure prediction model developed by Meta AI that produces accurate 3D coordinates directly from an amino acid sequence without requiring multiple sequence alignments (MSA) or template search.

Key advantages of ESMFold:
- **No MSA required**: Predictions run on a single sequence, making inference dramatically faster than AlphaFold2 (seconds vs. minutes/hours).
- **Single GPU execution**: The entire model fits on one GPU (requires ~16 GB VRAM for sequences up to ~400 residues, more for longer sequences).
- **End-to-end**: Takes a raw amino acid string and outputs a full PDB structure with per-residue confidence scores (pLDDT).
- **Drug discovery ready**: Suitable for rapid screening of target structures, variant modeling, and initial structural hypotheses.

## When to Use This Skill

Use the `structure-prediction` skill when you need to:

- **Predict a protein structure** from an amino acid sequence
- **Fold a protein** when no experimental structure is available
- **Screen multiple sequences** for structural viability in batch mode
- **Evaluate prediction confidence** to assess reliability of modeled regions
- **Compare a predicted structure** against an experimental reference (e.g., from PDB)
- **Identify disordered regions** in a protein based on low-confidence scores
- **Generate initial models** for downstream molecular docking or dynamics simulations

Trigger phrases: "predict structure", "fold protein", "run ESMFold", "structure from sequence", "batch fold", "evaluate pLDDT", "compare structures"


### Related Skills
- **alphafold-database**: If the protein has a UniProt ID, check AlphaFold DB first — pre-computed structures are instant, no GPU needed.
- **esm**: For generative protein design, embeddings, or inverse folding (broader than just structure prediction).
- **protein-diagram**: For rendering 2D diagrams of protein structures (domain maps, Ramachandran plots) — not prediction.

## Installation

```bash
pip install fair-esm torch biopython
```

**Requirements:**
- Python 3.8+
- PyTorch 1.12+ (with CUDA support recommended for GPU acceleration)
- `fair-esm` (provides the ESMFold model)
- `biopython` (for PDB parsing, structure I/O, and superimposition)

For GPU acceleration, ensure you have a CUDA-compatible GPU with at least 16 GB VRAM. CPU inference is supported but significantly slower.

Optional for structure comparison:
- TMalign (external binary) for TM-score computation. If not available, the compare script falls back to BioPython-based RMSD calculation.

## Core Workflows

### 1. Single Structure Prediction

Predict a 3D structure from a single amino acid sequence or FASTA file.

```bash
# From a FASTA file
python scripts/predict.py --input sequence.fasta --output predicted.pdb

# From a raw sequence string
python scripts/predict.py --input "MKFLILLFNILCLFPVLAADNHGVS..." --output predicted.pdb

# Force CPU (useful if GPU memory is insufficient)
python scripts/predict.py --input sequence.fasta --output predicted.pdb --device cpu

# Auto-detect device (default)
python scripts/predict.py --input sequence.fasta --output predicted.pdb --device auto
```

**Output:** A PDB file with atomic coordinates and a printed summary including sequence length, mean pLDDT, and per-residue confidence statistics.

See: `scripts/predict.py`

### 2. Batch Structure Prediction

Predict structures for multiple sequences from a multi-FASTA file or CSV.

```bash
# From a multi-FASTA file
python scripts/predict_batch.py --input sequences.fasta --output-dir results/

# From a CSV file (must have 'name' and 'sequence' columns)
python scripts/predict_batch.py --input sequences.csv --output-dir results/

# Specify device
python scripts/predict_batch.py --input sequences.fasta --output-dir results/ --device cuda
```

**Output:** Individual PDB files in the output directory named by sequence ID, plus a `summary.csv` containing: name, sequence length, mean pLDDT, and output path for each prediction.

See: `scripts/predict_batch.py`

### 3. Structure Evaluation

Evaluate a predicted PDB structure for confidence metrics and structural quality.

```bash
python scripts/evaluate.py --input predicted.pdb
```

**Output:** A formatted report including:
- Mean pLDDT score
- pLDDT distribution by confidence tier
- Estimated secondary structure content (helix, sheet, coil)
- List of low-confidence regions (pLDDT < 50) that may be disordered or unreliable

See: `scripts/evaluate.py`

### 4. Structure Comparison

Compare a predicted structure against an experimental reference.

```bash
python scripts/compare.py --predicted predicted.pdb --reference experimental.pdb
```

**Output:** A comparison report including:
- C-alpha RMSD after optimal superimposition
- TM-score (if TMalign is installed, otherwise BioPython-based approximation)
- GDT-TS score (if TMalign is available)
- Per-residue distance analysis

See: `scripts/compare.py`

## Output Interpretation

### pLDDT Confidence Scores

ESMFold outputs per-residue pLDDT (predicted Local Distance Difference Test) scores ranging from 0 to 100. These scores indicate the model's confidence in each residue's predicted position:

| Score Range | Confidence Level | Interpretation |
|-------------|-----------------|----------------|
| > 90        | Very high       | Atomic-level accuracy expected. Backbone and side-chain positions are likely reliable. |
| 70 - 90     | Confident       | Backbone topology is reliable. Side-chain rotamers may vary. |
| 50 - 70     | Low             | Overall fold topology may be correct, but local details are uncertain. |
| < 50        | Very low        | Region is likely intrinsically disordered or unstructured. Do not trust atomic positions. |

**What good looks like:** A well-folded globular protein will typically show mean pLDDT > 70, with most of the core residues above 80-90 and only flexible loops or termini below 70.

**What bad looks like:** A prediction with mean pLDDT < 50 suggests the model has low confidence across the entire structure. This may indicate an intrinsically disordered protein, a sequence outside the model's training distribution, or a sequence that is too long for reliable single-sequence prediction.

For detailed confidence metric interpretation, see: `references/confidence_metrics.md`

## Limitations

1. **Sequence length**: ESMFold performs best on sequences under ~400 residues. Sequences of 400-800 residues are feasible but require more GPU memory (32+ GB VRAM). Sequences over 800 residues may cause out-of-memory errors on most hardware and typically produce lower-quality predictions.

2. **No multi-chain prediction**: ESMFold predicts single-chain structures only. It cannot model protein complexes, homo-oligomers, or hetero-oligomeric assemblies. For multimer prediction, consider AlphaFold-Multimer.

3. **Accuracy vs. AlphaFold2**: ESMFold achieves competitive but generally lower accuracy compared to AlphaFold2, particularly for:
   - Targets with few homologs (where MSA information would help)
   - Large proteins with complex domain arrangements
   - Proteins with unusual folds not well represented in training data

   On CASP15 targets, ESMFold's median GDT-TS is approximately 10-15 points below AlphaFold2 on difficult targets, but is comparable on easier targets with abundant homologous sequences.

4. **No ligand or cofactor modeling**: The predicted structures do not include bound ligands, metal ions, or cofactors.

5. **Static prediction**: ESMFold produces a single static structure and does not capture conformational dynamics or multiple states.

6. **No confidence calibration guarantee**: While pLDDT scores are generally informative, they are not perfectly calibrated probability estimates. Regions with moderate pLDDT (50-70) require careful manual inspection.

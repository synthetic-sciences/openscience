---
name: pocket-detection
description: Multi-method binding pocket detection and druggability assessment. Grid-based, fpocket, and P2Rank detection with druggability scoring, visualization, and cross-structure comparison.
category: chemistry
license: MIT
metadata:
    skill-author: Synthetic Sciences
version: 1.0.0
author: Synthetic Sciences
tags: [Pocket Detection, Druggability, Drug Discovery, Structure-Based Design]
dependencies: ["biopython>=1.84", "numpy", "scipy"]
---

# Pocket Detection & Druggability Assessment

## Overview

This skill provides multi-method binding pocket detection on protein structures, druggability scoring, pocket visualization, and cross-structure pocket comparison. It is the first dedicated step in any structure-based drug design workflow — identifying **where** on a protein a small molecule can bind before docking or de novo design begins.

**Key capabilities:**
- **Three detection methods**: grid-based cavity scan, fpocket (alpha spheres), P2Rank (machine learning)
- **Druggability scoring**: 6-axis weighted assessment (volume, hydrophobicity, enclosure, depth, H-bond capacity, aromaticity)
- **Visualization**: summary panels, residue composition, druggability radar, method comparison plots
- **Cross-structure comparison**: match pockets across apo/holo, wild-type/mutant, or predicted/experimental structures

## When to Use This Skill

Use the `pocket-detection` skill when you need to:

- **Find binding sites** on a protein structure before docking
- **Assess druggability** of detected pockets (can a drug-like molecule bind here?)
- **Compare pockets** across multiple structures (e.g., apo vs holo, WT vs mutant)
- **Visualize pocket properties** for reports or publications
- **Validate binding sites** using multiple detection methods for consensus
- **Identify allosteric sites** beyond the obvious orthosteric pocket

Trigger phrases: "find binding pocket", "detect active site", "druggability assessment", "pocket detection", "where does the ligand bind", "compare binding sites"

**Do NOT use this skill for:**
- Actually docking ligands into pockets (use `molecular-docking`)
- Predicting how tightly a ligand binds (use `binding-affinity`)
- Protein structure prediction (use `structure-prediction` first, then this)
- Protein-protein interaction surfaces (use ClusPro or HDOCK)

### Related Skills
- **molecular-docking**: Dock ligands into detected pockets. This skill's JSON output feeds directly into `dock.py --center_x/y/z`.
- **binding-affinity**: Score docked poses for binding strength. Run after docking.
- **structure-prediction**: Predict protein structure from sequence when no experimental PDB is available. Run before this skill.

## Installation

### Required Dependencies

```bash
# Core (required for all modes)
pip install biopython numpy scipy
```

### Optional Dependencies

```bash
# fpocket method (external binary)
# Ubuntu/Debian: sudo apt-get install fpocket
# macOS: brew install fpocket
# Or build from source: https://github.com/Discngine/fpocket

# P2Rank method (external binary)
# Download from: https://github.com/rdk/p2rank/releases
# Set P2RANK_HOME environment variable to installation directory

# Visualization
pip install matplotlib

# RDKit (optional, for enhanced hydrogen bond analysis)
pip install rdkit-pypi
```

### Quick Verification

```bash
python -c "from Bio.PDB import PDBParser; print('BioPython OK')"
python -c "import numpy; print('NumPy OK')"
python -c "from scipy.spatial import ConvexHull; print('SciPy OK')"
python -c "import shutil; print('fpocket:', 'OK' if shutil.which('fpocket') else 'not found')"
```

### Species Validation

Before running pocket detection, verify the PDB structure species matches the user's target.
If the user requests "human" but the PDB HEADER shows another organism (e.g., murine), flag
this to the user before proceeding. Parse the PDB HEADER/SOURCE records to check organism.

## Core Workflows

### Workflow 1: Detect Pockets (Grid Method)

Detect binding pockets on a prepared protein structure using the built-in grid-based cavity scan.

```bash
# Basic detection
python scripts/detect.py \
    --input prepared_protein.pdb \
    --output pockets.json

# With chain selection and custom parameters
python scripts/detect.py \
    --input protein.pdb \
    --output pockets.json \
    --chain A \
    --min-volume 200 \
    --max-pockets 5

# Also check co-crystallized ligand sites
python scripts/detect.py \
    --input protein_with_ligand.pdb \
    --output pockets.json \
    --include-ligand-sites
```

### Workflow 2: Multi-Method Detection

Run multiple detection methods for higher confidence.

```bash
# Grid-based (built-in, no external deps)
python scripts/detect.py --input protein.pdb --output pockets_grid.json --method grid

# fpocket (requires fpocket binary)
python scripts/detect.py --input protein.pdb --output pockets_fpocket.json --method fpocket

# P2Rank (requires P2Rank installation)
python scripts/detect.py --input protein.pdb --output pockets_p2rank.json --method p2rank

# Auto: tries P2Rank → fpocket → grid (first available)
python scripts/detect.py --input protein.pdb --output pockets.json --method auto
```

### Workflow 3: Druggability Assessment

Score detected pockets for drug-likeness.

```bash
python scripts/druggability.py \
    --input protein.pdb \
    --pockets pockets.json \
    --output druggability.json
```

### Workflow 4: Visualize Pockets

Generate publication-quality pocket visualizations.

```bash
# Summary overview (multi-panel)
python scripts/visualize.py \
    --input protein.pdb \
    --pockets druggability.json \
    --output pocket_summary.png \
    --plot-type summary

# Druggability radar for top 3 pockets
python scripts/visualize.py \
    --input protein.pdb \
    --pockets druggability.json \
    --output radar.png \
    --plot-type druggability-radar

# Compare methods side-by-side
python scripts/visualize.py \
    --input protein.pdb \
    --pockets pockets_grid.json pockets_fpocket.json pockets_p2rank.json \
    --labels "Grid" "fpocket" "P2Rank" \
    --output method_comparison.png \
    --plot-type method-comparison
```

### Workflow 5: Cross-Structure Comparison

Compare pockets across different structures of the same protein.

```bash
python scripts/compare.py \
    --structures apo.pdb holo.pdb \
    --labels "Apo" "Holo" \
    --output pocket_comparison.json \
    --align
```

### Workflow 6: Full Pipeline (Detection → Druggability → Docking)

```bash
# 1. Detect pockets
python scripts/detect.py \
    --input prepared.pdb \
    --output pockets.json

# 2. Score druggability
python scripts/druggability.py \
    --input prepared.pdb \
    --pockets pockets.json \
    --output druggability.json

# 3. Feed into docking (reads center from pockets JSON)
python ../molecular-docking/scripts/dock.py \
    --protein prepared.pdb \
    --ligand ligand.sdf \
    --output-dir docking_results/ \
    --center_x $(python -c "import json; d=json.load(open('pockets.json')); print(d['pockets'][0]['center'][0])") \
    --center_y $(python -c "import json; d=json.load(open('pockets.json')); print(d['pockets'][0]['center'][1])") \
    --center_z $(python -c "import json; d=json.load(open('pockets.json')); print(d['pockets'][0]['center'][2])")
```

## Script Reference

| Script | Purpose | Key Inputs | Key Outputs |
|--------|---------|------------|-------------|
| `scripts/detect.py` | Multi-method pocket detection | PDB file | Pockets JSON |
| `scripts/druggability.py` | Pocket druggability scoring | PDB + Pockets JSON | Druggability JSON |
| `scripts/visualize.py` | Pocket visualization | PDB + Pockets JSON | PNG/SVG image |
| `scripts/compare.py` | Cross-structure comparison | 2+ PDB files | Comparison JSON |

## Output Format

### Pockets JSON (from detect.py)

```json
{
  "protein": "protein.pdb",
  "method": "grid",
  "chain": "A",
  "n_pockets": 3,
  "pockets": [
    {
      "rank": 1,
      "source": "grid",
      "center": [10.5, 22.3, 15.0],
      "volume_A3": 542.8,
      "residues": ["ASP189", "SER195", "HIS57"],
      "n_residues": 15,
      "bbox_min": [5.2, 17.1, 10.8],
      "bbox_max": [16.1, 27.9, 19.3]
    }
  ]
}
```

**Critical:** The `"center"` field is a 3-element float list `[x, y, z]` compatible with `dock.py` auto-discovery.

### Druggability JSON (from druggability.py)

Augments the pockets JSON with per-pocket druggability data:

```json
{
  "pockets": [
    {
      "rank": 1,
      "center": [10.5, 22.3, 15.0],
      "druggability_score": 0.72,
      "druggability_class": "druggable",
      "properties": {
        "volume_A3": 542.8,
        "hydrophobicity": 0.45,
        "enclosure": 0.62,
        "depth_A": 7.3,
        "hb_capacity": 5,
        "aromaticity": 3
      }
    }
  ]
}
```

## Output Interpretation

### Druggability Classes

| Class | Score | Meaning |
|-------|-------|---------|
| Druggable | > 0.7 | Pocket is well-suited for small molecule inhibitors |
| Difficult | 0.4 - 0.7 | May require fragment-based or specialized approaches |
| Undruggable | < 0.4 | Unlikely to bind drug-like molecules; consider PPI inhibitors or peptides |

**Important:** Druggability classification is based on literature-derived heuristic thresholds (Halgren 2009, Volkamer 2012), not a validated predictive model. Treat as guidance for prioritization, not a definitive assessment.

### Volume Interpretation

- **< 150 A^3**: Too small for drug-like molecules. May bind fragments or ions.
- **150-300 A^3**: Fragment-sized pocket. Suitable for fragment-based drug design.
- **300-800 A^3**: Ideal drug-like pocket. Most approved drugs bind in this range.
- **800-1500 A^3**: Large pocket. May require extended molecules or PROTACs.
- **> 1500 A^3**: Very large or flat. Likely a protein-protein interaction surface.

### Method Comparison

| Method | Strengths | Limitations |
|--------|-----------|-------------|
| Grid | No external deps, good for standard cavities | Slow on large proteins, may find non-functional cavities |
| fpocket | Fast, well-validated, handles flexible pockets | Requires external binary |
| P2Rank | ML-based, highest accuracy on benchmarks | Requires Java + external binary |

When methods agree on a pocket location (centers within 5 A), confidence is high. Disagreements suggest the pocket is borderline or method-dependent.

## Troubleshooting

- **Single giant pocket (volume >5000 A^3) or only 1 pocket returned**: The grid method's clustering merged nearby cavities into one. Fixes, in order:
  1. Try `--method auto` (uses P2Rank or fpocket if available — both handle this better)
  2. Try `--method fpocket` (alpha sphere method naturally separates sub-pockets)
  3. Increase `--min-volume 300` to filter noise and re-run
  4. Add `--chain A` to analyze only the biologically relevant chain
  5. **Do NOT rewrite the detection logic in custom code.** Adjust parameters instead.
- **No pockets detected**: The protein may lack a clear cavity. Try reducing `--min-volume 100`, or provide manual coordinates for docking.
- **All druggability scores are identical**: This can happen when all detected pockets have similar size/depth/composition. Run `druggability.py` — it uses continuous Gaussian scoring that produces differentiated scores even for similar pockets. If scores are still very close (>0.9 for all), the protein genuinely has multiple high-quality binding sites.
- **fpocket not found**: Install fpocket or use `--method grid` as fallback.
- **P2Rank not found**: Set `P2RANK_HOME` environment variable or use `--method grid`.
- **Very large protein (>5000 residues)**: Grid method may be slow. Use fpocket or P2Rank instead, or increase `--grid-spacing` to 1.5.
- **Pocket at crystal contact**: Check if the pocket is between symmetry mates. Filter by chain with `--chain`.

**IMPORTANT for agents**: When a skill script produces unexpected output (e.g., a single giant pocket, no pockets, or identical scores), adjust the script's parameters or try a different `--method`. Do NOT abandon the skill scripts and rewrite the logic in custom code. The skill scripts handle edge cases, validate I/O contracts, and log to the manifest — custom rewrites skip all of this.

## References

- Le Guilloux, V. et al. "Fpocket: an open source platform for ligand pocket detection." BMC Bioinformatics 10, 168 (2009).
- Krivak, R. & Hoksza, D. "P2Rank: machine learning based tool for rapid and accurate prediction of ligand binding sites." J. Cheminform. 10, 39 (2018).
- Halgren, T.A. "Identifying and characterizing binding sites and assessing druggability." J. Chem. Inf. Model. 49, 377-389 (2009).
- Volkamer, A. et al. "DoGSiteScorer: a web server for automatic binding site prediction, analysis and druggability assessment." Bioinformatics 28, 2074-2075 (2012).

---
name: drug-design
description: End-to-end drug discovery pipeline orchestration. Deterministic Python script that auto-chains structure prediction, pocket detection, de novo design, docking, scoring, and ADMET filtering into reproducible workflows.
category: chemistry
license: MIT
metadata:
    skill-author: Synthetic Sciences
version: 1.0.0
author: Synthetic Sciences
tags: [Drug Discovery, Pipeline, Orchestration, Drug Design]
dependencies: ["biopython>=1.84", "rdkit-pypi", "numpy", "scipy"]
---

# Drug Design Pipeline

## Overview

This skill provides a **deterministic pipeline orchestrator** (`pipeline.py`) that auto-chains multiple drug discovery skills into reproducible workflows. Instead of manually invoking 10+ scripts in the correct order, the agent runs a single command that handles file wiring, schema validation, and manifest logging at every stage.

**Why a script instead of manual chaining:**
- Guarantees correct execution order — the agent cannot skip or reorder stages
- Validates I/O contracts between stages — catches schema mismatches early
- Logs every invocation to `_script_manifest.jsonl` — critique agent can verify the full trace
- Stops on first failure with clear diagnostics — no silent errors

## Pipeline Mode Selection

Choose the mode based on what the user wants:

| User Intent | Mode | Command |
|------------|------|---------|
| "Find drugs for target X" | `full` | `--mode full --protein target.pdb` |
| "Optimize this hit compound" | `lead-opt` | `--mode lead-opt --protein target.pdb --ligand hit.sdf` |
| "Screen this library" | `screen` | `--mode screen --protein target.pdb --library compounds.sdf` |
| "Is this target druggable?" | `assess` | `--mode assess --protein target.pdb` |
| "Design molecules for this pocket" | `denovo` | `--mode denovo --protein target.pdb` |

Trigger phrases: "drug discovery pipeline", "find drugs", "design drugs", "screen compounds", "druggability assessment", "de novo design", "lead optimization"

## Quick Start

### Full Pipeline (target → drug candidates)

```bash
python scripts/pipeline.py \
    --mode full \
    --protein target.pdb \
    --output-dir results/ \
    --top-n 10
```

### Lead Optimization (improve an existing hit)

```bash
python scripts/pipeline.py \
    --mode lead-opt \
    --protein target.pdb \
    --ligand hit_compound.sdf \
    --output-dir lead_opt_results/ \
    --top-n 20
```

### Virtual Screening (screen a compound library)

```bash
python scripts/pipeline.py \
    --mode screen \
    --protein target.pdb \
    --library compound_library.sdf \
    --output-dir screening_results/ \
    --top-n 50
```

### Target Assessment (is this druggable?)

```bash
python scripts/pipeline.py \
    --mode assess \
    --protein target.pdb \
    --output-dir assessment/
```

### De Novo Design (generate novel molecules)

```bash
python scripts/pipeline.py \
    --mode denovo \
    --protein target.pdb \
    --output-dir denovo_results/ \
    --top-n 15
```

### From Sequence (no PDB available)

```bash
python scripts/pipeline.py \
    --mode full \
    --sequence "MKTLLLTLLLGLLVSSALA..." \
    --output-dir results/
```

## Pipeline Stages Reference

### Full Pipeline (`--mode full`)

| Stage | Skill | Script | Input | Output |
|-------|-------|--------|-------|--------|
| 1. Structure Prediction | structure-prediction | predict.py | Sequence | predicted_structure.pdb |
| 2. Pocket Detection | pocket-detection | detect.py | PDB | pockets.json |
| 3. Druggability | pocket-detection | druggability.py | PDB + pockets.json | druggability.json |
| 4. De Novo Design | denovo-design | generate_sbdd.py | PDB + pockets.json | candidates.sdf |
| 5. Drug-Likeness Filter | denovo-design | filter.py | candidates.sdf | filtered.sdf |
| 6. Docking | molecular-docking | dock.py | PDB + filtered.sdf | docking/poses.sdf |
| 7. Interaction Scoring | molecular-docking | score.py | PDB + poses.sdf | interactions.json |
| 8. Affinity Prediction | binding-affinity | predict.py | PDB + poses.sdf | affinity.json |
| 9. MM/GBSA Rescore | binding-affinity | rescore.py | PDB + poses.sdf | mmgbsa.json |
| 10. Consensus Ranking | binding-affinity | consensus.py | All score files | consensus.json |
| 11. 3D Visualization | molecule-visualization | render_3d.py | PDB + poses.sdf | complex_3d.html |

### Lead Optimization (`--mode lead-opt`)

| Stage | Script | Input | Output |
|-------|--------|-------|--------|
| 1. Analog Generation | generate_analogs.py | hit.sdf | analogs.sdf |
| 2. Drug-Likeness Filter | filter.py | analogs.sdf | filtered.sdf |
| 3. Docking | dock.py | PDB + filtered.sdf | docking/poses.sdf |
| 4. Affinity Prediction | predict.py | PDB + poses.sdf | affinity.json |
| 5. Consensus Ranking | consensus.py | affinity.json | consensus.json |

### Virtual Screening (`--mode screen`)

| Stage | Script | Input | Output |
|-------|--------|-------|--------|
| 1. Pocket Detection | detect.py | PDB | pockets.json |
| 2. Batch Scoring | batch.py | PDB + library.sdf | screening_hits.csv |
| 3. Docking | dock.py | PDB + hits | docking/poses.sdf |
| 4. Affinity Prediction | predict.py | PDB + poses.sdf | affinity.json |
| 5. Consensus Ranking | consensus.py | affinity.json | consensus.json |

### Target Assessment (`--mode assess`)

| Stage | Script | Input | Output |
|-------|--------|-------|--------|
| 1. Structure Prediction | predict.py | Sequence | predicted.pdb |
| 2. Pocket Detection | detect.py | PDB | pockets.json |
| 3. Druggability | druggability.py | PDB + pockets.json | druggability.json |
| 4. Summary Plot | visualize.py | PDB + druggability.json | pocket_summary.png |
| 5. Druggability Radar | visualize.py | PDB + druggability.json | druggability_radar.png |
| 6. 3D View | render_3d.py | PDB | protein_3d.html |

### De Novo Design (`--mode denovo`)

| Stage | Script | Input | Output |
|-------|--------|-------|--------|
| 1. Pocket Detection | detect.py | PDB | pockets.json |
| 2. SBDD Generation | generate_sbdd.py | PDB + pockets.json | candidates_sbdd.sdf |
| 3. Fragment Generation | generate_fragments.py | PDB + pockets.json | candidates_frag.sdf |
| 4. Drug-Likeness Filter | filter.py | candidates.sdf | filtered.sdf |
| 5. Docking | dock.py | PDB + filtered.sdf | docking/poses.sdf |
| 6. Affinity Prediction | predict.py | PDB + poses.sdf | affinity.json |
| 7. Consensus Ranking | consensus.py | affinity.json | consensus.json |

## I/O Contract Reference

These are the JSON schemas each stage expects from its upstream stage:

### pockets.json (pocket-detection → docking, druggability, denovo)

```json
{
  "pockets": [
    {
      "center": [10.5, 22.3, 15.0],
      "volume_A3": 542.8,
      "residues": ["ASP189", "SER195"]
    }
  ]
}
```

**Critical field:** `pockets[0].center` must be `[float, float, float]` — dock.py reads this directly.

### affinity.json (binding-affinity → consensus)

```json
{
  "predictions": [
    {
      "pose_id": 1,
      "predicted_pKd": 7.2,
      "predicted_dG_kcal": -9.8,
      "confidence": "moderate"
    }
  ]
}
```

### consensus.json (final output)

```json
{
  "rankings": [
    {
      "pose_id": 1,
      "consensus_score": 0.85,
      "consensus_rank": 1,
      "individual_ranks": {"predict": 1, "rescore": 2}
    }
  ]
}
```

## Output Directory Structure

After `--mode full`:

```
pipeline_results/
├── pockets.json              # Detected binding pockets
├── druggability.json         # Pocket druggability scores
├── candidates.sdf            # Generated molecules (pre-filter)
├── filtered.sdf              # Drug-like molecules (post-filter)
├── docking/
│   ├── poses.sdf             # Docked poses
│   └── scores.csv            # Docking scores
├── interactions.json          # Protein-ligand interactions
├── affinity.json              # Binding affinity predictions
├── mmgbsa.json                # MM/GBSA rescoring
├── consensus.json             # Final consensus ranking
├── complex_3d.html            # Interactive 3D viewer
├── pipeline_report.json       # Stage timings and status
└── _script_manifest.jsonl     # Full invocation log (for critique)
```

## Script Reference

| Argument | Required | Description |
|----------|----------|-------------|
| `--mode` | Yes | Pipeline mode: full, lead-opt, screen, assess, denovo |
| `--protein` | Yes* | Input PDB file (*or --sequence) |
| `--sequence` | No | Protein sequence (triggers structure prediction if no PDB) |
| `--ligand` | lead-opt | Input ligand SDF file |
| `--library` | screen | Compound library SDF file |
| `--pocket` | No | Pre-computed pocket JSON (skips pocket detection) |
| `--output-dir` | No | Output directory (default: ./pipeline_results/) |
| `--skip` | No | Comma-separated stages to skip |
| `--top-n` | No | Number of top compounds (default: 10) |
| `--docking-method` | No | Docking engine: vina or diffdock (default: vina) |

## Error Recovery

| Error | Cause | Fix |
|-------|-------|-----|
| "Script not found" | Missing skill or wrong OPENSCIENCE_SKILLS_DIR | Set OPENSCIENCE_SKILLS_DIR to skills root or ensure skills are installed |
| "Schema validation failed" | Upstream script produced unexpected output | Check the failed stage's output file manually |
| "No pockets detected" | Protein too small or no clear cavity | Try `--skip pocket-detection` with manual `--pocket` coordinates |
| "Docking failed" | Missing Vina binary or wrong PDB format | Install Vina: `pip install vina`, or use `--docking-method diffdock` |
| "No analogs generated" | Input ligand too complex or invalid SMILES | Check ligand parses in RDKit: `python -c "from rdkit import Chem; print(Chem.MolFromSmiles('...'))"` |

## Related Skills

- **pocket-detection**: Standalone pocket detection with visualization
- **binding-affinity**: Standalone affinity prediction and consensus scoring
- **denovo-design**: Standalone molecule generation with multiple strategies
- **molecular-docking**: Standalone docking with Vina/DiffDock
- **structure-prediction**: Standalone protein structure prediction from sequence
- **molecule-visualization**: Standalone 2D/3D molecular visualization

## References

- Eberhardt, J. et al. "AutoDock Vina 1.2.0." J. Chem. Inf. Model. 61, 3891-3898 (2021).
- Corso, G. et al. "DiffDock: Diffusion Steps, Twists, and Turns for Molecular Docking." ICLR (2023).
- Le Guilloux, V. et al. "Fpocket." BMC Bioinformatics 10, 168 (2009).
- Wang, R. et al. "The PDBbind database." J. Med. Chem. 47, 2977-2980 (2004).

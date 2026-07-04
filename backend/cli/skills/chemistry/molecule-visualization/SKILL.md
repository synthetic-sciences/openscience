---
name: molecule-visualization
description: Publication-quality molecular visualization. 2D structure drawings (PNG/SVG), molecule grids with property annotations, scaffold highlighting, protein-ligand interaction diagrams, and interactive 3D views.
category: chemistry
license: MIT
metadata:
    skill-author: Synthetic Sciences
---

# Molecule Visualization

Generate publication-quality molecular images for drug discovery, medicinal chemistry, and computational chemistry workflows. This skill provides a comprehensive suite of tools for rendering 2D structural drawings, annotated molecule grids, scaffold decomposition views, protein-ligand interaction diagrams, and interactive 3D molecular viewers.

## When to Use

- **2D structure drawings**: Generate clean, high-resolution depictions of small molecules for papers, patents, reports, and presentations.
- **Molecule grids**: Compare compound series side-by-side with property annotations (QED, LogP, MW, etc.).
- **Scaffold highlighting**: Visualize SAR by decomposing molecules into core scaffolds and R-groups.
- **Interaction diagrams**: Summarize protein-ligand binding modes from docking or crystal structures.
- **3D interactive views**: Create browser-based 3D viewers for proteins, ligands, and complexes.

## Installation

All scripts require Python 3.8+ and the following packages:

```bash
# Core (required for all scripts)
pip install rdkit-pypi pillow matplotlib

# For protein-ligand interaction diagrams
pip install biopython

# For 3D interactive views
pip install py3Dmol

# Full installation
pip install rdkit-pypi pillow matplotlib biopython py3Dmol
```

## Core Workflows

### 1. Single Molecule Drawing (`scripts/draw_2d.py`)

Render a single molecule as a high-quality PNG or SVG image.

```bash
# Basic usage
python scripts/draw_2d.py --smiles "c1ccccc1" --output benzene.png

# With atom highlighting and title
python scripts/draw_2d.py \
  --smiles "CC(=O)Oc1ccccc1C(=O)O" \
  --output aspirin.svg \
  --title "Aspirin" \
  --highlight-atoms 0,1,2,3 \
  --highlight-color "#4A90D9"

# Show atom indices for reference
python scripts/draw_2d.py \
  --smiles "c1ccc(NC(=O)c2ccccc2)cc1" \
  --output benzanilide.png \
  --show-atom-indices \
  --size 600x400
```

### 2. Molecule Grid (`scripts/draw_grid.py`)

Compare multiple molecules in a grid layout with optional property annotations.

```bash
# From CSV file
python scripts/draw_grid.py \
  --input compounds.csv \
  --output grid.png \
  --cols 4 \
  --properties "qed,mw,logp"

# From comma-separated SMILES
python scripts/draw_grid.py \
  --input "c1ccccc1,c1ccncc1,c1ccoc1" \
  --output ring_comparison.png \
  --title "Aromatic Ring Comparison"
```

### 3. Scaffold Highlighting (`scripts/draw_scaffold.py`)

Decompose molecules into scaffolds and R-groups for SAR analysis.

```bash
# Manual scaffold specification
python scripts/draw_scaffold.py \
  --smiles "c1ccc(NC(=O)c2ccccc2Cl)cc1" \
  --scaffold "c1ccc(NC(=O)c2ccccc2)cc1" \
  --output scaffold.png

# Automatic Murcko scaffold detection
python scripts/draw_scaffold.py \
  --smiles "CC(=O)Oc1ccccc1C(=O)O" \
  --scaffold auto \
  --output murcko.png

# R-group decomposition across analogs
python scripts/draw_scaffold.py \
  --smiles "c1ccc(NC(=O)c2ccccc2)cc1" \
  --scaffold "c1ccc(NC(=O)c2ccccc2)cc1" \
  --analogs analogs.csv \
  --output rgroup_table.png
```

### 4. Protein-Ligand Interaction Diagram (`scripts/draw_interactions.py`)

Generate 2D interaction diagrams from protein-ligand complexes.

```bash
python scripts/draw_interactions.py \
  --protein receptor.pdb \
  --ligand ligand.sdf \
  --output interactions.png \
  --distance-cutoff 4.0
```

### 5. Interactive 3D View (`scripts/render_3d.py`)

Create self-contained HTML files with interactive 3D molecular viewers.

```bash
# Protein with cartoon representation
python scripts/render_3d.py \
  --input protein.pdb \
  --output view.html \
  --style cartoon \
  --color chain

# Protein-ligand complex
python scripts/render_3d.py \
  --input protein.pdb \
  --ligand ligand.sdf \
  --output complex.html \
  --style cartoon
```

### 6. Pocket Visualization (`scripts/render_3d.py --mode pockets`)

Visualize detected binding pockets as colored spheres on the protein surface. Sphere color indicates druggability: green (>0.7), orange (0.4-0.7), red (<0.4). Sphere size is proportional to pocket volume.

```bash
# After pocket-detection/detect.py or druggability.py
python scripts/render_3d.py \
  --input protein.pdb \
  --pockets druggability.json \
  --mode pockets \
  --output pocket_view.html

# With specific residues highlighted
python scripts/render_3d.py \
  --input protein.pdb \
  --pockets pockets.json \
  --mode pockets \
  --highlight-residues "189,195,57" \
  --output pocket_view.html
```

### 7. Docking Results Visualization (`scripts/render_3d.py --mode docking-results`)

Overlay top docked poses on the protein, colored by rank (green = best, red = worst). The top-ranked pose gets a translucent surface highlight.

```bash
# After molecular-docking/dock.py
python scripts/render_3d.py \
  --input protein.pdb \
  --poses dock_results/poses.sdf \
  --mode docking-results \
  --top-n 5 \
  --output docking_results.html
```

## Script Reference

| Script | Purpose | Key Inputs |
|--------|---------|------------|
| `draw_2d.py` | Single molecule 2D drawing | SMILES, output path |
| `draw_grid.py` | Multi-molecule grid | CSV or SMILES list, output path |
| `draw_scaffold.py` | Scaffold and R-group analysis | SMILES, scaffold, output path |
| `draw_interactions.py` | Protein-ligand interactions | PDB, SDF, output path |
| `render_3d.py` | Interactive 3D viewer | PDB/SDF/SMILES, output HTML |

## Style Guide

See `references/style_guide.md` for detailed guidance on:

- **Colors**: CPK atom coloring scheme (C=gray, N=blue, O=red, S=yellow, Cl=green, etc.)
- **Resolution**: 300 DPI minimum for print; 150 DPI for screen. Vector (SVG) preferred for publications.
- **Font sizes**: 12pt minimum for labels in figures; 8pt minimum for atom indices.
- **Image dimensions**: Single molecule 400x300px default; grid cells 300x250px; interaction diagrams 800x800px.
- **Interaction colors**: Green for H-bonds, gray for hydrophobic, orange for pi-stacking, red for salt bridges.
- **Colorblind-friendly**: Prefer blue/orange instead of red/green when accessibility is a concern.
- **2D vs 3D**: Use 2D for SAR tables, patent figures, and print publications. Use 3D for binding mode analysis, presentations, and supplementary material.

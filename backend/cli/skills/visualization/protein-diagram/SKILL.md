---
name: protein-diagram
description: Publication-quality protein analysis diagrams. Domain architecture maps, secondary structure annotation, Ramachandran plots, contact maps, multiple sequence alignment visualization, and protein feature tracks.
category: visualization
license: MIT
metadata:
    skill-author: Synthetic Sciences
---

# Protein Diagram

Generate publication-quality protein analysis diagrams for structural biology, bioinformatics, and drug discovery workflows. This skill provides tools for rendering domain architecture maps, secondary structure annotations, Ramachandran plots, residue contact maps, colored MSA visualizations, and protein feature tracks.

## When to Use

- **Domain architecture**: Pfam/InterPro-style domain maps showing functional domains, motifs, and regions along a protein sequence.
- **Secondary structure**: Helix/sheet/coil annotation tracks from PDB structures or DSSP assignments.
- **Ramachandran plots**: Phi/psi dihedral angle scatter plots for structure validation and quality assessment.
- **Contact maps**: Residue-residue distance or contact heatmaps from PDB structures for fold analysis.
- **MSA visualization**: Colored multiple sequence alignment plots showing conservation, gaps, and consensus.
- **Feature tracks**: Annotated protein feature maps showing PTMs, binding sites, mutations, and domain boundaries.


### Related Skills
- **structure-prediction**: To predict a 3D structure from sequence before visualization.
- **alphafold-database**: To retrieve a pre-computed AlphaFold structure for visualization.
- **molecule-visualization**: For small-molecule (SMILES) 2D/3D rendering or interactive 3D protein views.

## Important

**This skill handles protein structures (PDB) and sequences (FASTA).** For small-molecule SMILES visualization, use `molecule-visualization`. For 3D interactive protein views, use `molecule-visualization` with `render_3d.py`. For DNA/RNA sequences, use `dna-visualization`.

## Installation

All scripts require Python 3.9+ and the following packages:

```bash
# Core (required for most scripts)
pip install biopython matplotlib numpy

# For MSA visualization
pip install pymsaviz

# For secondary structure (DSSP)
pip install dssp  # or install via: apt-get install dssp / conda install -c salilab dssp

# Full installation
pip install biopython matplotlib numpy pymsaviz
```

## Core Workflows

### 1. Domain Architecture Map (`scripts/draw_domain_map.py`)

Render a linear domain architecture diagram for a protein.

```bash
# From a JSON domain definition
python scripts/draw_domain_map.py \
  --length 450 \
  --domains '[{"name":"SH2","start":10,"end":100,"color":"#e74c3c"},{"name":"Kinase","start":150,"end":400,"color":"#3498db"}]' \
  --output domain_map.png \
  --title "ABL1 Kinase"

# From UniProt ID (fetches InterPro domains)
python scripts/draw_domain_map.py \
  --uniprot P00519 \
  --output abl1_domains.png

# Custom figure size
python scripts/draw_domain_map.py \
  --length 800 \
  --domains domains.json \
  --output domain_map.svg \
  --figsize 12x3 \
  --dpi 300
```

### 2. Secondary Structure Annotation (`scripts/draw_secondary_structure.py`)

Annotate helix/sheet/coil regions from a PDB file using DSSP.

```bash
# From PDB file
python scripts/draw_secondary_structure.py \
  --input structure.pdb \
  --output secondary_structure.png \
  --chain A

# With residue numbering
python scripts/draw_secondary_structure.py \
  --input structure.pdb \
  --output ss_track.svg \
  --chain A \
  --show-residue-numbers \
  --title "Lysozyme Secondary Structure"
```

### 3. Ramachandran Plot (`scripts/draw_ramachandran.py`)

Generate phi/psi dihedral angle scatter plots for structure validation.

```bash
# Basic Ramachandran plot
python scripts/draw_ramachandran.py \
  --input structure.pdb \
  --output ramachandran.png

# Specific chain with Glycine/Proline highlighting
python scripts/draw_ramachandran.py \
  --input structure.pdb \
  --output ramachandran.svg \
  --chain A \
  --highlight-glycine \
  --highlight-proline \
  --title "Ramachandran — Chain A"

# Show favored/allowed/outlier regions
python scripts/draw_ramachandran.py \
  --input structure.pdb \
  --output ramachandran.png \
  --show-regions \
  --dpi 300
```

### 4. Contact Map (`scripts/draw_contact_map.py`)

Generate residue-residue distance or contact heatmaps.

```bash
# Distance matrix from PDB (C-alpha atoms)
python scripts/draw_contact_map.py \
  --input structure.pdb \
  --output contact_map.png \
  --chain A

# Binary contact map with distance cutoff
python scripts/draw_contact_map.py \
  --input structure.pdb \
  --output contacts.svg \
  --chain A \
  --cutoff 8.0 \
  --binary \
  --title "Contact Map — 8Å Cutoff"

# Custom colormap
python scripts/draw_contact_map.py \
  --input structure.pdb \
  --output distance_matrix.png \
  --chain A \
  --cmap viridis_r
```

### 5. MSA Visualization (`scripts/draw_alignment.py`)

Render colored multiple sequence alignment plots.

```bash
# From aligned FASTA
python scripts/draw_alignment.py \
  --input alignment.fasta \
  --output msa.png

# With wrapping and conservation bar
python scripts/draw_alignment.py \
  --input alignment.fasta \
  --output msa.svg \
  --wrap 80 \
  --show-conservation \
  --color-scheme Clustal

# Specific region
python scripts/draw_alignment.py \
  --input alignment.fasta \
  --output msa_region.png \
  --start 100 --end 200 \
  --title "Kinase Domain Alignment"
```

### 6. Protein Feature Tracks (`scripts/draw_features.py`)

Annotate protein features (PTMs, binding sites, mutations, variants) along the sequence.

```bash
# From a JSON feature definition
python scripts/draw_features.py \
  --length 450 \
  --features '[{"name":"Active site","position":271,"type":"site","color":"red"},{"name":"Phospho-Y412","position":412,"type":"ptm","color":"orange"}]' \
  --output features.png \
  --title "ABL1 Features"

# From UniProt ID (fetches annotated features)
python scripts/draw_features.py \
  --uniprot P00519 \
  --output abl1_features.png

# Multiple feature tracks
python scripts/draw_features.py \
  --length 450 \
  --features features.json \
  --output feature_tracks.svg \
  --figsize 14x6
```

## Script Reference

| Script | Purpose | Key Inputs |
|--------|---------|------------|
| `draw_domain_map.py` | Domain architecture diagram | Protein length, domain JSON, output path |
| `draw_secondary_structure.py` | Helix/sheet/coil annotation | PDB file, chain ID, output path |
| `draw_ramachandran.py` | Phi/psi dihedral scatter | PDB file, output path |
| `draw_contact_map.py` | Residue-residue distance heatmap | PDB file, chain ID, cutoff, output |
| `draw_alignment.py` | Colored MSA visualization | Aligned FASTA, output path |
| `draw_features.py` | Protein feature tracks | Length, features JSON, output path |

## Input Formats

| Format | Extension | How to Provide |
|--------|-----------|---------------|
| PDB | `.pdb` | File path (for Ramachandran, contact maps, secondary structure) |
| mmCIF | `.cif` | File path (alternative to PDB) |
| FASTA (aligned) | `.fasta`, `.fa` | File path (for MSA visualization) |
| Clustal | `.aln` | File path (for MSA visualization) |
| JSON | `.json` | File path or inline (for domain/feature definitions) |
| UniProt ID | inline | `--uniprot P00519` (auto-fetches annotations) |

## Style Guide

- **Resolution**: 300 DPI for print; SVG preferred for publications.
- **Colors**: Domain maps use distinct, colorblind-safe colors per domain family. Ramachandran uses standard blue/green/yellow for favored/allowed/generously-allowed regions.
- **Font sizes**: 10pt minimum for domain labels; 8pt for residue numbers.
- **Figure dimensions**: Domain maps 12x3 inches; Ramachandran 8x8 inches; contact maps 8x8 inches; MSA 14x variable.
- **Ramachandran conventions**: Show favored (blue), allowed (green), generously allowed (yellow), and outlier (red/white) regions per Lovell et al. (2003).
- **Contact map colormaps**: Use `viridis_r` or `Blues` for distance matrices; binary contacts use black/white.

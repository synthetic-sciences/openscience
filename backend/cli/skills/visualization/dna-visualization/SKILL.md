---
name: dna-visualization
description: Publication-quality DNA/RNA visualizations. Plasmid maps (circular/linear), sequence logos, restriction enzyme maps, GC content plots, and gene feature annotation tracks from GenBank/FASTA.
category: visualization
license: MIT
metadata:
    skill-author: Synthetic Sciences
---

# DNA Visualization

Generate publication-quality DNA and RNA diagrams for molecular biology, genomics, and synthetic biology workflows. This skill provides tools for rendering annotated plasmid maps, sequence logos from alignments, restriction enzyme site maps, GC content plots, and linear gene feature tracks.

## When to Use

- **Plasmid maps**: Circular or linear plasmid diagrams with annotated features (promoters, genes, origins, terminators) from GenBank files.
- **Sequence logos**: Consensus visualization from multiple sequence alignments showing positional conservation and variability.
- **Restriction maps**: Annotate restriction enzyme cut sites on linear or circular DNA sequences.
- **GC content plots**: Sliding-window GC percentage along a DNA sequence to identify GC-rich/AT-rich regions.
- **Gene maps**: Linear gene/feature annotation tracks from GenBank or GFF files for publication figures.

## Important

**This skill handles DNA/RNA sequences (FASTA, GenBank).** For small-molecule SMILES input, use `molecule-visualization` instead. Never pass a DNA sequence to a SMILES-based tool.

## Installation

All scripts require Python 3.9+ and the following packages:

```bash
# Core (required for all scripts)
pip install biopython matplotlib

# For plasmid maps and gene feature tracks
pip install dna_features_viewer

# For sequence logos
pip install logomaker

# Full installation
pip install biopython matplotlib dna_features_viewer logomaker
```

## Core Workflows

### 1. Plasmid Map (`scripts/draw_plasmid.py`)

Render circular or linear plasmid maps with annotated features from a GenBank file.

```bash
# Circular plasmid map from GenBank
python scripts/draw_plasmid.py \
  --input plasmid.gb \
  --output plasmid_map.png

# Linear map
python scripts/draw_plasmid.py \
  --input plasmid.gb \
  --output plasmid_linear.png \
  --linear

# Custom feature colors and figure size
python scripts/draw_plasmid.py \
  --input plasmid.gb \
  --output plasmid_map.svg \
  --figsize 10x10 \
  --dpi 300
```

### 2. Sequence Logo (`scripts/draw_sequence_logo.py`)

Generate a sequence logo from a multiple sequence alignment (FASTA or Clustal format).

```bash
# From aligned FASTA
python scripts/draw_sequence_logo.py \
  --input alignment.fasta \
  --output logo.png

# Specify logo type (information or probability)
python scripts/draw_sequence_logo.py \
  --input alignment.fasta \
  --output logo.svg \
  --type information \
  --title "Promoter Motif"

# Show specific positions only
python scripts/draw_sequence_logo.py \
  --input alignment.fasta \
  --output logo.png \
  --start 10 --end 30
```

### 3. Restriction Map (`scripts/draw_restriction_map.py`)

Annotate restriction enzyme cut sites on a DNA sequence.

```bash
# Common enzymes on a GenBank sequence
python scripts/draw_restriction_map.py \
  --input sequence.gb \
  --output restriction_map.png

# Specific enzymes on a FASTA sequence
python scripts/draw_restriction_map.py \
  --input sequence.fasta \
  --output restriction_map.png \
  --enzymes EcoRI,BamHI,HindIII,NotI

# Linear display with custom figure width
python scripts/draw_restriction_map.py \
  --input sequence.gb \
  --output restriction_map.svg \
  --linear \
  --figwidth 16
```

### 4. GC Content Plot (`scripts/draw_gc_content.py`)

Plot sliding-window GC percentage along a DNA sequence.

```bash
# Default 100bp window
python scripts/draw_gc_content.py \
  --input sequence.fasta \
  --output gc_plot.png

# Custom window size and step
python scripts/draw_gc_content.py \
  --input sequence.fasta \
  --output gc_plot.svg \
  --window 200 \
  --step 50 \
  --title "GC Content — pUC19"

# Show threshold line
python scripts/draw_gc_content.py \
  --input sequence.gb \
  --output gc_plot.png \
  --threshold 0.5
```

### 5. Gene Map (`scripts/draw_gene_map.py`)

Linear gene/feature annotation tracks from GenBank or GFF files.

```bash
# From GenBank file
python scripts/draw_gene_map.py \
  --input genome_region.gb \
  --output gene_map.png

# Specific region only
python scripts/draw_gene_map.py \
  --input chromosome.gb \
  --output region.png \
  --start 10000 --end 25000

# Custom figure dimensions
python scripts/draw_gene_map.py \
  --input genome_region.gb \
  --output gene_map.svg \
  --figsize 14x4 \
  --dpi 300
```

## Script Reference

| Script | Purpose | Key Inputs |
|--------|---------|------------|
| `draw_plasmid.py` | Circular/linear plasmid maps | GenBank file, output path |
| `draw_sequence_logo.py` | Sequence logo from MSA | Aligned FASTA/Clustal, output path |
| `draw_restriction_map.py` | Restriction enzyme cut sites | GenBank/FASTA, enzyme list, output |
| `draw_gc_content.py` | Sliding-window GC% plot | FASTA/GenBank, window size, output |
| `draw_gene_map.py` | Linear gene feature tracks | GenBank/GFF, output path |

## Input Formats

| Format | Extension | How to Provide |
|--------|-----------|---------------|
| GenBank | `.gb`, `.gbk`, `.genbank` | File path (contains sequence + feature annotations) |
| FASTA | `.fasta`, `.fa`, `.fna` | File path (sequence only, no annotations) |
| Clustal | `.aln`, `.clustal` | File path (for sequence logos from alignments) |
| Raw sequence | inline | `--sequence ATCGATCG...` (some scripts support this) |

## Style Guide

- **Resolution**: 300 DPI for print; SVG preferred for publications.
- **Colors**: Use colorblind-safe palettes. Default feature colors follow standard conventions: blue for CDS/genes, green for promoters, red for terminators, orange for origins of replication.
- **Font sizes**: 10pt minimum for feature labels; 8pt for nucleotide positions.
- **Figure dimensions**: Plasmid maps 8x8 inches default; linear maps 14x4 inches; logos 10x3 inches.
- **Sequence logos**: Use bits (information content) for conservation analysis; use probability for frequency visualization.

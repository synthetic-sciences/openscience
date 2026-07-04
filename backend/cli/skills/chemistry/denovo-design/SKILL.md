---
name: denovo-design
description: De novo molecule generation for drug discovery. Scaffold-based analog enumeration, fragment growing/linking, structure-based design, multi-objective optimization, and drug-likeness filtering.
category: chemistry
license: MIT
metadata:
    skill-author: Synthetic Sciences
---

# De Novo Molecule Design

## Overview

De novo design is the computational generation of novel molecular structures with desired properties, without starting from known active compounds. This skill provides a complete toolkit for generating drug candidates through multiple complementary strategies: scaffold-based analog enumeration, fragment-based design, structure-based design (SBDD), multi-objective optimization, and drug-likeness filtering.

All generation strategies produce molecules with computed physicochemical properties and similarity metrics, enabling rapid prioritization. The scripts are designed for CPU-first execution using RDKit as the core cheminformatics engine, with optional GPU acceleration noted where applicable.

## When to Use This Skill

Use this skill when you need to:

- **Explore chemical space** around a known lead compound by generating analogs with R-group enumeration, bioisosteric replacements, or random mutations
- **Design molecules from fragments** by growing, linking, or merging fragment hits from screening campaigns
- **Generate molecules for a protein target** using pocket shape complementarity or pharmacophore constraints
- **Optimize a set of hits** against multiple objectives (QED, LogP, synthetic accessibility, molecular weight) through iterative refinement
- **Filter compound libraries** for drug-likeness using Lipinski, Veber, PAINS, Brenk alerts, lead-like, fragment-like, or beyond Rule of Five criteria
- **Enumerate focused libraries** for virtual screening or synthesis planning

## Installation

```bash
pip install rdkit-pypi datamol numpy pandas
```

Optional (for enhanced fragment design and structure-based approaches):

```bash
pip install scipy
```

For structure-based design with PDB parsing:

```bash
pip install biopython
```

## Choosing the Right Strategy

| Scenario | Script | Strategy |
|----------|--------|----------|
| Have a lead compound, want analogs | `generate_analogs.py` | R-group, bioisostere, mutate |
| Have fragment screening hits | `generate_fragments.py` | grow, link, merge |
| Have a protein structure / pocket | `generate_sbdd.py` | shape, pharmacophore |
| Have hits, need property optimization | `optimize.py` | multi-objective iterative |
| Have a library, need filtering | `filter.py` | lipinski, veber, pains, etc. |

## Core Workflows

### 1. Analog Generation

Generate structural analogs of a lead compound using three complementary strategies.

```bash
# Generate 50 analogs using all strategies
python scripts/generate_analogs.py --smiles "c1ccc(NC(=O)c2ccccc2)cc1" --output analogs.csv --num 50 --strategy all

# Only bioisosteric replacements
python scripts/generate_analogs.py --smiles "c1ccc(NC(=O)c2ccccc2)cc1" --output analogs.csv --strategy bioisostere

# Only R-group enumeration
python scripts/generate_analogs.py --smiles "c1ccc(NC(=O)c2ccccc2)cc1" --output analogs.csv --strategy rgroup
```

Strategies:
- **R-group enumeration**: Identifies aromatic and sp3 carbon positions, enumerates common substituents (methyl, ethyl, halides, CF3, OMe, NH2, OH, CN, etc.)
- **Bioisosteric replacement**: Swaps functional groups using a curated dictionary (COOH to tetrazole, phenyl to thienyl, amide to sulfonamide, ester to oxadiazole, etc.)
- **Random mutation**: Fragment-based random modifications to the molecular graph

Output CSV includes: id, smiles, mw, logp, qed, tanimoto_to_parent, strategy.

### 2. Fragment-Based Design

Build drug-like molecules from fragment hits.

```bash
# Grow a fragment by adding substituents
python scripts/generate_fragments.py --fragments "c1cc[nH]c1" --mode grow --output grown.csv --num 50

# Link two fragments
python scripts/generate_fragments.py --fragments "c1cc[nH]c1,c1ccccc1O" --mode link --output linked.csv --num 50

# Merge fragment pharmacophores
python scripts/generate_fragments.py --fragments "c1cc[nH]c1,c1ccccc1O" --mode merge --output merged.csv --num 50
```

Modes:
- **Grow**: Adds substituents at attachment points on a single fragment
- **Link**: Connects two fragments with linkers (alkyl chains, amides, ethers, piperazines, etc.)
- **Merge**: Combines pharmacophoric features of two fragments into hybrid molecules

### 3. Structure-Based Design (SBDD)

Generate molecules complementary to a protein binding pocket.

```bash
# Shape-based design from a PDB file
python scripts/generate_sbdd.py --protein target.pdb --pocket-residues "ASP189,SER195,HIS57" --method shape --output sbdd_hits.csv --num 100

# Pharmacophore-based design
python scripts/generate_sbdd.py --protein target.pdb --pocket-residues auto --method pharmacophore --output sbdd_hits.csv --num 100
```

Methods:
- **Shape-based** (CPU): Generates molecules complementing the pocket shape using fragment assembly
- **Pharmacophore** (CPU): Defines pharmacophore features from pocket residues and generates matching molecules

Note: For production SBDD, consider GPU-accelerated methods like DiffSBDD or Pocket2Mol. This script provides a CPU-based starting point.

### 4. Multi-Objective Optimization

Iteratively optimize a set of compounds against multiple property objectives.

```bash
# Optimize for QED and LogP with constraints
python scripts/optimize.py --input hits.csv --objectives qed,logp,sa --constraints "mw<500,logp<5,qed>0.5" --output optimized.csv --num-iterations 3
```

The optimizer runs iterative cycles: generate analogs, compute properties, filter by constraints, rank by multi-objective score, select top compounds for the next round.

### 5. Drug-Likeness Filtering

Apply standard medicinal chemistry filters to compound libraries.

```bash
# Apply Lipinski and PAINS filters
python scripts/filter.py --input library.csv --output filtered.csv --filters lipinski,pains

# Apply all available filters
python scripts/filter.py --input library.csv --output filtered.csv --filters lipinski,veber,qed,pains,brenk,leadlike,fragmentlike,bro5

# Custom thresholds
python scripts/filter.py --input library.csv --output filtered.csv --filters qed,pains --qed-threshold 0.6 --sa-threshold 5.0
```

Available filters:
- **Lipinski Ro5**: MW <= 500, LogP <= 5, HBD <= 5, HBA <= 10
- **Veber**: RotBonds <= 10, TPSA <= 140
- **QED**: Quantitative drug-likeness score above threshold
- **PAINS**: Pan-assay interference compounds (RDKit FilterCatalog)
- **Brenk**: Structural alerts for reactive/toxic groups
- **Lead-like**: MW 200-350, LogP -1 to 3
- **Fragment-like (Ro3)**: MW <= 300, LogP <= 3, HBD <= 3, HBA <= 3
- **bRo5**: Beyond Rule of Five for natural product-like space (MW 500-1000, LogP -2 to 10)
- **SA score**: Synthetic accessibility (1 = easy, 10 = hard)

## Tips

- **Start broad, then narrow**: Use `generate_analogs.py` with `--strategy all` first, then filter with `filter.py`, then optimize survivors with `optimize.py`.
- **Fragment merging is powerful**: If you have multiple fragment hits from an FBDD campaign, merging can produce leads that retain key interactions from both fragments.
- **Combine SBDD with filtering**: Structure-based hits often need medicinal chemistry optimization. Pipe SBDD output through `filter.py` and `optimize.py`.
- **Check synthetic accessibility**: Always include SA score in your analysis. A beautiful molecule is useless if it cannot be synthesized. Use `--sa-threshold 5.0` or lower for practical compounds.
- **Deduplicate early**: All generation scripts deduplicate by canonical SMILES, but if you combine outputs from multiple runs, deduplicate again before downstream analysis.
- **Property distributions matter**: Look at the property distribution summaries printed by each script. Bimodal distributions or outliers can indicate issues with the generation strategy.

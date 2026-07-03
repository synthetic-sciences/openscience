# Pocket Detection Methods Guide

## Overview

This guide explains the three detection methods available in the pocket-detection skill, when to use each, and how to interpret their results.

## Method 1: Grid-Based Cavity Detection (Built-in)

### Algorithm

1. Construct a 3D grid (default 1.0 A spacing) around the protein with 6 A margin
2. For each grid point, classify as:
   - **Protein interior**: within 2.2 A (vdW + 0.5) of any protein atom
   - **Bulk solvent**: no protein atoms within 5.1 A (vdW + probe + 2.0)
   - **Cavity candidate**: between inner and outer cutoff, with atoms in >= 3 directional octants (indicating burial)
3. Cluster cavity points using hierarchical clustering (DBSCAN-style, eps=3.5 A)
4. Filter clusters by minimum size (30 points) and volume
5. Compute per-pocket: center, volume (convex hull), bounding box, depth, nearby residues

### Strengths
- No external dependencies (only BioPython + NumPy + SciPy)
- Deterministic and reproducible
- Good for standard deep cavities

### Limitations
- Slow on large proteins (>5000 residues): O(grid_points * n_atoms)
- Grid resolution limits small pocket detection
- May detect crystal-contact artifacts
- Cannot distinguish functional from non-functional cavities

### When to Use
- Default method when no external tools are installed
- Quick analysis where speed matters less than convenience
- Structures with clear, deep binding pockets

### Tuning Parameters
- `--grid-spacing`: Lower = more resolution but slower (0.5 A for small pockets, 1.5 A for large proteins)
- `--min-volume`: Raise to 200+ to filter fragment-sized pockets
- `--max-pockets`: Default 10 is sufficient for most proteins

## Method 2: fpocket (Alpha Sphere)

### Algorithm

fpocket uses Voronoi tessellation and alpha spheres:
1. Compute Voronoi tessellation of protein atoms
2. For each Voronoi vertex, compute the alpha sphere (smallest sphere touching 4 atoms)
3. Filter alpha spheres by size: too small = protein interior, too large = solvent
4. Cluster alpha spheres into pockets
5. Rank by druggability score (based on pocket properties)

### Strengths
- Fast (seconds even for large proteins)
- Well-validated (benchmark studies show good performance)
- Handles flexible/partially open pockets well
- Returns druggability estimates

### Limitations
- Requires external binary installation
- Sensitive to hydrogen atoms (add/remove consistently)
- Can over-segment large cavities

### When to Use
- Preferred method when installed
- Large proteins where grid method is too slow
- Exploratory analysis of many structures

### Installation
```bash
# Ubuntu/Debian
sudo apt-get install fpocket

# macOS
brew install fpocket

# From source
git clone https://github.com/Discngine/fpocket.git
cd fpocket && make && sudo make install
```

## Method 3: P2Rank (Machine Learning)

### Algorithm

P2Rank is a machine learning method:
1. Compute connolly surface points on the protein
2. Extract features for each surface point (geometry, chemical properties, evolutionary conservation)
3. Random forest classifier predicts binding probability per point
4. Cluster high-probability points into pockets
5. Rank by aggregate prediction score

### Strengths
- Highest accuracy on benchmarks (Chen et al. 2021)
- Learns from known binding site patterns
- Probability scores are well-calibrated
- Handles unusual pocket geometries

### Limitations
- Requires Java + external binary
- Larger installation footprint
- Prediction quality depends on training data coverage

### When to Use
- When highest accuracy is needed
- Novel targets where geometry alone may be insufficient
- Validation of pockets found by other methods

### Installation
```bash
# Download latest release
wget https://github.com/rdk/p2rank/releases/download/2.4.2/p2rank_2.4.2.tar.gz
tar -xzf p2rank_2.4.2.tar.gz
export P2RANK_HOME=$(pwd)/p2rank_2.4.2
```

## Method Selection Guide

| Scenario | Recommended Method | Why |
|----------|-------------------|-----|
| Quick analysis, no external tools | `grid` | Built-in, no setup |
| Large protein (>3000 residues) | `fpocket` or `p2rank` | Grid too slow |
| Highest accuracy needed | `p2rank` | Best benchmark performance |
| Novel/unusual target | `p2rank` then `grid` | ML + geometry consensus |
| Apo structure (no ligand) | `auto` | Tries best available |
| Holo structure (has ligand) | `grid --include-ligand-sites` | Use ligand as ground truth |
| Multiple structures to compare | `grid` | Consistent method across all |

## Auto Mode

`--method auto` tries methods in order of accuracy:
1. P2Rank (if `P2RANK_HOME` is set or `prank` is in PATH)
2. fpocket (if `fpocket` is in PATH)
3. Grid (always available)

## Consensus Strategy

For high-confidence pocket identification, run all available methods:

```bash
python detect.py --input protein.pdb --output grid.json --method grid
python detect.py --input protein.pdb --output fpocket.json --method fpocket
python detect.py --input protein.pdb --output p2rank.json --method p2rank
```

Then compare:
```bash
python visualize.py --input protein.pdb --pockets grid.json fpocket.json p2rank.json \
    --labels Grid fpocket P2Rank --output consensus.png --plot-type method-comparison
```

Pockets detected by all 3 methods (centers within 5 A) have the highest confidence.

## References

- Le Guilloux, V. et al. "Fpocket: an open source platform for ligand pocket detection." BMC Bioinformatics 10, 168 (2009).
- Krivak, R. & Hoksza, D. "P2Rank: machine learning based tool for rapid and accurate prediction of ligand binding sites." J. Cheminform. 10, 39 (2018).
- Chen, J. et al. "Predicting protein-ligand binding residues with deep convolutional neural networks." BMC Bioinformatics 22, 289 (2021).
- Halgren, T.A. "Identifying and characterizing binding sites and assessing druggability." J. Chem. Inf. Model. 49, 377-389 (2009).

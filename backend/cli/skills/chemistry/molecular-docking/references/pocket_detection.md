# Pocket Detection Methods and Druggability Assessment

## Overview

Binding pocket detection is a critical first step in structure-based drug design. A pocket (or binding site) is a cavity on the protein surface where a small molecule ligand can bind. Accurate pocket identification determines the quality of downstream docking results.

## Detection Methods

### 1. Ligand-Based Detection (Highest Confidence)

When a co-crystallized ligand is present in the PDB structure (HETATM records), the pocket is defined by protein residues within a distance cutoff (typically 6-8 Angstroms) of the ligand atoms.

**When to use:** Always preferred when a reference ligand is available. This is the gold standard for known binding sites.

**Implemented in:** `prepare_target.py` automatically detects HETATM groups and identifies surrounding residues using BioPython's NeighborSearch.

**Limitations:**
- Only works for proteins with co-crystallized ligands
- May miss allosteric or secondary binding sites
- Pocket shape may be biased by the specific ligand present

### 2. Grid-Based Cavity Detection (Geometry-Driven)

A 3D grid is placed around the protein. Grid points are classified as protein interior, solvent, or cavity based on their distance to protein atoms and the degree of burial (enclosure by protein atoms from multiple directions).

**Algorithm steps:**
1. Construct a regular 3D grid with spacing ~1.0 Angstroms around the protein
2. For each grid point, compute distances to nearby protein atoms
3. Classify points as:
   - **Protein interior**: within van der Waals radius of an atom
   - **Bulk solvent**: no protein atoms within outer cutoff
   - **Cavity candidate**: between inner and outer cutoff, with atoms in at least 3 directional octants (indicating burial)
4. Cluster cavity points into pockets using distance-based grouping
5. Rank pockets by number of cavity points (proxy for volume)

**When to use:** General-purpose detection for apo structures (no ligand) or when searching for novel binding sites.

**Limitations:**
- Computationally more expensive than ligand-based detection
- Grid spacing affects resolution and runtime
- May detect non-functional cavities (crystal contacts, solvent channels)

### 3. Alpha Sphere Methods (fpocket-style)

Alpha spheres are spheres that contact exactly four atoms on their boundary and contain no atom in their interior. Dense clusters of small alpha spheres indicate buried cavities.

**Not directly implemented** in the current pipeline. Use the external tool `fpocket` for this approach:
```bash
fpocket -f protein.pdb
```

### 4. Energy-Based Methods (SiteMap-style)

Evaluate each detected cavity for favorable van der Waals and electrostatic interactions with probe molecules (water, methane, amine). Sites with favorable energetics are more likely to bind drug-like molecules.

**Not directly implemented.** Consider using Schrodinger SiteMap or DoGSiteScorer for energy-based analysis.

## Druggability Assessment

Not all pockets can bind drug-like molecules. Druggability refers to the likelihood that a small molecule can bind with sufficient affinity to modulate protein function.

### Key Druggability Criteria

| Property | Druggable | Difficult | Undruggable |
|----------|-----------|-----------|-------------|
| Volume (A^3) | 300-1500 | 150-300 or >1500 | <150 |
| Enclosure | >0.5 | 0.3-0.5 | <0.3 |
| Hydrophobicity | 0.3-0.7 | <0.3 or >0.7 | - |
| Hydrogen bond sites | 2-8 | >8 or <2 | 0 |
| Pocket depth (A) | >5 | 3-5 | <3 |

### Volume Interpretation

- **< 150 A^3**: Too small for drug-like molecules. May bind fragments or ions.
- **150-300 A^3**: Fragment-sized pocket. Suitable for fragment-based drug design.
- **300-800 A^3**: Ideal drug-like pocket. Most approved drugs bind in this range.
- **800-1500 A^3**: Large pocket. May require extended molecules or PROTACs.
- **> 1500 A^3**: Very large or flat. Likely a protein-protein interaction surface. Consider peptide or macrocycle inhibitors.

### Hydrophobicity Balance

The ideal pocket has a mix of hydrophobic and polar character:
- **Hydrophobic floor/walls** provide binding energy through desolvation entropy
- **Polar rim/ceiling** provides specificity through directional hydrogen bonds
- **Fully hydrophobic** pockets are harder to target with selective inhibitors
- **Fully polar** pockets have weaker binding due to water competition

### Shape Complementarity

- **Deep, enclosed pockets** (tunnel-like) are highly druggable
- **Shallow, exposed pockets** require larger contact areas
- **Pockets with "sub-pockets"** allow selectivity optimization
- **Flat surfaces** (common in PPI interfaces) require specialized approaches

## Interpreting Pocket Properties from prepare_target.py

### Center Coordinates

The pocket center is the geometric mean of all cavity grid points or ligand-proximal residue atoms. Use these directly as `--center_x/y/z` arguments in the docking step.

### Volume Estimate

When SciPy is available, volume is computed as the convex hull volume of cavity points. Otherwise, it is estimated as `n_grid_points * grid_spacing^3`. The convex hull tends to overestimate, while grid-based underestimates; the true cavity volume typically lies between these values.

### Residue List

The pocket residues define the binding site composition. Important residues to look for:
- **Catalytic residues** (SER, HIS, ASP in serine proteases)
- **Charged residues** (LYS, ARG, GLU, ASP) for salt bridge potential
- **Aromatic residues** (PHE, TYR, TRP) for pi-stacking
- **Backbone amides** that line the pocket for hydrogen bonding

### Using Multiple Pockets

When multiple pockets are detected:
1. **Pocket 1** (from co-crystallized ligand): Use for standard docking campaigns
2. **Pocket 2+** (from cavity detection): May represent allosteric sites
3. Consider docking to each pocket independently and comparing scores
4. Pockets near known functional sites (e.g., catalytic residues) are higher priority

## Manual Pocket Specification

If automatic detection fails or you want to target a specific site:

```bash
# Use known residue coordinates as the pocket center
python dock.py --protein target.pdb --ligand ligand.sdf --output-dir results/ \
    --center_x 25.0 --center_y 30.0 --center_z 15.0 \
    --size_x 25 --size_y 25 --size_z 25
```

Tips for manual specification:
- Use a molecular viewer (PyMOL, ChimeraX) to identify the binding site
- Center on the catalytic or functional residues of interest
- Set box size 5-10 Angstroms larger than the expected ligand diameter
- For blind docking (unknown site), use a large box covering the entire protein with high exhaustiveness

## Recommended External Tools

| Tool | Method | Availability | Best For |
|------|--------|-------------|----------|
| fpocket | Alpha spheres | Open source | Fast cavity detection |
| DoGSiteScorer | Grid + ML | Free web | Druggability prediction |
| SiteMap | Energy-based | Commercial (Schrodinger) | Detailed druggability |
| P2Rank | Machine learning | Open source | High accuracy detection |
| DeepSite | Deep learning | Free web | Novel site prediction |
| CavityPlus | Multiple methods | Free web | Comprehensive analysis |

## References

- Le Guilloux, V. et al. "Fpocket: an open source platform for ligand pocket detection." BMC Bioinformatics 10, 168 (2009).
- Halgren, T.A. "Identifying and characterizing binding sites and assessing druggability." J. Chem. Inf. Model. 49, 377-389 (2009).
- Krivak, R. & Hoksza, D. "P2Rank: machine learning based tool for rapid and accurate prediction of ligand binding sites." J. Cheminform. 10, 39 (2018).
- Volkamer, A. et al. "DoGSiteScorer: a web server for automatic binding site prediction, analysis and druggability assessment." Bioinformatics 28, 2074-2075 (2012).

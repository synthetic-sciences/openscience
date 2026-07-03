---
name: synthetic-biology
description: Synthetic biology design and simulation tools. Codon optimization, gene circuit ODE modeling with growth feedback, SBML model creation, bifurcation analysis, barcode sequencing fitness analysis, and therapeutic genome engineering. For metabolic modeling use cobrapy; for sequence tools use biopython.
category: biology
license: MIT license
metadata:
    skill-author: InkVell Inc.
---

# Synthetic Biology: Design & Simulation

## Overview

Synthetic Biology provides computational tools for designing and simulating engineered biological systems. This skill covers codon optimization with species-specific usage tables, gene circuit ODE modeling (repressilator, toggle switch, inducible promoters) with growth dilution coupling, SBML model creation and validation using python-libsbml, bifurcation analysis for bistable circuits, barcode sequencing fitness analysis, and genome engineering with expression cassette insertion. All simulations produce quantitative outputs suitable for guiding experimental design.

## When to Use This Skill

- Optimizing gene sequences for heterologous expression (codon adaptation)
- Simulating gene circuit dynamics (toggle switches, repressilators, inducible systems)
- Creating standardized SBML models of biological networks
- Analyzing bistability and bifurcation behavior in synthetic circuits
- Processing barcode sequencing data for fitness landscape analysis
- Designing expression cassettes and generating annotated plasmid maps
- Sensitivity analysis of circuit parameters for robust design

**Related Skills:** For constraint-based metabolic modeling use `cobrapy`. For sequence manipulation and file parsing use `biopython`. For molecular cloning simulation use `molecular-cloning`.

## Installation

```bash
uv pip install python-libsbml scipy biopython numpy pandas matplotlib
```

## Quick Start

```python
import numpy as np
from scipy.integrate import solve_ivp

# Toggle switch: two mutually repressing genes
def toggle_switch(t, y, alpha1, alpha2, beta, n, gamma):
    u, v = y  # Protein concentrations
    du = alpha1 / (1 + v**n) - (beta + gamma) * u  # gamma = growth dilution
    dv = alpha2 / (1 + u**n) - (beta + gamma) * v
    return [du, dv]

sol = solve_ivp(toggle_switch, [0, 50], [0.1, 3.0],
                args=(5.0, 5.0, 0.5, 2.0, 0.1),
                t_eval=np.linspace(0, 50, 500))

print(f"Final state: u={sol.y[0,-1]:.3f}, v={sol.y[1,-1]:.3f}")
print(f"Bistable: {'Yes' if abs(sol.y[0,-1] - sol.y[1,-1]) > 0.5 else 'No'}")
```

## Core Capabilities

### 1. Codon Optimization

Optimize gene sequences for expression in target organisms.

```python
import numpy as np
from collections import Counter

# E. coli codon usage table (fraction per amino acid)
ECOLI_CODON_TABLE = {
    'F': {'TTT': 0.58, 'TTC': 0.42},
    'L': {'TTA': 0.11, 'TTG': 0.11, 'CTT': 0.10, 'CTC': 0.10, 'CTA': 0.04, 'CTG': 0.54},
    'I': {'ATT': 0.49, 'ATC': 0.39, 'ATA': 0.07},
    'M': {'ATG': 1.0},
    'V': {'GTT': 0.28, 'GTC': 0.20, 'GTA': 0.17, 'GTG': 0.35},
    'S': {'TCT': 0.17, 'TCC': 0.15, 'TCA': 0.14, 'TCG': 0.14, 'AGT': 0.16, 'AGC': 0.25},
    'P': {'CCT': 0.18, 'CCC': 0.13, 'CCA': 0.20, 'CCG': 0.49},
    'T': {'ACT': 0.19, 'ACC': 0.40, 'ACA': 0.17, 'ACG': 0.25},
    'A': {'GCT': 0.18, 'GCC': 0.26, 'GCA': 0.23, 'GCG': 0.33},
    'Y': {'TAT': 0.59, 'TAC': 0.41},
    '*': {'TAA': 0.61, 'TAG': 0.09, 'TGA': 0.30},
    'H': {'CAT': 0.57, 'CAC': 0.43},
    'Q': {'CAA': 0.34, 'CAG': 0.66},
    'N': {'AAT': 0.49, 'AAC': 0.51},
    'K': {'AAA': 0.74, 'AAG': 0.26},
    'D': {'GAT': 0.63, 'GAC': 0.37},
    'E': {'GAA': 0.68, 'GAG': 0.32},
    'C': {'TGT': 0.46, 'TGC': 0.54},
    'W': {'TGG': 1.0},
    'R': {'CGT': 0.36, 'CGC': 0.36, 'CGA': 0.07, 'CGG': 0.11, 'AGA': 0.07, 'AGG': 0.04},
    'G': {'GGT': 0.35, 'GGC': 0.37, 'GGA': 0.13, 'GGG': 0.15},
}

CODON_TO_AA = {}
for aa, codons in ECOLI_CODON_TABLE.items():
    for codon in codons:
        CODON_TO_AA[codon] = aa

def calculate_cai(dna_seq, codon_table=ECOLI_CODON_TABLE):
    """Calculate Codon Adaptation Index."""
    codons = [dna_seq[i:i+3] for i in range(0, len(dna_seq)-2, 3)]
    weights = []

    for codon in codons:
        aa = CODON_TO_AA.get(codon)
        if aa and aa != '*':
            aa_codons = codon_table[aa]
            max_freq = max(aa_codons.values())
            w = aa_codons.get(codon, 0) / max_freq if max_freq > 0 else 0
            if w > 0:
                weights.append(np.log(w))

    cai = np.exp(np.mean(weights)) if weights else 0
    return cai

def optimize_codons(protein_seq, codon_table=ECOLI_CODON_TABLE,
                    gc_min=0.40, gc_max=0.60):
    """Optimize codons for target organism."""
    optimized = []

    for aa in protein_seq:
        if aa == '*':
            break
        if aa not in codon_table:
            raise ValueError(f"Unknown amino acid: {aa}")

        codons = codon_table[aa]
        # Select highest-frequency codon
        best_codon = max(codons, key=codons.get)
        optimized.append(best_codon)

    dna_seq = ''.join(optimized)

    # Check GC content
    gc = (dna_seq.count('G') + dna_seq.count('C')) / len(dna_seq)
    cai = calculate_cai(dna_seq, codon_table)

    print(f"Optimized sequence: {len(dna_seq)} bp")
    print(f"GC content: {gc:.1%}")
    print(f"CAI: {cai:.4f}")

    if gc < gc_min or gc > gc_max:
        print(f"WARNING: GC content {gc:.1%} outside target range [{gc_min:.0%}-{gc_max:.0%}]")

    return dna_seq, cai, gc

# Example
protein = "MSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKL"  # GFP fragment
opt_dna, cai, gc = optimize_codons(protein)
```

### 2. Gene Circuit Simulation

ODE models for common synthetic gene circuits.

```python
import numpy as np
from scipy.integrate import solve_ivp

def repressilator(t, y, alpha, n, beta, gamma):
    """Repressilator: 3-gene oscillator (Elowitz & Leibler).
    gamma = growth dilution rate."""
    m1, p1, m2, p2, m3, p3 = y

    dm1 = alpha / (1 + p3**n) - (beta + gamma) * m1
    dp1 = m1 - (beta + gamma) * p1
    dm2 = alpha / (1 + p1**n) - (beta + gamma) * m2
    dp2 = m2 - (beta + gamma) * p2
    dm3 = alpha / (1 + p2**n) - (beta + gamma) * m3
    dp3 = m3 - (beta + gamma) * p3

    return [dm1, dp1, dm2, dp2, dm3, dp3]

def inducible_promoter(t, y, V_max, Km, n, beta, gamma, inducer_conc):
    """Inducible gene expression (Hill function)."""
    mRNA, protein = y
    induction = V_max * inducer_conc**n / (Km**n + inducer_conc**n)
    dmRNA = induction - (beta + gamma) * mRNA
    dprotein = mRNA - (beta + gamma) * protein
    return [dmRNA, dprotein]

# Simulate repressilator
y0 = [0.5, 1.0, 0.0, 0.0, 0.0, 0.0]
sol = solve_ivp(repressilator, [0, 200], y0,
                args=(5.0, 2.0, 0.5, 0.1),
                t_eval=np.linspace(0, 200, 2000),
                method='RK45')

# Check for oscillation
from scipy.signal import find_peaks
peaks, _ = find_peaks(sol.y[1])
if len(peaks) > 2:
    period = np.mean(np.diff(sol.t[peaks]))
    print(f"Oscillation period: {period:.1f} time units")
    print(f"Amplitude: {sol.y[1, peaks].mean() - sol.y[1].min():.3f}")
else:
    print("No sustained oscillations detected")

# Parameter sensitivity analysis
def sensitivity_analysis(param_name, param_values, base_params, y0, t_span):
    """Sweep one parameter and measure output."""
    results = []
    for val in param_values:
        params = base_params.copy()
        params[param_name] = val
        sol = solve_ivp(repressilator, t_span, y0,
                        args=tuple(params.values()),
                        t_eval=np.linspace(*t_span, 500))
        # Measure amplitude
        amplitude = sol.y[1].max() - sol.y[1].min()
        results.append({'param_value': val, 'amplitude': amplitude})
    return pd.DataFrame(results)
```

### 3. SBML Model Creation

Build standardized SBML models with python-libsbml.

```python
import libsbml

def create_sbml_model(model_name, compartments, species_list, reactions):
    """Create SBML Level 3 model.

    Args:
        model_name: string name
        compartments: list of (id, size) tuples
        species_list: list of (id, compartment, initial_amount) tuples
        reactions: list of dicts with 'id', 'reactants', 'products', 'kinetic_law'
    """
    doc = libsbml.SBMLDocument(3, 2)
    model = doc.createModel()
    model.setId(model_name)

    # Compartments
    for comp_id, size in compartments:
        c = model.createCompartment()
        c.setId(comp_id)
        c.setConstant(True)
        c.setSize(size)
        c.setSpatialDimensions(3)

    # Species
    for sp_id, comp_id, init_amount in species_list:
        s = model.createSpecies()
        s.setId(sp_id)
        s.setCompartment(comp_id)
        s.setInitialAmount(init_amount)
        s.setConstant(False)
        s.setBoundaryCondition(False)
        s.setHasOnlySubstanceUnits(False)

    # Reactions
    for rxn in reactions:
        r = model.createReaction()
        r.setId(rxn['id'])
        r.setReversible(rxn.get('reversible', False))

        for reactant_id, stoich in rxn.get('reactants', []):
            sr = r.createReactant()
            sr.setSpecies(reactant_id)
            sr.setStoichiometry(stoich)
            sr.setConstant(True)

        for product_id, stoich in rxn.get('products', []):
            sp = r.createProduct()
            sp.setSpecies(product_id)
            sp.setStoichiometry(stoich)
            sp.setConstant(True)

        kl = r.createKineticLaw()
        kl.setMath(libsbml.parseL3Formula(rxn['kinetic_law']))

        # Add parameters
        for param_id, value in rxn.get('parameters', []):
            p = kl.createLocalParameter()
            p.setId(param_id)
            p.setValue(value)

    # Validate
    errors = doc.getNumErrors()
    if errors > 0:
        for i in range(errors):
            print(f"SBML Error: {doc.getError(i).getMessage()}")

    return doc

# Example: simple enzymatic reaction
doc = create_sbml_model(
    'enzyme_kinetics',
    compartments=[('cell', 1.0)],
    species_list=[('S', 'cell', 10.0), ('P', 'cell', 0.0), ('E', 'cell', 1.0)],
    reactions=[{
        'id': 'v1',
        'reactants': [('S', 1)],
        'products': [('P', 1)],
        'kinetic_law': 'Vmax * S / (Km + S)',
        'parameters': [('Vmax', 1.0), ('Km', 0.5)]
    }]
)

# Write to file
libsbml.writeSBMLToFile(doc, 'model.xml')
print("SBML model written to model.xml")
```

### 4. Bifurcation Analysis

Identify bistability in gene circuits.

```python
import numpy as np
from scipy.optimize import fsolve

def toggle_steady_states(alpha1, alpha2, n, beta):
    """Find steady states of toggle switch by sweeping inducer."""
    def steady_state_eq(x, alpha1_eff, alpha2, n, beta):
        u, v = x
        eq1 = alpha1_eff / (1 + v**n) - beta * u
        eq2 = alpha2 / (1 + u**n) - beta * v
        return [eq1, eq2]

    inducer_values = np.linspace(0, 10, 200)
    stable_u = []
    stable_v = []

    for ind in inducer_values:
        alpha1_eff = alpha1 * (1 + ind)  # Inducer enhances gene 1 expression
        solutions = []

        # Try multiple initial conditions to find all steady states
        for u0 in [0.01, 1.0, 5.0, 10.0]:
            for v0 in [0.01, 1.0, 5.0, 10.0]:
                try:
                    sol = fsolve(steady_state_eq, [u0, v0],
                                args=(alpha1_eff, alpha2, n, beta),
                                full_output=True)
                    if sol[2] == 1:  # Converged
                        u, v = sol[0]
                        if u > 0 and v > 0:
                            solutions.append((round(u, 4), round(v, 4)))
                except Exception:
                    pass

        # Deduplicate
        unique = list(set(solutions))
        for u, v in unique:
            stable_u.append({'inducer': ind, 'u': u, 'branch': 'high' if u > v else 'low'})

    import pandas as pd
    df = pd.DataFrame(stable_u)
    n_branches = df.groupby('inducer')['branch'].nunique()
    bistable_range = n_branches[n_branches > 1]

    if len(bistable_range) > 0:
        print(f"Bistable region: inducer = [{bistable_range.index.min():.2f}, "
              f"{bistable_range.index.max():.2f}]")
    else:
        print("No bistability detected")

    return df

results = toggle_steady_states(alpha1=3.0, alpha2=3.0, n=2.5, beta=1.0)
```

### 5. Barcode Sequencing Analysis

Analyze fitness from barcode tracking experiments.

```python
import pandas as pd
import numpy as np
from scipy.cluster.hierarchy import linkage, fcluster

def analyze_barcode_fitness(count_table, reference_timepoint='T0', min_reads=10):
    """Calculate fitness from barcode count data.

    Args:
        count_table: DataFrame with barcodes as index, timepoints as columns
        reference_timepoint: column name for initial counts
    """
    # Filter low-abundance barcodes
    mask = count_table[reference_timepoint] >= min_reads
    filtered = count_table[mask].copy()
    print(f"Barcodes passing filter: {len(filtered)} / {len(count_table)}")

    # Normalize to relative frequency
    normalized = filtered.div(filtered.sum(axis=0), axis=1)

    # Calculate log2 fold change vs reference
    fitness = np.log2(normalized.div(normalized[reference_timepoint], axis=0) + 1e-10)
    fitness = fitness.drop(columns=[reference_timepoint])

    # Summary statistics
    for col in fitness.columns:
        positive = (fitness[col] > 0).sum()
        negative = (fitness[col] < 0).sum()
        print(f"{col}: {positive} positive, {negative} negative fitness barcodes")

    return fitness

def cluster_lineage_fitness(fitness_df, n_clusters=5):
    """Hierarchical clustering of barcode fitness profiles."""
    Z = linkage(fitness_df.values, method='ward')
    clusters = fcluster(Z, n_clusters, criterion='maxclust')
    fitness_df['cluster'] = clusters

    # Cluster summary
    for c in range(1, n_clusters+1):
        cluster_data = fitness_df[fitness_df['cluster'] == c].drop(columns=['cluster'])
        print(f"Cluster {c} ({len(cluster_data)} barcodes): "
              f"mean fitness = {cluster_data.values.mean():.3f}")

    return fitness_df
```

### 6. Genome Engineering

Design and annotate expression cassettes.

```python
from Bio.Seq import Seq
from Bio.SeqRecord import SeqRecord
from Bio.SeqFeature import SeqFeature, FeatureLocation
from Bio import SeqIO

def insert_expression_cassette(genome_record, insert_seq, locus_position,
                                promoter_name='Ptac', gene_name='gfp',
                                terminator_name='T7_term'):
    """Insert expression cassette at specified genomic locus."""
    # Build cassette
    cassette_features = []
    pos = 0

    # Promoter (assume 100bp)
    promoter_seq = 'A' * 100  # Placeholder — use actual sequence
    cassette_features.append(SeqFeature(
        FeatureLocation(pos, pos + len(promoter_seq)),
        type='promoter', qualifiers={'label': promoter_name}
    ))
    pos += len(promoter_seq)

    # RBS (20bp)
    rbs_seq = 'AAGGAGATATACAT'  # Consensus RBS
    cassette_features.append(SeqFeature(
        FeatureLocation(pos, pos + len(rbs_seq)),
        type='RBS', qualifiers={'label': 'RBS'}
    ))
    pos += len(rbs_seq)

    # CDS
    cassette_features.append(SeqFeature(
        FeatureLocation(pos, pos + len(insert_seq)),
        type='CDS', qualifiers={'label': gene_name, 'translation': str(Seq(insert_seq).translate())}
    ))
    pos += len(insert_seq)

    # Terminator (50bp)
    term_seq = 'T' * 50
    cassette_features.append(SeqFeature(
        FeatureLocation(pos, pos + len(term_seq)),
        type='terminator', qualifiers={'label': terminator_name}
    ))

    full_cassette = promoter_seq + rbs_seq + insert_seq + term_seq

    # Insert into genome
    new_seq = str(genome_record.seq[:locus_position]) + full_cassette + \
              str(genome_record.seq[locus_position:])

    # Adjust feature positions
    offset = len(full_cassette)
    new_features = []
    for f in genome_record.features:
        if f.location.start >= locus_position:
            new_loc = FeatureLocation(f.location.start + offset,
                                       f.location.end + offset, f.location.strand)
            new_features.append(SeqFeature(new_loc, type=f.type, qualifiers=f.qualifiers))
        else:
            new_features.append(f)

    # Add cassette features
    for f in cassette_features:
        adjusted = SeqFeature(
            FeatureLocation(f.location.start + locus_position,
                           f.location.end + locus_position),
            type=f.type, qualifiers=f.qualifiers
        )
        new_features.append(adjusted)

    new_record = SeqRecord(Seq(new_seq), id=genome_record.id,
                           name=genome_record.name,
                           description=f"{genome_record.description} + {gene_name} cassette",
                           features=new_features)
    return new_record
```

## Typical Workflows

### Workflow 1: Optimize Gene for E. coli Expression and Calculate CAI

```python
protein_seq = "MVSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTTLTYGVQCFSRYPDHMKQHDFFKSAMPEGYVQERTIFFKDDGNYKTRAEVKFEGDTLVNRIELKGIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIGDGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITLGMDELYK"
opt_dna, cai, gc = optimize_codons(protein_seq)
print(f"Original CAI: {calculate_cai(opt_dna):.4f}")
```

### Workflow 2: Simulate Toggle Switch with Growth Dilution

```python
import numpy as np
from scipy.integrate import solve_ivp

sol = solve_ivp(toggle_switch, [0, 100], [0.1, 3.0],
                args=(5.0, 5.0, 0.5, 2.0, 0.1),
                t_eval=np.linspace(0, 100, 1000))
print(f"Final: u={sol.y[0,-1]:.3f}, v={sol.y[1,-1]:.3f}")
print(f"State: {'Gene 1 ON' if sol.y[0,-1] > sol.y[1,-1] else 'Gene 2 ON'}")
```

### Workflow 3: Create SBML Model of a Metabolic Pathway

```python
doc = create_sbml_model(
    'glycolysis_simplified',
    compartments=[('cytoplasm', 1.0)],
    species_list=[
        ('glucose', 'cytoplasm', 5.0),
        ('G6P', 'cytoplasm', 0.0),
        ('pyruvate', 'cytoplasm', 0.0),
        ('ATP', 'cytoplasm', 2.0),
    ],
    reactions=[
        {'id': 'hexokinase', 'reactants': [('glucose', 1), ('ATP', 1)],
         'products': [('G6P', 1)], 'kinetic_law': 'Vmax * glucose * ATP / ((Km_g + glucose) * (Km_a + ATP))',
         'parameters': [('Vmax', 1.0), ('Km_g', 0.1), ('Km_a', 0.5)]},
        {'id': 'glycolysis', 'reactants': [('G6P', 1)],
         'products': [('pyruvate', 2), ('ATP', 2)], 'kinetic_law': 'k * G6P',
         'parameters': [('k', 0.5)]},
    ]
)
libsbml.writeSBMLToFile(doc, 'glycolysis.xml')
```

## Best Practices

1. **Codon optimization** — always check GC content after optimization; extreme GC can cause expression problems
2. **Circuit simulation** — include growth dilution term (gamma * x) in all ODE models; cells divide, diluting intracellular molecules
3. **SBML validation** — always call `doc.getNumErrors()` after model creation; common errors are missing units and unbalanced reactions
4. **Bifurcation analysis** — use multiple initial conditions to find all steady states; bistable systems have hysteresis
5. **Barcode fitness** — require minimum read count (>10) to filter PCR/sequencing noise; use log2 fold change for fitness
6. **Stiffness** — gene circuits with fast mRNA and slow protein dynamics are stiff; use `method='BDF'` in `solve_ivp`

## Troubleshooting

**Problem:** ODE solver fails with "excess work"
**Solution:** Increase `max_step` or switch to stiff solver (`BDF`, `Radau`). Check parameter values for unreasonably large rates.

**Problem:** python-libsbml not found after installation
**Solution:** Use `pip install python-libsbml` (not `libsbml`). On some systems: `pip install python-libsbml-experimental`.

**Problem:** Codon optimization produces sequence with internal stop codons
**Solution:** Verify protein sequence uses standard single-letter amino acid codes. Check for ambiguous residues (B, X, Z).

**Problem:** Bifurcation analysis misses steady states
**Solution:** Use more initial conditions for `fsolve`. Add parameter continuation methods for systematic sweeps.

## Resources

- [python-libsbml Documentation](https://sbml.org/software/libsbml/)
- [Repressilator Paper (Elowitz & Leibler, 2000)](https://doi.org/10.1038/35002125)
- [Toggle Switch Paper (Gardner et al., 2000)](https://doi.org/10.1038/35002131)
- [iGEM Parts Registry](http://parts.igem.org/)
- [Codon Usage Database](https://www.kazusa.or.jp/codon/)

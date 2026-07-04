---
name: glycobiology
description: Glycosylation site prediction and glycobiology analysis. N-glycosylation motif finding, O-glycosylation hotspot prediction, glycan structure resources. Lightweight, pure Python. For protein function queries use uniprot-database; for structure analysis use alphafold-database.
category: biology
license: MIT license
metadata:
    skill-author: InkVell Inc.
---

# Glycobiology: Glycosylation Analysis

## Overview

Glycobiology provides lightweight computational tools for predicting and analyzing glycosylation sites in protein sequences. This skill covers N-glycosylation sequon motif finding (N-X-S/T where X is not P), O-glycosylation hotspot prediction using a sliding window serine/threonine density heuristic, glycan structure tool references, and combined glycoprotein analysis with domain mapping. All analyses use pure Python with minimal dependencies (Biopython for sequence I/O, regex for pattern matching).

## When to Use This Skill

- Predicting N-glycosylation sites from protein sequences
- Identifying O-glycosylation hotspot regions
- Planning glycosylation site mutagenesis experiments
- Comparing predicted vs experimentally determined glycosylation sites
- Annotating glycosylation in biotherapeutic protein design
- Surveying glycan analysis tools for downstream structural studies

**Related Skills:** For protein function and existing glycosylation annotations use `uniprot-database`. For protein 3D structure and site accessibility use `alphafold-database`. For sequence manipulation use `biopython`.

## Installation

```bash
uv pip install biopython numpy
```

No additional dependencies required — this skill uses pure Python.

## Quick Start

```python
import re

def find_n_glycosylation_sites(sequence):
    """Find N-X-S/T sequons where X != P."""
    sites = []
    for i in range(len(sequence) - 2):
        if sequence[i] == 'N' and sequence[i+1] != 'P' and sequence[i+2] in ('S', 'T'):
            sites.append({
                'position': i + 1,  # 1-based
                'motif': sequence[i:i+3],
                'context': sequence[max(0,i-3):i+6]
            })
    return sites

# Example: human EPO
epo_seq = "MGVHECPAWLWLLLSLLSLPLGLPVLGAPPRLICDSRVLERYLLEAKEAENITTGCAEHCSLNENITVPDTKVNFYAWKRMEVGQQAVEVWQGLALLSEAVLRGQALLVNSSQPWEPLQLHVDKAVSGLRSLTTLLRALGAQKEAISPPDAASAAPLRTITADTFRKLFRVYSNFLRGKLKLYTGEACRTGDR"

sites = find_n_glycosylation_sites(epo_seq)
print(f"N-glycosylation sites: {len(sites)}")
for s in sites:
    print(f"  Position {s['position']}: {s['motif']} (context: ...{s['context']}...)")
```

## Core Capabilities

### 1. N-Glycosylation Motif Finding

Identify N-X-S/T sequons in protein sequences.

```python
import re
from Bio import SeqIO

def find_n_glycosylation_sites(sequence, exclude_proline=True):
    """Find N-linked glycosylation sequons (N-X-S/T).

    Args:
        sequence: protein sequence string
        exclude_proline: if True, exclude N-P-S/T motifs (standard rule)
    """
    sites = []
    seq = str(sequence).upper()

    for i in range(len(seq) - 2):
        if seq[i] != 'N':
            continue

        x_residue = seq[i + 1]
        st_residue = seq[i + 2]

        # Standard rule: X != P
        if exclude_proline and x_residue == 'P':
            continue

        if st_residue not in ('S', 'T'):
            continue

        # Context (5 residues each side)
        context_start = max(0, i - 5)
        context_end = min(len(seq), i + 8)
        context = seq[context_start:context_end]

        sites.append({
            'position': i + 1,  # 1-based position
            'residue': seq[i],
            'motif': seq[i:i+3],
            'x_residue': x_residue,
            'acceptor': st_residue,
            'context': context,
            'context_start': context_start + 1
        })

    return sites

def scan_fasta_for_n_glyc(fasta_path):
    """Scan all sequences in a FASTA file for N-glycosylation sites."""
    results = []
    for record in SeqIO.parse(fasta_path, 'fasta'):
        sites = find_n_glycosylation_sites(str(record.seq))
        results.append({
            'id': record.id,
            'description': record.description,
            'length': len(record.seq),
            'n_sites': len(sites),
            'sites': sites,
            'density': len(sites) / len(record.seq) * 1000  # per 1000 residues
        })

    import pandas as pd
    df = pd.DataFrame([{k: v for k, v in r.items() if k != 'sites'} for r in results])
    print(f"Scanned {len(df)} sequences")
    print(f"Total N-glyc sites: {df['n_sites'].sum()}")
    print(f"Mean density: {df['density'].mean():.1f} per 1000 residues")
    return results

# Example with multiple sequences
sites = find_n_glycosylation_sites("MANLQTSPNGTLKNVTSITDA")
for s in sites:
    print(f"N{s['position']}: {s['motif']} (X={s['x_residue']}, acceptor={s['acceptor']})")
```

### 2. O-Glycosylation Hotspot Prediction

Identify regions enriched in serine/threonine that may be O-glycosylated.

```python
import numpy as np

def predict_o_glycosylation_hotspots(sequence, window_size=20, threshold=0.4,
                                       exclude_near_proline=True):
    """Predict O-glycosylation hotspots using S/T density heuristic.

    O-glycosylation preferentially occurs in S/T-rich regions, often near
    proline residues. This heuristic identifies candidate regions.

    Args:
        sequence: protein sequence string
        window_size: sliding window size
        threshold: minimum S/T fraction to call a hotspot
        exclude_near_proline: if True, downweight S/T not near P
    """
    seq = str(sequence).upper()
    n = len(seq)

    if n < window_size:
        return []

    # Calculate S/T density in sliding windows
    densities = []
    for i in range(n - window_size + 1):
        window = seq[i:i + window_size]
        st_count = window.count('S') + window.count('T')
        density = st_count / window_size
        densities.append(density)

    densities = np.array(densities)

    # Find hotspot regions
    hotspots = []
    in_hotspot = False
    start = 0

    for i, d in enumerate(densities):
        if d >= threshold and not in_hotspot:
            start = i
            in_hotspot = True
        elif d < threshold and in_hotspot:
            hotspots.append({
                'start': start + 1,  # 1-based
                'end': i + window_size,
                'length': i + window_size - start,
                'max_density': float(densities[start:i].max()),
                'mean_density': float(densities[start:i].mean()),
                'region': seq[start:i + window_size]
            })
            in_hotspot = False

    if in_hotspot:
        hotspots.append({
            'start': start + 1,
            'end': n,
            'length': n - start,
            'max_density': float(densities[start:].max()),
            'mean_density': float(densities[start:].mean()),
            'region': seq[start:]
        })

    # Individual S/T residues in hotspots
    all_st_sites = []
    for hs in hotspots:
        region_start = hs['start'] - 1
        region_seq = hs['region']
        for j, aa in enumerate(region_seq):
            if aa in ('S', 'T'):
                pos = region_start + j + 1
                # Check proline neighbors
                has_nearby_P = False
                for k in range(-3, 4):
                    check_pos = region_start + j + k
                    if 0 <= check_pos < n and seq[check_pos] == 'P':
                        has_nearby_P = True
                        break

                all_st_sites.append({
                    'position': pos,
                    'residue': aa,
                    'in_hotspot': True,
                    'near_proline': has_nearby_P
                })

    print(f"O-glycosylation hotspots: {len(hotspots)}")
    for hs in hotspots:
        print(f"  Pos {hs['start']}-{hs['end']}: density={hs['max_density']:.2f}, "
              f"{hs['region'][:30]}{'...' if len(hs['region'])>30 else ''}")
    print(f"Candidate S/T residues: {len(all_st_sites)}")

    return hotspots, all_st_sites
```

### 3. Glycan Structure Resources

Curated list of tools for glycan structure analysis and prediction.

```python
GLYCAN_TOOLS = {
    'NetNGlyc': {
        'url': 'https://services.healthtech.dtu.dk/services/NetNGlyc-1.0/',
        'description': 'Neural network prediction of N-glycosylation sites',
        'input': 'Protein sequence (FASTA)',
        'output': 'N-glycosylation probability per Asn',
        'note': 'More accurate than motif-only scanning; considers sequence context'
    },
    'NetOGlyc': {
        'url': 'https://services.healthtech.dtu.dk/services/NetOGlyc-4.0/',
        'description': 'Neural network prediction of mucin-type O-glycosylation',
        'input': 'Protein sequence (FASTA)',
        'output': 'O-glycosylation probability per Ser/Thr',
        'note': 'Version 4.0 trained on O-GalNAc glycoproteomics data'
    },
    'GlycoWorkbench': {
        'url': 'https://code.google.com/archive/p/glycoworkbench/',
        'description': 'Glycan structure drawing and MS annotation',
        'input': 'Mass spectrometry data',
        'output': 'Glycan structure assignments'
    },
    'GLYCAM-Web': {
        'url': 'https://glycam.org/',
        'description': 'Glycan 3D structure building and MD simulation',
        'input': 'Glycan sequence (IUPAC condensed)',
        'output': '3D coordinates (PDB), AMBER parameters'
    },
    'Glycoshield-MD': {
        'url': 'https://github.com/GlycoSHIELD-MD/GlycoSHIELD-MD',
        'description': 'Model glycan shields on protein structures for MD',
        'input': 'Protein PDB + glycosylation sites',
        'output': 'Glycosylated protein structure'
    },
    'SweetTalk': {
        'url': 'https://glycoproteome.expasy.org/sweettalk/',
        'description': 'Glycoprotein structure visualization',
        'input': 'UniProt ID',
        'output': 'Interactive glycoprotein 3D viewer'
    }
}

def list_glycan_tools():
    """Print available glycan analysis tools."""
    for name, info in GLYCAN_TOOLS.items():
        print(f"\n{name}")
        print(f"  URL: {info['url']}")
        print(f"  Description: {info['description']}")
        if 'note' in info:
            print(f"  Note: {info['note']}")
```

### 4. Glycoprotein Analysis

Combined N/O glycosylation analysis with domain mapping.

```python
def analyze_glycoprotein(sequence, protein_name='protein',
                          uniprot_sites=None):
    """Comprehensive glycosylation analysis.

    Args:
        sequence: protein sequence
        protein_name: name for reporting
        uniprot_sites: dict of known sites from UniProt
                       {'N_glyc': [positions], 'O_glyc': [positions]}
    """
    seq = str(sequence).upper()
    print(f"=== Glycoprotein Analysis: {protein_name} ===")
    print(f"Length: {len(seq)} residues")

    # N-glycosylation
    n_sites = find_n_glycosylation_sites(seq)
    print(f"\nN-glycosylation sites (sequon motif): {len(n_sites)}")
    for s in n_sites:
        print(f"  N{s['position']}: {s['motif']}")

    # O-glycosylation hotspots
    o_hotspots, o_sites = predict_o_glycosylation_hotspots(seq)

    # Comparison with UniProt annotations
    if uniprot_sites:
        known_n = set(uniprot_sites.get('N_glyc', []))
        predicted_n = set(s['position'] for s in n_sites)

        tp = known_n & predicted_n
        fp = predicted_n - known_n
        fn = known_n - predicted_n

        print(f"\nComparison with UniProt annotations:")
        print(f"  True positives (predicted & annotated): {len(tp)}")
        print(f"  False positives (predicted, not annotated): {len(fp)}")
        print(f"  False negatives (annotated, not predicted): {len(fn)}")

        if fn:
            print(f"  Missed sites: {sorted(fn)}")
            for pos in fn:
                context = seq[max(0,pos-4):pos+5]
                print(f"    N{pos}: ...{context}... (may have N-P-S/T or non-standard motif)")

    # Summary
    print(f"\nSummary:")
    print(f"  N-glyc sites: {len(n_sites)}")
    print(f"  O-glyc hotspots: {len(o_hotspots)}")
    print(f"  Total candidate O-glyc S/T: {len(o_sites)}")
    print(f"  Glycosylation density: {(len(n_sites) + len(o_sites)) / len(seq) * 100:.1f}%")

    return {
        'n_glyc_sites': n_sites,
        'o_glyc_hotspots': o_hotspots,
        'o_glyc_sites': o_sites
    }
```

## Typical Workflows

### Workflow 1: Predict All Glycosylation Sites in a Protein

```python
sequence = "MANLQTSPNGTLKNVTSITDANLTQSPNNFTLRNITSANDTVTQSTPNVTQLNVSQSTPNVTQLNVSQST"
results = analyze_glycoprotein(sequence, protein_name='MyProtein')
```

### Workflow 2: Compare Predicted vs UniProt-Annotated Sites

```python
sequence = "MGVHECPAWLWLLLSLLSLPLGLPVLGAPPRLICDSRVLERYLLEAKEAENITTGCAEHCSLNENITVPDT"
known = {'N_glyc': [24, 38, 83], 'O_glyc': []}  # Known from UniProt
results = analyze_glycoprotein(sequence, protein_name='EPO', uniprot_sites=known)
```

## Best Practices

1. **N-glycosylation prediction** — sequon motif (N-X-S/T, X!=P) is necessary but not sufficient; not all sequons are glycosylated; use NetNGlyc for probability-based prediction
2. **O-glycosylation** — much harder to predict than N-glyc; the S/T density heuristic identifies candidate regions but has high false positive rate; use NetOGlyc for better accuracy
3. **Validate with UniProt** — always cross-reference predictions with experimentally verified glycosylation annotations in UniProt
4. **Signal peptide** — glycosylation occurs in the ER/Golgi; ensure the protein has a signal peptide (positions are relative to mature protein in databases)
5. **Structural context** — glycosylation requires surface accessibility; use AlphaFold to check if predicted sites are surface-exposed
6. **Biotherapeutics** — for antibody/protein drug design, N-glycosylation in Fc regions (N297 in IgG) is critical for effector function

## Troubleshooting

**Problem:** Sequon search finds sites in cytoplasmic proteins
**Solution:** N-glycosylation only occurs in secretory pathway proteins. Filter predictions by subcellular localization (check UniProt).

**Problem:** Known glycosylation site not detected
**Solution:** Some rare N-glycosylation occurs at non-canonical motifs (N-X-C). Check if the site has N-P-S/T which is excluded by default.

**Problem:** Too many O-glycosylation hotspots
**Solution:** Increase the density threshold (e.g., 0.5). Focus on regions that are both S/T-rich and in extracellular domains.

## Resources

- [UniProt Glycosylation Annotations](https://www.uniprot.org/help/carbohyd)
- [NetNGlyc Server](https://services.healthtech.dtu.dk/services/NetNGlyc-1.0/)
- [NetOGlyc Server](https://services.healthtech.dtu.dk/services/NetOGlyc-4.0/)
- [GlyConnect Database](https://glyconnect.expasy.org/)
- [Essentials of Glycobiology (NCBI)](https://www.ncbi.nlm.nih.gov/books/NBK310274/)

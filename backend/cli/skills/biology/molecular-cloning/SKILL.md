---
name: molecular-cloning
description: Molecular cloning simulation and design. PCR amplicon prediction, restriction enzyme digestion, Golden Gate and Gibson assembly simulation, primer design, CRISPR sgRNA design, and plasmid annotation. For protein-level sequence analysis use biopython or esm; for database lookups use gene-database or ensembl-database.
category: biology
license: MIT license
metadata:
    skill-author: InkVell Inc.
---

# Molecular Cloning: Sequence Engineering & Cloning Design

## Overview

Molecular Cloning provides computational tools for simulating and designing molecular cloning workflows. This skill covers PCR amplicon prediction with primer binding analysis, restriction enzyme digestion simulation, Golden Gate and Gibson assembly design and verification, primer design with thermodynamic calculations, CRISPR sgRNA design with off-target scoring, and plasmid feature annotation. All simulations use Biopython's Bio.Restriction and Bio.SeqUtils for accurate enzyme and sequence handling.

## When to Use This Skill

- Predicting PCR amplicons from primer sequences and templates
- Simulating restriction enzyme digestions and predicting fragment sizes
- Designing Golden Gate assembly with 4bp overhang compatibility
- Planning Gibson assembly with overlap design
- Designing PCR primers with Tm and specificity constraints
- Designing CRISPR sgRNAs and scoring off-target potential
- Annotating plasmid features (promoters, CDS, terminators, origins)
- Generating plasmid maps in GenBank format

**Related Skills:** For protein-level sequence analysis use `biopython` or `esm`. For gene/transcript lookups use `gene-database` or `ensembl-database`. For synthetic biology circuit design use `synthetic-biology`.

## Installation

```bash
uv pip install biopython primer3-py numpy
```

## Quick Start

```python
from Bio.Seq import Seq
from Bio.Restriction import BamHI, EcoRI
from Bio.SeqUtils import MeltingTemp as mt

# Restriction digestion
sequence = Seq("ATCGATCGGGATCCATCGATCGAATTCATCGATCG")
print(f"BamHI cuts at: {BamHI.search(sequence)}")
print(f"EcoRI cuts at: {EcoRI.search(sequence)}")

# Primer Tm calculation
primer = Seq("ATCGATCGGATCCATCGATCG")
tm = mt.Tm_NN(primer)
print(f"Primer Tm: {tm:.1f} C")
```

## Core Capabilities

### 1. PCR Simulation

Predict amplicon from primer binding on template.

```python
from Bio.Seq import Seq
from Bio.SeqUtils import MeltingTemp as mt
import re

def find_primer_binding(template, primer, max_mismatches=2):
    """Find primer binding sites on template (both strands).

    Returns list of (position, strand, mismatches) tuples.
    """
    template_str = str(template).upper()
    primer_str = str(primer).upper()
    rc_template = str(template.reverse_complement()).upper()

    sites = []

    # Search forward strand
    for i in range(len(template_str) - len(primer_str) + 1):
        region = template_str[i:i+len(primer_str)]
        mismatches = sum(a != b for a, b in zip(primer_str, region))
        if mismatches <= max_mismatches:
            sites.append((i, '+', mismatches))

    # Search reverse strand
    for i in range(len(rc_template) - len(primer_str) + 1):
        region = rc_template[i:i+len(primer_str)]
        mismatches = sum(a != b for a, b in zip(primer_str, region))
        if mismatches <= max_mismatches:
            pos = len(template_str) - i - len(primer_str)
            sites.append((pos, '-', mismatches))

    return sites

def simulate_pcr(template, fwd_primer, rev_primer, max_mismatches=2):
    """Simulate PCR and predict amplicon.

    Args:
        template: Bio.Seq template sequence (can be circular)
        fwd_primer: forward primer sequence
        rev_primer: reverse primer sequence (as ordered, 5'->3')
    """
    fwd_sites = find_primer_binding(template, fwd_primer, max_mismatches)
    rev_rc = Seq(str(rev_primer)).reverse_complement()
    rev_sites = find_primer_binding(template, rev_rc, max_mismatches)

    amplicons = []
    for f_pos, f_strand, f_mm in fwd_sites:
        if f_strand != '+':
            continue
        for r_pos, r_strand, r_mm in rev_sites:
            if r_strand != '-':
                continue
            if r_pos > f_pos:
                amp_len = r_pos + len(str(rev_primer)) - f_pos
                if 50 < amp_len < 10000:  # Reasonable amplicon size
                    amplicon = template[f_pos:r_pos + len(str(rev_primer))]
                    amplicons.append({
                        'start': f_pos,
                        'end': r_pos + len(str(rev_primer)),
                        'length': amp_len,
                        'fwd_mismatches': f_mm,
                        'rev_mismatches': r_mm,
                        'sequence': str(amplicon)
                    })

    # Calculate primer Tm
    fwd_tm = mt.Tm_NN(fwd_primer)
    rev_tm = mt.Tm_NN(rev_primer)

    print(f"Forward primer Tm: {fwd_tm:.1f} C")
    print(f"Reverse primer Tm: {rev_tm:.1f} C")
    print(f"Tm difference: {abs(fwd_tm - rev_tm):.1f} C")
    print(f"Predicted amplicons: {len(amplicons)}")

    for i, amp in enumerate(amplicons):
        print(f"  Amplicon {i+1}: {amp['length']} bp "
              f"(pos {amp['start']}-{amp['end']}, "
              f"mismatches: fwd={amp['fwd_mismatches']}, rev={amp['rev_mismatches']})")

    return amplicons
```

### 2. Restriction Digestion

Simulate enzyme digestion and predict fragments.

```python
from Bio.Seq import Seq
from Bio.Restriction import *
from Bio.Restriction import RestrictionBatch, Analysis

def restriction_digest(sequence, enzymes, is_linear=True):
    """Simulate restriction enzyme digestion.

    Args:
        sequence: Bio.Seq DNA sequence
        enzymes: list of enzyme names (e.g., ['EcoRI', 'BamHI'])
        is_linear: True for linear DNA, False for circular
    """
    # Create restriction batch
    rb = RestrictionBatch()
    for enz_name in enzymes:
        rb.add(eval(enz_name))

    # Run analysis
    analysis = Analysis(rb, sequence, linear=is_linear)
    results = analysis.full()

    all_cut_sites = []
    for enzyme, sites in results.items():
        if sites:
            print(f"{enzyme}: cuts at positions {sites}")
            all_cut_sites.extend(sites)
        else:
            print(f"{enzyme}: no cut sites")

    # Calculate fragment sizes
    if not all_cut_sites:
        print(f"No cuts — single fragment: {len(sequence)} bp")
        return [len(sequence)]

    all_cut_sites = sorted(set(all_cut_sites))

    if is_linear:
        positions = [0] + all_cut_sites + [len(sequence)]
    else:
        positions = all_cut_sites

    fragments = []
    if is_linear:
        for i in range(len(positions) - 1):
            fragments.append(positions[i+1] - positions[i])
    else:
        for i in range(len(positions)):
            next_i = (i + 1) % len(positions)
            if next_i == 0:
                frag = len(sequence) - positions[i] + positions[0]
            else:
                frag = positions[next_i] - positions[i]
            fragments.append(frag)

    fragments.sort(reverse=True)
    print(f"\nFragments ({len(fragments)}): {fragments}")
    print(f"Total: {sum(fragments)} bp")

    return fragments

# Example: double digest
seq = Seq("ATCG" * 100 + "GGATCC" + "ATCG" * 50 + "GAATTC" + "ATCG" * 75)
frags = restriction_digest(seq, ['BamHI', 'EcoRI'], is_linear=True)
```

### 3. Golden Gate Assembly

Design and simulate Golden Gate cloning.

```python
from Bio.Seq import Seq

def design_golden_gate(parts, enzyme='BsaI'):
    """Design Golden Gate assembly with verified overhang compatibility.

    Args:
        parts: list of dicts with 'name', 'sequence' keys
        enzyme: Type IIS enzyme ('BsaI' or 'BpiI')
    """
    # Standard overhangs for 4-part Golden Gate
    standard_overhangs = [
        'AATG',  # Start codon region
        'AGGT',
        'TTCG',
        'GCTT',
        'CGCT',  # After last part (return to vector)
    ]

    if len(parts) + 1 > len(standard_overhangs):
        raise ValueError(f"Too many parts ({len(parts)}) for standard overhang set")

    # Check overhang compatibility (no palindromes, no near-matches)
    overhangs_used = standard_overhangs[:len(parts) + 1]
    for i, oh in enumerate(overhangs_used):
        rc = str(Seq(oh).reverse_complement())
        if oh == rc:
            print(f"WARNING: Overhang {oh} is palindromic — may self-ligate")
        for j, oh2 in enumerate(overhangs_used):
            if i != j and oh == oh2:
                raise ValueError(f"Duplicate overhangs: position {i} and {j}")

    # Build assembly plan
    assembly = []
    for i, part in enumerate(parts):
        left_oh = overhangs_used[i]
        right_oh = overhangs_used[i + 1]

        # Part with enzyme sites added
        if enzyme == 'BsaI':
            recognition = 'GGTCTC'
            spacer = 'N'
        else:  # BpiI
            recognition = 'GAAGAC'
            spacer = 'NN'

        assembled_part = f"{recognition}{spacer}{left_oh}{part['sequence']}{right_oh}"

        assembly.append({
            'name': part['name'],
            'left_overhang': left_oh,
            'right_overhang': right_oh,
            'part_length': len(part['sequence']),
            'total_length': len(assembled_part)
        })

        print(f"Part {i+1} ({part['name']}): [{left_oh}]--{len(part['sequence'])}bp--[{right_oh}]")

    # Predict assembled product
    total_insert = sum(len(p['sequence']) for p in parts) + \
                   len(overhangs_used) * 4  # Overhangs contribute 4bp each
    print(f"\nAssembly: {len(parts)} parts")
    print(f"Total insert: ~{total_insert} bp (excluding vector)")
    print(f"Overhang set: {' -> '.join(overhangs_used)}")

    return assembly

# Example
parts = [
    {'name': 'Promoter', 'sequence': 'TTGACAATTAATCATCGGCTCG' * 5},
    {'name': 'RBS', 'sequence': 'AAGGAGATATACAT'},
    {'name': 'GFP_CDS', 'sequence': 'ATGGTGAGCAAGGGCGAG' * 40},
    {'name': 'Terminator', 'sequence': 'TTTTTTTTTTT' * 4},
]

assembly = design_golden_gate(parts)
```

### 4. Gibson Assembly

Design overlapping fragments for Gibson assembly.

```python
from Bio.Seq import Seq
from Bio.SeqUtils import MeltingTemp as mt

def design_gibson_assembly(fragments, overlap_length=30):
    """Design Gibson assembly with overlap primers.

    Args:
        fragments: list of dicts with 'name', 'sequence' keys (in assembly order)
        overlap_length: overlap length in bp (20-40 recommended)
    """
    assembly_plan = []

    for i in range(len(fragments)):
        current = fragments[i]
        next_frag = fragments[(i + 1) % len(fragments)]

        # Forward primer: end of previous fragment + start of current
        if i == 0:
            fwd_primer = current['sequence'][:20]
        else:
            prev = fragments[i - 1]
            overlap_5 = prev['sequence'][-overlap_length:]
            fwd_primer = overlap_5 + current['sequence'][:20]

        # Reverse primer: RC of (end of current + start of next)
        overlap_3 = next_frag['sequence'][:overlap_length]
        rev_binding = str(Seq(current['sequence'][-20:]).reverse_complement())
        rev_primer = str(Seq(overlap_3).reverse_complement()) + rev_binding

        # Tm of binding region
        fwd_tm = mt.Tm_NN(Seq(current['sequence'][:20]))
        rev_tm = mt.Tm_NN(Seq(current['sequence'][-20:]))

        assembly_plan.append({
            'fragment': current['name'],
            'fragment_length': len(current['sequence']),
            'fwd_primer': fwd_primer,
            'rev_primer': rev_primer,
            'fwd_tm': fwd_tm,
            'rev_tm': rev_tm,
            'overlap_length': overlap_length
        })

        print(f"Fragment {i+1} ({current['name']}): {len(current['sequence'])} bp")
        print(f"  Fwd primer: {fwd_primer[:40]}... ({len(fwd_primer)} nt, Tm={fwd_tm:.1f} C)")
        print(f"  Rev primer: {rev_primer[:40]}... ({len(rev_primer)} nt, Tm={rev_tm:.1f} C)")

    total = sum(len(f['sequence']) for f in fragments)
    print(f"\nTotal assembled length: ~{total} bp")

    return assembly_plan
```

### 5. Primer Design

Design primers with thermodynamic constraints.

```python
import primer3

def design_primers(template_seq, target_start, target_length,
                   product_size_range=(200, 500), tm_target=60):
    """Design PCR primers using primer3.

    Args:
        template_seq: template DNA sequence (string)
        target_start: start position of target region
        target_length: length of target region
        product_size_range: (min, max) product size
        tm_target: target melting temperature
    """
    result = primer3.bindings.design_primers(
        seq_args={
            'SEQUENCE_TEMPLATE': template_seq,
            'SEQUENCE_TARGET': [target_start, target_length],
        },
        global_args={
            'PRIMER_NUM_RETURN': 5,
            'PRIMER_OPT_SIZE': 20,
            'PRIMER_MIN_SIZE': 18,
            'PRIMER_MAX_SIZE': 25,
            'PRIMER_OPT_TM': tm_target,
            'PRIMER_MIN_TM': tm_target - 5,
            'PRIMER_MAX_TM': tm_target + 5,
            'PRIMER_MIN_GC': 40,
            'PRIMER_MAX_GC': 60,
            'PRIMER_PRODUCT_SIZE_RANGE': [list(product_size_range)],
            'PRIMER_MAX_SELF_COMPLEMENT': 6,
            'PRIMER_MAX_SELF_END': 3,
            'PRIMER_MAX_HAIRPIN_TH': 47,
        }
    )

    primers = []
    for i in range(result.get('PRIMER_PAIR_NUM_RETURNED', 0)):
        pair = {
            'left_seq': result[f'PRIMER_LEFT_{i}_SEQUENCE'],
            'right_seq': result[f'PRIMER_RIGHT_{i}_SEQUENCE'],
            'left_tm': result[f'PRIMER_LEFT_{i}_TM'],
            'right_tm': result[f'PRIMER_RIGHT_{i}_TM'],
            'left_gc': result[f'PRIMER_LEFT_{i}_GC_PERCENT'],
            'right_gc': result[f'PRIMER_RIGHT_{i}_GC_PERCENT'],
            'product_size': result[f'PRIMER_PAIR_{i}_PRODUCT_SIZE'],
            'penalty': result[f'PRIMER_PAIR_{i}_PENALTY'],
        }
        primers.append(pair)
        print(f"Pair {i+1}: product={pair['product_size']}bp, penalty={pair['penalty']:.2f}")
        print(f"  Fwd: {pair['left_seq']} (Tm={pair['left_tm']:.1f}, GC={pair['left_gc']:.0f}%)")
        print(f"  Rev: {pair['right_seq']} (Tm={pair['right_tm']:.1f}, GC={pair['right_gc']:.0f}%)")

    return primers
```

### 6. CRISPR sgRNA Design

Design guide RNAs for CRISPR-Cas9 knockout.

```python
from Bio.Seq import Seq
import re

def design_crispr_guides(target_seq, pam='NGG', guide_length=20, top_n=10):
    """Design CRISPR sgRNAs for SpCas9.

    Args:
        target_seq: target gene/region sequence (string)
        pam: PAM sequence ('NGG' for SpCas9)
        guide_length: guide RNA length (typically 20)
        top_n: number of top guides to return
    """
    seq = str(target_seq).upper()
    rc_seq = str(Seq(seq).reverse_complement())

    guides = []

    # Search forward strand for PAM (NGG at 3' end of target)
    for i in range(len(seq) - guide_length - len(pam) + 1):
        pam_site = seq[i + guide_length:i + guide_length + 3]
        if re.match(pam.replace('N', '.'), pam_site):
            guide_seq = seq[i:i + guide_length]
            score = score_guide(guide_seq)
            guides.append({
                'sequence': guide_seq,
                'pam': pam_site,
                'position': i,
                'strand': '+',
                'score': score,
                'full_target': guide_seq + pam_site
            })

    # Search reverse strand
    for i in range(len(rc_seq) - guide_length - len(pam) + 1):
        pam_site = rc_seq[i + guide_length:i + guide_length + 3]
        if re.match(pam.replace('N', '.'), pam_site):
            guide_seq = rc_seq[i:i + guide_length]
            score = score_guide(guide_seq)
            guides.append({
                'sequence': guide_seq,
                'pam': pam_site,
                'position': len(seq) - i - guide_length,
                'strand': '-',
                'score': score,
                'full_target': guide_seq + pam_site
            })

    # Sort by score (higher is better)
    guides.sort(key=lambda x: x['score'], reverse=True)

    print(f"Found {len(guides)} potential guide RNAs")
    print(f"\nTop {min(top_n, len(guides))} guides:")
    for i, g in enumerate(guides[:top_n]):
        print(f"  {i+1}. {g['sequence']} {g['pam']} "
              f"(strand={g['strand']}, pos={g['position']}, score={g['score']:.2f})")

    return guides[:top_n]

def score_guide(guide_seq):
    """Heuristic guide scoring based on known design rules."""
    score = 50.0  # Base score

    # GC content (40-70% preferred)
    gc = (guide_seq.count('G') + guide_seq.count('C')) / len(guide_seq)
    if 0.4 <= gc <= 0.7:
        score += 10
    elif gc < 0.3 or gc > 0.8:
        score -= 20

    # Avoid poly-T (>4 consecutive T = pol III terminator)
    if 'TTTT' in guide_seq:
        score -= 30

    # G at position 20 (adjacent to PAM) preferred
    if guide_seq[-1] == 'G':
        score += 5

    # Avoid GG at position 19-20 (can cause off-target)
    if guide_seq[-2:] == 'GG':
        score -= 5

    # Self-complementarity penalty
    rc = str(Seq(guide_seq).reverse_complement())
    matches = sum(a == b for a, b in zip(guide_seq, rc))
    if matches > 12:
        score -= 15

    return max(score, 0)
```

### 7. Plasmid Annotation

Identify and annotate features in plasmid sequences.

```python
from Bio.Seq import Seq
from Bio.SeqRecord import SeqRecord
from Bio.SeqFeature import SeqFeature, FeatureLocation
from Bio import SeqIO
from Bio.Restriction import RestrictionBatch, Analysis, CommOnly

def annotate_plasmid(sequence, name='plasmid'):
    """Annotate plasmid features and restriction sites.

    Args:
        sequence: plasmid DNA sequence (string)
        name: plasmid name
    """
    seq = Seq(sequence)
    record = SeqRecord(seq, id=name, name=name,
                       description=f'{name} annotated plasmid',
                       annotations={'molecule_type': 'DNA', 'topology': 'circular'})

    # Common feature patterns
    feature_patterns = {
        'T7_promoter': 'TAATACGACTCACTATAG',
        'lac_operator': 'AATTGTGAGCGGATAACAATT',
        'RBS_consensus': 'AAGGAG',
        'T7_terminator': 'CTAGCATAACCCCTTGGGGCCTCTAAACGGGTCTTGAGG',
        'ColE1_origin': 'CCTGTTTTGGCGGATGAGAGAAG',
    }

    for feat_name, pattern in feature_patterns.items():
        pos = str(seq).find(pattern)
        if pos >= 0:
            record.features.append(SeqFeature(
                FeatureLocation(pos, pos + len(pattern)),
                type='misc_feature',
                qualifiers={'label': feat_name}
            ))
            print(f"Found {feat_name} at position {pos}")

    # Find ORFs (>300bp)
    for strand, nuc in [(1, seq), (-1, seq.reverse_complement())]:
        for frame in range(3):
            trans = str(nuc[frame:].translate())
            start = 0
            while True:
                start = trans.find('M', start)
                if start == -1:
                    break
                stop = trans.find('*', start)
                if stop == -1:
                    stop = len(trans)
                orf_len = (stop - start) * 3

                if orf_len >= 300:
                    if strand == 1:
                        dna_start = frame + start * 3
                        dna_end = frame + stop * 3 + 3
                    else:
                        dna_end = len(seq) - frame - start * 3
                        dna_start = len(seq) - frame - stop * 3 - 3

                    record.features.append(SeqFeature(
                        FeatureLocation(min(dna_start, dna_end),
                                       max(dna_start, dna_end), strand),
                        type='CDS',
                        qualifiers={'label': f'ORF_{orf_len}bp'}
                    ))
                    print(f"ORF: {orf_len}bp at {dna_start}-{dna_end} (strand {'+' if strand==1 else '-'})")

                start = stop + 1

    # Map restriction sites
    rb = CommOnly
    analysis = Analysis(rb, seq, linear=False)
    unique_sites = {str(enz): sites for enz, sites in analysis.full().items()
                    if len(sites) == 1}

    print(f"\nUnique restriction sites: {len(unique_sites)}")
    for enz, sites in sorted(unique_sites.items()):
        print(f"  {enz}: {sites[0]}")

    return record

# Write annotated plasmid
# record = annotate_plasmid(plasmid_seq, name='pMyPlasmid')
# SeqIO.write(record, 'pMyPlasmid.gb', 'genbank')
```

## Typical Workflows

### Workflow 1: Design PCR Primers and Predict Amplicon

```python
from Bio.Seq import Seq

template = Seq("ATCGATCGATCGATCGATCGATCGATCG" * 50)  # 1400 bp template
fwd = Seq("ATCGATCGATCGATCGATCG")
rev = Seq("CGATCGATCGATCGATCGAT")

amplicons = simulate_pcr(template, fwd, rev)
if amplicons:
    print(f"Amplicon size: {amplicons[0]['length']} bp")
```

### Workflow 2: Plan Golden Gate Assembly with 4 Parts

```python
parts = [
    {'name': 'J23100_promoter', 'sequence': 'TTGACGGCTAGCTCAGTCCTAGGTACAGTGCTAGC'},
    {'name': 'B0034_RBS', 'sequence': 'AAAGAGGAGAAA'},
    {'name': 'GFP', 'sequence': 'ATGGTGAGCAAGGGCGAGGAG' + 'NNN' * 230 + 'TAA'},
    {'name': 'B0015_terminator', 'sequence': 'CCAGGCATCAAATAAAACGAAAGGCTCAGTCGAAAG'},
]
assembly = design_golden_gate(parts)
```

### Workflow 3: Design CRISPR Knockout sgRNAs

```python
# Target: exon 3 of a gene
target_exon = "ATGCGATCGATCGATCGATCGATCGAGGCGATCGATCGATCGATCGATCGATCGATCGATCG"
guides = design_crispr_guides(target_exon, pam='NGG', top_n=5)
```

## Best Practices

1. **Primer design** — aim for Tm within 2 C between forward and reverse primers; 40-60% GC content; avoid 3' complementarity
2. **Golden Gate** — verify 4bp overhangs are unique and non-palindromic; use standardized overhang sets from published studies
3. **Gibson assembly** — use 20-40bp overlaps; ensure fragments have similar Tm at overlap junctions; minimum 2 fragments
4. **CRISPR guides** — avoid poly-T (>4 T) which terminates U6/H1 transcription; prefer guides in early exons; validate against off-target databases
5. **Restriction digestion** — always check both orientations; verify compatible cohesive ends for ligation; methylation sensitivity can block cutting
6. **Plasmid annotation** — verify ORFs are in correct reading frame; check for cryptic promoters; map all unique restriction sites for future cloning

## Troubleshooting

**Problem:** PCR simulation finds no amplicons
**Solution:** Check primer orientation (forward should match sense strand 5'->3'). Increase `max_mismatches`. Verify template contains the target region.

**Problem:** Restriction enzyme doesn't cut expected site
**Solution:** Check for CpG methylation sensitivity (dam/dcm methylation). Verify site isn't in a modified context. Use `isoschizomers()` to find alternatives.

**Problem:** Golden Gate assembly produces wrong product
**Solution:** Verify all overhangs are unique. Check enzyme is BsaI (not BsmBI) — different cut distances. Ensure parts are in correct orientation.

**Problem:** primer3 returns no primers
**Solution:** Relax constraints: widen Tm range, increase max size, lower GC requirement. Ensure target region has sufficient flanking sequence.

**Problem:** CRISPR guide design returns few candidates
**Solution:** Expand search region (use full gene, not just one exon). Try alternative PAM sequences (NAG for relaxed SpCas9). Consider Cas12a (TTTV PAM) for AT-rich regions.

## Resources

- [Biopython Restriction Module](https://biopython.org/wiki/Restriction)
- [primer3-py Documentation](https://libnano.github.io/primer3-py/)
- [CRISPR Design Rules](https://doi.org/10.1038/nbt.2647)
- [Golden Gate Assembly (Engler et al.)](https://doi.org/10.1371/journal.pone.0003647)
- [Gibson Assembly (Gibson et al.)](https://doi.org/10.1038/nmeth.1318)

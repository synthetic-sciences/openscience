#!/usr/bin/env python3
"""
Codon Optimization for Heterologous Expression

Optimize DNA or protein sequences for expression in a target organism by
replacing codons with the most frequently used synonymous codons. Calculates
Codon Adaptation Index (CAI) before and after optimization, enforces GC content
constraints, removes restriction enzyme recognition sites (BsaI, BpiI), and
eliminates homopolymer runs longer than 5 bases.

Usage:
    python codon_optimize.py --sequence ATGAAAGCG... --organism ecoli
    python codon_optimize.py --sequence MKAIIV... --organism yeast --output optimized.fasta
    python codon_optimize.py --sequence input.fasta --organism human

Examples:
    # Optimize a raw DNA sequence for E. coli
    python codon_optimize.py --sequence ATGAAAGCGATTTACGTG --organism ecoli

    # Back-translate a protein sequence for yeast expression
    python codon_optimize.py --sequence MKAIIVSRT --organism yeast

    # Read from FASTA and write optimized to file
    python codon_optimize.py --sequence gene.fasta --organism cho --output optimized.fasta

Dependencies: numpy, biopython
"""

import argparse
import math
import os
import re
import sys
from pathlib import Path

import numpy as np


# ---------------------------------------------------------------------------
# Codon usage tables: top codon per amino acid for each organism
# Frequencies are relative synonymous codon usage (RSCU-like weights, 0-1).
# ---------------------------------------------------------------------------

# Full codon tables mapping every codon to its amino acid
CODON_TABLE = {
    "TTT": "F", "TTC": "F", "TTA": "L", "TTG": "L",
    "CTT": "L", "CTC": "L", "CTA": "L", "CTG": "L",
    "ATT": "I", "ATC": "I", "ATA": "I", "ATG": "M",
    "GTT": "V", "GTC": "V", "GTA": "V", "GTG": "V",
    "TCT": "S", "TCC": "S", "TCA": "S", "TCG": "S",
    "CCT": "P", "CCC": "P", "CCA": "P", "CCG": "P",
    "ACT": "T", "ACC": "T", "ACA": "T", "ACG": "T",
    "GCT": "A", "GCC": "A", "GCA": "A", "GCG": "A",
    "TAT": "Y", "TAC": "Y", "TAA": "*", "TAG": "*",
    "CAT": "H", "CAC": "H", "CAA": "Q", "CAG": "Q",
    "AAT": "N", "AAC": "N", "AAA": "K", "AAG": "K",
    "GAT": "D", "GAC": "D", "GAA": "E", "GAG": "E",
    "TGT": "C", "TGC": "C", "TGA": "*", "TGG": "W",
    "CGT": "R", "CGC": "R", "CGA": "R", "CGG": "R",
    "AGT": "S", "AGC": "S", "AGA": "R", "AGG": "R",
    "GGT": "G", "GGC": "G", "GGA": "G", "GGG": "G",
}

# Per-organism codon usage frequencies (fraction of usage within synonymous group)
# Sources: Kazusa codon usage database, curated for high-expression genes
CODON_USAGE = {
    "ecoli": {
        "F": {"TTT": 0.42, "TTC": 0.58},
        "L": {"TTA": 0.06, "TTG": 0.06, "CTT": 0.10, "CTC": 0.10, "CTA": 0.02, "CTG": 0.66},
        "I": {"ATT": 0.40, "ATC": 0.55, "ATA": 0.05},
        "M": {"ATG": 1.00},
        "V": {"GTT": 0.29, "GTC": 0.20, "GTA": 0.13, "GTG": 0.38},
        "S": {"TCT": 0.19, "TCC": 0.20, "TCA": 0.08, "TCG": 0.12, "AGT": 0.08, "AGC": 0.33},
        "P": {"CCT": 0.12, "CCC": 0.08, "CCA": 0.20, "CCG": 0.60},
        "T": {"ACT": 0.18, "ACC": 0.46, "ACA": 0.10, "ACG": 0.26},
        "A": {"GCT": 0.19, "GCC": 0.30, "GCA": 0.19, "GCG": 0.32},
        "Y": {"TAT": 0.40, "TAC": 0.60},
        "H": {"CAT": 0.40, "CAC": 0.60},
        "Q": {"CAA": 0.31, "CAG": 0.69},
        "N": {"AAT": 0.35, "AAC": 0.65},
        "K": {"AAA": 0.76, "AAG": 0.24},
        "D": {"GAT": 0.56, "GAC": 0.44},
        "E": {"GAA": 0.70, "GAG": 0.30},
        "C": {"TGT": 0.40, "TGC": 0.60},
        "W": {"TGG": 1.00},
        "R": {"CGT": 0.42, "CGC": 0.38, "CGA": 0.04, "CGG": 0.06, "AGA": 0.04, "AGG": 0.06},
        "G": {"GGT": 0.38, "GGC": 0.38, "GGA": 0.08, "GGG": 0.16},
        "*": {"TAA": 0.64, "TAG": 0.07, "TGA": 0.29},
    },
    "yeast": {
        "F": {"TTT": 0.41, "TTC": 0.59},
        "L": {"TTA": 0.26, "TTG": 0.29, "CTT": 0.12, "CTC": 0.05, "CTA": 0.13, "CTG": 0.15},
        "I": {"ATT": 0.46, "ATC": 0.26, "ATA": 0.28},
        "M": {"ATG": 1.00},
        "V": {"GTT": 0.39, "GTC": 0.21, "GTA": 0.20, "GTG": 0.20},
        "S": {"TCT": 0.26, "TCC": 0.16, "TCA": 0.18, "TCG": 0.09, "AGT": 0.14, "AGC": 0.17},
        "P": {"CCT": 0.31, "CCC": 0.15, "CCA": 0.42, "CCG": 0.12},
        "T": {"ACT": 0.35, "ACC": 0.22, "ACA": 0.30, "ACG": 0.13},
        "A": {"GCT": 0.38, "GCC": 0.22, "GCA": 0.29, "GCG": 0.11},
        "Y": {"TAT": 0.44, "TAC": 0.56},
        "H": {"CAT": 0.36, "CAC": 0.64},
        "Q": {"CAA": 0.69, "CAG": 0.31},
        "N": {"AAT": 0.42, "AAC": 0.58},
        "K": {"AAA": 0.58, "AAG": 0.42},
        "D": {"GAT": 0.65, "GAC": 0.35},
        "E": {"GAA": 0.71, "GAG": 0.29},
        "C": {"TGT": 0.63, "TGC": 0.37},
        "W": {"TGG": 1.00},
        "R": {"CGT": 0.14, "CGC": 0.06, "CGA": 0.07, "CGG": 0.04, "AGA": 0.48, "AGG": 0.21},
        "G": {"GGT": 0.47, "GGC": 0.19, "GGA": 0.22, "GGG": 0.12},
        "*": {"TAA": 0.48, "TAG": 0.24, "TGA": 0.28},
    },
    "human": {
        "F": {"TTT": 0.45, "TTC": 0.55},
        "L": {"TTA": 0.07, "TTG": 0.13, "CTT": 0.13, "CTC": 0.20, "CTA": 0.07, "CTG": 0.40},
        "I": {"ATT": 0.36, "ATC": 0.48, "ATA": 0.16},
        "M": {"ATG": 1.00},
        "V": {"GTT": 0.18, "GTC": 0.24, "GTA": 0.11, "GTG": 0.47},
        "S": {"TCT": 0.18, "TCC": 0.22, "TCA": 0.15, "TCG": 0.06, "AGT": 0.15, "AGC": 0.24},
        "P": {"CCT": 0.28, "CCC": 0.33, "CCA": 0.27, "CCG": 0.12},
        "T": {"ACT": 0.24, "ACC": 0.36, "ACA": 0.28, "ACG": 0.12},
        "A": {"GCT": 0.26, "GCC": 0.40, "GCA": 0.23, "GCG": 0.11},
        "Y": {"TAT": 0.43, "TAC": 0.57},
        "H": {"CAT": 0.41, "CAC": 0.59},
        "Q": {"CAA": 0.25, "CAG": 0.75},
        "N": {"AAT": 0.46, "AAC": 0.54},
        "K": {"AAA": 0.42, "AAG": 0.58},
        "D": {"GAT": 0.46, "GAC": 0.54},
        "E": {"GAA": 0.42, "GAG": 0.58},
        "C": {"TGT": 0.45, "TGC": 0.55},
        "W": {"TGG": 1.00},
        "R": {"CGT": 0.08, "CGC": 0.19, "CGA": 0.11, "CGG": 0.21, "AGA": 0.20, "AGG": 0.21},
        "G": {"GGT": 0.16, "GGC": 0.34, "GGA": 0.25, "GGG": 0.25},
        "*": {"TAA": 0.28, "TAG": 0.20, "TGA": 0.52},
    },
    "cho": {
        "F": {"TTT": 0.43, "TTC": 0.57},
        "L": {"TTA": 0.06, "TTG": 0.12, "CTT": 0.12, "CTC": 0.21, "CTA": 0.07, "CTG": 0.42},
        "I": {"ATT": 0.34, "ATC": 0.51, "ATA": 0.15},
        "M": {"ATG": 1.00},
        "V": {"GTT": 0.17, "GTC": 0.25, "GTA": 0.10, "GTG": 0.48},
        "S": {"TCT": 0.18, "TCC": 0.23, "TCA": 0.14, "TCG": 0.06, "AGT": 0.14, "AGC": 0.25},
        "P": {"CCT": 0.29, "CCC": 0.34, "CCA": 0.26, "CCG": 0.11},
        "T": {"ACT": 0.23, "ACC": 0.38, "ACA": 0.27, "ACG": 0.12},
        "A": {"GCT": 0.27, "GCC": 0.41, "GCA": 0.22, "GCG": 0.10},
        "Y": {"TAT": 0.42, "TAC": 0.58},
        "H": {"CAT": 0.40, "CAC": 0.60},
        "Q": {"CAA": 0.24, "CAG": 0.76},
        "N": {"AAT": 0.44, "AAC": 0.56},
        "K": {"AAA": 0.40, "AAG": 0.60},
        "D": {"GAT": 0.44, "GAC": 0.56},
        "E": {"GAA": 0.40, "GAG": 0.60},
        "C": {"TGT": 0.43, "TGC": 0.57},
        "W": {"TGG": 1.00},
        "R": {"CGT": 0.08, "CGC": 0.20, "CGA": 0.11, "CGG": 0.22, "AGA": 0.19, "AGG": 0.20},
        "G": {"GGT": 0.15, "GGC": 0.35, "GGA": 0.26, "GGG": 0.24},
        "*": {"TAA": 0.26, "TAG": 0.20, "TGA": 0.54},
    },
}

# Restriction enzyme recognition sites to avoid (forward and reverse complement)
RESTRICTION_SITES = {
    "BsaI": ["GGTCTC", "GAGACC"],
    "BpiI": ["GAAGAC", "GTCTTC"],
}

AMINO_ACIDS_1 = set("ACDEFGHIKLMNPQRSTVWY*")


def is_protein_sequence(seq):
    """Determine if a sequence is protein (contains non-ACGT characters)."""
    upper = seq.upper().replace("\n", "").replace(" ", "")
    dna_chars = set("ACGTN")
    non_dna = set(upper) - dna_chars
    if not non_dna:
        return False
    if non_dna.issubset(AMINO_ACIDS_1):
        return True
    return False


def parse_fasta(filepath):
    """Parse a FASTA file, returning the first sequence."""
    header = ""
    sequences = []
    with open(filepath) as fh:
        for line in fh:
            line = line.strip()
            if line.startswith(">"):
                if sequences:
                    break
                header = line[1:]
            else:
                sequences.append(line.upper())
    return header, "".join(sequences)


def read_sequence(seq_input):
    """Read sequence from raw string or FASTA file path. Returns (header, sequence)."""
    path = Path(seq_input)
    if path.is_file():
        return parse_fasta(str(path))
    cleaned = seq_input.upper().replace(" ", "").replace("\n", "")
    if not cleaned:
        raise ValueError("Empty sequence provided")
    return ("optimized_sequence", cleaned)


def translate_dna(dna_seq):
    """Translate a DNA sequence to protein."""
    protein = []
    for i in range(0, len(dna_seq) - 2, 3):
        codon = dna_seq[i:i+3]
        aa = CODON_TABLE.get(codon, "X")
        if aa == "*":
            break
        protein.append(aa)
    return "".join(protein)


def best_codon(aa, organism):
    """Return the optimal codon for an amino acid in the given organism."""
    usage = CODON_USAGE[organism]
    if aa not in usage:
        raise ValueError(f"Unknown amino acid: {aa}")
    codons = usage[aa]
    return max(codons, key=codons.get)


def back_translate(protein_seq, organism):
    """Back-translate a protein sequence using optimal codons for the organism."""
    codons = []
    for aa in protein_seq:
        if aa == "*":
            codons.append(best_codon("*", organism))
            break
        codons.append(best_codon(aa, organism))
    return "".join(codons)


def get_codons(dna_seq):
    """Split a DNA sequence into a list of codons."""
    return [dna_seq[i:i+3] for i in range(0, len(dna_seq), 3) if i+3 <= len(dna_seq)]


def calculate_cai(dna_seq, organism):
    """
    Calculate the Codon Adaptation Index (CAI).

    CAI = geometric mean of (w_i) for each codon, where w_i = f_i / f_max
    for the synonymous codon group.
    """
    usage = CODON_USAGE[organism]
    codons = get_codons(dna_seq)
    if not codons:
        return 0.0

    log_weights = []
    for codon in codons:
        aa = CODON_TABLE.get(codon)
        if aa is None or aa not in usage:
            continue
        synonymous = usage[aa]
        max_freq = max(synonymous.values())
        if max_freq == 0:
            continue
        freq = synonymous.get(codon, 0)
        if freq == 0:
            freq = 0.001  # avoid log(0) for extremely rare codons
        w = freq / max_freq
        log_weights.append(math.log(w))

    if not log_weights:
        return 0.0
    return math.exp(sum(log_weights) / len(log_weights))


def gc_content(dna_seq):
    """Calculate GC content as a fraction."""
    if not dna_seq:
        return 0.0
    gc = sum(1 for b in dna_seq.upper() if b in "GC")
    return gc / len(dna_seq)


def find_restriction_sites(dna_seq):
    """Find all restriction enzyme recognition sites in the sequence."""
    hits = []
    for enzyme, patterns in RESTRICTION_SITES.items():
        for pat in patterns:
            for m in re.finditer(pat, dna_seq, re.IGNORECASE):
                hits.append((enzyme, m.start(), m.end(), pat))
    return hits


def has_homopolymer_run(dna_seq, max_run=5):
    """Check for homopolymer runs exceeding max_run length. Returns list of (base, start, length)."""
    runs = []
    for base in "ACGT":
        pattern = base * (max_run + 1)
        idx = 0
        while True:
            pos = dna_seq.upper().find(pattern, idx)
            if pos == -1:
                break
            # find full extent of run
            end = pos + max_run + 1
            while end < len(dna_seq) and dna_seq[end].upper() == base:
                end += 1
            runs.append((base, pos, end - pos))
            idx = end
    return runs


def synonymous_codons_for(codon, organism):
    """Return all synonymous codons for a given codon, sorted by usage frequency descending."""
    aa = CODON_TABLE.get(codon)
    if aa is None:
        return [codon]
    usage = CODON_USAGE[organism]
    if aa not in usage:
        return [codon]
    return sorted(usage[aa].keys(), key=lambda c: usage[aa][c], reverse=True)


def remove_restriction_sites(codons, organism):
    """Replace codons to eliminate restriction enzyme recognition sites."""
    max_iterations = 50
    for _ in range(max_iterations):
        dna = "".join(codons)
        hits = find_restriction_sites(dna)
        if not hits:
            break
        for enzyme, start, end, pat in hits:
            # Find which codons overlap with the site
            codon_start = start // 3
            codon_end = min((end - 1) // 3 + 1, len(codons))
            replaced = False
            for ci in range(codon_start, codon_end):
                original = codons[ci]
                alternatives = synonymous_codons_for(original, organism)
                for alt in alternatives:
                    if alt == original:
                        continue
                    test_codons = codons[:ci] + [alt] + codons[ci+1:]
                    test_dna = "".join(test_codons)
                    region = test_dna[max(0, start-6):min(len(test_dna), end+6)]
                    if not any(p in region.upper() for _, patterns in RESTRICTION_SITES.items() for p in patterns):
                        codons[ci] = alt
                        replaced = True
                        break
                if replaced:
                    break
    return codons


def fix_gc_content(codons, organism, target_min=0.40, target_max=0.60, window=30):
    """
    Adjust codons in windows to keep local GC content between target_min and target_max.
    Uses a sliding window approach.
    """
    dna = "".join(codons)
    n = len(dna)
    if n < window:
        return codons

    for win_start in range(0, n - window + 1, 3):
        win_end = min(win_start + window, n)
        segment = dna[win_start:win_end]
        local_gc = gc_content(segment)

        if target_min <= local_gc <= target_max:
            continue

        codon_start = win_start // 3
        codon_end = min(win_end // 3 + 1, len(codons))

        for ci in range(codon_start, codon_end):
            current_gc = gc_content("".join(codons))
            if target_min <= current_gc <= target_max:
                break

            original = codons[ci]
            aa = CODON_TABLE.get(original)
            if aa is None or aa not in CODON_USAGE[organism]:
                continue

            alternatives = synonymous_codons_for(original, organism)
            best_alt = original
            best_diff = abs(gc_content("".join(codons)) - 0.50)

            for alt in alternatives:
                if alt == original:
                    continue
                test_codons = codons.copy()
                test_codons[ci] = alt
                new_gc = gc_content("".join(test_codons))
                diff = abs(new_gc - 0.50)
                if diff < best_diff and target_min <= new_gc <= target_max:
                    best_alt = alt
                    best_diff = diff

            codons[ci] = best_alt
        dna = "".join(codons)

    return codons


def fix_homopolymers(codons, organism, max_run=5):
    """Remove homopolymer runs by swapping to synonymous codons."""
    max_iterations = 50
    for _ in range(max_iterations):
        dna = "".join(codons)
        runs = has_homopolymer_run(dna, max_run)
        if not runs:
            break
        for base, start, length in runs:
            codon_start = start // 3
            codon_end = min((start + length - 1) // 3 + 1, len(codons))
            fixed = False
            for ci in range(codon_start, codon_end):
                original = codons[ci]
                alternatives = synonymous_codons_for(original, organism)
                for alt in alternatives:
                    if alt == original:
                        continue
                    test_codons = codons.copy()
                    test_codons[ci] = alt
                    test_dna = "".join(test_codons)
                    if not has_homopolymer_run(test_dna[max(0, start-3):min(len(test_dna), start+length+3)], max_run):
                        codons[ci] = alt
                        fixed = True
                        break
                if fixed:
                    break
    return codons


def optimize_sequence(dna_seq, organism):
    """
    Full codon optimization pipeline:
    1. Replace each codon with the optimal codon for the organism
    2. Remove restriction enzyme sites
    3. Fix GC content
    4. Remove homopolymer runs
    """
    # Step 1: Replace with optimal codons
    original_codons = get_codons(dna_seq)
    optimized = []
    for codon in original_codons:
        aa = CODON_TABLE.get(codon)
        if aa is None:
            optimized.append(codon)
            continue
        optimized.append(best_codon(aa, organism))

    # Step 2: Remove restriction sites
    optimized = remove_restriction_sites(optimized, organism)

    # Step 3: Fix GC content
    optimized = fix_gc_content(optimized, organism)

    # Step 4: Remove homopolymer runs
    optimized = fix_homopolymers(optimized, organism)

    return "".join(optimized)


def format_fasta(header, sequence, line_width=70):
    """Format a sequence as FASTA."""
    lines = [f">{header}"]
    for i in range(0, len(sequence), line_width):
        lines.append(sequence[i:i+line_width])
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Codon optimization for heterologous expression",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --sequence ATGAAAGCGATTTAC --organism ecoli
  %(prog)s --sequence MKAIV --organism yeast --output opt.fasta
  %(prog)s --sequence input.fasta --organism human
        """,
    )
    parser.add_argument(
        "--sequence", required=True,
        help="DNA or protein sequence string, or path to a FASTA file",
    )
    parser.add_argument(
        "--organism", default="ecoli",
        choices=["ecoli", "yeast", "human", "cho"],
        help="Target organism for optimization (default: ecoli)",
    )
    parser.add_argument(
        "--output", default=None,
        help="Output FASTA file path (optional; prints to stdout if omitted)",
    )
    args = parser.parse_args()

    # Read sequence
    try:
        header, seq = read_sequence(args.sequence)
    except Exception as e:
        print(f"ERROR: Failed to read sequence: {e}", file=sys.stderr)
        sys.exit(1)

    if not seq:
        print("ERROR: Empty sequence", file=sys.stderr)
        sys.exit(1)

    organism = args.organism
    is_protein = is_protein_sequence(seq)

    print(f"=== Codon Optimization Report ===")
    print(f"Organism:       {organism}")
    print(f"Input type:     {'Protein' if is_protein else 'DNA'}")
    print(f"Input length:   {len(seq)} {'aa' if is_protein else 'bp'}")
    print()

    if is_protein:
        # Back-translate protein to DNA using optimal codons
        print("Back-translating protein to optimized DNA...")
        protein_seq = seq.replace("*", "")
        dna_initial = back_translate(protein_seq, organism)
        # Run full optimization for constraint enforcement
        optimized_dna = optimize_sequence(dna_initial, organism)

        original_cai = calculate_cai(dna_initial, organism)
        optimized_cai = calculate_cai(optimized_dna, organism)

        print(f"Protein:        {protein_seq[:50]}{'...' if len(protein_seq) > 50 else ''}")
        print(f"DNA length:     {len(optimized_dna)} bp ({len(optimized_dna)//3} codons)")
        print(f"Initial CAI:    {original_cai:.4f}")
        print(f"Optimized CAI:  {optimized_cai:.4f}")
    else:
        # DNA input: re-optimize codons
        if len(seq) % 3 != 0:
            print(f"WARNING: Sequence length ({len(seq)}) is not a multiple of 3. "
                  f"Trimming {len(seq) % 3} trailing bases.", file=sys.stderr)
            seq = seq[:len(seq) - (len(seq) % 3)]

        original_cai = calculate_cai(seq, organism)
        print(f"Original CAI:   {original_cai:.4f}")

        optimized_dna = optimize_sequence(seq, organism)
        optimized_cai = calculate_cai(optimized_dna, organism)
        print(f"Optimized CAI:  {optimized_cai:.4f}")
        print(f"CAI improvement:{(optimized_cai - original_cai):+.4f}")

        # Verify translation is preserved
        orig_protein = translate_dna(seq)
        opt_protein = translate_dna(optimized_dna)
        if orig_protein != opt_protein:
            print("WARNING: Protein translation changed during optimization!", file=sys.stderr)
            print(f"  Original: {orig_protein[:40]}...", file=sys.stderr)
            print(f"  Optimized: {opt_protein[:40]}...", file=sys.stderr)
        else:
            print(f"Translation:    VERIFIED (protein sequence preserved)")

    # GC content
    final_gc = gc_content(optimized_dna)
    gc_ok = 0.40 <= final_gc <= 0.60
    print(f"GC content:     {final_gc*100:.1f}% {'(OK)' if gc_ok else '(WARNING: outside 40-60%)'}")

    # Restriction site check
    rs_hits = find_restriction_sites(optimized_dna)
    if rs_hits:
        print(f"Restriction:    WARNING - {len(rs_hits)} site(s) found:")
        for enzyme, start, end, pat in rs_hits:
            print(f"  {enzyme} ({pat}) at position {start}-{end}")
    else:
        print(f"Restriction:    PASS (no BsaI/BpiI sites)")

    # Homopolymer check
    homo_runs = has_homopolymer_run(optimized_dna, 5)
    if homo_runs:
        print(f"Homopolymers:   WARNING - {len(homo_runs)} run(s) > 5bp:")
        for base, start, length in homo_runs:
            print(f"  {base}x{length} at position {start}")
    else:
        print(f"Homopolymers:   PASS (no runs > 5bp)")

    print(f"Length:         {len(optimized_dna)} bp")
    print()

    # Output
    out_header = f"{header}_optimized_{organism}"
    fasta_output = format_fasta(out_header, optimized_dna)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w") as fh:
            fh.write(fasta_output + "\n")
        print(f"Saved to: {out_path}")
    else:
        print("--- Optimized FASTA ---")
        print(fasta_output)


if __name__ == "__main__":
    main()

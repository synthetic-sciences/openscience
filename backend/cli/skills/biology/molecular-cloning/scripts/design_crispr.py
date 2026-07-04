#!/usr/bin/env python3
"""Design CRISPR-Cas9 sgRNA guides with on-target scoring.

Scans a target DNA sequence on both strands for PAM sites, extracts the
20-nt guide upstream of each PAM, and ranks candidates by a composite
on-target score that considers GC content, poly-T runs (Pol III
terminator signal), homopolymer stretches, and position-weighted
nucleotide preferences.

Usage:
    python design_crispr.py --sequence SEQ [options]

Examples:
    # Default SpCas9 (NGG PAM), top 10 guides
    python design_crispr.py --sequence target_region.fasta --output-dir crispr_out

    # Custom PAM and top 5
    python design_crispr.py \\
        --sequence ATGCCC...NNNNN \\
        --pam NAG \\
        --top-n 5 \\
        --output-dir crispr_out
"""

import argparse
import csv
import os
import re
import sys

import numpy as np
from Bio import SeqIO
from Bio.Seq import Seq
from Bio.SeqRecord import SeqRecord
from Bio.SeqUtils import gc_fraction


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

IUPAC_MAP = {
    "A": "A", "C": "C", "G": "G", "T": "T",
    "R": "[AG]", "Y": "[CT]", "S": "[GC]", "W": "[AT]",
    "K": "[GT]", "M": "[AC]", "B": "[CGT]", "D": "[AGT]",
    "H": "[ACT]", "V": "[ACG]", "N": "[ACGT]",
}

GUIDE_LEN = 20

# Position-weight matrix for on-target scoring (simplified Doench 2014 style).
# Each position (0 = 5'-most of guide, 19 = 3'-most, adjacent to PAM) has a
# preference weight for each nucleotide.  Higher value = more favourable.
# These are illustrative; real scoring models use trained regression weights.
_rng = np.random.RandomState(42)
POSITION_WEIGHTS = np.ones((GUIDE_LEN, 4), dtype=np.float64)  # A, C, G, T
# 3' seed region (positions 14-19) contributes more
for pos in range(14, GUIDE_LEN):
    POSITION_WEIGHTS[pos] = [0.8, 1.0, 1.2, 0.7]
# Position 20 (last nt before PAM): G is favoured
POSITION_WEIGHTS[19] = [0.6, 0.8, 1.4, 0.5]

NUC_INDEX = {"A": 0, "C": 1, "G": 2, "T": 3}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_sequence(path_or_seq: str) -> str:
    """Return an uppercase DNA string from a FASTA file or raw sequence."""
    if os.path.isfile(path_or_seq):
        record = SeqIO.read(path_or_seq, "fasta")
        return str(record.seq).upper()
    cleaned = "".join(path_or_seq.split()).upper()
    valid = set("ACGTNRYSWKMBDHV")
    if all(c in valid for c in cleaned):
        return cleaned
    raise ValueError(
        f"Input is neither a valid FASTA file nor a DNA sequence: {path_or_seq[:60]}..."
    )


def reverse_complement(seq: str) -> str:
    return str(Seq(seq).reverse_complement())


def pam_to_regex(pam: str) -> str:
    """Convert an IUPAC PAM string to a regex pattern."""
    return "".join(IUPAC_MAP.get(c, c) for c in pam.upper())


# ---------------------------------------------------------------------------
# Guide finding
# ---------------------------------------------------------------------------

def find_guides(seq: str, pam: str) -> list[dict]:
    """Scan both strands for PAM sites and extract upstream guides."""
    pam_re = pam_to_regex(pam)
    pam_len = len(pam)
    guides: list[dict] = []

    # Sense strand: guide is 20 nt upstream of PAM
    for m in re.finditer(f"(?=(.{{{GUIDE_LEN}}}{pam_re}))", seq):
        full = m.group(1)
        guide_seq = full[:GUIDE_LEN]
        pam_seq = full[GUIDE_LEN:]
        pos = m.start()  # 0-based start of guide on sense
        guides.append({
            "guide": guide_seq,
            "pam_seq": pam_seq,
            "strand": "+",
            "position": pos,
        })

    # Antisense strand
    rc = reverse_complement(seq)
    for m in re.finditer(f"(?=(.{{{GUIDE_LEN}}}{pam_re}))", rc):
        full = m.group(1)
        guide_seq = full[:GUIDE_LEN]
        pam_seq = full[GUIDE_LEN:]
        # Map position back to sense strand coordinates
        rc_pos = m.start()
        sense_pos = len(seq) - rc_pos - GUIDE_LEN - pam_len
        guides.append({
            "guide": guide_seq,
            "pam_seq": pam_seq,
            "strand": "-",
            "position": sense_pos,
        })

    return guides


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score_guide(guide_seq: str) -> tuple[float, list[str]]:
    """Return (score 0-100, list_of_penalty_reasons) for a 20-nt guide."""
    score = 100.0
    reasons: list[str] = []

    # --- GC content (40-70% optimal) ---
    gc = gc_fraction(guide_seq) * 100
    if gc < 30 or gc > 80:
        penalty = 30.0
        score -= penalty
        reasons.append(f"GC={gc:.0f}% (far from 40-70%)")
    elif gc < 40 or gc > 70:
        penalty = 10.0
        score -= penalty
        reasons.append(f"GC={gc:.0f}% (outside 40-70%)")

    # --- Poly-T (TTTT) = Pol III terminator signal ---
    if "TTTT" in guide_seq:
        score -= 25.0
        reasons.append("Contains TTTT (Pol III terminator)")

    # --- Homopolymer runs > 4 ---
    for nuc in "ACGT":
        pattern = nuc * 5
        if pattern in guide_seq:
            score -= 15.0
            reasons.append(f"Homopolymer run: {pattern}")

    # --- Position-weighted nucleotide preference ---
    pw_score = 0.0
    pw_max = 0.0
    for i, nt in enumerate(guide_seq):
        idx = NUC_INDEX.get(nt)
        if idx is not None:
            pw_score += POSITION_WEIGHTS[i, idx]
            pw_max += max(POSITION_WEIGHTS[i])
        else:
            pw_max += max(POSITION_WEIGHTS[i])
    pw_frac = pw_score / pw_max if pw_max > 0 else 0.5
    # Scale positional component to 0-20 range
    pos_bonus = pw_frac * 20.0
    score += pos_bonus - 10.0  # centre so neutral = 0 adjustment

    # --- Seed region (last 12 nt) GC ---
    seed = guide_seq[-12:]
    seed_gc = gc_fraction(seed) * 100
    if seed_gc < 30 or seed_gc > 80:
        score -= 10.0
        reasons.append(f"Seed GC={seed_gc:.0f}% (extreme)")

    score = max(0.0, min(100.0, score))
    return round(score, 1), reasons


def rank_guides(guides: list[dict]) -> list[dict]:
    """Add scores and sort descending."""
    for g in guides:
        s, r = score_guide(g["guide"])
        g["score"] = s
        g["gc_pct"] = round(gc_fraction(g["guide"]) * 100, 1)
        g["penalties"] = "; ".join(r) if r else "none"
    guides.sort(key=lambda g: g["score"], reverse=True)
    return guides


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def print_report(guides: list[dict], top_n: int):
    print(f"=== CRISPR sgRNA Design (top {min(top_n, len(guides))} of {len(guides)} candidates) ===\n")
    header = f"{'Rank':<5} {'Guide (5->3)':<22} {'PAM':<6} {'Strand':<7} {'Pos':<8} {'GC%':<6} {'Score':<7} {'Notes'}"
    print(header)
    print("-" * len(header))
    for idx, g in enumerate(guides[:top_n], 1):
        print(
            f"{idx:<5} {g['guide']:<22} {g['pam_seq']:<6} {g['strand']:<7} "
            f"{g['position']:<8} {g['gc_pct']:<6} {g['score']:<7} {g['penalties']}"
        )

    if not guides:
        print("No valid guide RNA candidates found.")


def save_outputs(guides: list[dict], top_n: int, outdir: str):
    os.makedirs(outdir, exist_ok=True)
    selected = guides[:top_n]

    # CSV
    csv_path = os.path.join(outdir, "guides.csv")
    with open(csv_path, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["rank", "guide_seq", "pam", "strand", "position", "gc_pct", "score", "notes"])
        for idx, g in enumerate(selected, 1):
            writer.writerow([
                idx, g["guide"], g["pam_seq"], g["strand"],
                g["position"], g["gc_pct"], g["score"], g["penalties"],
            ])
    print(f"\nGuides CSV saved to {csv_path}")

    # FASTA
    records = []
    for idx, g in enumerate(selected, 1):
        rec = SeqRecord(
            Seq(g["guide"]),
            id=f"guide_{idx}",
            description=(
                f"strand={g['strand']} pos={g['position']} "
                f"pam={g['pam_seq']} gc={g['gc_pct']}% score={g['score']}"
            ),
        )
        records.append(rec)
    fasta_path = os.path.join(outdir, "guides.fasta")
    SeqIO.write(records, fasta_path, "fasta")
    print(f"Guides FASTA saved to {fasta_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Design CRISPR-Cas9 sgRNA guides with on-target scoring."
    )
    p.add_argument(
        "--sequence",
        required=True,
        help="Path to a FASTA file or a raw DNA sequence string (target region).",
    )
    p.add_argument(
        "--pam",
        default="NGG",
        help="PAM motif in IUPAC notation (default: NGG for SpCas9).",
    )
    p.add_argument(
        "--top-n",
        type=int,
        default=10,
        help="Number of top-ranked guides to report (default: 10).",
    )
    p.add_argument(
        "--output-dir",
        default=None,
        help="Directory for output files (CSV + FASTA).",
    )
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)

    try:
        seq = load_sequence(args.sequence)
    except Exception as exc:
        print(f"ERROR: Could not load sequence: {exc}", file=sys.stderr)
        sys.exit(1)

    if len(seq) < GUIDE_LEN + len(args.pam):
        print(
            f"ERROR: Sequence too short ({len(seq)} bp) for guide design.",
            file=sys.stderr,
        )
        sys.exit(1)

    guides = find_guides(seq, args.pam)

    if not guides:
        print(f"No {args.pam} PAM sites found in the input sequence.", file=sys.stderr)
        sys.exit(1)

    ranked = rank_guides(guides)
    print_report(ranked, args.top_n)

    if args.output_dir:
        save_outputs(ranked, args.top_n, args.output_dir)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
draw_sequence_logo.py - Generate sequence logos from multiple sequence alignments.

Renders information-content or probability logos from aligned FASTA or Clustal
files using logomaker and BioPython.

Usage:
    python draw_sequence_logo.py --input alignment.fasta --output logo.png
    python draw_sequence_logo.py --input alignment.fasta --output logo.svg --type probability
    python draw_sequence_logo.py --input alignment.fasta --output logo.png --start 10 --end 30
"""

import argparse
import sys

try:
    from Bio import AlignIO
except ImportError:
    print("Error: BioPython is required. Install with: pip install biopython", file=sys.stderr)
    sys.exit(1)

try:
    import logomaker
except ImportError:
    print("Error: logomaker is required. Install with: pip install logomaker", file=sys.stderr)
    sys.exit(1)

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np


def alignment_to_matrix(alignment, logo_type="information"):
    seqs = [str(rec.seq) for rec in alignment]
    length = len(seqs[0])
    n_seqs = len(seqs)

    # Detect alphabet
    all_chars = set("".join(seqs)) - {"-", "."}
    is_protein = len(all_chars) > 4

    if is_protein:
        alphabet = sorted(all_chars)
    else:
        alphabet = ["A", "C", "G", "T"]

    # Build counts matrix
    counts = pd.DataFrame(0, index=range(length), columns=alphabet, dtype=float)
    for seq in seqs:
        for i, char in enumerate(seq):
            if char in alphabet:
                counts.at[i, char] += 1

    if logo_type == "probability":
        matrix = counts.div(counts.sum(axis=1), axis=0).fillna(0)
    else:
        # Information content
        matrix = logomaker.transform_matrix(
            counts,
            from_type="counts",
            to_type="information",
        )

    return matrix


def detect_format(path):
    with open(path) as f:
        first_line = f.readline().strip()
    if first_line.startswith(">"):
        return "fasta"
    if first_line.startswith("CLUSTAL") or first_line.startswith("MUSCLE"):
        return "clustal"
    return "fasta"


def main():
    parser = argparse.ArgumentParser(description="Generate sequence logos from alignments")
    parser.add_argument("--input", required=True, help="Aligned FASTA or Clustal file")
    parser.add_argument("--output", required=True, help="Output image path (PNG/SVG/PDF)")
    parser.add_argument("--type", choices=["information", "probability"], default="information",
                        help="Logo type (default: information)")
    parser.add_argument("--start", type=int, default=None, help="Start position (0-indexed)")
    parser.add_argument("--end", type=int, default=None, help="End position (exclusive)")
    parser.add_argument("--title", default=None, help="Figure title")
    parser.add_argument("--figsize", default="10x3", help="Figure size as WxH (default: 10x3)")
    parser.add_argument("--dpi", type=int, default=300, help="Resolution in DPI (default: 300)")
    args = parser.parse_args()

    fmt = detect_format(args.input)
    alignment = AlignIO.read(args.input, fmt)

    matrix = alignment_to_matrix(alignment, args.type)

    # Slice if requested
    if args.start is not None or args.end is not None:
        start = args.start or 0
        end = args.end or len(matrix)
        matrix = matrix.iloc[start:end].reset_index(drop=True)

    # Parse figsize
    try:
        parts = args.figsize.lower().split("x")
        figw, figh = float(parts[0]), float(parts[1])
    except (ValueError, IndexError):
        figw, figh = 10, 3

    fig, ax = plt.subplots(figsize=(figw, figh))
    logo = logomaker.Logo(matrix, ax=ax, shade_below=0.5, fade_below=0.5)

    if args.type == "information":
        # Determine max info content
        all_chars = set()
        for col in matrix.columns:
            all_chars.add(col)
        max_bits = np.log2(len(matrix.columns))
        ax.set_ylabel("Information (bits)", fontsize=12)
        ax.set_ylim(0, max_bits * 1.1)
    else:
        ax.set_ylabel("Probability", fontsize=12)
        ax.set_ylim(0, 1.05)

    ax.set_xlabel("Position", fontsize=12)
    if args.title:
        ax.set_title(args.title, fontsize=14, fontweight="bold")

    logo.style_spines(visible=False)
    logo.style_spines(spines=["left", "bottom"], visible=True)

    plt.tight_layout()
    plt.savefig(args.output, dpi=args.dpi, bbox_inches="tight")
    plt.close()

    n_seqs = len(alignment)
    n_pos = len(matrix)
    print(f"Sequence logo saved to {args.output} ({n_seqs} sequences, {n_pos} positions, type={args.type})")


if __name__ == "__main__":
    main()

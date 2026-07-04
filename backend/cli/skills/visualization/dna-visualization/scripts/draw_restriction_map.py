#!/usr/bin/env python3
"""
draw_restriction_map.py - Annotate restriction enzyme cut sites on DNA sequences.

Renders a linear or circular diagram showing restriction enzyme recognition sites
and cut positions using BioPython's Restriction module and matplotlib.

Usage:
    python draw_restriction_map.py --input sequence.gb --output restriction_map.png
    python draw_restriction_map.py --input sequence.fasta --output map.png --enzymes EcoRI,BamHI,HindIII
    python draw_restriction_map.py --input sequence.gb --output map.svg --linear --figwidth 16
"""

import argparse
import sys

try:
    from Bio import SeqIO
    from Bio.Seq import Seq
    from Bio.Restriction import RestrictionBatch, CommOnly
except ImportError:
    print("Error: BioPython is required. Install with: pip install biopython", file=sys.stderr)
    sys.exit(1)

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np


# Colorblind-safe palette for enzyme labels
ENZYME_COLORS = [
    "#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6",
    "#1abc9c", "#e67e22", "#34495e", "#d35400", "#8e44ad",
    "#16a085", "#c0392b", "#2980b9", "#27ae60", "#f1c40f",
]


def read_sequence(path):
    ext = path.lower()
    if ext.endswith((".gb", ".gbk", ".genbank")):
        record = SeqIO.read(path, "genbank")
    else:
        record = SeqIO.read(path, "fasta")
    return record


def find_cut_sites(seq, enzyme_names=None):
    if enzyme_names:
        batch = RestrictionBatch(enzyme_names)
    else:
        batch = CommOnly

    results = batch.search(seq)

    # Filter to enzymes that actually cut
    sites = {}
    for enzyme, positions in results.items():
        if positions:
            sites[str(enzyme)] = sorted(positions)
    return sites


def main():
    parser = argparse.ArgumentParser(description="Generate restriction enzyme site maps")
    parser.add_argument("--input", required=True, help="GenBank or FASTA file path")
    parser.add_argument("--output", required=True, help="Output image path (PNG/SVG/PDF)")
    parser.add_argument("--enzymes", default=None,
                        help="Comma-separated enzyme names (default: all common enzymes that cut)")
    parser.add_argument("--max-enzymes", type=int, default=15,
                        help="Max enzymes to display (default: 15)")
    parser.add_argument("--linear", action="store_true", help="Force linear display")
    parser.add_argument("--figwidth", type=float, default=14, help="Figure width in inches")
    parser.add_argument("--dpi", type=int, default=300, help="Resolution in DPI")
    parser.add_argument("--title", default=None, help="Figure title")
    args = parser.parse_args()

    record = read_sequence(args.input)
    seq = record.seq
    seq_len = len(seq)

    enzyme_names = args.enzymes.split(",") if args.enzymes else None
    sites = find_cut_sites(seq, enzyme_names)

    if not sites:
        print("No restriction enzyme cut sites found.", file=sys.stderr)
        sys.exit(0)

    # Sort by number of cuts (fewest first), limit display
    sorted_enzymes = sorted(sites.keys(), key=lambda e: len(sites[e]))
    if len(sorted_enzymes) > args.max_enzymes:
        sorted_enzymes = sorted_enzymes[:args.max_enzymes]
        print(f"Showing top {args.max_enzymes} enzymes (fewest cuts). "
              f"Use --enzymes to specify.", file=sys.stderr)

    # Plot
    n_enzymes = len(sorted_enzymes)
    fig_h = max(3, 1 + n_enzymes * 0.4)
    fig, ax = plt.subplots(figsize=(args.figwidth, fig_h))

    # Draw sequence backbone
    ax.plot([0, seq_len], [0, 0], color="black", linewidth=2, zorder=1)

    # Draw tick marks at each cut site
    for i, enzyme in enumerate(sorted_enzymes):
        positions = sites[enzyme]
        color = ENZYME_COLORS[i % len(ENZYME_COLORS)]
        y_offset = -(i + 1) * 0.35

        for pos in positions:
            ax.plot([pos, pos], [0, y_offset], color=color, linewidth=1, alpha=0.7)
            ax.plot(pos, y_offset, "v", color=color, markersize=5)

        # Label
        ax.text(seq_len * 1.02, y_offset, f"{enzyme} ({len(positions)})",
                fontsize=9, va="center", color=color, fontweight="bold")

    # Axis formatting
    ax.set_xlim(-seq_len * 0.02, seq_len * 1.15)
    ax.set_ylim(-(n_enzymes + 1) * 0.35, 0.5)
    ax.set_xlabel("Position (bp)", fontsize=11)
    ax.set_yticks([])
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_visible(False)

    title = args.title or f"Restriction Map — {record.name} ({seq_len:,} bp)"
    ax.set_title(title, fontsize=13, fontweight="bold", pad=10)

    plt.tight_layout()
    plt.savefig(args.output, dpi=args.dpi, bbox_inches="tight")
    plt.close()

    total_sites = sum(len(sites[e]) for e in sorted_enzymes)
    print(f"Restriction map saved to {args.output} ({n_enzymes} enzymes, {total_sites} cut sites)")


if __name__ == "__main__":
    main()

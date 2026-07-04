#!/usr/bin/env python3
"""
draw_gc_content.py - Plot sliding-window GC content along a DNA sequence.

Renders a line plot of GC percentage using a sliding window across a FASTA or
GenBank sequence. Useful for identifying GC-rich islands, AT-rich regions, and
compositional bias.

Usage:
    python draw_gc_content.py --input sequence.fasta --output gc_plot.png
    python draw_gc_content.py --input sequence.fasta --output gc.svg --window 200 --step 50
    python draw_gc_content.py --input sequence.gb --output gc.png --threshold 0.5
"""

import argparse
import sys

try:
    from Bio import SeqIO
except ImportError:
    print("Error: BioPython is required. Install with: pip install biopython", file=sys.stderr)
    sys.exit(1)

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def read_sequence(path):
    ext = path.lower()
    if ext.endswith((".gb", ".gbk", ".genbank")):
        record = SeqIO.read(path, "genbank")
    else:
        record = SeqIO.read(path, "fasta")
    return record


def gc_content_sliding(seq, window, step):
    seq = str(seq).upper()
    positions = []
    gc_values = []

    for i in range(0, len(seq) - window + 1, step):
        subseq = seq[i:i + window]
        gc = (subseq.count("G") + subseq.count("C")) / len(subseq)
        positions.append(i + window // 2)
        gc_values.append(gc)

    return np.array(positions), np.array(gc_values)


def main():
    parser = argparse.ArgumentParser(description="Plot GC content along a DNA sequence")
    parser.add_argument("--input", required=True, help="FASTA or GenBank file path")
    parser.add_argument("--output", required=True, help="Output image path (PNG/SVG/PDF)")
    parser.add_argument("--window", type=int, default=100, help="Sliding window size in bp (default: 100)")
    parser.add_argument("--step", type=int, default=None, help="Step size in bp (default: window/4)")
    parser.add_argument("--threshold", type=float, default=None, help="Draw horizontal threshold line")
    parser.add_argument("--title", default=None, help="Figure title")
    parser.add_argument("--figsize", default="12x4", help="Figure size as WxH (default: 12x4)")
    parser.add_argument("--dpi", type=int, default=300, help="Resolution in DPI (default: 300)")
    args = parser.parse_args()

    step = args.step or max(1, args.window // 4)

    record = read_sequence(args.input)
    seq = record.seq
    seq_len = len(seq)

    if seq_len < args.window:
        print(f"Error: Sequence length ({seq_len}) is shorter than window size ({args.window}).",
              file=sys.stderr)
        sys.exit(1)

    positions, gc_values = gc_content_sliding(seq, args.window, step)
    overall_gc = (str(seq).upper().count("G") + str(seq).upper().count("C")) / seq_len

    # Parse figsize
    try:
        parts = args.figsize.lower().split("x")
        figw, figh = float(parts[0]), float(parts[1])
    except (ValueError, IndexError):
        figw, figh = 12, 4

    fig, ax = plt.subplots(figsize=(figw, figh))

    ax.fill_between(positions, gc_values, alpha=0.3, color="#3498db")
    ax.plot(positions, gc_values, color="#2980b9", linewidth=1)

    # Overall GC line
    ax.axhline(y=overall_gc, color="#e74c3c", linestyle="--", linewidth=1, alpha=0.7,
               label=f"Overall GC: {overall_gc:.1%}")

    if args.threshold is not None:
        ax.axhline(y=args.threshold, color="#f39c12", linestyle=":", linewidth=1,
                    label=f"Threshold: {args.threshold:.0%}")

    ax.set_xlabel("Position (bp)", fontsize=11)
    ax.set_ylabel("GC Content", fontsize=11)
    ax.set_ylim(0, 1)
    ax.set_xlim(0, seq_len)
    ax.legend(fontsize=9, loc="upper right")

    title = args.title or f"GC Content — {record.name} ({seq_len:,} bp, window={args.window}bp)"
    ax.set_title(title, fontsize=13, fontweight="bold")

    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)

    plt.tight_layout()
    plt.savefig(args.output, dpi=args.dpi, bbox_inches="tight")
    plt.close()

    print(f"GC content plot saved to {args.output} (overall GC: {overall_gc:.1%}, "
          f"window: {args.window}bp, {len(positions)} data points)")


if __name__ == "__main__":
    main()

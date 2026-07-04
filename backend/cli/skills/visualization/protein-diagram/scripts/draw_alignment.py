#!/usr/bin/env python3
"""
draw_alignment.py - Render colored multiple sequence alignment visualizations.

Generates publication-quality MSA plots from aligned FASTA or Clustal files
using pyMSAviz, a matplotlib-based MSA visualization package.

Usage:
    python draw_alignment.py --input alignment.fasta --output msa.png
    python draw_alignment.py --input alignment.fasta --output msa.svg --wrap 80 --show-conservation
    python draw_alignment.py --input alignment.fasta --output msa.png --start 100 --end 200 --color-scheme Clustal
"""

import argparse
import sys

try:
    from pymsaviz import MsaViz
except ImportError:
    print("Error: pyMSAviz is required. Install with: pip install pymsaviz", file=sys.stderr)
    sys.exit(1)

import matplotlib
matplotlib.use("Agg")


def detect_format(path):
    with open(path) as f:
        first_line = f.readline().strip()
    if first_line.startswith(">"):
        return "fasta"
    if first_line.startswith("CLUSTAL") or first_line.startswith("MUSCLE"):
        return "clustal"
    return "fasta"


def main():
    parser = argparse.ArgumentParser(description="Render colored MSA visualizations")
    parser.add_argument("--input", required=True, help="Aligned FASTA or Clustal file")
    parser.add_argument("--output", required=True, help="Output image path (PNG/SVG/PDF)")
    parser.add_argument("--start", type=int, default=None, help="Start position (1-indexed)")
    parser.add_argument("--end", type=int, default=None, help="End position (inclusive)")
    parser.add_argument("--wrap", type=int, default=None, help="Wrap alignment at N columns")
    parser.add_argument("--show-conservation", action="store_true", help="Show conservation bar")
    parser.add_argument("--color-scheme", default="Clustal",
                        choices=["Clustal", "Zappo", "Taylor", "Flower", "Buried", "Cinema", "MAEditor", "Helix"],
                        help="Color scheme (default: Clustal)")
    parser.add_argument("--title", default=None, help="Figure title")
    parser.add_argument("--dpi", type=int, default=300, help="Resolution in DPI (default: 300)")
    args = parser.parse_args()

    mv = MsaViz(args.input, color_scheme=args.color_scheme, wrap_length=args.wrap,
                show_consensus=args.show_conservation)

    if args.start is not None or args.end is not None:
        start = (args.start or 1) - 1  # Convert to 0-indexed
        end = args.end  # MsaViz uses exclusive end
        mv.set_plot_params(start=start, end=end)

    fig = mv.plotfig()

    if args.title:
        fig.suptitle(args.title, fontsize=14, fontweight="bold", y=1.02)

    fig.savefig(args.output, dpi=args.dpi, bbox_inches="tight")

    print(f"MSA visualization saved to {args.output} (color scheme: {args.color_scheme})")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
draw_plasmid.py - Generate circular or linear plasmid maps from GenBank files.

Renders annotated plasmid diagrams with color-coded features (genes, promoters,
origins, terminators) using dna_features_viewer and BioPython.

Usage:
    python draw_plasmid.py --input plasmid.gb --output plasmid_map.png
    python draw_plasmid.py --input plasmid.gb --output map.svg --linear
    python draw_plasmid.py --input plasmid.gb --output map.png --figsize 10x10 --dpi 300
"""

import argparse
import sys

try:
    from Bio import SeqIO
except ImportError:
    print("Error: BioPython is required. Install with: pip install biopython", file=sys.stderr)
    sys.exit(1)

try:
    from dna_features_viewer import GraphicFeature, GraphicRecord, CircularGraphicRecord
except ImportError:
    print("Error: dna_features_viewer is required. Install with: pip install dna_features_viewer", file=sys.stderr)
    sys.exit(1)

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


# Default feature colors by type
FEATURE_COLORS = {
    "CDS": "#3498db",
    "gene": "#3498db",
    "promoter": "#2ecc71",
    "terminator": "#e74c3c",
    "rep_origin": "#f39c12",
    "misc_feature": "#9b59b6",
    "primer_bind": "#1abc9c",
    "regulatory": "#2ecc71",
    "source": None,  # skip
}


def parse_figsize(s):
    try:
        parts = s.lower().split("x")
        return float(parts[0]), float(parts[1])
    except (ValueError, IndexError):
        print(f"Warning: Invalid figsize '{s}', using default.", file=sys.stderr)
        return 8, 8


def genbank_to_features(record):
    features = []
    for feat in record.features:
        if feat.type in ("source", "gene"):
            continue
        label = feat.qualifiers.get("label", feat.qualifiers.get("product", feat.qualifiers.get("gene", [feat.type])))[0]
        color = FEATURE_COLORS.get(feat.type, "#95a5a6")
        if color is None:
            continue
        start = int(feat.location.start)
        end = int(feat.location.end)
        strand = feat.location.strand if feat.location.strand else 1
        features.append(GraphicFeature(
            start=start,
            end=end,
            strand=strand,
            color=color,
            label=label,
        ))
    return features


def main():
    parser = argparse.ArgumentParser(description="Generate plasmid maps from GenBank files")
    parser.add_argument("--input", required=True, help="GenBank file path")
    parser.add_argument("--output", required=True, help="Output image path (PNG/SVG/PDF)")
    parser.add_argument("--linear", action="store_true", help="Draw linear map instead of circular")
    parser.add_argument("--figsize", default=None, help="Figure size as WxH in inches (e.g. 10x10)")
    parser.add_argument("--dpi", type=int, default=300, help="Resolution in DPI (default: 300)")
    parser.add_argument("--title", default=None, help="Figure title")
    args = parser.parse_args()

    record = SeqIO.read(args.input, "genbank")
    seq_length = len(record.seq)
    features = genbank_to_features(record)

    if not features:
        print("Warning: No features found in GenBank file.", file=sys.stderr)

    title = args.title or record.name or "Plasmid Map"

    if args.linear:
        fig_w, fig_h = parse_figsize(args.figsize) if args.figsize else (14, 4)
        rec = GraphicRecord(sequence_length=seq_length, features=features)
        ax, _ = rec.plot(figure_width=fig_w)
        ax.set_title(title, fontsize=14, fontweight="bold", pad=12)
    else:
        fig_w, fig_h = parse_figsize(args.figsize) if args.figsize else (8, 8)
        rec = CircularGraphicRecord(sequence_length=seq_length, features=features)
        ax, _ = rec.plot(figure_width=fig_w)
        ax.set_title(f"{title}\n({seq_length:,} bp)", fontsize=14, fontweight="bold", pad=12)

    plt.tight_layout()
    plt.savefig(args.output, dpi=args.dpi, bbox_inches="tight")
    plt.close()
    print(f"Plasmid map saved to {args.output} ({seq_length:,} bp, {len(features)} features)")


if __name__ == "__main__":
    main()

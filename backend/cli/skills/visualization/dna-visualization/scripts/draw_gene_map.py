#!/usr/bin/env python3
"""
draw_gene_map.py - Generate linear gene/feature annotation tracks from GenBank files.

Renders publication-quality gene annotation diagrams showing features as colored
arrows/blocks along a linear sequence using dna_features_viewer and BioPython.

Usage:
    python draw_gene_map.py --input genome_region.gb --output gene_map.png
    python draw_gene_map.py --input chromosome.gb --output region.png --start 10000 --end 25000
    python draw_gene_map.py --input genome.gb --output map.svg --figsize 14x4 --dpi 300
"""

import argparse
import sys

try:
    from Bio import SeqIO
except ImportError:
    print("Error: BioPython is required. Install with: pip install biopython", file=sys.stderr)
    sys.exit(1)

try:
    from dna_features_viewer import GraphicFeature, GraphicRecord
except ImportError:
    print("Error: dna_features_viewer is required. Install with: pip install dna_features_viewer", file=sys.stderr)
    sys.exit(1)

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


FEATURE_COLORS = {
    "CDS": "#3498db",
    "gene": "#2980b9",
    "mRNA": "#85c1e9",
    "tRNA": "#1abc9c",
    "rRNA": "#16a085",
    "ncRNA": "#48c9b0",
    "promoter": "#2ecc71",
    "terminator": "#e74c3c",
    "rep_origin": "#f39c12",
    "misc_feature": "#9b59b6",
    "regulatory": "#2ecc71",
    "mobile_element": "#e67e22",
    "repeat_region": "#f1c40f",
    "sig_peptide": "#d35400",
    "mat_peptide": "#c0392b",
    "exon": "#3498db",
    "intron": "#bdc3c7",
}


def get_label(feat):
    for key in ("label", "gene", "product", "locus_tag", "note"):
        val = feat.qualifiers.get(key)
        if val:
            return val[0]
    return feat.type


def genbank_to_features(record, start=None, end=None):
    features = []
    for feat in record.features:
        if feat.type == "source":
            continue
        feat_start = int(feat.location.start)
        feat_end = int(feat.location.end)

        # Filter by region if specified
        if start is not None and feat_end < start:
            continue
        if end is not None and feat_start > end:
            continue

        label = get_label(feat)
        color = FEATURE_COLORS.get(feat.type, "#95a5a6")
        strand = feat.location.strand if feat.location.strand else 1

        # Clip to region
        if start is not None:
            feat_start = max(feat_start, start)
        if end is not None:
            feat_end = min(feat_end, end)

        features.append(GraphicFeature(
            start=feat_start - (start or 0),
            end=feat_end - (start or 0),
            strand=strand,
            color=color,
            label=label,
        ))

    return features


def main():
    parser = argparse.ArgumentParser(description="Generate linear gene feature tracks from GenBank files")
    parser.add_argument("--input", required=True, help="GenBank file path")
    parser.add_argument("--output", required=True, help="Output image path (PNG/SVG/PDF)")
    parser.add_argument("--start", type=int, default=None, help="Region start position")
    parser.add_argument("--end", type=int, default=None, help="Region end position")
    parser.add_argument("--figsize", default="14x4", help="Figure size as WxH (default: 14x4)")
    parser.add_argument("--dpi", type=int, default=300, help="Resolution in DPI (default: 300)")
    parser.add_argument("--title", default=None, help="Figure title")
    args = parser.parse_args()

    record = SeqIO.read(args.input, "genbank")
    seq_len = len(record.seq)

    start = args.start
    end = args.end or seq_len
    region_len = end - (start or 0)

    features = genbank_to_features(record, start, end)

    if not features:
        print("Warning: No features found in specified region.", file=sys.stderr)

    # Parse figsize
    try:
        parts = args.figsize.lower().split("x")
        figw, figh = float(parts[0]), float(parts[1])
    except (ValueError, IndexError):
        figw, figh = 14, 4

    rec = GraphicRecord(sequence_length=region_len, features=features)
    ax, _ = rec.plot(figure_width=figw)

    title = args.title
    if not title:
        if start is not None:
            title = f"{record.name} ({start:,}–{end:,} bp)"
        else:
            title = f"{record.name} ({seq_len:,} bp)"
    ax.set_title(title, fontsize=13, fontweight="bold", pad=10)

    plt.tight_layout()
    plt.savefig(args.output, dpi=args.dpi, bbox_inches="tight")
    plt.close()

    print(f"Gene map saved to {args.output} ({len(features)} features, {region_len:,} bp region)")


if __name__ == "__main__":
    main()

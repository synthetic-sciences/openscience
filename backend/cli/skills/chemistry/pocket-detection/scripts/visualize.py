#!/usr/bin/env python3
"""
Pocket visualization.

Generates publication-quality plots for pocket analysis: summary panels,
residue composition, druggability radar, and method comparison.

Usage:
    python visualize.py --input protein.pdb --pockets pockets.json --output plot.png --plot-type summary
    python visualize.py --input protein.pdb --pockets p1.json p2.json --labels Grid fpocket --output compare.png --plot-type method-comparison
"""

import argparse
import json
import math
import os
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    import numpy as np
except ImportError:
    sys.exit("ERROR: NumPy is required. Install with: pip install numpy")

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import FancyBboxPatch
except ImportError:
    sys.exit("ERROR: matplotlib is required. Install with: pip install matplotlib")

# ---------------------------------------------------------------------------
# Residue categories for composition analysis
# ---------------------------------------------------------------------------

RESIDUE_CATEGORIES = {
    "Hydrophobic": {"ALA", "VAL", "ILE", "LEU", "MET", "PRO"},
    "Aromatic": {"PHE", "TYR", "TRP"},
    "Polar": {"SER", "THR", "ASN", "GLN", "CYS", "HIS"},
    "Positive": {"LYS", "ARG"},
    "Negative": {"ASP", "GLU"},
    "Special": {"GLY"},
}

CATEGORY_COLORS = {
    "Hydrophobic": "#4C72B0",
    "Aromatic": "#DD8452",
    "Polar": "#55A868",
    "Positive": "#C44E52",
    "Negative": "#8172B3",
    "Special": "#937860",
}


def _categorize_residues(residue_names):
    """Classify residue names into categories."""
    counts = {cat: 0 for cat in RESIDUE_CATEGORIES}
    for name in residue_names:
        # Extract 3-letter code (e.g., "ASP189" → "ASP")
        code = "".join(c for c in name if c.isalpha())[:3].upper()
        found = False
        for cat, members in RESIDUE_CATEGORIES.items():
            if code in members:
                counts[cat] += 1
                found = True
                break
        if not found:
            counts["Special"] += 1
    return counts


# ---------------------------------------------------------------------------
# Plot: Summary (multi-panel)
# ---------------------------------------------------------------------------


def plot_summary(pockets_data_list, labels, output_path, figsize, dpi):
    """Multi-panel summary: volume bar + properties table + composition pie."""
    data = pockets_data_list[0]
    pockets = data.get("pockets", [])
    if not pockets:
        print("No pockets to visualize.")
        return

    n_pockets = min(len(pockets), 5)
    pockets = pockets[:n_pockets]

    fig, axes = plt.subplots(1, 3, figsize=figsize)
    fig.suptitle(f"Pocket Summary — {data.get('protein', 'Unknown')}", fontsize=14, y=0.98)

    # Panel 1: Volume bar chart
    ax = axes[0]
    ranks = [f"Pocket {p['rank']}" for p in pockets]
    volumes = [p.get("volume_A3", 0) for p in pockets]
    colors = []
    for p in pockets:
        cls = p.get("druggability_class", "")
        if cls == "druggable":
            colors.append("#55A868")
        elif cls == "difficult":
            colors.append("#DD8452")
        else:
            colors.append("#C44E52")
    if not any(colors):
        colors = ["#4C72B0"] * n_pockets

    ax.barh(ranks, volumes, color=colors, edgecolor="white")
    ax.set_xlabel("Volume (A³)")
    ax.set_title("Pocket Volumes")
    ax.invert_yaxis()

    # Add volume ranges
    ax.axvline(300, color="gray", linestyle="--", alpha=0.5, linewidth=0.8)
    ax.axvline(800, color="gray", linestyle="--", alpha=0.5, linewidth=0.8)

    # Panel 2: Properties table
    ax = axes[1]
    ax.axis("off")
    headers = ["Pocket", "Vol", "Encl", "Hydro", "Score", "Class"]
    table_data = []
    for p in pockets:
        props = p.get("properties", {})
        table_data.append([
            str(p["rank"]),
            f"{p.get('volume_A3', props.get('volume_A3', 0)):.0f}",
            f"{props.get('enclosure', 0):.2f}",
            f"{props.get('hydrophobicity', 0):.2f}",
            f"{p.get('druggability_score', 0):.2f}",
            p.get("druggability_class", "N/A")[:4],
        ])

    table = ax.table(
        cellText=table_data, colLabels=headers,
        loc="center", cellLoc="center",
    )
    table.auto_set_font_size(False)
    table.set_fontsize(9)
    table.scale(1, 1.5)
    ax.set_title("Properties")

    # Panel 3: Residue composition pie for top pocket
    ax = axes[2]
    top_pocket = pockets[0]
    residues = top_pocket.get("residues", [])
    if residues:
        cats = _categorize_residues(residues)
        nonzero = {k: v for k, v in cats.items() if v > 0}
        if nonzero:
            ax.pie(
                nonzero.values(),
                labels=nonzero.keys(),
                colors=[CATEGORY_COLORS[k] for k in nonzero],
                autopct="%1.0f%%",
                startangle=90,
            )
    ax.set_title(f"Pocket {top_pocket['rank']} Composition")

    plt.tight_layout()
    plt.savefig(output_path, dpi=dpi, bbox_inches="tight")
    plt.close()
    print(f"Summary plot saved to: {output_path}")


# ---------------------------------------------------------------------------
# Plot: Residue Composition (stacked bar)
# ---------------------------------------------------------------------------


def plot_residue_composition(pockets_data_list, labels, output_path, figsize, dpi):
    """Stacked bar chart of residue categories for each pocket."""
    data = pockets_data_list[0]
    pockets = data.get("pockets", [])[:5]
    if not pockets:
        print("No pockets to visualize.")
        return

    fig, ax = plt.subplots(figsize=figsize)

    pocket_labels = [f"Pocket {p['rank']}" for p in pockets]
    categories = list(RESIDUE_CATEGORIES.keys())
    bottom = np.zeros(len(pockets))

    for cat in categories:
        values = []
        for p in pockets:
            cats = _categorize_residues(p.get("residues", []))
            values.append(cats.get(cat, 0))
        ax.bar(
            pocket_labels, values, bottom=bottom,
            label=cat, color=CATEGORY_COLORS[cat],
        )
        bottom += np.array(values)

    ax.set_ylabel("Number of Residues")
    ax.set_title(f"Residue Composition — {data.get('protein', 'Unknown')}")
    ax.legend(loc="upper right", fontsize=8)
    plt.tight_layout()
    plt.savefig(output_path, dpi=dpi, bbox_inches="tight")
    plt.close()
    print(f"Residue composition plot saved to: {output_path}")


# ---------------------------------------------------------------------------
# Plot: Druggability Radar (spider plot)
# ---------------------------------------------------------------------------


def plot_druggability_radar(pockets_data_list, labels, output_path, figsize,
                            dpi, pocket_rank=1):
    """Spider/radar plot of 6 druggability property scores."""
    data = pockets_data_list[0]
    pockets = data.get("pockets", [])

    # Find requested pockets
    target_pockets = []
    for p in pockets:
        if p["rank"] <= 3:  # show top 3
            target_pockets.append(p)

    if not target_pockets:
        print("No pockets with druggability data to visualize.")
        return

    categories = ["Volume", "Hydrophobicity", "Enclosure", "Depth", "H-Bond Cap.", "Aromaticity"]
    score_keys = ["volume", "hydrophobicity", "enclosure", "depth", "hb_capacity", "aromaticity"]
    n_cats = len(categories)
    angles = [n / n_cats * 2 * math.pi for n in range(n_cats)]
    angles += angles[:1]  # close the polygon

    fig, ax = plt.subplots(figsize=(figsize[0], figsize[0]), subplot_kw=dict(polar=True))

    colors = ["#4C72B0", "#DD8452", "#55A868"]
    for i, pocket in enumerate(target_pockets):
        scores = pocket.get("property_scores", {})
        values = [scores.get(k, 0) for k in score_keys]
        values += values[:1]
        color = colors[i % len(colors)]
        ax.plot(angles, values, "o-", linewidth=2, color=color,
                label=f"Pocket {pocket['rank']} ({pocket.get('druggability_score', 0):.2f})")
        ax.fill(angles, values, alpha=0.1, color=color)

    ax.set_xticks(angles[:-1])
    ax.set_xticklabels(categories, fontsize=9)
    ax.set_ylim(0, 1.1)
    ax.set_yticks([0.2, 0.4, 0.6, 0.8, 1.0])
    ax.set_yticklabels(["0.2", "0.4", "0.6", "0.8", "1.0"], fontsize=7)
    ax.legend(loc="upper right", bbox_to_anchor=(1.3, 1.1), fontsize=9)
    ax.set_title(f"Druggability Radar — {data.get('protein', 'Unknown')}", pad=20)

    plt.tight_layout()
    plt.savefig(output_path, dpi=dpi, bbox_inches="tight")
    plt.close()
    print(f"Druggability radar saved to: {output_path}")


# ---------------------------------------------------------------------------
# Plot: Method Comparison
# ---------------------------------------------------------------------------


def plot_method_comparison(pockets_data_list, labels, output_path, figsize, dpi):
    """Compare pockets from different detection methods."""
    if len(pockets_data_list) < 2:
        print("Method comparison requires 2+ pocket JSON files.")
        return

    fig, axes = plt.subplots(1, 2, figsize=figsize)

    # Panel 1: Scatter (volume vs druggability by method)
    ax = axes[0]
    colors = ["#4C72B0", "#DD8452", "#55A868", "#C44E52"]
    for i, (data, label) in enumerate(zip(pockets_data_list, labels)):
        pockets = data.get("pockets", [])
        volumes = [p.get("volume_A3", 0) for p in pockets]
        scores = [p.get("druggability_score", 0.5) for p in pockets]
        color = colors[i % len(colors)]
        ax.scatter(volumes, scores, label=label, color=color, s=80, alpha=0.7,
                   edgecolors="white", linewidth=0.5)

    ax.set_xlabel("Volume (A³)")
    ax.set_ylabel("Druggability Score")
    ax.set_title("Volume vs Druggability by Method")
    ax.legend(fontsize=9)
    ax.axhline(0.7, color="green", linestyle="--", alpha=0.3, linewidth=0.8)
    ax.axhline(0.4, color="orange", linestyle="--", alpha=0.3, linewidth=0.8)

    # Panel 2: Pocket count comparison table
    ax = axes[1]
    ax.axis("off")
    headers = ["Method", "N Pockets", "Top Vol", "Top Score"]
    table_data = []
    for data, label in zip(pockets_data_list, labels):
        pockets = data.get("pockets", [])
        n = len(pockets)
        top_vol = max((p.get("volume_A3", 0) for p in pockets), default=0)
        top_score = max((p.get("druggability_score", 0) for p in pockets), default=0)
        table_data.append([label, str(n), f"{top_vol:.0f}", f"{top_score:.2f}"])

    table = ax.table(
        cellText=table_data, colLabels=headers,
        loc="center", cellLoc="center",
    )
    table.auto_set_font_size(False)
    table.set_fontsize(10)
    table.scale(1, 1.8)
    ax.set_title("Method Summary")

    plt.tight_layout()
    plt.savefig(output_path, dpi=dpi, bbox_inches="tight")
    plt.close()
    print(f"Method comparison saved to: {output_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

PLOT_FUNCTIONS = {
    "summary": plot_summary,
    "residue-composition": plot_residue_composition,
    "druggability-radar": plot_druggability_radar,
    "method-comparison": plot_method_comparison,
}


def main():
    parser = argparse.ArgumentParser(
        description="Visualize pocket detection and druggability results.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Plot types:
  summary              Multi-panel: volume bar + properties table + composition pie
  residue-composition  Stacked bar by amino acid category
  druggability-radar   Spider plot of 6 property scores
  method-comparison    Compare pockets from different detection methods

Examples:
  python visualize.py --input protein.pdb --pockets pockets.json --output summary.png --plot-type summary
  python visualize.py --input protein.pdb --pockets grid.json fpocket.json --labels Grid fpocket --output compare.png --plot-type method-comparison
        """,
    )
    parser.add_argument("--input", required=True, help="Input PDB file")
    parser.add_argument(
        "--pockets", required=True, nargs="+",
        help="Pockets/druggability JSON file(s)",
    )
    parser.add_argument("--labels", nargs="+", help="Labels for each JSON file")
    parser.add_argument("--output", required=True, help="Output image (PNG or SVG)")
    parser.add_argument(
        "--plot-type", default="summary",
        choices=list(PLOT_FUNCTIONS.keys()),
        help="Type of plot (default: summary)",
    )
    parser.add_argument(
        "--figsize", default="12x8",
        help="Figure size WxH in inches (default: 12x8)",
    )
    parser.add_argument(
        "--dpi", type=int, default=300,
        help="Output DPI (default: 300)",
    )
    parser.add_argument(
        "--pocket-rank", type=int, default=1,
        help="Which pocket to focus on (default: 1)",
    )

    args = parser.parse_args()

    # Parse figsize
    try:
        w, h = args.figsize.split("x")
        figsize = (float(w), float(h))
    except ValueError:
        figsize = (12, 8)

    # Load pocket data
    pockets_data_list = []
    for pf in args.pockets:
        if not os.path.exists(pf):
            sys.exit(f"ERROR: File not found: {pf}")
        with open(pf) as f:
            pockets_data_list.append(json.load(f))

    # Default labels
    labels = args.labels or [
        os.path.splitext(os.path.basename(pf))[0] for pf in args.pockets
    ]
    while len(labels) < len(pockets_data_list):
        labels.append(f"Source {len(labels) + 1}")

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    # Generate plot
    plot_fn = PLOT_FUNCTIONS[args.plot_type]
    plot_fn(pockets_data_list, labels, args.output, figsize, args.dpi)


if __name__ == "__main__":
    main()

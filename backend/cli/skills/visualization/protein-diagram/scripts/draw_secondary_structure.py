#!/usr/bin/env python3
"""
draw_secondary_structure.py - Annotate helix/sheet/coil regions from PDB structures.

Renders a linear secondary structure annotation track showing alpha-helices,
beta-sheets, and coil/loop regions from a PDB file using BioPython's DSSP module.

Usage:
    python draw_secondary_structure.py --input structure.pdb --output ss.png --chain A
    python draw_secondary_structure.py --input structure.pdb --output ss.svg --chain A --show-residue-numbers
"""

import argparse
import sys

try:
    from Bio.PDB import PDBParser
    from Bio.PDB.DSSP import DSSP
except ImportError:
    print("Error: BioPython is required. Install with: pip install biopython", file=sys.stderr)
    sys.exit(1)

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches


# DSSP code → category mapping
SS_MAP = {
    "H": "helix",    # Alpha helix
    "G": "helix",    # 3-10 helix
    "I": "helix",    # Pi helix
    "E": "sheet",    # Extended strand (beta)
    "B": "sheet",    # Isolated bridge
    "T": "coil",     # Turn
    "S": "coil",     # Bend
    "-": "coil",     # Coil/loop
}

SS_COLORS = {
    "helix": "#e74c3c",
    "sheet": "#3498db",
    "coil": "#bdc3c7",
}


def get_secondary_structure(pdb_path, chain_id):
    parser = PDBParser(QUIET=True)
    structure = parser.get_structure("protein", pdb_path)
    model = structure[0]

    try:
        dssp = DSSP(model, pdb_path, dssp="mkdssp")
    except Exception:
        try:
            dssp = DSSP(model, pdb_path, dssp="dssp")
        except Exception as e:
            print(f"Error running DSSP: {e}", file=sys.stderr)
            print("Install DSSP: apt-get install dssp / conda install -c salilab dssp", file=sys.stderr)
            sys.exit(1)

    residues = []
    for key in dssp.keys():
        chain, res_id = key
        if chain != chain_id:
            continue
        ss_code = dssp[key][2]
        category = SS_MAP.get(ss_code, "coil")
        res_num = res_id[1]
        residues.append((res_num, category))

    return residues


def draw_ss_track(residues, title=None, show_numbers=False, figsize=(14, 2), dpi=300, output="ss.png"):
    if not residues:
        print("Error: No residues found for specified chain.", file=sys.stderr)
        sys.exit(1)

    fig, ax = plt.subplots(figsize=figsize)

    # Group consecutive residues with same SS
    segments = []
    current_ss = residues[0][1]
    current_start = residues[0][0]
    for res_num, ss in residues[1:]:
        if ss != current_ss:
            segments.append((current_start, res_num - 1, current_ss))
            current_ss = ss
            current_start = res_num
    segments.append((current_start, residues[-1][0], current_ss))

    min_res = residues[0][0]
    max_res = residues[-1][0]
    total_len = max_res - min_res + 1

    # Draw segments
    y = 0.5
    for start, end, ss_type in segments:
        width = end - start + 1
        color = SS_COLORS[ss_type]
        height = 0.35 if ss_type == "coil" else 0.5

        if ss_type == "helix":
            # Draw as rounded rectangle
            rect = mpatches.FancyBboxPatch(
                (start, y - height / 2), width, height,
                boxstyle="round,pad=0.3",
                facecolor=color, edgecolor="white", linewidth=0.5,
            )
        elif ss_type == "sheet":
            # Draw as arrow-shaped
            rect = mpatches.FancyBboxPatch(
                (start, y - height / 2), width, height,
                boxstyle="rarrow,pad=0.1",
                facecolor=color, edgecolor="white", linewidth=0.5,
            )
        else:
            rect = mpatches.Rectangle(
                (start, y - height / 2), width, height,
                facecolor=color, edgecolor="none",
            )
        ax.add_patch(rect)

    # Axis formatting
    ax.set_xlim(min_res - total_len * 0.02, max_res + total_len * 0.02)
    ax.set_ylim(0, 1)
    ax.set_xlabel("Residue Number", fontsize=11)
    ax.set_yticks([])
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_visible(False)

    # Legend
    handles = [
        mpatches.Patch(color=SS_COLORS["helix"], label="Helix"),
        mpatches.Patch(color=SS_COLORS["sheet"], label="Sheet"),
        mpatches.Patch(color=SS_COLORS["coil"], label="Coil/Loop"),
    ]
    ax.legend(handles=handles, loc="upper right", fontsize=9, ncol=3)

    if title:
        ax.set_title(title, fontsize=13, fontweight="bold", pad=10)

    # Count stats
    n_helix = sum(1 for _, ss in residues if ss == "helix")
    n_sheet = sum(1 for _, ss in residues if ss == "sheet")
    n_coil = sum(1 for _, ss in residues if ss == "coil")
    n_total = len(residues)

    plt.tight_layout()
    plt.savefig(output, dpi=dpi, bbox_inches="tight")
    plt.close()

    print(f"Secondary structure saved to {output}")
    print(f"  {n_total} residues: {n_helix} helix ({n_helix/n_total:.0%}), "
          f"{n_sheet} sheet ({n_sheet/n_total:.0%}), {n_coil} coil ({n_coil/n_total:.0%})")


def main():
    parser = argparse.ArgumentParser(description="Annotate secondary structure from PDB files")
    parser.add_argument("--input", required=True, help="PDB file path")
    parser.add_argument("--output", required=True, help="Output image path (PNG/SVG/PDF)")
    parser.add_argument("--chain", required=True, help="Chain ID (e.g., A)")
    parser.add_argument("--show-residue-numbers", action="store_true", help="Show residue numbers on track")
    parser.add_argument("--title", default=None, help="Figure title")
    parser.add_argument("--figsize", default="14x2", help="Figure size as WxH (default: 14x2)")
    parser.add_argument("--dpi", type=int, default=300, help="Resolution in DPI (default: 300)")
    args = parser.parse_args()

    residues = get_secondary_structure(args.input, args.chain)

    try:
        parts = args.figsize.lower().split("x")
        figsize = (float(parts[0]), float(parts[1]))
    except (ValueError, IndexError):
        figsize = (14, 2)

    draw_ss_track(residues, title=args.title, show_numbers=args.show_residue_numbers,
                  figsize=figsize, dpi=args.dpi, output=args.output)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
draw_ramachandran.py - Generate Ramachandran plots from PDB structures.

Renders phi/psi dihedral angle scatter plots for protein structure validation
using BioPython and matplotlib. Shows favored/allowed/outlier regions.

Usage:
    python draw_ramachandran.py --input structure.pdb --output ramachandran.png
    python draw_ramachandran.py --input structure.pdb --output rama.svg --chain A --show-regions
    python draw_ramachandran.py --input structure.pdb --output rama.png --highlight-glycine --highlight-proline
"""

import argparse
import sys
import math

try:
    from Bio.PDB import PDBParser
    from Bio.PDB.Polypeptide import PPBuilder
except ImportError:
    print("Error: BioPython is required. Install with: pip install biopython", file=sys.stderr)
    sys.exit(1)

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def extract_dihedrals(pdb_path, chain_id=None):
    parser = PDBParser(QUIET=True)
    structure = parser.get_structure("protein", pdb_path)
    model = structure[0]

    ppb = PPBuilder()
    phi_psi = []
    gly_phi_psi = []
    pro_phi_psi = []

    for chain in model:
        if chain_id and chain.id != chain_id:
            continue
        for pp in ppb.build_peptides(chain):
            angles = pp.get_phi_psi_list()
            residues = list(pp)
            for i, (phi, psi) in enumerate(angles):
                if phi is None or psi is None:
                    continue
                phi_deg = math.degrees(phi)
                psi_deg = math.degrees(psi)
                resname = residues[i].get_resname()

                if resname == "GLY":
                    gly_phi_psi.append((phi_deg, psi_deg))
                elif resname == "PRO":
                    pro_phi_psi.append((phi_deg, psi_deg))
                else:
                    phi_psi.append((phi_deg, psi_deg))

    return phi_psi, gly_phi_psi, pro_phi_psi


def draw_favored_regions(ax):
    """Draw approximate favored and allowed regions."""
    # Favored regions (approximate contours from Lovell et al. 2003)
    # Alpha-helix region
    from matplotlib.patches import Ellipse
    alpha = Ellipse((-63, -43), 50, 50, alpha=0.1, color="#3498db", label="Favored")
    ax.add_patch(alpha)
    # Beta-sheet region
    beta = Ellipse((-120, 135), 50, 40, alpha=0.1, color="#3498db")
    ax.add_patch(beta)
    # Left-handed alpha
    lalpha = Ellipse((57, 47), 40, 40, alpha=0.05, color="#2ecc71", label="Allowed")
    ax.add_patch(lalpha)


def main():
    parser = argparse.ArgumentParser(description="Generate Ramachandran plots from PDB files")
    parser.add_argument("--input", required=True, help="PDB file path")
    parser.add_argument("--output", required=True, help="Output image path (PNG/SVG/PDF)")
    parser.add_argument("--chain", default=None, help="Chain ID (default: all chains)")
    parser.add_argument("--highlight-glycine", action="store_true", help="Highlight glycine residues")
    parser.add_argument("--highlight-proline", action="store_true", help="Highlight proline residues")
    parser.add_argument("--show-regions", action="store_true", help="Show favored/allowed regions")
    parser.add_argument("--title", default=None, help="Figure title")
    parser.add_argument("--figsize", default="8x8", help="Figure size as WxH (default: 8x8)")
    parser.add_argument("--dpi", type=int, default=300, help="Resolution in DPI (default: 300)")
    args = parser.parse_args()

    general, glycines, prolines = extract_dihedrals(args.input, args.chain)

    if not general and not glycines and not prolines:
        print("Error: No phi/psi angles found. Check PDB file and chain ID.", file=sys.stderr)
        sys.exit(1)

    try:
        parts = args.figsize.lower().split("x")
        figsize = (float(parts[0]), float(parts[1]))
    except (ValueError, IndexError):
        figsize = (8, 8)

    fig, ax = plt.subplots(figsize=figsize)

    if args.show_regions:
        draw_favored_regions(ax)

    # Plot general residues
    if general:
        phi_vals, psi_vals = zip(*general)
        ax.scatter(phi_vals, psi_vals, s=8, c="#2c3e50", alpha=0.5, label=f"General ({len(general)})", zorder=2)

    # Plot glycines
    if glycines and args.highlight_glycine:
        phi_vals, psi_vals = zip(*glycines)
        ax.scatter(phi_vals, psi_vals, s=15, c="#e74c3c", alpha=0.7, marker="^",
                   label=f"Glycine ({len(glycines)})", zorder=3)
    elif glycines:
        phi_vals, psi_vals = zip(*glycines)
        ax.scatter(phi_vals, psi_vals, s=8, c="#2c3e50", alpha=0.5, zorder=2)

    # Plot prolines
    if prolines and args.highlight_proline:
        phi_vals, psi_vals = zip(*prolines)
        ax.scatter(phi_vals, psi_vals, s=15, c="#3498db", alpha=0.7, marker="s",
                   label=f"Proline ({len(prolines)})", zorder=3)
    elif prolines:
        phi_vals, psi_vals = zip(*prolines)
        ax.scatter(phi_vals, psi_vals, s=8, c="#2c3e50", alpha=0.5, zorder=2)

    # Axis formatting
    ax.set_xlim(-180, 180)
    ax.set_ylim(-180, 180)
    ax.set_xlabel("Phi (φ) [degrees]", fontsize=12)
    ax.set_ylabel("Psi (ψ) [degrees]", fontsize=12)
    ax.set_xticks(range(-180, 181, 60))
    ax.set_yticks(range(-180, 181, 60))
    ax.axhline(y=0, color="#bdc3c7", linewidth=0.5)
    ax.axvline(x=0, color="#bdc3c7", linewidth=0.5)
    ax.set_aspect("equal")
    ax.grid(True, alpha=0.2)

    total = len(general) + len(glycines) + len(prolines)
    title = args.title or "Ramachandran Plot"
    ax.set_title(f"{title} ({total} residues)", fontsize=14, fontweight="bold")

    if args.highlight_glycine or args.highlight_proline:
        ax.legend(fontsize=9, loc="upper left")

    plt.tight_layout()
    plt.savefig(args.output, dpi=args.dpi, bbox_inches="tight")
    plt.close()

    print(f"Ramachandran plot saved to {args.output} ({total} residues: "
          f"{len(general)} general, {len(glycines)} Gly, {len(prolines)} Pro)")


if __name__ == "__main__":
    main()

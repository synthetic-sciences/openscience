#!/usr/bin/env python3
"""
draw_contact_map.py - Generate residue-residue distance or contact heatmaps.

Renders C-alpha distance matrices or binary contact maps from PDB structures
using BioPython, NumPy, and matplotlib.

Usage:
    python draw_contact_map.py --input structure.pdb --output contacts.png --chain A
    python draw_contact_map.py --input structure.pdb --output contacts.svg --chain A --cutoff 8.0 --binary
    python draw_contact_map.py --input structure.pdb --output dist.png --chain A --cmap viridis_r
"""

import argparse
import sys

try:
    from Bio.PDB import PDBParser
except ImportError:
    print("Error: BioPython is required. Install with: pip install biopython", file=sys.stderr)
    sys.exit(1)

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def extract_ca_coords(pdb_path, chain_id):
    parser = PDBParser(QUIET=True)
    structure = parser.get_structure("protein", pdb_path)
    model = structure[0]
    chain = model[chain_id]

    coords = []
    res_ids = []
    for residue in chain:
        if residue.id[0] != " ":
            continue  # skip heteroatoms
        if "CA" not in residue:
            continue
        coords.append(residue["CA"].get_vector().get_array())
        res_ids.append(residue.id[1])

    return np.array(coords), res_ids


def compute_distance_matrix(coords):
    n = len(coords)
    dist = np.zeros((n, n))
    for i in range(n):
        for j in range(i + 1, n):
            d = np.linalg.norm(coords[i] - coords[j])
            dist[i, j] = d
            dist[j, i] = d
    return dist


def main():
    parser = argparse.ArgumentParser(description="Generate residue contact maps from PDB files")
    parser.add_argument("--input", required=True, help="PDB file path")
    parser.add_argument("--output", required=True, help="Output image path (PNG/SVG/PDF)")
    parser.add_argument("--chain", required=True, help="Chain ID (e.g., A)")
    parser.add_argument("--cutoff", type=float, default=8.0, help="Contact distance cutoff in Angstroms (default: 8.0)")
    parser.add_argument("--binary", action="store_true", help="Show binary contact map instead of distance matrix")
    parser.add_argument("--cmap", default=None, help="Matplotlib colormap (default: viridis_r for distance, binary for contacts)")
    parser.add_argument("--title", default=None, help="Figure title")
    parser.add_argument("--figsize", default="8x8", help="Figure size as WxH (default: 8x8)")
    parser.add_argument("--dpi", type=int, default=300, help="Resolution in DPI (default: 300)")
    args = parser.parse_args()

    coords, res_ids = extract_ca_coords(args.input, args.chain)

    if len(coords) == 0:
        print(f"Error: No C-alpha atoms found for chain {args.chain}.", file=sys.stderr)
        sys.exit(1)

    dist_matrix = compute_distance_matrix(coords)

    try:
        parts = args.figsize.lower().split("x")
        figsize = (float(parts[0]), float(parts[1]))
    except (ValueError, IndexError):
        figsize = (8, 8)

    fig, ax = plt.subplots(figsize=figsize)

    if args.binary:
        contact_matrix = (dist_matrix <= args.cutoff).astype(float)
        np.fill_diagonal(contact_matrix, 0)
        cmap = args.cmap or "Greys"
        im = ax.imshow(contact_matrix, cmap=cmap, origin="lower", aspect="equal")
        n_contacts = int(contact_matrix.sum() / 2)
        cbar_label = "Contact"
    else:
        cmap = args.cmap or "viridis_r"
        im = ax.imshow(dist_matrix, cmap=cmap, origin="lower", aspect="equal")
        cbar_label = "Distance (Å)"

    # Colorbar
    cbar = plt.colorbar(im, ax=ax, shrink=0.8)
    cbar.set_label(cbar_label, fontsize=11)

    # Axis labels with residue numbers
    n = len(res_ids)
    tick_step = max(1, n // 10)
    tick_positions = list(range(0, n, tick_step))
    tick_labels = [str(res_ids[i]) for i in tick_positions]
    ax.set_xticks(tick_positions)
    ax.set_xticklabels(tick_labels, fontsize=8, rotation=45)
    ax.set_yticks(tick_positions)
    ax.set_yticklabels(tick_labels, fontsize=8)

    ax.set_xlabel("Residue Number", fontsize=11)
    ax.set_ylabel("Residue Number", fontsize=11)

    if args.binary:
        title = args.title or f"Contact Map — Chain {args.chain} ({args.cutoff}Å cutoff)"
        subtitle = f"{n} residues, {n_contacts} contacts"
    else:
        title = args.title or f"Distance Matrix — Chain {args.chain}"
        subtitle = f"{n} residues, C-alpha distances"
    ax.set_title(f"{title}\n{subtitle}", fontsize=13, fontweight="bold")

    plt.tight_layout()
    plt.savefig(args.output, dpi=args.dpi, bbox_inches="tight")
    plt.close()

    if args.binary:
        print(f"Contact map saved to {args.output} ({n} residues, {n_contacts} contacts, cutoff={args.cutoff}Å)")
    else:
        print(f"Distance matrix saved to {args.output} ({n} residues)")


if __name__ == "__main__":
    main()

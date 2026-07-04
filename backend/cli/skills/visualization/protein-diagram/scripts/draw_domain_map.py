#!/usr/bin/env python3
"""
draw_domain_map.py - Generate Pfam/InterPro-style protein domain architecture diagrams.

Renders a linear domain architecture map for a protein, either from a JSON domain
definition or by fetching InterPro annotations from a UniProt ID.

Usage:
    python draw_domain_map.py --length 450 --domains '[{"name":"SH2","start":10,"end":100,"color":"#e74c3c"}]' --output domains.png
    python draw_domain_map.py --uniprot P00519 --output abl1_domains.png
    python draw_domain_map.py --length 800 --domains domains.json --output domains.svg
"""

import argparse
import json
import sys
import urllib.request
import urllib.error

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches


# Colorblind-safe palette for domains
DOMAIN_PALETTE = [
    "#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6",
    "#1abc9c", "#e67e22", "#34495e", "#d35400", "#8e44ad",
    "#16a085", "#c0392b", "#2980b9", "#27ae60", "#f1c40f",
]


def fetch_interpro_domains(uniprot_id):
    url = f"https://www.ebi.ac.uk/interpro/api/entry/all/protein/uniprot/{uniprot_id}?format=json"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except urllib.error.URLError as e:
        print(f"Error fetching InterPro data for {uniprot_id}: {e}", file=sys.stderr)
        sys.exit(1)

    # Also fetch protein length
    len_url = f"https://rest.uniprot.org/uniprotkb/{uniprot_id}.json"
    try:
        req = urllib.request.Request(len_url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            prot_data = json.loads(resp.read())
            prot_length = prot_data["sequence"]["length"]
    except Exception:
        prot_length = None

    domains = []
    for entry in data.get("results", []):
        entry_name = entry["metadata"]["name"]
        entry_type = entry["metadata"]["type"]
        if entry_type not in ("domain", "family", "homologous_superfamily"):
            continue
        for protein in entry.get("proteins", []):
            for loc in protein.get("entry_protein_locations", []):
                for frag in loc.get("fragments", []):
                    domains.append({
                        "name": entry_name,
                        "start": frag["start"],
                        "end": frag["end"],
                    })

    return domains, prot_length


def load_domains(domains_arg):
    # Try as file path
    try:
        with open(domains_arg) as f:
            return json.load(f)
    except (FileNotFoundError, IsADirectoryError):
        pass

    # Try as inline JSON
    try:
        return json.loads(domains_arg)
    except json.JSONDecodeError:
        print(f"Error: Cannot parse domains from '{domains_arg}'. Provide a JSON file or inline JSON array.",
              file=sys.stderr)
        sys.exit(1)


def draw_domain_map(domains, prot_length, title=None, figsize=(12, 3), dpi=300, output="domains.png"):
    fig, ax = plt.subplots(figsize=figsize)

    # Draw backbone
    backbone_y = 0.5
    backbone_height = 0.08
    ax.add_patch(mpatches.FancyBboxPatch(
        (0, backbone_y - backbone_height / 2), prot_length, backbone_height,
        boxstyle="round,pad=0", facecolor="#bdc3c7", edgecolor="none",
    ))

    # Draw domains
    legend_handles = []
    for i, domain in enumerate(domains):
        name = domain["name"]
        start = domain["start"]
        end = domain["end"]
        color = domain.get("color", DOMAIN_PALETTE[i % len(DOMAIN_PALETTE)])
        height = 0.3

        rect = mpatches.FancyBboxPatch(
            (start, backbone_y - height / 2), end - start, height,
            boxstyle="round,pad=2",
            facecolor=color,
            edgecolor="white",
            linewidth=1.5,
            alpha=0.9,
        )
        ax.add_patch(rect)

        # Label
        mid = (start + end) / 2
        label_text = name if (end - start) > prot_length * 0.08 else ""
        if label_text:
            ax.text(mid, backbone_y, label_text, ha="center", va="center",
                    fontsize=8, fontweight="bold", color="white")

        legend_handles.append(mpatches.Patch(color=color, label=f"{name} ({start}–{end})"))

    # Axis formatting
    ax.set_xlim(-prot_length * 0.02, prot_length * 1.02)
    ax.set_ylim(0, 1)
    ax.set_xlabel("Residue Position", fontsize=11)
    ax.set_yticks([])
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_visible(False)

    # Legend
    if len(legend_handles) <= 10:
        ax.legend(handles=legend_handles, loc="upper right", fontsize=8,
                  framealpha=0.8, ncol=min(3, len(legend_handles)))

    if title:
        ax.set_title(title, fontsize=14, fontweight="bold", pad=12)

    # Residue count label
    ax.text(prot_length, backbone_y - 0.15, f"{prot_length} aa", ha="right",
            fontsize=9, color="#7f8c8d")

    plt.tight_layout()
    plt.savefig(output, dpi=dpi, bbox_inches="tight")
    plt.close()
    print(f"Domain map saved to {output} ({len(domains)} domains, {prot_length} residues)")


def main():
    parser = argparse.ArgumentParser(description="Generate protein domain architecture diagrams")
    parser.add_argument("--length", type=int, default=None, help="Protein length in residues")
    parser.add_argument("--domains", default=None, help="JSON array of domains or path to JSON file")
    parser.add_argument("--uniprot", default=None, help="UniProt accession (fetches InterPro domains)")
    parser.add_argument("--output", required=True, help="Output image path (PNG/SVG/PDF)")
    parser.add_argument("--title", default=None, help="Figure title")
    parser.add_argument("--figsize", default="12x3", help="Figure size as WxH (default: 12x3)")
    parser.add_argument("--dpi", type=int, default=300, help="Resolution in DPI (default: 300)")
    args = parser.parse_args()

    if args.uniprot:
        domains, prot_length = fetch_interpro_domains(args.uniprot)
        if args.length:
            prot_length = args.length
        if not prot_length:
            print("Error: Could not determine protein length. Provide --length.", file=sys.stderr)
            sys.exit(1)
        title = args.title or f"{args.uniprot} Domain Architecture"
    elif args.domains:
        domains = load_domains(args.domains)
        prot_length = args.length
        if not prot_length:
            prot_length = max(d["end"] for d in domains) + 10
        title = args.title or "Domain Architecture"
    else:
        print("Error: Provide either --uniprot or --domains.", file=sys.stderr)
        sys.exit(1)

    if not domains:
        print("Warning: No domains found.", file=sys.stderr)

    try:
        parts = args.figsize.lower().split("x")
        figsize = (float(parts[0]), float(parts[1]))
    except (ValueError, IndexError):
        figsize = (12, 3)

    draw_domain_map(domains, prot_length, title=title, figsize=figsize, dpi=args.dpi, output=args.output)


if __name__ == "__main__":
    main()

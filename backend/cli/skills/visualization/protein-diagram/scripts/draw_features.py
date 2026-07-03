#!/usr/bin/env python3
"""
draw_features.py - Annotate protein features (PTMs, binding sites, mutations, variants).

Renders protein feature tracks showing post-translational modifications, binding sites,
active sites, mutations, and other annotations along the sequence using matplotlib.

Usage:
    python draw_features.py --length 450 --features '[{"name":"Active site","position":271,"type":"site"}]' --output features.png
    python draw_features.py --uniprot P00519 --output abl1_features.png
    python draw_features.py --length 450 --features features.json --output tracks.svg
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


# Feature type → (color, marker shape)
FEATURE_STYLES = {
    "site": ("#e74c3c", "v"),
    "active_site": ("#e74c3c", "*"),
    "binding": ("#3498db", "D"),
    "ptm": ("#f39c12", "o"),
    "phosphorylation": ("#f39c12", "o"),
    "glycosylation": ("#2ecc71", "s"),
    "acetylation": ("#9b59b6", "^"),
    "mutation": ("#e67e22", "X"),
    "variant": ("#e67e22", "X"),
    "disulfide": ("#1abc9c", "p"),
    "signal": ("#95a5a6", ">"),
    "transit": ("#95a5a6", ">"),
    "region": ("#34495e", None),  # drawn as box
    "domain": ("#3498db", None),  # drawn as box
}


def fetch_uniprot_features(uniprot_id):
    url = f"https://rest.uniprot.org/uniprotkb/{uniprot_id}.json"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except urllib.error.URLError as e:
        print(f"Error fetching UniProt data for {uniprot_id}: {e}", file=sys.stderr)
        sys.exit(1)

    prot_length = data["sequence"]["length"]

    features = []
    for feat in data.get("features", []):
        feat_type = feat["type"].lower().replace(" ", "_")
        desc = feat.get("description", feat["type"])
        loc = feat["location"]

        if "position" in loc.get("start", {}) and "position" in loc.get("end", {}):
            start = loc["start"]["value"]
            end = loc["end"]["value"]
            if start == end:
                features.append({
                    "name": desc,
                    "position": start,
                    "type": feat_type,
                })
            else:
                features.append({
                    "name": desc,
                    "start": start,
                    "end": end,
                    "type": feat_type,
                })

    return features, prot_length


def load_features(features_arg):
    try:
        with open(features_arg) as f:
            return json.load(f)
    except (FileNotFoundError, IsADirectoryError):
        pass
    try:
        return json.loads(features_arg)
    except json.JSONDecodeError:
        print(f"Error: Cannot parse features from '{features_arg}'.", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Generate protein feature track diagrams")
    parser.add_argument("--length", type=int, default=None, help="Protein length in residues")
    parser.add_argument("--features", default=None, help="JSON array of features or path to JSON file")
    parser.add_argument("--uniprot", default=None, help="UniProt accession (auto-fetches features)")
    parser.add_argument("--output", required=True, help="Output image path (PNG/SVG/PDF)")
    parser.add_argument("--title", default=None, help="Figure title")
    parser.add_argument("--figsize", default="14x6", help="Figure size as WxH (default: 14x6)")
    parser.add_argument("--dpi", type=int, default=300, help="Resolution in DPI (default: 300)")
    parser.add_argument("--max-features", type=int, default=50, help="Max features to display (default: 50)")
    args = parser.parse_args()

    if args.uniprot:
        features, prot_length = fetch_uniprot_features(args.uniprot)
        if args.length:
            prot_length = args.length
        title = args.title or f"{args.uniprot} Features"
    elif args.features:
        features = load_features(args.features)
        prot_length = args.length
        if not prot_length:
            max_pos = 0
            for f in features:
                max_pos = max(max_pos, f.get("position", 0), f.get("end", 0))
            prot_length = max_pos + 10
        title = args.title or "Protein Features"
    else:
        print("Error: Provide either --uniprot or --features.", file=sys.stderr)
        sys.exit(1)

    # Limit features
    if len(features) > args.max_features:
        features = features[:args.max_features]
        print(f"Showing first {args.max_features} features.", file=sys.stderr)

    # Separate point features from region features
    points = [f for f in features if "position" in f]
    regions = [f for f in features if "start" in f and "end" in f]

    try:
        parts = args.figsize.lower().split("x")
        figsize = (float(parts[0]), float(parts[1]))
    except (ValueError, IndexError):
        figsize = (14, 6)

    n_tracks = 1 + (1 if regions else 0)
    fig, axes = plt.subplots(n_tracks, 1, figsize=figsize, sharex=True,
                              gridspec_kw={"height_ratios": [2] + [1] * (n_tracks - 1)})
    if n_tracks == 1:
        axes = [axes]

    ax_points = axes[0]
    ax_regions = axes[1] if n_tracks > 1 else None

    # Draw backbone on point features axis
    ax_points.plot([0, prot_length], [0, 0], color="#bdc3c7", linewidth=3, zorder=1)

    # Plot point features
    legend_seen = set()
    for feat in points:
        pos = feat["position"]
        feat_type = feat.get("type", "site")
        color, marker = FEATURE_STYLES.get(feat_type, ("#95a5a6", "o"))
        label = feat_type if feat_type not in legend_seen else None
        legend_seen.add(feat_type)
        feat_color = feat.get("color", color)

        ax_points.plot(pos, 0, marker=marker, color=feat_color, markersize=10,
                       markeredgecolor="white", markeredgewidth=0.5, zorder=3, label=label)
        ax_points.annotate(feat["name"], (pos, 0), textcoords="offset points",
                           xytext=(0, 12), fontsize=7, ha="center", rotation=45)

    ax_points.set_ylim(-0.5, 1.5)
    ax_points.set_yticks([])
    ax_points.spines["top"].set_visible(False)
    ax_points.spines["right"].set_visible(False)
    ax_points.spines["left"].set_visible(False)
    if legend_seen:
        ax_points.legend(fontsize=8, loc="upper right", ncol=min(4, len(legend_seen)))

    # Draw region features
    if ax_regions and regions:
        ax_regions.plot([0, prot_length], [0.5, 0.5], color="#bdc3c7", linewidth=2, zorder=1)
        for i, feat in enumerate(regions):
            feat_type = feat.get("type", "region")
            color = feat.get("color", FEATURE_STYLES.get(feat_type, ("#95a5a6", None))[0])
            rect = mpatches.FancyBboxPatch(
                (feat["start"], 0.3), feat["end"] - feat["start"], 0.4,
                boxstyle="round,pad=1",
                facecolor=color, edgecolor="white", linewidth=0.5, alpha=0.8,
            )
            ax_regions.add_patch(rect)
            mid = (feat["start"] + feat["end"]) / 2
            ax_regions.text(mid, 0.5, feat["name"], ha="center", va="center",
                            fontsize=7, fontweight="bold", color="white")

        ax_regions.set_ylim(0, 1)
        ax_regions.set_yticks([])
        ax_regions.spines["top"].set_visible(False)
        ax_regions.spines["right"].set_visible(False)
        ax_regions.spines["left"].set_visible(False)

    axes[-1].set_xlabel("Residue Position", fontsize=11)
    axes[-1].set_xlim(-prot_length * 0.02, prot_length * 1.02)
    fig.suptitle(f"{title} ({prot_length} aa)", fontsize=14, fontweight="bold")

    plt.tight_layout()
    plt.savefig(args.output, dpi=args.dpi, bbox_inches="tight")
    plt.close()

    print(f"Feature tracks saved to {args.output} ({len(points)} point features, "
          f"{len(regions)} region features, {prot_length} residues)")


if __name__ == "__main__":
    main()

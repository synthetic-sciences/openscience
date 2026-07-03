#!/usr/bin/env python3
"""
Multi-Marker Immunophenotyping with Automated or Manual Gating

Identifies immune cell populations from multi-color flow cytometry data by
applying threshold-based gating across multiple fluorescence markers. Supports
an optional FSC/SSC parent gate for lymphocyte selection and generates
population frequency tables with density plots.

Dependencies: flowio, numpy, pandas, matplotlib, scipy

Usage:
    python immunophenotype.py --fcs blood.fcs --panel panel.json --output-dir pheno/
    python immunophenotype.py --fcs pbmc.fcs --panel markers.json --parent-gate '{"FSC-A": [50000, 200000], "SSC-A": [10000, 100000]}'
    python immunophenotype.py --fcs sample.fcs --panel panel.json --output-dir results/

Examples:
    # Basic T-cell panel
    python immunophenotype.py --fcs t_cell_panel.fcs \\
        --panel '{"CD3": {"channel": "FL1-A", "threshold": 1000}, "CD4": {"channel": "FL2-A", "threshold": 500}, "CD8": {"channel": "FL3-A", "threshold": 800}}' \\
        --output-dir t_cells/

    # Full lymphocyte panel with parent gate
    python immunophenotype.py --fcs pbmc.fcs \\
        --panel panel_definition.json \\
        --parent-gate '{"FSC-A": [40000, 180000], "SSC-A": [5000, 80000]}' \\
        --output-dir lymphocytes/

    # Panel from JSON file
    python immunophenotype.py --fcs stained.fcs --panel my_panel.json
"""

import argparse
import itertools
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

try:
    from scipy.stats import gaussian_kde
except ImportError:
    gaussian_kde = None

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LogNorm
except ImportError:
    plt = None

try:
    import flowio
except ImportError:
    flowio = None


def load_fcs(fcs_path):
    """
    Load an FCS file and return channel names and event data.

    Parameters:
        fcs_path: Path to the FCS file.

    Returns:
        Tuple of (channel_names, events_dataframe).
    """
    if flowio is None:
        print("ERROR: flowio is required. Install: pip install flowio", file=sys.stderr)
        sys.exit(1)

    fdata = flowio.FlowData(str(fcs_path))
    n_channels = int(fdata.channel_count)

    channel_names = []
    for i in range(1, n_channels + 1):
        stain = fdata.text.get(f"p{i}s", "").strip()
        name = fdata.text.get(f"p{i}n", f"Ch{i}").strip()
        channel_names.append(stain if stain else name)

    events = np.array(fdata.events, dtype=np.float64).reshape(-1, n_channels)
    df = pd.DataFrame(events, columns=channel_names)

    return channel_names, df


def load_panel(panel_arg):
    """
    Load panel definition from a JSON string or file.

    Panel format:
        {
            "MarkerName": {
                "channel": "FL1-A",
                "threshold": 1000
            },
            ...
        }

    Parameters:
        panel_arg: JSON string or path to JSON file.

    Returns:
        Dictionary with marker definitions.
    """
    if os.path.isfile(panel_arg):
        with open(panel_arg, "r") as f:
            panel = json.load(f)
    else:
        try:
            panel = json.loads(panel_arg)
        except json.JSONDecodeError as exc:
            print(f"ERROR: Could not parse panel as JSON: {exc}", file=sys.stderr)
            sys.exit(1)

    # Validate structure
    for marker, defn in panel.items():
        if not isinstance(defn, dict):
            print(f"ERROR: Panel entry for '{marker}' must be a dict with 'channel' and 'threshold'.", file=sys.stderr)
            sys.exit(1)
        if "channel" not in defn:
            print(f"ERROR: Panel entry for '{marker}' missing 'channel' key.", file=sys.stderr)
            sys.exit(1)
        if "threshold" not in defn:
            print(f"ERROR: Panel entry for '{marker}' missing 'threshold' key.", file=sys.stderr)
            sys.exit(1)

    return panel


def load_parent_gate(gate_arg):
    """
    Parse parent gate definition from JSON string or file.

    Parameters:
        gate_arg: JSON string or file path with {"channel": [low, high]} format.

    Returns:
        Dictionary with gate definitions, or None if gate_arg is None.
    """
    if gate_arg is None:
        return None

    if os.path.isfile(gate_arg):
        with open(gate_arg, "r") as f:
            gate = json.load(f)
    else:
        try:
            gate = json.loads(gate_arg)
        except json.JSONDecodeError as exc:
            print(f"ERROR: Could not parse parent gate as JSON: {exc}", file=sys.stderr)
            sys.exit(1)

    for channel, bounds in gate.items():
        if not isinstance(bounds, (list, tuple)) or len(bounds) != 2:
            print(f"ERROR: Parent gate for '{channel}' must be [low, high].", file=sys.stderr)
            sys.exit(1)

    return gate


def apply_parent_gate(df, parent_gate):
    """
    Apply a rectangular FSC/SSC parent gate to select a base population
    (typically lymphocytes).

    Parameters:
        df: Events DataFrame.
        parent_gate: Dictionary of channel -> [low, high].

    Returns:
        Tuple of (gated_df, mask) where mask is the boolean array.
    """
    mask = np.ones(len(df), dtype=bool)

    for channel, (lo, hi) in parent_gate.items():
        if channel not in df.columns:
            print(f"WARNING: Parent gate channel '{channel}' not found. Skipping.", file=sys.stderr)
            continue
        mask = mask & (df[channel].values >= lo) & (df[channel].values <= hi)

    gated = df[mask].copy().reset_index(drop=True)
    return gated, mask


def apply_marker_thresholds(df, panel):
    """
    Apply threshold gating for each marker and compute positivity.

    Parameters:
        df: Events DataFrame (after parent gating).
        panel: Panel definition dictionary.

    Returns:
        Tuple of (marker_positivity_df, marker_stats) where:
        - marker_positivity_df has boolean columns for each marker
        - marker_stats is a list of dicts with per-marker statistics
    """
    positivity = pd.DataFrame(index=df.index)
    stats = []

    for marker, defn in panel.items():
        channel = defn["channel"]
        threshold = defn["threshold"]

        if channel not in df.columns:
            print(f"WARNING: Channel '{channel}' for marker '{marker}' not found. Skipping.", file=sys.stderr)
            continue

        values = df[channel].values
        positive = values >= threshold
        positivity[marker] = positive

        n_pos = int(np.sum(positive))
        n_total = len(positive)
        pct = n_pos / n_total * 100 if n_total > 0 else 0

        stats.append({
            "marker": marker,
            "channel": channel,
            "threshold": threshold,
            "positive_count": n_pos,
            "negative_count": n_total - n_pos,
            "total_count": n_total,
            "pct_positive": round(pct, 2),
            "median_positive": round(float(np.median(values[positive])), 2) if n_pos > 0 else 0,
            "median_negative": round(float(np.median(values[~positive])), 2) if (n_total - n_pos) > 0 else 0,
        })

    return positivity, stats


def identify_populations(positivity, panel):
    """
    Identify standard immune cell populations based on marker combinations.

    Recognizes common patterns:
    - CD3+CD4+CD8-: Helper T cells
    - CD3+CD4-CD8+: Cytotoxic T cells
    - CD3-CD19+: B cells
    - CD3-CD56+: NK cells
    - CD3+CD56+: NKT cells
    - CD4+CD25+: Regulatory T cells (if markers present)

    Parameters:
        positivity: DataFrame with boolean columns for each marker.
        panel: Panel definition for marker name reference.

    Returns:
        List of dictionaries with population name, definition, count, and percentage.
    """
    markers = list(positivity.columns)
    n_total = len(positivity)
    populations = []

    # Define known populations
    known = [
        ("CD3+ T cells", {"CD3": True}),
        ("CD3+CD4+ Helper T", {"CD3": True, "CD4": True}),
        ("CD3+CD8+ Cytotoxic T", {"CD3": True, "CD8": True}),
        ("CD3+CD4+CD8- Helper T (exclusive)", {"CD3": True, "CD4": True, "CD8": False}),
        ("CD3+CD4-CD8+ Cytotoxic T (exclusive)", {"CD3": True, "CD4": False, "CD8": True}),
        ("CD3+CD4-CD8- DN T", {"CD3": True, "CD4": False, "CD8": False}),
        ("CD3+CD4+CD8+ DP T", {"CD3": True, "CD4": True, "CD8": True}),
        ("CD3-CD19+ B cells", {"CD3": False, "CD19": True}),
        ("CD3-CD56+ NK cells", {"CD3": False, "CD56": True}),
        ("CD3+CD56+ NKT cells", {"CD3": True, "CD56": True}),
        ("CD4+CD25+ Treg candidates", {"CD4": True, "CD25": True}),
        ("CD3-CD14+ Monocytes", {"CD3": False, "CD14": True}),
        ("CD3-CD16+CD56+ NK (mature)", {"CD3": False, "CD16": True, "CD56": True}),
    ]

    for pop_name, criteria in known:
        # Check if all required markers are in the panel
        if not all(m in markers for m in criteria.keys()):
            continue

        mask = np.ones(n_total, dtype=bool)
        definition_parts = []
        for marker_name, is_positive in criteria.items():
            if is_positive:
                mask = mask & positivity[marker_name].values
                definition_parts.append(f"{marker_name}+")
            else:
                mask = mask & ~positivity[marker_name].values
                definition_parts.append(f"{marker_name}-")

        count = int(np.sum(mask))
        pct = count / n_total * 100 if n_total > 0 else 0

        populations.append({
            "population": pop_name,
            "definition": " ".join(definition_parts),
            "count": count,
            "pct_of_parent": round(pct, 2),
        })

    # Also enumerate all marker combinations present in the data
    if len(markers) <= 6:
        combo_populations = []
        for combo_len in range(1, min(len(markers) + 1, 4)):
            for combo in itertools.combinations(markers, combo_len):
                mask = np.ones(n_total, dtype=bool)
                parts = []
                for m in combo:
                    mask = mask & positivity[m].values
                    parts.append(f"{m}+")
                count = int(np.sum(mask))
                if count > 0:
                    pct = count / n_total * 100 if n_total > 0 else 0
                    combo_populations.append({
                        "population": " ".join(parts),
                        "definition": " ".join(parts),
                        "count": count,
                        "pct_of_parent": round(pct, 2),
                    })
        # Add combo populations that are not already covered by known
        known_defs = {p["definition"] for p in populations}
        for cp in combo_populations:
            if cp["definition"] not in known_defs:
                populations.append(cp)

    return populations


def save_density_plots(df, panel, positivity, output_dir):
    """
    Save density plots for each pair of markers, showing threshold lines
    and quadrant percentages.

    Parameters:
        df: Events DataFrame (after parent gating).
        panel: Panel definition dictionary.
        positivity: DataFrame with boolean columns.
        output_dir: Output directory.

    Returns:
        List of saved plot paths.
    """
    if plt is None:
        print("WARNING: matplotlib not available, skipping density plots.", file=sys.stderr)
        return []

    markers = list(panel.keys())
    saved = []

    # Generate plots for all marker pairs
    pairs = list(itertools.combinations(markers, 2))
    if not pairs:
        return []

    # Limit to reasonable number of plots
    max_plots = 15
    if len(pairs) > max_plots:
        print(f"  Limiting to {max_plots} marker pair plots (of {len(pairs)} possible).")
        pairs = pairs[:max_plots]

    for m1, m2 in pairs:
        ch1 = panel[m1]["channel"]
        ch2 = panel[m2]["channel"]
        th1 = panel[m1]["threshold"]
        th2 = panel[m2]["threshold"]

        if ch1 not in df.columns or ch2 not in df.columns:
            continue

        x = df[ch1].values
        y = df[ch2].values

        fig, ax = plt.subplots(figsize=(8, 7))

        # Subsample for density estimation if too many events
        max_events = 50000
        if len(x) > max_events:
            idx = np.random.choice(len(x), max_events, replace=False)
            x_plot = x[idx]
            y_plot = y[idx]
        else:
            x_plot = x
            y_plot = y

        # 2D histogram as pseudo-density
        # Use log scale for fluorescence values if they span a wide range
        x_range = np.ptp(x_plot)
        y_range = np.ptp(y_plot)

        ax.hist2d(
            x_plot, y_plot,
            bins=200,
            cmap="viridis",
            norm=LogNorm() if x_range > 1000 and y_range > 1000 else None,
            cmin=1,
        )

        # Threshold lines
        ax.axvline(th1, color="red", linestyle="--", linewidth=1.5, alpha=0.8)
        ax.axhline(th2, color="red", linestyle="--", linewidth=1.5, alpha=0.8)

        # Quadrant percentages
        n_total = len(x)
        q_pp = np.sum((x >= th1) & (y >= th2))  # ++
        q_pn = np.sum((x >= th1) & (y < th2))   # +-
        q_np = np.sum((x < th1) & (y >= th2))    # -+
        q_nn = np.sum((x < th1) & (y < th2))     # --

        def pct(count):
            return count / n_total * 100 if n_total > 0 else 0

        # Place quadrant labels
        x_mid_hi = th1 + (ax.get_xlim()[1] - th1) * 0.5 if ax.get_xlim()[1] > th1 else th1
        x_mid_lo = (ax.get_xlim()[0] + th1) * 0.5
        y_mid_hi = th2 + (ax.get_ylim()[1] - th2) * 0.5 if ax.get_ylim()[1] > th2 else th2
        y_mid_lo = (ax.get_ylim()[0] + th2) * 0.5

        bbox_props = dict(boxstyle="round,pad=0.3", facecolor="white", alpha=0.8)
        ax.text(0.75, 0.95, f"{m1}+{m2}+\n{pct(q_pp):.1f}%", transform=ax.transAxes,
                fontsize=10, fontweight="bold", va="top", ha="center", bbox=bbox_props)
        ax.text(0.25, 0.95, f"{m1}-{m2}+\n{pct(q_np):.1f}%", transform=ax.transAxes,
                fontsize=10, fontweight="bold", va="top", ha="center", bbox=bbox_props)
        ax.text(0.75, 0.05, f"{m1}+{m2}-\n{pct(q_pn):.1f}%", transform=ax.transAxes,
                fontsize=10, fontweight="bold", va="bottom", ha="center", bbox=bbox_props)
        ax.text(0.25, 0.05, f"{m1}-{m2}-\n{pct(q_nn):.1f}%", transform=ax.transAxes,
                fontsize=10, fontweight="bold", va="bottom", ha="center", bbox=bbox_props)

        ax.set_xlabel(f"{m1} ({ch1})", fontsize=12)
        ax.set_ylabel(f"{m2} ({ch2})", fontsize=12)
        ax.set_title(f"{m1} vs {m2}", fontsize=13)

        plt.tight_layout()
        plot_name = f"density_{m1}_vs_{m2}.png".replace("/", "_").replace(" ", "_")
        plot_path = Path(output_dir) / plot_name
        fig.savefig(plot_path, dpi=150)
        plt.close(fig)
        saved.append(plot_path)

    return saved


def main():
    parser = argparse.ArgumentParser(
        description="Multi-marker immunophenotyping with threshold gating."
    )
    parser.add_argument(
        "--fcs",
        type=str,
        required=True,
        help="Path to the FCS file.",
    )
    parser.add_argument(
        "--panel",
        type=str,
        required=True,
        help=(
            'JSON string or file defining markers and thresholds. '
            'Format: {"MarkerName": {"channel": "FL1-A", "threshold": 1000}, ...}'
        ),
    )
    parser.add_argument(
        "--parent-gate",
        type=str,
        default=None,
        help=(
            'Optional JSON string or file for initial FSC/SSC gate. '
            'Format: {"FSC-A": [low, high], "SSC-A": [low, high]}'
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="immunophenotype_output",
        help="Output directory (default: immunophenotype_output).",
    )

    args = parser.parse_args()

    fcs_path = Path(args.fcs)
    if not fcs_path.is_file():
        print(f"ERROR: FCS file not found: {fcs_path}", file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load FCS
    print(f"Loading FCS file: {fcs_path}")
    channel_names, df = load_fcs(fcs_path)
    print(f"  Channels ({len(channel_names)}): {', '.join(channel_names)}")
    print(f"  Events: {len(df):,}")

    # Load panel
    panel = load_panel(args.panel)
    print(f"\nPanel markers ({len(panel)}):")
    for marker, defn in panel.items():
        print(f"  {marker}: channel={defn['channel']}, threshold={defn['threshold']}")

    # Validate panel channels exist
    missing = [m for m, d in panel.items() if d["channel"] not in channel_names]
    if missing:
        print(f"\nWARNING: Channels not found for markers: {missing}", file=sys.stderr)
        print(f"  Available channels: {channel_names}", file=sys.stderr)
        # Remove missing markers
        for m in missing:
            del panel[m]
        if not panel:
            print("ERROR: No valid markers remain after removing missing channels.", file=sys.stderr)
            sys.exit(1)

    # Apply parent gate
    parent_gate = load_parent_gate(args.parent_gate)
    if parent_gate:
        print(f"\nApplying parent gate:")
        for ch, (lo, hi) in parent_gate.items():
            print(f"  {ch}: [{lo}, {hi}]")
        df, parent_mask = apply_parent_gate(df, parent_gate)
        print(f"  Events after parent gate: {len(df):,} ({len(df) / parent_mask.shape[0] * 100:.1f}%)")
    else:
        print("\nNo parent gate applied (using all events).")

    # Apply marker thresholds
    print("\nApplying marker thresholds...")
    positivity, marker_stats = apply_marker_thresholds(df, panel)

    print(f"\n--- Marker Positivity ---")
    print(f"  {'Marker':<15} {'Channel':<12} {'Threshold':>10} {'% Positive':>12} {'Count +':>10} {'Count -':>10}")
    print("  " + "-" * 72)
    for s in marker_stats:
        print(
            f"  {s['marker']:<15} {s['channel']:<12} {s['threshold']:>10.0f} "
            f"{s['pct_positive']:>11.1f}% {s['positive_count']:>10,} {s['negative_count']:>10,}"
        )

    # Identify populations
    print("\n--- Identified Populations ---")
    populations = identify_populations(positivity, panel)

    if populations:
        print(f"  {'Population':<45} {'Count':>10} {'% Parent':>10}")
        print("  " + "-" * 67)
        for p in sorted(populations, key=lambda x: x["count"], reverse=True):
            print(f"  {p['population']:<45} {p['count']:>10,} {p['pct_of_parent']:>9.1f}%")
    else:
        print("  No standard populations identified with current marker panel.")

    # Save marker stats CSV
    marker_csv = output_dir / "marker_positivity.csv"
    pd.DataFrame(marker_stats).to_csv(marker_csv, index=False)
    print(f"\nMarker positivity saved to: {marker_csv}")

    # Save population frequencies CSV
    pop_csv = output_dir / "population_frequencies.csv"
    pd.DataFrame(populations).to_csv(pop_csv, index=False)
    print(f"Population frequencies saved to: {pop_csv}")

    # Save gated events with positivity columns
    events_csv = output_dir / "phenotyped_events.csv"
    combined = pd.concat([df.reset_index(drop=True), positivity.reset_index(drop=True)], axis=1)
    combined.to_csv(events_csv, index=False)
    print(f"Phenotyped events saved to: {events_csv}")

    # Generate density plots
    print("\nGenerating density plots...")
    plots = save_density_plots(df, panel, positivity, output_dir)
    if plots:
        print(f"  Saved {len(plots)} density plot(s):")
        for p in plots:
            print(f"    {p}")
    else:
        print("  No density plots generated.")


if __name__ == "__main__":
    main()

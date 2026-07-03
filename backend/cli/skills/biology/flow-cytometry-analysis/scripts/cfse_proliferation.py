#!/usr/bin/env python3
"""
CFSE Proliferation Analysis with Peak Detection

Analyzes CFSE (or CellTrace Violet) dye dilution assays to quantify cell
proliferation. Detects generation peaks in the log-transformed fluorescence
histogram and computes standard proliferation metrics: division index,
proliferation index, and percent divided.

Dependencies: flowio, numpy, pandas, scipy, matplotlib

Usage:
    python cfse_proliferation.py --fcs cfse_sample.fcs --cfse-channel "FITC-A" --output-dir prolif/
    python cfse_proliferation.py --fcs cfse.fcs --cfse-channel "FL1-A" --max-generations 6
    python cfse_proliferation.py --fcs exported.csv --cfse-channel "CFSE" --output-dir results/

Examples:
    # Standard CFSE analysis on FITC channel
    python cfse_proliferation.py --fcs stimulated.fcs --cfse-channel "FITC-A" --output-dir proliferation/

    # Limit to 6 generations with CellTrace Violet
    python cfse_proliferation.py --fcs ctv_stim.fcs --cfse-channel "BV421-A" --max-generations 6

    # From CSV export
    python cfse_proliferation.py --fcs events.csv --cfse-channel "CFSE_log" --max-generations 10
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.signal import find_peaks

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except ImportError:
    plt = None

try:
    import flowio
except ImportError:
    flowio = None


def load_cfse_channel(fcs_path, cfse_channel):
    """
    Load CFSE fluorescence data from an FCS file or CSV.

    Parameters:
        fcs_path: Path to FCS or CSV file.
        cfse_channel: Channel name (string) or column index (integer string).

    Returns:
        Tuple of (cfse_values, channel_label).
    """
    path = Path(fcs_path)
    suffix = path.suffix.lower()

    if suffix == ".csv":
        df = pd.read_csv(path)
        if cfse_channel.isdigit():
            idx = int(cfse_channel)
            if idx >= len(df.columns):
                print(f"ERROR: Column index {idx} out of range (0-{len(df.columns)-1}).", file=sys.stderr)
                sys.exit(1)
            col = df.columns[idx]
        else:
            col = cfse_channel
            if col not in df.columns:
                print(f"ERROR: Column '{col}' not found. Available: {list(df.columns)}", file=sys.stderr)
                sys.exit(1)
        values = df[col].dropna().values.astype(np.float64)
        return values, col

    # FCS file
    if flowio is None:
        print("ERROR: flowio is required for FCS files. Install: pip install flowio", file=sys.stderr)
        sys.exit(1)

    fdata = flowio.FlowData(str(path))
    n_channels = int(fdata.channel_count)
    channel_names = []
    for i in range(1, n_channels + 1):
        stain = fdata.text.get(f"p{i}s", "").strip()
        name = fdata.text.get(f"p{i}n", f"Ch{i}").strip()
        channel_names.append(stain if stain else name)

    events = np.array(fdata.events, dtype=np.float64).reshape(-1, n_channels)

    if cfse_channel.isdigit():
        idx = int(cfse_channel)
        if idx >= n_channels:
            print(f"ERROR: Channel index {idx} out of range (0-{n_channels-1}).", file=sys.stderr)
            sys.exit(1)
        label = channel_names[idx]
    else:
        if cfse_channel not in channel_names:
            print(f"ERROR: Channel '{cfse_channel}' not found. Available: {channel_names}", file=sys.stderr)
            sys.exit(1)
        idx = channel_names.index(cfse_channel)
        label = cfse_channel

    return events[:, idx], label


def detect_generation_peaks(cfse_log, max_generations, n_bins=512):
    """
    Detect generation peaks in the log-transformed CFSE histogram.

    Each cell division halves the CFSE intensity, producing evenly spaced peaks
    on a log scale. Generation 0 has the highest CFSE, and each subsequent
    generation appears at lower intensity.

    Parameters:
        cfse_log: Log-transformed CFSE values.
        max_generations: Maximum number of generations to search for.
        n_bins: Number of histogram bins.

    Returns:
        Dictionary with peak_positions (log scale), generation_assignments,
        peak_counts, histogram bin_centers, and histogram counts.
    """
    # Remove outliers
    q01, q99 = np.percentile(cfse_log, [0.5, 99.5])
    filtered = cfse_log[(cfse_log >= q01) & (cfse_log <= q99)]

    counts, bin_edges = np.histogram(filtered, bins=n_bins)
    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2
    bin_width = bin_centers[1] - bin_centers[0]

    # Smooth histogram for peak detection
    kernel_size = max(3, n_bins // 64)
    if kernel_size % 2 == 0:
        kernel_size += 1
    smoothed = np.convolve(counts, np.ones(kernel_size) / kernel_size, mode="same")

    # Expected spacing between generation peaks on log scale
    # Each division halves intensity: log2 spacing ~ log10(2) ~ 0.301 on log10 scale
    log2_spacing = np.log10(2)
    expected_spacing_bins = log2_spacing / bin_width

    # Find peaks with prominence and minimum distance
    min_distance = max(int(expected_spacing_bins * 0.5), 3)
    min_prominence = max(smoothed) * 0.01

    peaks, properties = find_peaks(
        smoothed,
        distance=min_distance,
        prominence=min_prominence,
        height=max(smoothed) * 0.005,
    )

    if len(peaks) == 0:
        print("WARNING: No peaks detected in CFSE histogram.", file=sys.stderr)
        return {
            "peak_positions": np.array([]),
            "generation_assignments": np.array([]),
            "peak_counts": np.array([]),
            "bin_centers": bin_centers,
            "counts": counts,
            "smoothed": smoothed,
        }

    # Sort peaks by position (highest CFSE = rightmost on log scale = gen 0)
    sorted_peak_idx = np.argsort(bin_centers[peaks])[::-1]
    sorted_peaks = peaks[sorted_peak_idx]

    # Assign generations: gen 0 is the brightest (rightmost) peak
    # Validate spacing — peaks should be approximately log2 apart
    assigned_peaks = []
    assigned_gens = []
    assigned_counts = []

    gen0_pos = bin_centers[sorted_peaks[0]]
    assigned_peaks.append(gen0_pos)
    assigned_gens.append(0)
    assigned_counts.append(int(counts[sorted_peaks[0]]))

    for i in range(1, len(sorted_peaks)):
        if len(assigned_gens) >= max_generations + 1:
            break
        pos = bin_centers[sorted_peaks[i]]
        expected_gen = (gen0_pos - pos) / log2_spacing
        nearest_gen = round(expected_gen)

        # Accept if within 40% of expected spacing and not already assigned
        if nearest_gen > 0 and nearest_gen <= max_generations:
            if abs(expected_gen - nearest_gen) < 0.4 and nearest_gen not in assigned_gens:
                assigned_peaks.append(pos)
                assigned_gens.append(int(nearest_gen))
                assigned_counts.append(int(counts[sorted_peaks[i]]))

    return {
        "peak_positions": np.array(assigned_peaks),
        "generation_assignments": np.array(assigned_gens),
        "peak_counts": np.array(assigned_counts),
        "bin_centers": bin_centers,
        "counts": counts,
        "smoothed": smoothed,
        "gen0_position": gen0_pos,
        "log2_spacing": log2_spacing,
    }


def assign_events_to_generations(cfse_log, peak_results):
    """
    Assign individual events to generations based on proximity to detected peaks.

    Parameters:
        cfse_log: Log-transformed CFSE values for all events.
        peak_results: Dictionary from detect_generation_peaks().

    Returns:
        Array of generation assignments for each event (-1 if unassigned).
    """
    positions = peak_results["peak_positions"]
    gens = peak_results["generation_assignments"]

    if len(positions) == 0:
        return np.full(len(cfse_log), -1, dtype=int)

    # Compute boundaries midway between adjacent peaks
    sorted_idx = np.argsort(positions)[::-1]  # Descending (gen 0 first)
    sorted_pos = positions[sorted_idx]
    sorted_gens = gens[sorted_idx]

    assignments = np.full(len(cfse_log), -1, dtype=int)

    for i in range(len(sorted_pos)):
        # Upper bound
        if i == 0:
            upper = np.inf
        else:
            upper = (sorted_pos[i - 1] + sorted_pos[i]) / 2

        # Lower bound
        if i == len(sorted_pos) - 1:
            lower = -np.inf
        else:
            lower = (sorted_pos[i] + sorted_pos[i + 1]) / 2

        mask = (cfse_log >= lower) & (cfse_log < upper)
        assignments[mask] = sorted_gens[i]

    return assignments


def compute_proliferation_metrics(gen_assignments, max_gen_detected):
    """
    Compute standard proliferation metrics from generation assignments.

    Parameters:
        gen_assignments: Array of per-event generation assignments (-1 for unassigned).
        max_gen_detected: Maximum generation number detected.

    Returns:
        Dictionary with division_index, proliferation_index, percent_divided,
        and per-generation cell counts.
    """
    assigned = gen_assignments[gen_assignments >= 0]
    total_assigned = len(assigned)

    if total_assigned == 0:
        return {
            "division_index": 0.0,
            "proliferation_index": 0.0,
            "percent_divided": 0.0,
            "generation_counts": {},
            "total_assigned": 0,
            "total_unassigned": int(np.sum(gen_assignments < 0)),
        }

    gen_counts = {}
    for g in range(max_gen_detected + 1):
        gen_counts[g] = int(np.sum(assigned == g))

    # Back-calculate precursor frequencies
    # Each cell in generation i came from 1/2^i precursors
    precursor_counts = {}
    for g, count in gen_counts.items():
        precursor_counts[g] = count / (2 ** g) if count > 0 else 0

    total_precursors = sum(precursor_counts.values())
    undivided_precursors = precursor_counts.get(0, 0)
    divided_precursors = total_precursors - undivided_precursors

    # Division Index: average number of divisions of ALL cells in the original population
    # = (total cells now - total precursors) / total precursors
    if total_precursors > 0:
        division_index = (total_assigned - total_precursors) / total_precursors
    else:
        division_index = 0.0

    # Proliferation Index: average number of divisions of only the RESPONDING cells
    # = total cells from divided precursors / divided precursors
    divided_cells = sum(count for g, count in gen_counts.items() if g > 0)
    if divided_precursors > 0:
        proliferation_index = divided_cells / divided_precursors
    else:
        proliferation_index = 0.0

    # Percent Divided: fraction of precursors that divided at least once
    if total_precursors > 0:
        percent_divided = divided_precursors / total_precursors * 100
    else:
        percent_divided = 0.0

    return {
        "division_index": round(division_index, 3),
        "proliferation_index": round(proliferation_index, 3),
        "percent_divided": round(percent_divided, 2),
        "generation_counts": gen_counts,
        "precursor_counts": {g: round(c, 1) for g, c in precursor_counts.items()},
        "total_assigned": total_assigned,
        "total_unassigned": int(np.sum(gen_assignments < 0)),
    }


def save_proliferation_plot(cfse_log, peak_results, gen_assignments, metrics, channel_label, output_dir):
    """
    Save a histogram plot with generation peak labels and proliferation metrics.

    Parameters:
        cfse_log: Log-transformed CFSE values.
        peak_results: Dictionary from detect_generation_peaks().
        gen_assignments: Per-event generation assignments.
        metrics: Dictionary from compute_proliferation_metrics().
        channel_label: Channel name for axis label.
        output_dir: Output directory.

    Returns:
        Path to saved plot, or None if matplotlib unavailable.
    """
    if plt is None:
        print("WARNING: matplotlib not available, skipping plot.", file=sys.stderr)
        return None

    fig, ax = plt.subplots(figsize=(12, 6))

    hist = peak_results
    bin_width = hist["bin_centers"][1] - hist["bin_centers"][0]

    # Plot histogram
    ax.bar(
        hist["bin_centers"], hist["counts"],
        width=bin_width, alpha=0.5, color="gray", label="Data",
    )
    ax.plot(hist["bin_centers"], hist["smoothed"], "k-", linewidth=1, alpha=0.7, label="Smoothed")

    # Color generations
    colors = plt.cm.tab10(np.linspace(0, 1, 10))
    for i, (pos, gen) in enumerate(zip(hist["peak_positions"], hist["generation_assignments"])):
        color = colors[int(gen) % 10]
        ax.axvline(pos, color=color, linestyle="--", linewidth=1.5, alpha=0.7)
        ax.text(
            pos, ax.get_ylim()[1] * 0.95 - (i % 3) * ax.get_ylim()[1] * 0.06,
            f"Gen {gen}", fontsize=9, ha="center", fontweight="bold",
            color=color, bbox=dict(facecolor="white", alpha=0.7, edgecolor="none", pad=1),
        )

    ax.set_xlabel(f"log10({channel_label})", fontsize=12)
    ax.set_ylabel("Event Count", fontsize=12)
    ax.set_title("CFSE Proliferation Analysis", fontsize=14)

    # Metrics box
    text = (
        f"Division Index: {metrics['division_index']:.3f}\n"
        f"Proliferation Index: {metrics['proliferation_index']:.3f}\n"
        f"Percent Divided: {metrics['percent_divided']:.1f}%\n"
        f"Generations Detected: {len(hist['generation_assignments'])}"
    )
    ax.text(
        0.02, 0.95, text, transform=ax.transAxes,
        fontsize=9, verticalalignment="top",
        bbox=dict(boxstyle="round,pad=0.4", facecolor="lightyellow", alpha=0.9),
    )

    ax.legend(loc="upper right", fontsize=9)
    plt.tight_layout()

    plot_path = Path(output_dir) / "cfse_proliferation.png"
    fig.savefig(plot_path, dpi=150)
    plt.close(fig)
    return plot_path


def main():
    parser = argparse.ArgumentParser(
        description="CFSE proliferation analysis with generation peak detection."
    )
    parser.add_argument(
        "--fcs",
        type=str,
        required=True,
        help="Path to FCS file or CSV with CFSE channel data.",
    )
    parser.add_argument(
        "--cfse-channel",
        type=str,
        required=True,
        help="CFSE channel name (e.g. 'FITC-A') or column index.",
    )
    parser.add_argument(
        "--max-generations",
        type=int,
        default=8,
        help="Maximum number of generations to detect (default: 8).",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="cfse_output",
        help="Output directory (default: cfse_output).",
    )

    args = parser.parse_args()

    fcs_path = Path(args.fcs)
    if not fcs_path.is_file():
        print(f"ERROR: File not found: {fcs_path}", file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load CFSE data
    print(f"Loading CFSE data from: {fcs_path}")
    cfse_values, channel_label = load_cfse_channel(fcs_path, args.cfse_channel)
    print(f"  Channel: {channel_label}")
    print(f"  Events: {len(cfse_values):,}")

    # Remove non-positive values before log transform
    positive_mask = cfse_values > 0
    n_removed = np.sum(~positive_mask)
    if n_removed > 0:
        print(f"  Removed {n_removed:,} non-positive events before log transform.")
    cfse_positive = cfse_values[positive_mask]

    # Log10 transform
    cfse_log = np.log10(cfse_positive)
    print(f"  Log10 range: [{cfse_log.min():.2f}, {cfse_log.max():.2f}]")

    # Detect peaks
    print(f"\nDetecting generation peaks (max {args.max_generations} generations)...")
    peak_results = detect_generation_peaks(cfse_log, args.max_generations)

    n_peaks = len(peak_results["generation_assignments"])
    print(f"  Peaks detected: {n_peaks}")

    if n_peaks == 0:
        print("WARNING: No generation peaks detected. Check channel and data quality.", file=sys.stderr)
        sys.exit(1)

    for pos, gen in zip(peak_results["peak_positions"], peak_results["generation_assignments"]):
        print(f"    Gen {gen}: log10(CFSE) = {pos:.3f}  (CFSE ~ {10**pos:.0f})")

    # Assign events to generations
    gen_assignments = assign_events_to_generations(cfse_log, peak_results)

    # Compute metrics
    max_gen = int(peak_results["generation_assignments"].max())
    metrics = compute_proliferation_metrics(gen_assignments, max_gen)

    # Report
    print("\n--- Proliferation Metrics ---")
    print(f"  Division Index:      {metrics['division_index']:.3f}")
    print(f"    (Average # divisions of all original cells)")
    print(f"  Proliferation Index: {metrics['proliferation_index']:.3f}")
    print(f"    (Average # divisions of responding cells only)")
    print(f"  Percent Divided:     {metrics['percent_divided']:.1f}%")
    print(f"    (Fraction of precursors that divided at least once)")

    print("\n--- Generation Distribution ---")
    print(f"  {'Gen':<6} {'Events':>10} {'Precursors':>12} {'% of Total':>12}")
    print("  " + "-" * 42)
    total = metrics["total_assigned"]
    for gen in sorted(metrics["generation_counts"].keys()):
        count = metrics["generation_counts"][gen]
        precursor = metrics["precursor_counts"].get(gen, 0)
        pct = count / total * 100 if total > 0 else 0
        print(f"  {gen:<6} {count:>10,} {precursor:>12.1f} {pct:>11.1f}%")
    print(f"  {'Unassigned':<6} {metrics['total_unassigned']:>10,}")

    # Save generation counts CSV
    gen_csv = output_dir / "generation_counts.csv"
    rows = []
    for gen in sorted(metrics["generation_counts"].keys()):
        rows.append({
            "generation": gen,
            "event_count": metrics["generation_counts"][gen],
            "precursor_count": metrics["precursor_counts"].get(gen, 0),
            "pct_of_total": round(
                metrics["generation_counts"][gen] / total * 100 if total > 0 else 0, 2
            ),
        })
    pd.DataFrame(rows).to_csv(gen_csv, index=False)
    print(f"\nGeneration counts saved to: {gen_csv}")

    # Save metrics CSV
    metrics_csv = output_dir / "proliferation_metrics.csv"
    pd.DataFrame([{
        "division_index": metrics["division_index"],
        "proliferation_index": metrics["proliferation_index"],
        "percent_divided": metrics["percent_divided"],
        "generations_detected": n_peaks,
        "total_events_assigned": metrics["total_assigned"],
        "total_events_unassigned": metrics["total_unassigned"],
    }]).to_csv(metrics_csv, index=False)
    print(f"Proliferation metrics saved to: {metrics_csv}")

    # Save plot
    plot_path = save_proliferation_plot(
        cfse_log, peak_results, gen_assignments, metrics, channel_label, output_dir
    )
    if plot_path:
        print(f"Histogram plot saved to: {plot_path}")


if __name__ == "__main__":
    main()

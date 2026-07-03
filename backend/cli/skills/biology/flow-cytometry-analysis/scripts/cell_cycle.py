#!/usr/bin/env python3
"""
Cell Cycle Analysis from DNA Content (PI Staining) Histograms

Fits a Dean-Jett-Fox model to DNA content histograms to quantify cell cycle
phase distribution. The model consists of two Gaussian peaks (G0/G1 and G2/M)
with a polynomial S-phase component between them.

Dependencies: flowio, numpy, pandas, scipy, matplotlib

Usage:
    python cell_cycle.py --fcs pi_stained.fcs --dna-channel "PI-A" --output-dir cell_cycle/
    python cell_cycle.py --fcs dna_data.csv --dna-channel 0 --output-dir results/
    python cell_cycle.py --fcs sample.fcs --dna-channel "FL2-A"

Examples:
    # Analyze PI-stained sample, channel by name
    python cell_cycle.py --fcs sample.fcs --dna-channel "PI-A" --output-dir analysis/

    # Analyze from CSV export, channel by column index
    python cell_cycle.py --fcs exported_events.csv --dna-channel 5

    # Use a specific channel with auto-detected G1 peak
    python cell_cycle.py --fcs fixed_cells.fcs --dna-channel "FL3-A" --output-dir cycle_results/
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import curve_fit
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


def load_dna_channel(fcs_path, dna_channel):
    """
    Load DNA content data from an FCS file or CSV.

    Parameters:
        fcs_path: Path to FCS or CSV file.
        dna_channel: Channel name (string) or column index (int/string digit).

    Returns:
        Tuple of (dna_values, channel_label) where dna_values is a 1D numpy array.
    """
    path = Path(fcs_path)
    suffix = path.suffix.lower()

    if suffix == ".csv":
        df = pd.read_csv(path)
        if dna_channel.isdigit():
            idx = int(dna_channel)
            if idx >= len(df.columns):
                print(f"ERROR: Column index {idx} out of range (0-{len(df.columns)-1}).", file=sys.stderr)
                sys.exit(1)
            col = df.columns[idx]
        else:
            col = dna_channel
            if col not in df.columns:
                print(f"ERROR: Column '{col}' not found. Available: {list(df.columns)}", file=sys.stderr)
                sys.exit(1)
        return df[col].dropna().values.astype(np.float64), col

    # FCS file
    if flowio is None:
        print("ERROR: flowio is required to read FCS files. Install with: pip install flowio", file=sys.stderr)
        sys.exit(1)

    fdata = flowio.FlowData(str(path))
    n_channels = int(fdata.channel_count)
    channel_names = []
    for i in range(1, n_channels + 1):
        stain = fdata.text.get(f"p{i}s", "").strip()
        name = fdata.text.get(f"p{i}n", f"Ch{i}").strip()
        channel_names.append(stain if stain else name)

    events = np.array(fdata.events, dtype=np.float64).reshape(-1, n_channels)

    if dna_channel.isdigit():
        idx = int(dna_channel)
        if idx >= n_channels:
            print(f"ERROR: Channel index {idx} out of range (0-{n_channels-1}).", file=sys.stderr)
            sys.exit(1)
        label = channel_names[idx]
    else:
        if dna_channel not in channel_names:
            print(f"ERROR: Channel '{dna_channel}' not found. Available: {channel_names}", file=sys.stderr)
            sys.exit(1)
        idx = channel_names.index(dna_channel)
        label = dna_channel

    return events[:, idx], label


def estimate_initial_params(dna_values, n_bins=256):
    """
    Estimate initial parameters for the Dean-Jett-Fox model by detecting
    the G1 and G2 peaks in the histogram.

    Parameters:
        dna_values: 1D array of DNA content values.
        n_bins: Number of histogram bins.

    Returns:
        Dictionary with initial parameter estimates: g1_mean, g1_sigma,
        g1_amp, g2_mean, g2_sigma, g2_amp, s_amp, s_slope.
    """
    # Filter out extreme outliers for robust peak detection
    q01, q99 = np.percentile(dna_values, [1, 99])
    filtered = dna_values[(dna_values >= q01) & (dna_values <= q99)]

    counts, bin_edges = np.histogram(filtered, bins=n_bins)
    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2
    smoothed = np.convolve(counts, np.ones(5) / 5, mode="same")

    # Find peaks with minimum prominence and distance
    peaks, properties = find_peaks(
        smoothed,
        distance=n_bins // 8,
        prominence=max(smoothed) * 0.05,
        height=max(smoothed) * 0.02,
    )

    if len(peaks) == 0:
        # Fallback: use histogram maximum as G1
        g1_idx = np.argmax(smoothed)
        g1_mean = bin_centers[g1_idx]
        g2_mean = g1_mean * 2.0
    elif len(peaks) == 1:
        g1_mean = bin_centers[peaks[0]]
        g2_mean = g1_mean * 2.0
    else:
        # Sort peaks by height, take the two largest
        sorted_peaks = peaks[np.argsort(smoothed[peaks])[::-1]]
        p1, p2 = sorted(sorted_peaks[:2])
        g1_mean = bin_centers[p1]
        g2_mean = bin_centers[p2]

        # Verify G2 is approximately 2x G1 — if not, adjust
        ratio = g2_mean / g1_mean if g1_mean > 0 else 0
        if ratio < 1.5 or ratio > 2.5:
            g2_mean = g1_mean * 2.0

    # Estimate widths from the G1 peak region
    g1_region = filtered[(filtered > g1_mean * 0.8) & (filtered < g1_mean * 1.2)]
    g1_sigma = np.std(g1_region) if len(g1_region) > 10 else g1_mean * 0.05

    g1_amp = np.max(smoothed)
    g2_amp = g1_amp * 0.3
    g2_sigma = g1_sigma * 1.2

    return {
        "g1_mean": g1_mean,
        "g1_sigma": max(g1_sigma, 1.0),
        "g1_amp": g1_amp,
        "g2_mean": g2_mean,
        "g2_sigma": max(g2_sigma, 1.0),
        "g2_amp": g2_amp,
        "s_amp": g1_amp * 0.1,
        "s_slope": 0.0,
    }


def dean_jett_fox_model(x, g1_mean, g1_sigma, g1_amp, g2_mean, g2_sigma, g2_amp, s_amp, s_slope):
    """
    Dean-Jett-Fox cell cycle model.

    The model is a sum of:
    - G0/G1 peak: Gaussian centered at g1_mean
    - G2/M peak: Gaussian centered at g2_mean (~2x g1_mean)
    - S phase: broadened distribution between G1 and G2, modeled as a
      truncated polynomial

    Parameters:
        x: Histogram bin centers.
        g1_mean, g1_sigma, g1_amp: G0/G1 Gaussian parameters.
        g2_mean, g2_sigma, g2_amp: G2/M Gaussian parameters.
        s_amp: S-phase amplitude.
        s_slope: S-phase linear slope component.

    Returns:
        Model values at each x.
    """
    # G0/G1 Gaussian
    g1 = g1_amp * np.exp(-0.5 * ((x - g1_mean) / g1_sigma) ** 2)

    # G2/M Gaussian
    g2 = g2_amp * np.exp(-0.5 * ((x - g2_mean) / g2_sigma) ** 2)

    # S phase: broadened distribution between G1 and G2 peaks
    s_region = np.zeros_like(x)
    s_left = g1_mean + g1_sigma
    s_right = g2_mean - g2_sigma
    if s_right > s_left:
        in_s = (x >= s_left) & (x <= s_right)
        t = (x[in_s] - s_left) / (s_right - s_left)  # 0 to 1
        s_region[in_s] = s_amp * (1.0 + s_slope * (t - 0.5))

    return g1 + g2 + s_region


def fit_cell_cycle(dna_values, n_bins=256):
    """
    Fit the Dean-Jett-Fox model to DNA content data.

    Parameters:
        dna_values: 1D array of DNA content values.
        n_bins: Number of histogram bins.

    Returns:
        Dictionary with fit results: parameters, phase fractions, histogram
        data, and fitted curves.
    """
    # Filter outliers
    q01, q99 = np.percentile(dna_values, [1, 99])
    filtered = dna_values[(dna_values >= q01) & (dna_values <= q99)]

    counts, bin_edges = np.histogram(filtered, bins=n_bins)
    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2
    bin_width = bin_edges[1] - bin_edges[0]

    # Normalize counts for fitting
    counts_float = counts.astype(np.float64)

    # Estimate initial parameters
    p0 = estimate_initial_params(filtered, n_bins)
    init = [
        p0["g1_mean"], p0["g1_sigma"], p0["g1_amp"],
        p0["g2_mean"], p0["g2_sigma"], p0["g2_amp"],
        p0["s_amp"], p0["s_slope"],
    ]

    # Parameter bounds
    x_min, x_max = bin_centers[0], bin_centers[-1]
    x_range = x_max - x_min
    max_amp = np.max(counts_float) * 3

    lower = [x_min, 0.5, 0, x_min, 0.5, 0, 0, -5]
    upper = [x_max, x_range * 0.3, max_amp, x_max, x_range * 0.3, max_amp, max_amp, 5]

    try:
        popt, pcov = curve_fit(
            dean_jett_fox_model,
            bin_centers,
            counts_float,
            p0=init,
            bounds=(lower, upper),
            maxfev=20000,
        )
    except RuntimeError as exc:
        print(f"WARNING: Curve fitting did not converge: {exc}", file=sys.stderr)
        print("Using initial parameter estimates.", file=sys.stderr)
        popt = np.array(init)
        pcov = None

    g1_mean, g1_sigma, g1_amp, g2_mean, g2_sigma, g2_amp, s_amp, s_slope = popt

    # Compute individual phase curves
    fitted_total = dean_jett_fox_model(bin_centers, *popt)
    g1_curve = g1_amp * np.exp(-0.5 * ((bin_centers - g1_mean) / g1_sigma) ** 2)
    g2_curve = g2_amp * np.exp(-0.5 * ((bin_centers - g2_mean) / g2_sigma) ** 2)
    s_curve = fitted_total - g1_curve - g2_curve
    s_curve = np.maximum(s_curve, 0)

    # Integrate areas for phase fractions
    g1_area = np.sum(g1_curve) * bin_width
    g2_area = np.sum(g2_curve) * bin_width
    s_area = np.sum(s_curve) * bin_width
    total_area = g1_area + g2_area + s_area

    if total_area > 0:
        pct_g1 = g1_area / total_area * 100
        pct_s = s_area / total_area * 100
        pct_g2m = g2_area / total_area * 100
    else:
        pct_g1 = pct_s = pct_g2m = 0.0

    g2_g1_ratio = g2_mean / g1_mean if g1_mean > 0 else float("nan")

    return {
        "params": {
            "g1_mean": g1_mean,
            "g1_sigma": g1_sigma,
            "g1_amp": g1_amp,
            "g2_mean": g2_mean,
            "g2_sigma": g2_sigma,
            "g2_amp": g2_amp,
            "s_amp": s_amp,
            "s_slope": s_slope,
        },
        "phases": {
            "pct_g0_g1": round(pct_g1, 2),
            "pct_s": round(pct_s, 2),
            "pct_g2_m": round(pct_g2m, 2),
        },
        "g1_peak_position": round(g1_mean, 2),
        "g2_g1_ratio": round(g2_g1_ratio, 4),
        "total_events": len(dna_values),
        "filtered_events": len(filtered),
        "histogram": {
            "bin_centers": bin_centers,
            "counts": counts_float,
            "fitted_total": fitted_total,
            "g1_curve": g1_curve,
            "g2_curve": g2_curve,
            "s_curve": s_curve,
        },
        "converged": pcov is not None,
    }


def save_histogram_plot(results, channel_label, output_dir):
    """
    Save a histogram plot with fitted Dean-Jett-Fox model curves.

    Parameters:
        results: Dictionary from fit_cell_cycle().
        channel_label: Name of the DNA channel for axis labeling.
        output_dir: Output directory.

    Returns:
        Path to the saved plot.
    """
    if plt is None:
        print("WARNING: matplotlib not available, skipping plot.", file=sys.stderr)
        return None

    hist = results["histogram"]
    phases = results["phases"]

    fig, ax = plt.subplots(figsize=(10, 6))

    # Data histogram
    ax.bar(
        hist["bin_centers"],
        hist["counts"],
        width=hist["bin_centers"][1] - hist["bin_centers"][0],
        alpha=0.4,
        color="gray",
        label="Data",
    )

    # Fitted curves
    ax.plot(hist["bin_centers"], hist["fitted_total"], "k-", linewidth=2, label="Total fit")
    ax.fill_between(
        hist["bin_centers"], hist["g1_curve"], alpha=0.3, color="blue",
        label=f"G0/G1 ({phases['pct_g0_g1']:.1f}%)",
    )
    ax.fill_between(
        hist["bin_centers"], hist["s_curve"], alpha=0.3, color="green",
        label=f"S ({phases['pct_s']:.1f}%)",
    )
    ax.fill_between(
        hist["bin_centers"], hist["g2_curve"], alpha=0.3, color="red",
        label=f"G2/M ({phases['pct_g2_m']:.1f}%)",
    )

    ax.set_xlabel(f"DNA Content ({channel_label})", fontsize=12)
    ax.set_ylabel("Event Count", fontsize=12)
    ax.set_title("Cell Cycle Analysis — Dean-Jett-Fox Model", fontsize=14)
    ax.legend(fontsize=10, loc="upper right")

    # Annotation box with results
    text = (
        f"G0/G1: {phases['pct_g0_g1']:.1f}%\n"
        f"S: {phases['pct_s']:.1f}%\n"
        f"G2/M: {phases['pct_g2_m']:.1f}%\n"
        f"G1 peak: {results['g1_peak_position']:.1f}\n"
        f"G2/G1 ratio: {results['g2_g1_ratio']:.3f}"
    )
    ax.text(
        0.98, 0.55, text, transform=ax.transAxes,
        fontsize=9, verticalalignment="top", horizontalalignment="right",
        bbox=dict(boxstyle="round,pad=0.4", facecolor="white", alpha=0.8),
    )

    plt.tight_layout()
    plot_path = Path(output_dir) / "cell_cycle_histogram.png"
    fig.savefig(plot_path, dpi=150)
    plt.close(fig)
    return plot_path


def main():
    parser = argparse.ArgumentParser(
        description="Cell cycle analysis from DNA content (PI staining) histograms."
    )
    parser.add_argument(
        "--fcs",
        type=str,
        required=True,
        help="Path to FCS file or CSV with DNA content data.",
    )
    parser.add_argument(
        "--dna-channel",
        type=str,
        required=True,
        help="DNA content channel name (e.g. 'PI-A') or column index (e.g. '5').",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="cell_cycle_output",
        help="Output directory (default: cell_cycle_output).",
    )

    args = parser.parse_args()

    fcs_path = Path(args.fcs)
    if not fcs_path.is_file():
        print(f"ERROR: File not found: {fcs_path}", file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load DNA channel data
    print(f"Loading DNA content data from: {fcs_path}")
    dna_values, channel_label = load_dna_channel(fcs_path, args.dna_channel)
    print(f"  Channel: {channel_label}")
    print(f"  Events: {len(dna_values):,}")
    print(f"  Range: [{dna_values.min():.1f}, {dna_values.max():.1f}]")
    print(f"  Median: {np.median(dna_values):.1f}")

    # Fit model
    print("\nFitting Dean-Jett-Fox cell cycle model...")
    results = fit_cell_cycle(dna_values)

    # Report results
    phases = results["phases"]
    print("\n--- Cell Cycle Phase Distribution ---")
    print(f"  G0/G1:  {phases['pct_g0_g1']:6.1f}%")
    print(f"  S:      {phases['pct_s']:6.1f}%")
    print(f"  G2/M:   {phases['pct_g2_m']:6.1f}%")
    print(f"\n  G1 peak position:  {results['g1_peak_position']:.2f}")
    print(f"  G2/G1 ratio:       {results['g2_g1_ratio']:.4f}")
    print(f"  Model converged:   {'Yes' if results['converged'] else 'No (used initial estimates)'}")
    print(f"  Events analyzed:   {results['filtered_events']:,} / {results['total_events']:,}")

    # Save results CSV
    results_csv = output_dir / "cell_cycle_results.csv"
    df_results = pd.DataFrame([{
        "phase": "G0/G1",
        "percentage": phases["pct_g0_g1"],
    }, {
        "phase": "S",
        "percentage": phases["pct_s"],
    }, {
        "phase": "G2/M",
        "percentage": phases["pct_g2_m"],
    }])
    df_results.to_csv(results_csv, index=False)
    print(f"\nPhase distribution saved to: {results_csv}")

    # Save parameters
    params_csv = output_dir / "model_parameters.csv"
    params = results["params"]
    params["g2_g1_ratio"] = results["g2_g1_ratio"]
    params["converged"] = results["converged"]
    df_params = pd.DataFrame([params])
    df_params.to_csv(params_csv, index=False)
    print(f"Model parameters saved to: {params_csv}")

    # Save plot
    plot_path = save_histogram_plot(results, channel_label, output_dir)
    if plot_path:
        print(f"Histogram plot saved to: {plot_path}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Antibody titer analysis from serial dilution ELISA data.

Determines endpoint titers from serial dilution ELISA plates by finding
the highest dilution at which the OD exceeds a cutoff threshold. Cutoff
can be calculated from negative controls (mean + 3*SD) or provided as
a fixed value. Reports geometric mean titer (GMT) across all samples.

Usage:
    python antibody_titer.py --data dilution_data.csv --output-dir results/

Examples:
    # Auto-calculate cutoff from negative control (sample_id = 'negative')
    python antibody_titer.py --data serial_dilution.csv --output-dir titer_output

    # Fixed cutoff OD value
    python antibody_titer.py --data serial_dilution.csv --cutoff-method fixed --cutoff-value 0.2

    # CSV must have columns: dilution, od450, sample_id
    # Include negative control samples with sample_id = 'negative'
"""

import argparse
import os
import sys

import numpy as np
import pandas as pd


def validate_data(df):
    """Validate input dataframe has required columns and sensible values.

    Parameters
    ----------
    df : pd.DataFrame
        Input data.

    Returns
    -------
    pd.DataFrame
        Validated and cleaned dataframe.

    Raises
    ------
    ValueError
        If required columns are missing or data is invalid.
    """
    required = {"dilution", "od450", "sample_id"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Missing required columns: {missing}")

    df = df.copy()
    df["sample_id"] = df["sample_id"].astype(str).str.strip()
    df["dilution"] = pd.to_numeric(df["dilution"], errors="coerce")
    df["od450"] = pd.to_numeric(df["od450"], errors="coerce")

    n_before = len(df)
    df = df.dropna(subset=["dilution", "od450"])
    n_dropped = n_before - len(df)
    if n_dropped > 0:
        print(f"WARNING: Dropped {n_dropped} rows with non-numeric dilution/od450 values.")

    if (df["dilution"] <= 0).any():
        raise ValueError("All dilution values must be > 0.")

    return df


def calculate_cutoff(df, method, fixed_value=None):
    """Determine the OD cutoff for endpoint titer calculation.

    Parameters
    ----------
    df : pd.DataFrame
        Full dataset (must include negative controls for 'mean_plus_3sd').
    method : str
        'mean_plus_3sd' or 'fixed'.
    fixed_value : float or None
        Required if method is 'fixed'.

    Returns
    -------
    float
        OD cutoff value.

    Raises
    ------
    ValueError
        If negative controls are missing for mean_plus_3sd or fixed_value not provided.
    """
    if method == "fixed":
        if fixed_value is None:
            raise ValueError("--cutoff-value is required when --cutoff-method is 'fixed'")
        return float(fixed_value)

    negatives = df[df["sample_id"].str.lower() == "negative"]
    if negatives.empty:
        raise ValueError(
            "No negative control samples found (sample_id = 'negative'). "
            "Provide negative controls or use --cutoff-method fixed --cutoff-value <value>."
        )

    neg_mean = negatives["od450"].mean()
    neg_sd = negatives["od450"].std(ddof=1) if len(negatives) > 1 else 0.0
    cutoff = neg_mean + 3.0 * neg_sd

    print(f"Negative control OD: mean={neg_mean:.4f}, SD={neg_sd:.4f}")
    print(f"Cutoff (mean + 3*SD): {cutoff:.4f}")

    return cutoff


def determine_endpoint_titer(sample_data, cutoff):
    """Find the endpoint titer for a single sample.

    Endpoint titer is the highest dilution where OD > cutoff.

    Parameters
    ----------
    sample_data : pd.DataFrame
        Data for one sample with 'dilution' and 'od450' columns.
    cutoff : float
        OD cutoff threshold.

    Returns
    -------
    float or None
        Endpoint titer (dilution value), or None if no dilution exceeds cutoff.
    """
    sorted_data = sample_data.sort_values("dilution", ascending=True)

    above_cutoff = sorted_data[sorted_data["od450"] > cutoff]

    if above_cutoff.empty:
        return None

    return above_cutoff["dilution"].max()


def calculate_gmt(titers):
    """Calculate geometric mean titer from a list of titers.

    Excludes None/NaN values. Returns NaN if no valid titers.

    Parameters
    ----------
    titers : list of float or None
        Endpoint titers for each sample.

    Returns
    -------
    float
        Geometric mean titer.
    """
    valid = [t for t in titers if t is not None and not np.isnan(t) and t > 0]
    if not valid:
        return float("nan")

    log_titers = np.log10(valid)
    return 10 ** np.mean(log_titers)


def save_titration_plot(df, sample_titers, cutoff, output_path):
    """Save titration curves for all samples.

    Parameters
    ----------
    df : pd.DataFrame
        Full dataset.
    sample_titers : dict
        Mapping sample_id -> endpoint titer.
    cutoff : float
        OD cutoff value (drawn as horizontal line).
    output_path : str
        Path for saving PNG plot.
    """
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    samples = [s for s in df["sample_id"].unique() if s.lower() != "negative"]

    if not samples:
        print("WARNING: No non-negative samples to plot.")
        return

    n_samples = len(samples)
    colors = plt.cm.tab10(np.linspace(0, 1, min(n_samples, 10)))

    fig, ax = plt.subplots(figsize=(10, 6))

    for idx, sample_id in enumerate(sorted(samples)):
        sdata = df[df["sample_id"] == sample_id].sort_values("dilution")
        color = colors[idx % len(colors)]
        titer = sample_titers.get(sample_id)
        label = f"{sample_id} (titer: {titer:.0f})" if titer else f"{sample_id} (< LOD)"
        ax.plot(
            sdata["dilution"],
            sdata["od450"],
            "o-",
            color=color,
            label=label,
            markersize=5,
            linewidth=1.5,
        )

    ax.axhline(y=cutoff, color="red", linestyle="--", linewidth=1.5, label=f"Cutoff ({cutoff:.4f})")

    ax.set_xscale("log")
    ax.set_xlabel("Dilution Factor", fontsize=12)
    ax.set_ylabel("OD450", fontsize=12)
    ax.set_title("Antibody Titration Curves", fontsize=14)
    ax.legend(fontsize=8, loc="best", ncol=max(1, n_samples // 8))
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150)
    plt.close(fig)
    print(f"Titration plot saved: {output_path}")


def save_titers_csv(sample_titers, gmt, output_path):
    """Save endpoint titers to CSV file.

    Parameters
    ----------
    sample_titers : dict
        Mapping sample_id -> titer (float or None).
    gmt : float
        Geometric mean titer.
    output_path : str
        Path for CSV output.
    """
    rows = []
    for sample_id, titer in sorted(sample_titers.items()):
        rows.append({
            "sample_id": sample_id,
            "endpoint_titer": titer if titer is not None else "< LOD",
            "log10_titer": np.log10(titer) if titer and titer > 0 else "",
        })

    rows.append({
        "sample_id": "GMT",
        "endpoint_titer": f"{gmt:.2f}" if not np.isnan(gmt) else "N/A",
        "log10_titer": f"{np.log10(gmt):.4f}" if not np.isnan(gmt) and gmt > 0 else "",
    })

    result_df = pd.DataFrame(rows)
    result_df.to_csv(output_path, index=False)
    print(f"Titers CSV saved: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Antibody titer analysis from serial dilution ELISA."
    )
    parser.add_argument(
        "--data",
        required=True,
        help="CSV with columns: dilution, od450, sample_id. Include 'negative' sample_id for controls.",
    )
    parser.add_argument(
        "--cutoff-method",
        choices=["mean_plus_3sd", "fixed"],
        default="mean_plus_3sd",
        help="Method for determining OD cutoff (default: mean_plus_3sd).",
    )
    parser.add_argument(
        "--cutoff-value",
        type=float,
        default=None,
        help="Fixed OD cutoff value (required if --cutoff-method is 'fixed').",
    )
    parser.add_argument(
        "--output-dir",
        default="titer_output",
        help="Output directory (default: titer_output).",
    )
    args = parser.parse_args()

    if not os.path.isfile(args.data):
        print(f"ERROR: Data file not found: {args.data}", file=sys.stderr)
        sys.exit(1)

    df = pd.read_csv(args.data)

    try:
        df = validate_data(df)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)

    print("=" * 60)
    print("ANTIBODY TITER ANALYSIS")
    print("=" * 60)
    print(f"Input file: {args.data}")

    all_samples = df["sample_id"].unique()
    test_samples = [s for s in all_samples if s.lower() != "negative"]
    n_neg = sum(1 for s in all_samples if s.lower() == "negative")

    print(f"Total samples: {len(all_samples)} ({len(test_samples)} test, {n_neg} negative control IDs)")
    print(f"Total data points: {len(df)}")
    print(f"Dilution range: {df['dilution'].min():.0f} - {df['dilution'].max():.0f}")

    try:
        cutoff = calculate_cutoff(df, args.cutoff_method, args.cutoff_value)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"\nCutoff method: {args.cutoff_method}")
    print(f"OD cutoff: {cutoff:.4f}")

    sample_titers = {}
    print(f"\n{'Sample':<20} {'Titer':<15} {'Log10 Titer':<15}")
    print("-" * 50)

    for sample_id in sorted(test_samples):
        sdata = df[df["sample_id"] == sample_id]
        titer = determine_endpoint_titer(sdata, cutoff)
        sample_titers[sample_id] = titer

        if titer is not None:
            print(f"{sample_id:<20} {titer:<15.0f} {np.log10(titer):<15.4f}")
        else:
            print(f"{sample_id:<20} {'< LOD':<15} {'N/A':<15}")

    valid_titers = [t for t in sample_titers.values() if t is not None]
    gmt = calculate_gmt(valid_titers)

    print("-" * 50)
    if not np.isnan(gmt):
        print(f"{'GMT':<20} {gmt:<15.2f} {np.log10(gmt):<15.4f}")
    else:
        print(f"{'GMT':<20} {'N/A':<15} {'N/A':<15}")

    n_valid = len(valid_titers)
    n_below = len(test_samples) - n_valid
    print(f"\nSamples with titer: {n_valid}/{len(test_samples)}")
    if n_below > 0:
        print(f"Samples below LOD: {n_below}")

    plot_path = os.path.join(args.output_dir, "titration_curves.png")
    save_titration_plot(df, sample_titers, cutoff, plot_path)

    csv_path = os.path.join(args.output_dir, "titers.csv")
    save_titers_csv(sample_titers, gmt, csv_path)

    print("\n" + "=" * 60)
    print("TITER ANALYSIS COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    main()

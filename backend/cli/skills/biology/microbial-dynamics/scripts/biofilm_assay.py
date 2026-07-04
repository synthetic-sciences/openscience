#!/usr/bin/env python3
"""
Crystal violet biofilm quantification from microplate reader data.

Processes OD570 absorbance readings from crystal-violet-stained biofilm
assays, subtracts blank values, classifies biofilm formation strength
per condition, and generates summary statistics with bar plots.

Classification scheme (O'Toole, 2011):
    ODc = mean(blank) + 3 * SD(blank)
    - No biofilm:   OD <= ODc
    - Weak:         ODc < OD <= 2*ODc
    - Moderate:     2*ODc < OD <= 4*ODc
    - Strong:       OD > 4*ODc

Usage:
    python biofilm_assay.py --data biofilm_data.csv --output-dir results/
    python biofilm_assay.py --data biofilm_data.csv --blank 0.05 --output-dir results/

Examples:
    # Auto-detect blank from rows where condition == 'blank'
    python biofilm_assay.py --data plate_data.csv --output-dir ./out

    # Manually specify blank OD value
    python biofilm_assay.py --data plate_data.csv --blank 0.042 --output-dir ./out

Dependencies: numpy, pandas, matplotlib
"""

import argparse
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Data loading and blank subtraction
# ---------------------------------------------------------------------------

def load_data(path):
    """
    Load biofilm assay CSV.

    Expected columns:
    - well:      well identifier (e.g. A1, B2)
    - condition: experimental condition / group name
    - od570:     OD570 absorbance reading

    Returns DataFrame with lowered column names.
    """
    df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]

    required = {"well", "condition", "od570"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Missing required columns: {missing}")

    df["od570"] = pd.to_numeric(df["od570"], errors="coerce")
    if df["od570"].isna().any():
        n_bad = df["od570"].isna().sum()
        print(f"WARNING: {n_bad} non-numeric OD570 values dropped.", file=sys.stderr)
        df = df.dropna(subset=["od570"])

    df["condition"] = df["condition"].astype(str).str.strip()
    return df


def compute_blank_stats(df, manual_blank=None):
    """
    Determine blank OD statistics.

    If manual_blank is provided, use it directly with SD=0.
    Otherwise look for rows where condition matches 'blank' (case-insensitive).

    Returns (blank_mean, blank_sd, blank_n).
    """
    if manual_blank is not None:
        return manual_blank, 0.0, 0

    blank_mask = df["condition"].str.lower() == "blank"
    blanks = df.loc[blank_mask, "od570"]

    if len(blanks) == 0:
        raise ValueError(
            "No 'blank' condition found in data.  "
            "Either add rows with condition='blank' or use --blank."
        )

    return float(blanks.mean()), float(blanks.std(ddof=1)) if len(blanks) > 1 else 0.0, len(blanks)


def subtract_blank(df, blank_mean):
    """Subtract blank OD from all readings; floor at 0."""
    df = df.copy()
    df["od570_corrected"] = (df["od570"] - blank_mean).clip(lower=0.0)
    return df


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def classify_biofilm(od, odc):
    """
    Classify a single corrected OD value.

    ODc = mean(blank) + 3*SD(blank)
    """
    if od <= odc:
        return "none"
    elif od <= 2 * odc:
        return "weak"
    elif od <= 4 * odc:
        return "moderate"
    else:
        return "strong"


def summarize_conditions(df, odc):
    """
    Group by condition, compute mean/SEM, classify.

    Returns DataFrame with columns:
    condition, n, mean_od570, sem, classification
    """
    # Exclude blank rows from summary
    df_exp = df[df["condition"].str.lower() != "blank"].copy()

    groups = df_exp.groupby("condition")["od570_corrected"]
    summary = groups.agg(["count", "mean", "std", "sem"]).reset_index()
    summary.columns = ["condition", "n", "mean_od570", "std", "sem"]

    # Fill NaN SEM when n=1
    summary["sem"] = summary["sem"].fillna(0.0)
    summary["std"] = summary["std"].fillna(0.0)

    summary["classification"] = summary["mean_od570"].apply(
        lambda x: classify_biofilm(x, odc)
    )

    # Sort by mean OD descending
    summary = summary.sort_values("mean_od570", ascending=False).reset_index(drop=True)
    return summary


# ---------------------------------------------------------------------------
# Plotting
# ---------------------------------------------------------------------------

CLASSIFICATION_COLORS = {
    "none": "#bdbdbd",
    "weak": "#fdd835",
    "moderate": "#fb8c00",
    "strong": "#e53935",
}


def plot_bar(summary, odc, output_dir):
    """Bar plot of corrected OD570 with error bars, colored by classification."""
    fig, ax = plt.subplots(figsize=(max(6, len(summary) * 0.8), 5))

    x = np.arange(len(summary))
    colors = [CLASSIFICATION_COLORS.get(c, "#999") for c in summary["classification"]]

    bars = ax.bar(
        x,
        summary["mean_od570"],
        yerr=summary["sem"],
        capsize=4,
        color=colors,
        edgecolor="black",
        linewidth=0.5,
    )

    # ODc reference lines
    ax.axhline(odc, color="gray", linestyle="--", linewidth=1, label=f"ODc = {odc:.4f}")
    ax.axhline(2 * odc, color="gray", linestyle=":", linewidth=0.8, label=f"2x ODc")
    ax.axhline(4 * odc, color="gray", linestyle="-.", linewidth=0.8, label=f"4x ODc")

    ax.set_xticks(x)
    ax.set_xticklabels(summary["condition"], rotation=45, ha="right", fontsize=9)
    ax.set_ylabel("Corrected OD570")
    ax.set_title("Crystal Violet Biofilm Assay")
    ax.legend(fontsize=8, loc="upper right")
    ax.grid(True, axis="y", alpha=0.3)
    fig.tight_layout()

    path = output_dir / "biofilm_barplot.png"
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def save_summary_csv(summary, odc, blank_mean, blank_sd, output_dir):
    """Save summary table and parameters to CSV."""
    # Add ODc info as metadata rows
    meta = pd.DataFrame([
        {"condition": "__blank_mean__", "n": 0, "mean_od570": blank_mean,
         "std": blank_sd, "sem": 0, "classification": ""},
        {"condition": "__ODc__", "n": 0, "mean_od570": odc,
         "std": 0, "sem": 0, "classification": ""},
    ])
    combined = pd.concat([summary, meta], ignore_index=True)
    path = output_dir / "biofilm_summary.csv"
    combined.to_csv(path, index=False)
    return path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Crystal violet biofilm quantification."
    )
    parser.add_argument(
        "--data",
        required=True,
        help="CSV file with columns: well, condition, od570.",
    )
    parser.add_argument(
        "--blank",
        type=float,
        default=None,
        help="Manual blank OD570 value (default: auto from 'blank' condition).",
    )
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Directory for output files (default: current directory).",
    )
    args = parser.parse_args()

    data_path = Path(args.data)
    if not data_path.exists():
        print(f"ERROR: Data file not found: {data_path}", file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load data
    df = load_data(data_path)
    n_wells = len(df)
    conditions = df["condition"].nunique()
    print(f"Loaded {n_wells} wells across {conditions} conditions.")

    # Blank determination
    blank_mean, blank_sd, blank_n = compute_blank_stats(df, args.blank)
    odc = blank_mean + 3.0 * blank_sd  # cutoff for biofilm classification
    if args.blank is not None:
        print(f"Manual blank OD:   {blank_mean:.4f}")
        print(f"ODc (cutoff):      {odc:.4f}  (= blank, SD=0 assumed)")
    else:
        print(f"Blank wells (n={blank_n}): mean = {blank_mean:.4f}, SD = {blank_sd:.4f}")
        print(f"ODc (cutoff):      {odc:.4f}  (= mean + 3*SD)")

    print(f"Classification thresholds:")
    print(f"  No biofilm:  OD <= {odc:.4f}")
    print(f"  Weak:        {odc:.4f} < OD <= {2*odc:.4f}")
    print(f"  Moderate:    {2*odc:.4f} < OD <= {4*odc:.4f}")
    print(f"  Strong:      OD > {4*odc:.4f}")

    # Blank subtraction
    df = subtract_blank(df, blank_mean)

    # Summarize
    summary = summarize_conditions(df, odc)

    print(f"\n{'Condition':<25s} {'n':>3s} {'Mean OD570':>10s} {'SEM':>8s} {'Class':>10s}")
    print("-" * 60)
    for _, row in summary.iterrows():
        print(
            f"{row['condition']:<25s} {int(row['n']):>3d} "
            f"{row['mean_od570']:>10.4f} {row['sem']:>8.4f} "
            f"{row['classification']:>10s}"
        )

    # Count by classification
    print("\nSummary by classification:")
    for cls in ["strong", "moderate", "weak", "none"]:
        n = (summary["classification"] == cls).sum()
        if n > 0:
            names = ", ".join(summary.loc[summary["classification"] == cls, "condition"])
            print(f"  {cls.upper():>10s}: {n} condition(s) — {names}")

    # Save outputs
    plot_path = plot_bar(summary, odc, output_dir)
    csv_path = save_summary_csv(summary, odc, blank_mean, blank_sd, output_dir)

    print(f"\nBar plot saved to:   {plot_path}")
    print(f"Summary CSV saved:   {csv_path}")


if __name__ == "__main__":
    main()

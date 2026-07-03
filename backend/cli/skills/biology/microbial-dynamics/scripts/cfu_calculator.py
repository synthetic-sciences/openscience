#!/usr/bin/env python3
"""
CFU enumeration from serial dilution plating data.

Calculates colony-forming units per mL (CFU/mL) from colony counts at
multiple dilution levels.  Applies the standard countable range filter
(30-300 colonies), computes a weighted average across dilutions, and
reports 95% confidence intervals using Poisson-based statistics.

Usage:
    python cfu_calculator.py --counts "156,42,4" --dilutions "1e-4,1e-5,1e-6" --output-dir results/
    python cfu_calculator.py --counts "280,32,3" --dilutions "1e-4,1e-5,1e-6" --volume-ml 0.1 --output-dir results/

Examples:
    # Standard serial dilution with 0.1 mL plating volume
    python cfu_calculator.py \\
        --counts "245,28,3" --dilutions "1e-4,1e-5,1e-6" --output-dir ./out

    # Triplicate plates at each dilution
    python cfu_calculator.py \\
        --counts "180,195,170,22,18,25,3,2,1" \\
        --dilutions "1e-4,1e-4,1e-4,1e-5,1e-5,1e-5,1e-6,1e-6,1e-6" \\
        --replicates 3 --output-dir ./out

    # Spread plating with 0.2 mL volume
    python cfu_calculator.py \\
        --counts "120,15" --dilutions "1e-5,1e-6" --volume-ml 0.2 --output-dir ./out

Dependencies: numpy, pandas, matplotlib
"""

import argparse
import math
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

COUNTABLE_LOW = 30
COUNTABLE_HIGH = 300


# ---------------------------------------------------------------------------
# Core calculations
# ---------------------------------------------------------------------------

def parse_list(s, dtype=float):
    """Parse a comma-separated string into a list."""
    return [dtype(x.strip()) for x in s.split(",")]


def compute_cfu_per_ml(count, dilution, volume_ml):
    """
    CFU/mL = count / (dilution_factor * volume_mL)

    Parameters
    ----------
    count : int or float    – colony count on the plate
    dilution : float        – dilution factor (e.g. 1e-5)
    volume_ml : float       – volume plated in mL

    Returns
    -------
    cfu : float – estimated CFU/mL
    """
    if dilution <= 0 or volume_ml <= 0:
        return float("nan")
    return count / (dilution * volume_ml)


def poisson_ci(count, confidence=0.95):
    """
    95% confidence interval for a Poisson-distributed count.

    Uses the normal approximation:  count +/- z * sqrt(count)
    where z = 1.96 for 95% CI.

    For low counts (<20), uses exact Poisson limits via chi-square
    approximation:
        lower = chi2.ppf(alpha/2, 2*count) / 2
        upper = chi2.ppf(1 - alpha/2, 2*(count+1)) / 2

    Returns (lower_count, upper_count).
    """
    alpha = 1.0 - confidence

    if count < 20:
        # Exact Poisson CI via chi-squared
        from scipy.stats import chi2
        if count == 0:
            lower = 0.0
            upper = chi2.ppf(1.0 - alpha / 2.0, 2) / 2.0
        else:
            lower = chi2.ppf(alpha / 2.0, 2 * count) / 2.0
            upper = chi2.ppf(1.0 - alpha / 2.0, 2 * (count + 1)) / 2.0
    else:
        z = 1.96
        sq = math.sqrt(count)
        lower = max(0, count - z * sq)
        upper = count + z * sq

    return lower, upper


def cfu_confidence_interval(count, dilution, volume_ml, confidence=0.95):
    """
    Convert Poisson CI on count to CI on CFU/mL.

    Returns (cfu_lower, cfu_upper).
    """
    lo_count, hi_count = poisson_ci(count, confidence)
    cfu_lo = compute_cfu_per_ml(lo_count, dilution, volume_ml)
    cfu_hi = compute_cfu_per_ml(hi_count, dilution, volume_ml)
    return cfu_lo, cfu_hi


def is_countable(count):
    """Check if a count falls in the standard countable range (30-300)."""
    return COUNTABLE_LOW <= count <= COUNTABLE_HIGH


def weighted_average_cfu(plate_data, volume_ml):
    """
    Compute a weighted-average CFU/mL across countable plates.

    Uses the standard method: sum of countable colonies divided by the
    sum of (dilution * volume) for those plates.

    If no plates are countable, falls back to the plate closest to the
    countable range.

    Parameters
    ----------
    plate_data : list of (count, dilution)
    volume_ml : float

    Returns
    -------
    dict with 'cfu_ml', 'ci_lower', 'ci_upper', 'method', 'plates_used'
    """
    countable = [(c, d) for c, d in plate_data if is_countable(c)]

    if not countable:
        # Fallback: use plate closest to geometric mean of countable range
        target = math.sqrt(COUNTABLE_LOW * COUNTABLE_HIGH)
        countable = [min(plate_data, key=lambda x: abs(x[0] - target))]
        method = "fallback (no plates in 30-300 range)"
    else:
        method = "standard (countable plates only)"

    total_count = sum(c for c, d in countable)
    total_dv = sum(d * volume_ml for c, d in countable)

    if total_dv == 0:
        return {"cfu_ml": float("nan"), "ci_lower": float("nan"),
                "ci_upper": float("nan"), "method": method,
                "plates_used": len(countable)}

    cfu_ml = total_count / total_dv

    # Pooled CI: treat total_count as a single Poisson observation
    lo_count, hi_count = poisson_ci(total_count)
    ci_lower = lo_count / total_dv
    ci_upper = hi_count / total_dv

    return {
        "cfu_ml": cfu_ml,
        "ci_lower": ci_lower,
        "ci_upper": ci_upper,
        "method": method,
        "plates_used": len(countable),
    }


def detection_limit(dilutions, volume_ml):
    """
    Lower detection limit: 1 colony at the lowest dilution.

    Upper detection limit: TNTC at the highest dilution (assume 300).
    """
    min_dilution = min(dilutions)
    max_dilution = max(dilutions)
    lower = compute_cfu_per_ml(1, min_dilution, volume_ml)
    upper = compute_cfu_per_ml(COUNTABLE_HIGH, max_dilution, volume_ml)
    return lower, upper


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def format_scientific(value, precision=2):
    """Format a number in scientific notation."""
    if np.isnan(value) or np.isinf(value):
        return str(value)
    exp = int(math.floor(math.log10(abs(value)))) if value != 0 else 0
    mantissa = value / (10 ** exp)
    return f"{mantissa:.{precision}f} x 10^{exp}"


def save_results_csv(plate_results, weighted, output_dir):
    """Save per-plate and aggregate results to CSV."""
    df = pd.DataFrame(plate_results)
    path = output_dir / "cfu_results.csv"
    df.to_csv(path, index=False)

    # Append summary row
    summary = pd.DataFrame([{
        "plate": "WEIGHTED_AVG",
        "count": "",
        "dilution": "",
        "cfu_ml": weighted["cfu_ml"],
        "ci_lower": weighted["ci_lower"],
        "ci_upper": weighted["ci_upper"],
        "countable": "",
        "method": weighted["method"],
    }])
    combined = pd.concat([df, summary], ignore_index=True)
    combined.to_csv(path, index=False)
    return path


def plot_cfu_by_dilution(plate_results, weighted, output_dir):
    """Plot CFU/mL estimates at each dilution level."""
    df = pd.DataFrame(plate_results)
    if df.empty:
        return None

    fig, ax = plt.subplots(figsize=(7, 5))

    # Group by dilution
    grouped = df.groupby("dilution")
    dilutions = sorted(grouped.groups.keys())
    x_labels = [f"{d:.0e}" for d in dilutions]
    x_pos = np.arange(len(dilutions))

    for i, dil in enumerate(dilutions):
        sub = grouped.get_group(dil)
        cfus = sub["cfu_ml"].values
        for j, cfu in enumerate(cfus):
            marker = "o" if sub.iloc[j]["countable"] else "x"
            color = "steelblue" if sub.iloc[j]["countable"] else "gray"
            ax.scatter(i, cfu, marker=marker, color=color, s=60, zorder=3)

    # Weighted average line
    ax.axhline(weighted["cfu_ml"], color="red", linestyle="--", linewidth=1.5,
               label=f"Weighted avg: {format_scientific(weighted['cfu_ml'])}")
    ax.axhspan(weighted["ci_lower"], weighted["ci_upper"], alpha=0.15, color="red",
               label="95% CI")

    ax.set_xticks(x_pos)
    ax.set_xticklabels(x_labels)
    ax.set_xlabel("Dilution Factor")
    ax.set_ylabel("CFU/mL")
    ax.set_yscale("log")
    ax.set_title("CFU Estimates by Dilution")
    ax.legend(fontsize=8, loc="best")
    ax.grid(True, alpha=0.3, which="both")
    fig.tight_layout()

    path = output_dir / "cfu_plot.png"
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="CFU enumeration from serial dilution plating."
    )
    parser.add_argument(
        "--counts",
        required=True,
        help="Comma-separated colony counts (e.g. '156,42,4').",
    )
    parser.add_argument(
        "--dilutions",
        required=True,
        help="Comma-separated dilution factors (e.g. '1e-4,1e-5,1e-6').",
    )
    parser.add_argument(
        "--volume-ml",
        type=float,
        default=0.1,
        help="Plating volume in mL (default: 0.1).",
    )
    parser.add_argument(
        "--replicates",
        type=int,
        default=1,
        help="Number of replicate plates per dilution (default: 1). "
             "Used for informational labelling only; counts and dilutions "
             "should list ALL plates.",
    )
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Directory for output files (default: current directory).",
    )
    args = parser.parse_args()

    counts = parse_list(args.counts, dtype=int)
    dilutions = parse_list(args.dilutions, dtype=float)

    if len(counts) != len(dilutions):
        print(
            f"ERROR: {len(counts)} counts but {len(dilutions)} dilutions. "
            f"Each plate needs both a count and a dilution factor.",
            file=sys.stderr,
        )
        sys.exit(1)

    n_plates = len(counts)
    volume = args.volume_ml

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Plates:        {n_plates}")
    print(f"Volume plated: {volume} mL")
    print(f"Replicates:    {args.replicates}")
    print(f"Countable range: {COUNTABLE_LOW} - {COUNTABLE_HIGH} colonies")

    # Per-plate calculations
    print(f"\n{'Plate':>6s} {'Count':>6s} {'Dilution':>10s} {'CFU/mL':>14s} {'95% CI':>28s} {'OK':>4s}")
    print("-" * 74)

    plate_results = []
    plate_data = list(zip(counts, dilutions))

    for i, (count, dil) in enumerate(plate_data, start=1):
        cfu = compute_cfu_per_ml(count, dil, volume)
        ci_lo, ci_hi = cfu_confidence_interval(count, dil, volume)
        countable = is_countable(count)
        ok_str = "YES" if countable else "no"

        print(
            f"{i:>6d} {count:>6d} {dil:>10.0e} "
            f"{format_scientific(cfu):>14s} "
            f"[{format_scientific(ci_lo):>12s}, {format_scientific(ci_hi):>12s}] "
            f"{ok_str:>4s}"
        )

        plate_results.append({
            "plate": i,
            "count": count,
            "dilution": dil,
            "cfu_ml": cfu,
            "ci_lower": ci_lo,
            "ci_upper": ci_hi,
            "countable": countable,
        })

    # Weighted average
    weighted = weighted_average_cfu(plate_data, volume)

    print(f"\n=== Weighted Average CFU/mL ===")
    print(f"  Method:      {weighted['method']}")
    print(f"  Plates used: {weighted['plates_used']}")
    print(f"  CFU/mL:      {format_scientific(weighted['cfu_ml'])}")
    print(f"  95% CI:      [{format_scientific(weighted['ci_lower'])}, "
          f"{format_scientific(weighted['ci_upper'])}]")

    # Log10 representation
    if weighted["cfu_ml"] > 0:
        log_cfu = math.log10(weighted["cfu_ml"])
        print(f"  log10(CFU/mL): {log_cfu:.2f}")

    # Detection limits
    det_lo, det_hi = detection_limit(dilutions, volume)
    print(f"\n  Detection limit (lower): {format_scientific(det_lo)} CFU/mL  "
          f"(1 colony at lowest dilution)")
    print(f"  Detection limit (upper): {format_scientific(det_hi)} CFU/mL  "
          f"(TNTC = {COUNTABLE_HIGH} at highest dilution)")

    # Countable plate check
    n_countable = sum(1 for c, _ in plate_data if is_countable(c))
    if n_countable == 0:
        print(f"\n  WARNING: No plates fell in the countable range ({COUNTABLE_LOW}-{COUNTABLE_HIGH}).")
        print(f"  Consider adjusting dilution series.")

    # Save outputs
    csv_path = save_results_csv(plate_results, weighted, output_dir)
    plot_path = plot_cfu_by_dilution(plate_results, weighted, output_dir)

    print(f"\nResults CSV:  {csv_path}")
    if plot_path:
        print(f"Plot saved:   {plot_path}")


if __name__ == "__main__":
    main()

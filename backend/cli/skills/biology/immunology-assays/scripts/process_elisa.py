#!/usr/bin/env python3
"""ELISA data processing with 4-parameter logistic (4PL) standard curve fitting.

Reads plate reader CSV data containing standards, unknowns, and blanks.
Fits a 4-parameter logistic model to the standard curve, then interpolates
unknown sample concentrations by inverting the fitted model.

Reports R-squared, limit of detection (LOD = blank + 3*SD),
limit of quantification (LOQ = blank + 10*SD), and all interpolated
concentrations.

Usage:
    python process_elisa.py --data plate_data.csv --output-dir results/

Examples:
    # Basic run with default output directory
    python process_elisa.py --data elisa_plate1.csv

    # Specify output directory
    python process_elisa.py --data elisa_plate1.csv --output-dir ./elisa_results

    # CSV must have columns: well, concentration, od450, sample_type
    # sample_type values: standard, unknown, blank
"""

import argparse
import os
import sys

import numpy as np
import pandas as pd
from scipy.optimize import curve_fit


def four_pl(x, a, b, c, d):
    """4-parameter logistic function.

    y = D + (A - D) / (1 + (x / C)^B)

    Parameters
    ----------
    x : array-like
        Concentration values.
    a : float
        Minimum asymptote (response at zero concentration).
    b : float
        Hill slope (steepness).
    c : float
        EC50 (inflection point concentration).
    d : float
        Maximum asymptote (response at infinite concentration).

    Returns
    -------
    array-like
        Predicted OD values.
    """
    return d + (a - d) / (1.0 + (x / c) ** b)


def inverse_four_pl(y, a, b, c, d):
    """Invert the 4PL to solve for concentration given OD.

    x = C * ((A - D) / (y - D) - 1)^(1/B)

    Returns NaN where the inversion is undefined (y outside [A, D] range).
    """
    y = np.asarray(y, dtype=float)
    ratio = (a - d) / (y - d) - 1.0
    with np.errstate(invalid="ignore", divide="ignore"):
        mask = ratio > 0
        result = np.full_like(y, np.nan)
        result[mask] = c * (ratio[mask] ** (1.0 / b))
    return result


def subtract_blanks(df):
    """Subtract mean blank OD from all readings.

    Parameters
    ----------
    df : pd.DataFrame
        Must contain columns 'od450' and 'sample_type'.

    Returns
    -------
    tuple of (pd.DataFrame, float, float)
        Blank-corrected dataframe, blank mean, blank SD.
    """
    blanks = df.loc[df["sample_type"] == "blank", "od450"]
    if blanks.empty:
        print("WARNING: No blank wells found. Proceeding without blank subtraction.")
        return df.copy(), 0.0, 0.0

    blank_mean = blanks.mean()
    blank_sd = blanks.std(ddof=1) if len(blanks) > 1 else 0.0

    corrected = df.copy()
    corrected["od450_corrected"] = corrected["od450"] - blank_mean
    corrected.loc[corrected["od450_corrected"] < 0, "od450_corrected"] = 0.0

    return corrected, blank_mean, blank_sd


def fit_standard_curve(standards):
    """Fit 4PL model to standard curve data.

    Parameters
    ----------
    standards : pd.DataFrame
        Must contain 'concentration' and 'od450_corrected' columns.
        Concentration must be > 0 for all standard points.

    Returns
    -------
    tuple of (array, float)
        Optimal parameters [a, b, c, d] and R-squared value.

    Raises
    ------
    RuntimeError
        If curve fitting fails to converge.
    """
    conc = standards["concentration"].values.astype(float)
    od = standards["od450_corrected"].values.astype(float)

    mask = conc > 0
    conc = conc[mask]
    od = od[mask]

    if len(conc) < 4:
        raise RuntimeError(
            f"Need at least 4 standard points with concentration > 0, got {len(conc)}"
        )

    a0 = np.min(od)
    d0 = np.max(od)
    c0 = np.median(conc)
    b0 = 1.0

    try:
        popt, _ = curve_fit(
            four_pl,
            conc,
            od,
            p0=[a0, b0, c0, d0],
            bounds=(
                [-np.inf, 0.01, 1e-12, -np.inf],
                [np.inf, 100.0, np.inf, np.inf],
            ),
            maxfev=10000,
        )
    except Exception as exc:
        raise RuntimeError(f"4PL curve fitting failed: {exc}") from exc

    predicted = four_pl(conc, *popt)
    ss_res = np.sum((od - predicted) ** 2)
    ss_tot = np.sum((od - np.mean(od)) ** 2)
    r_squared = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0

    return popt, r_squared


def interpolate_unknowns(unknowns, popt):
    """Interpolate concentrations for unknown samples using inverse 4PL.

    Parameters
    ----------
    unknowns : pd.DataFrame
        Must contain 'od450_corrected' column.
    popt : array-like
        4PL parameters [a, b, c, d].

    Returns
    -------
    pd.DataFrame
        Copy of unknowns with added 'interpolated_concentration' column.
    """
    result = unknowns.copy()
    od_values = result["od450_corrected"].values
    result["interpolated_concentration"] = inverse_four_pl(od_values, *popt)
    return result


def calculate_limits(blank_mean, blank_sd, popt):
    """Calculate LOD and LOQ from blank statistics and the fitted curve.

    LOD = OD at blank_mean + 3*SD, converted to concentration via inverse 4PL.
    LOQ = OD at blank_mean + 10*SD, converted to concentration via inverse 4PL.

    Parameters
    ----------
    blank_mean : float
        Mean blank OD (before subtraction, so LOD/LOQ are in corrected space).
    blank_sd : float
        SD of blank OD values.
    popt : array-like
        4PL parameters [a, b, c, d].

    Returns
    -------
    tuple of (float, float)
        (LOD concentration, LOQ concentration). May be NaN if outside curve range.
    """
    lod_od = 3.0 * blank_sd
    loq_od = 10.0 * blank_sd

    lod_conc = inverse_four_pl(np.array([lod_od]), *popt)[0]
    loq_conc = inverse_four_pl(np.array([loq_od]), *popt)[0]

    return float(lod_conc), float(loq_conc)


def save_standard_curve_plot(standards, popt, r_squared, output_path):
    """Save standard curve plot with fitted 4PL and data points.

    Parameters
    ----------
    standards : pd.DataFrame
        Standard data with 'concentration' and 'od450_corrected'.
    popt : array-like
        Fitted 4PL parameters.
    r_squared : float
        R-squared value.
    output_path : str
        Path to save the PNG plot.
    """
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    conc = standards.loc[standards["concentration"] > 0, "concentration"].values
    od = standards.loc[standards["concentration"] > 0, "od450_corrected"].values

    fig, ax = plt.subplots(figsize=(8, 6))

    ax.scatter(conc, od, color="navy", s=50, zorder=5, label="Standards")

    x_fit = np.logspace(
        np.log10(conc.min() * 0.5), np.log10(conc.max() * 2.0), 200
    )
    y_fit = four_pl(x_fit, *popt)
    ax.plot(x_fit, y_fit, "r-", linewidth=2, label="4PL Fit")

    ax.set_xscale("log")
    ax.set_xlabel("Concentration", fontsize=12)
    ax.set_ylabel("OD450 (blank-corrected)", fontsize=12)
    ax.set_title(f"ELISA Standard Curve (4PL)\nR² = {r_squared:.4f}", fontsize=14)
    ax.legend(fontsize=10)
    ax.grid(True, alpha=0.3)

    a, b, c, d = popt
    param_text = f"A={a:.4f}\nB={b:.4f}\nC={c:.4f}\nD={d:.4f}"
    ax.text(
        0.02,
        0.98,
        param_text,
        transform=ax.transAxes,
        verticalalignment="top",
        fontsize=9,
        fontfamily="monospace",
        bbox=dict(boxstyle="round", facecolor="wheat", alpha=0.5),
    )

    fig.tight_layout()
    fig.savefig(output_path, dpi=150)
    plt.close(fig)
    print(f"Standard curve plot saved: {output_path}")


def save_results_csv(unknowns_with_conc, output_path):
    """Save interpolated results to CSV.

    Parameters
    ----------
    unknowns_with_conc : pd.DataFrame
        Unknown samples with interpolated concentrations.
    output_path : str
        Path to save the results CSV.
    """
    cols = ["well", "od450", "od450_corrected", "interpolated_concentration"]
    available = [c for c in cols if c in unknowns_with_conc.columns]
    unknowns_with_conc[available].to_csv(output_path, index=False)
    print(f"Results CSV saved: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="ELISA data processing with 4-parameter logistic standard curve."
    )
    parser.add_argument(
        "--data",
        required=True,
        help="CSV file with columns: well, concentration, od450, sample_type (standard/unknown/blank)",
    )
    parser.add_argument(
        "--output-dir",
        default="elisa_output",
        help="Output directory for plots and results (default: elisa_output)",
    )
    args = parser.parse_args()

    if not os.path.isfile(args.data):
        print(f"ERROR: Data file not found: {args.data}", file=sys.stderr)
        sys.exit(1)

    df = pd.read_csv(args.data)
    required_cols = {"well", "concentration", "od450", "sample_type"}
    missing = required_cols - set(df.columns)
    if missing:
        print(
            f"ERROR: Missing required columns: {missing}. "
            f"Expected: well, concentration, od450, sample_type",
            file=sys.stderr,
        )
        sys.exit(1)

    df["sample_type"] = df["sample_type"].str.strip().str.lower()
    valid_types = {"standard", "unknown", "blank"}
    invalid = set(df["sample_type"].unique()) - valid_types
    if invalid:
        print(
            f"WARNING: Unexpected sample_type values: {invalid}. "
            f"Expected: standard, unknown, blank"
        )

    os.makedirs(args.output_dir, exist_ok=True)

    print("=" * 60)
    print("ELISA DATA PROCESSING")
    print("=" * 60)
    print(f"Input file: {args.data}")
    print(f"Total wells: {len(df)}")
    for st in ["standard", "unknown", "blank"]:
        n = (df["sample_type"] == st).sum()
        print(f"  {st}: {n} wells")

    df_corrected, blank_mean, blank_sd = subtract_blanks(df)
    print(f"\nBlank OD mean: {blank_mean:.4f}")
    print(f"Blank OD SD:   {blank_sd:.4f}")

    standards = df_corrected[df_corrected["sample_type"] == "standard"].copy()
    if standards.empty:
        print("ERROR: No standard wells found in data.", file=sys.stderr)
        sys.exit(1)

    try:
        popt, r_squared = fit_standard_curve(standards)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    a, b, c, d = popt
    print(f"\n4PL Parameters:")
    print(f"  A (min asymptote): {a:.6f}")
    print(f"  B (Hill slope):    {b:.6f}")
    print(f"  C (EC50):          {c:.6f}")
    print(f"  D (max asymptote): {d:.6f}")
    print(f"  R-squared:         {r_squared:.6f}")

    lod, loq = calculate_limits(blank_mean, blank_sd, popt)
    print(f"\nLimit of Detection (LOD): {lod:.6f}" if not np.isnan(lod) else "\nLOD: outside curve range")
    print(f"Limit of Quantification (LOQ): {loq:.6f}" if not np.isnan(loq) else "LOQ: outside curve range")

    unknowns = df_corrected[df_corrected["sample_type"] == "unknown"].copy()
    if unknowns.empty:
        print("\nNo unknown samples to interpolate.")
    else:
        unknowns_result = interpolate_unknowns(unknowns, popt)
        n_interpolated = unknowns_result["interpolated_concentration"].notna().sum()
        n_failed = unknowns_result["interpolated_concentration"].isna().sum()
        print(f"\nUnknown samples: {len(unknowns_result)}")
        print(f"  Successfully interpolated: {n_interpolated}")
        print(f"  Outside curve range: {n_failed}")

        if n_interpolated > 0:
            valid = unknowns_result["interpolated_concentration"].dropna()
            print(f"  Concentration range: {valid.min():.4f} - {valid.max():.4f}")
            print(f"  Concentration mean:  {valid.mean():.4f}")

        results_path = os.path.join(args.output_dir, "elisa_results.csv")
        save_results_csv(unknowns_result, results_path)

    plot_path = os.path.join(args.output_dir, "standard_curve.png")
    save_standard_curve_plot(standards, popt, r_squared, plot_path)

    print("\n" + "=" * 60)
    print("PROCESSING COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    main()

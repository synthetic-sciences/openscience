#!/usr/bin/env python3
"""
Cosinor Analysis for Circadian Rhythm Data

Fits a cosinor model Y(t) = MESOR + Amplitude * cos(2*pi*t/period - Acrophase)
to time-series data. Uses the linearized reparameterization:
    Y = M + beta*cos(2*pi*t/T) + gamma*sin(2*pi*t/T)
where Amplitude = sqrt(beta^2 + gamma^2) and Acrophase = atan2(gamma, beta).

Computes MESOR, amplitude, acrophase, peak time, R-squared, and an F-test
p-value comparing the fitted model against a null (mean-only) model.

Usage:
    python cosinor_analysis.py --data circadian.csv --output-dir results/
    python cosinor_analysis.py --data activity.csv --period 12 --output-dir results/

Examples:
    # Standard 24-hour circadian analysis
    python cosinor_analysis.py --data body_temp.csv --output-dir ./circadian_results

    # 12-hour ultradian rhythm
    python cosinor_analysis.py --data heart_rate.csv --period 12 --output-dir ./ultradian_results

Dependencies: numpy, scipy, pandas, matplotlib
"""

import argparse
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.optimize import curve_fit
from scipy.stats import f as f_dist


def load_data(filepath):
    """
    Load time-series data from CSV.

    Expected columns: 'time' (hours) and 'value' (measurement).

    Args:
        filepath: Path to CSV file.

    Returns:
        Tuple of (time array, value array) as float64.

    Raises:
        FileNotFoundError: If file does not exist.
        ValueError: If required columns are missing.
    """
    path = Path(filepath)
    if not path.exists():
        raise FileNotFoundError(f"Data file not found: {filepath}")

    df = pd.read_csv(path)

    if "time" not in df.columns or "value" not in df.columns:
        raise ValueError(
            f"CSV must contain 'time' and 'value' columns. Found: {list(df.columns)}"
        )

    df = df.dropna(subset=["time", "value"])

    if len(df) < 4:
        raise ValueError("At least 4 data points required for cosinor fitting.")

    time = df["time"].values.astype(np.float64)
    value = df["value"].values.astype(np.float64)

    return time, value


def cosinor_model(t, mesor, beta, gamma, period):
    """
    Linearized cosinor model.

    Y(t) = MESOR + beta*cos(2*pi*t/T) + gamma*sin(2*pi*t/T)

    Args:
        t: Time array.
        mesor: Midline Estimating Statistic Of Rhythm.
        beta: Cosine coefficient.
        gamma: Sine coefficient.
        period: Period in same units as t.

    Returns:
        Model values at times t.
    """
    omega = 2.0 * np.pi / period
    return mesor + beta * np.cos(omega * t) + gamma * np.sin(omega * t)


def fit_cosinor(time, value, period=24.0):
    """
    Fit cosinor model to data using least-squares optimization.

    Args:
        time: 1D array of time points (hours).
        value: 1D array of measurements.
        period: Expected period in hours (default: 24).

    Returns:
        Dictionary with fitted parameters:
            mesor, amplitude, acrophase_rad, acrophase_hours,
            peak_time, beta, gamma, r_squared, p_value,
            fitted_values, residuals.

    Raises:
        RuntimeError: If curve fitting fails to converge.
    """
    n = len(time)

    # Initial estimates
    mesor_init = np.mean(value)
    amp_init = (np.max(value) - np.min(value)) / 2.0
    beta_init = amp_init
    gamma_init = 0.0

    def model_fixed_period(t, mesor, beta, gamma):
        return cosinor_model(t, mesor, beta, gamma, period)

    try:
        popt, pcov = curve_fit(
            model_fixed_period,
            time,
            value,
            p0=[mesor_init, beta_init, gamma_init],
            maxfev=10000,
        )
    except RuntimeError as e:
        raise RuntimeError(f"Cosinor fitting failed: {e}")

    mesor, beta, gamma = popt

    # Derive amplitude and acrophase
    amplitude = np.sqrt(beta ** 2 + gamma ** 2)
    acrophase_rad = np.arctan2(gamma, beta)

    # Convert acrophase to hours: peak occurs when cos(omega*t - phi) = 1
    # i.e., omega*t = phi, so t_peak = phi * T / (2*pi)
    acrophase_hours = acrophase_rad * period / (2.0 * np.pi)
    if acrophase_hours < 0:
        acrophase_hours += period

    peak_time = acrophase_hours

    # Fitted values and residuals
    fitted = model_fixed_period(time, *popt)
    residuals = value - fitted

    # R-squared
    ss_res = np.sum(residuals ** 2)
    ss_tot = np.sum((value - np.mean(value)) ** 2)
    r_squared = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0

    # F-test: cosinor model (3 params: mesor, beta, gamma) vs null (1 param: mean)
    p_model = 3  # parameters in full model
    p_null = 1   # parameters in null model
    df_model = p_model - p_null  # additional parameters = 2
    df_resid = n - p_model

    if df_resid > 0 and ss_res > 0:
        ss_null = ss_tot  # null model residuals = total variation around mean
        f_stat = ((ss_null - ss_res) / df_model) / (ss_res / df_resid)
        p_value = 1.0 - f_dist.cdf(f_stat, df_model, df_resid)
    else:
        f_stat = np.nan
        p_value = np.nan

    return {
        "mesor": mesor,
        "amplitude": amplitude,
        "acrophase_rad": acrophase_rad,
        "acrophase_hours": acrophase_hours,
        "peak_time": peak_time,
        "beta": beta,
        "gamma": gamma,
        "r_squared": r_squared,
        "f_statistic": f_stat,
        "p_value": p_value,
        "period": period,
        "n_points": n,
        "fitted_values": fitted,
        "residuals": residuals,
    }


def plot_cosinor(time, value, results, output_path):
    """
    Save plot of raw data and fitted cosinor curve.

    Args:
        time: Time array.
        value: Value array.
        results: Dictionary from fit_cosinor.
        output_path: Path to save PNG plot.
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    period = results["period"]

    # Generate smooth fitted curve
    t_smooth = np.linspace(np.min(time), np.max(time), 500)
    y_smooth = cosinor_model(
        t_smooth, results["mesor"], results["beta"], results["gamma"], period
    )

    fig, axes = plt.subplots(2, 1, figsize=(10, 8), gridspec_kw={"height_ratios": [3, 1]})

    # Main plot
    ax = axes[0]
    ax.scatter(time, value, alpha=0.6, s=20, color="steelblue", label="Data", zorder=3)
    ax.plot(t_smooth, y_smooth, color="crimson", linewidth=2, label="Cosinor fit", zorder=4)
    ax.axhline(
        results["mesor"], color="gray", linestyle="--", alpha=0.7, label=f"MESOR = {results['mesor']:.3f}"
    )

    # Mark peak
    ax.axvline(
        results["peak_time"], color="orange", linestyle=":", alpha=0.8,
        label=f"Peak = {results['peak_time']:.2f} h",
    )

    ax.set_xlabel("Time (hours)")
    ax.set_ylabel("Value")
    ax.set_title(
        f"Cosinor Analysis (T={period}h, A={results['amplitude']:.3f}, "
        f"R\u00b2={results['r_squared']:.3f}, p={results['p_value']:.2e})"
    )
    ax.legend(loc="best", fontsize=9)
    ax.grid(True, alpha=0.3)

    # Residuals plot
    ax2 = axes[1]
    ax2.scatter(time, results["residuals"], alpha=0.5, s=15, color="gray")
    ax2.axhline(0, color="black", linewidth=0.5)
    ax2.set_xlabel("Time (hours)")
    ax2.set_ylabel("Residuals")
    ax2.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(str(output_path), dpi=150, bbox_inches="tight")
    plt.close(fig)


def print_results(results):
    """Print formatted cosinor analysis results."""
    print("\n=== Cosinor Analysis Results ===")
    print(f"  Period:           {results['period']:.2f} hours")
    print(f"  Data points:      {results['n_points']}")
    print(f"  MESOR:            {results['mesor']:.4f}")
    print(f"  Amplitude:        {results['amplitude']:.4f}")
    print(f"  Acrophase:        {results['acrophase_hours']:.2f} hours ({np.degrees(results['acrophase_rad']):.1f} deg)")
    print(f"  Peak time:        {results['peak_time']:.2f} hours")
    print(f"  Beta (cos):       {results['beta']:.4f}")
    print(f"  Gamma (sin):      {results['gamma']:.4f}")
    print(f"  R-squared:        {results['r_squared']:.4f}")
    print(f"  F-statistic:      {results['f_statistic']:.4f}")
    print(f"  p-value:          {results['p_value']:.2e}")

    if results["p_value"] < 0.05:
        print("  Significance:     Significant circadian rhythm detected (p < 0.05)")
    else:
        print("  Significance:     No significant rhythm detected (p >= 0.05)")


def main():
    parser = argparse.ArgumentParser(
        description="Cosinor analysis for circadian rhythm data.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python cosinor_analysis.py --data body_temp.csv --output-dir ./results
  python cosinor_analysis.py --data activity.csv --period 12 --output-dir ./results
        """,
    )
    parser.add_argument(
        "--data",
        required=True,
        help="Path to CSV file with 'time' and 'value' columns.",
    )
    parser.add_argument(
        "--period",
        type=float,
        default=24.0,
        help="Expected period in hours (default: 24).",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory for output files (plot PNG, summary CSV).",
    )

    args = parser.parse_args()

    # Load data
    print(f"Loading data: {args.data}")
    time, value = load_data(args.data)
    print(f"  Loaded {len(time)} data points")
    print(f"  Time range: [{np.min(time):.2f}, {np.max(time):.2f}] hours")
    print(f"  Value range: [{np.min(value):.4f}, {np.max(value):.4f}]")

    # Fit cosinor model
    print(f"\nFitting cosinor model with period = {args.period} hours ...")
    results = fit_cosinor(time, value, period=args.period)

    # Print results
    print_results(results)

    # Create output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Save plot
    plot_path = output_dir / "cosinor_fit.png"
    plot_cosinor(time, value, results, plot_path)
    print(f"\nFitted curve plot saved: {plot_path}")

    # Save summary CSV
    summary_path = output_dir / "cosinor_summary.csv"
    summary = {
        k: v
        for k, v in results.items()
        if k not in ("fitted_values", "residuals")
    }
    pd.DataFrame([summary]).to_csv(str(summary_path), index=False)
    print(f"Summary CSV saved: {summary_path}")

    # Save fitted values
    fitted_path = output_dir / "cosinor_fitted.csv"
    fitted_df = pd.DataFrame({
        "time": time,
        "observed": value,
        "fitted": results["fitted_values"],
        "residual": results["residuals"],
    })
    fitted_df.to_csv(str(fitted_path), index=False)
    print(f"Fitted values saved: {fitted_path}")


if __name__ == "__main__":
    main()

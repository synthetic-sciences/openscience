#!/usr/bin/env python3
"""Radiolabeled antibody biodistribution analysis.

Computes percent injected dose per gram (%ID/g), fits pharmacokinetic
clearance models per organ, calculates AUC via trapezoidal integration,
and reports tumor-to-blood ratios when applicable.

Usage:
    python biodistribution.py --data biodist.csv --output-dir results/

Examples:
    # Standard biodistribution analysis
    python biodistribution.py --data radiolabel_study.csv --output-dir ./biodist_out

    # With tumor and blood data for T:B ratios
    python biodistribution.py --data tumor_targeting.csv --output-dir ./biodist_out
"""

import argparse
import os
import sys
import warnings
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from scipy.optimize import curve_fit
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


# ---------------------------------------------------------------------------
# PK models
# ---------------------------------------------------------------------------

def mono_exponential_decay(t: np.ndarray, a: float, lam: float) -> np.ndarray:
    """y = A * exp(-lambda * t)"""
    return a * np.exp(-lam * t)


def uptake_clearance(t: np.ndarray, a: float, lam_up: float,
                     lam_cl: float) -> np.ndarray:
    """y = A * (exp(-lam_cl * t) - exp(-lam_up * t))

    Bateman-type model for organs that accumulate then clear.
    """
    return a * (np.exp(-lam_cl * t) - np.exp(-lam_up * t))


def fit_clearance(time: np.ndarray, values: np.ndarray
                  ) -> Dict:
    """Attempt both mono-exponential and uptake-clearance fits.

    Returns dict with model name, parameters, R-squared, half-life, peak time.
    """
    best = {"model": "none", "params": {}, "R2": -np.inf,
            "half_life": np.nan, "time_to_peak": np.nan}

    # Mono-exponential decay
    try:
        p0_mono = [values.max(), 0.01]
        bounds_mono = ([0, 1e-8], [values.max() * 10, 10.0])
        popt, _ = curve_fit(mono_exponential_decay, time, values,
                            p0=p0_mono, bounds=bounds_mono, maxfev=10000)
        pred = mono_exponential_decay(time, *popt)
        r2 = _r_squared(values, pred)
        t_half = np.log(2) / popt[1] if popt[1] > 0 else np.nan
        if r2 > best["R2"]:
            best = {
                "model": "mono_exponential",
                "params": {"A": popt[0], "lambda": popt[1]},
                "R2": r2,
                "half_life": t_half,
                "time_to_peak": 0.0,
            }
    except (RuntimeError, ValueError):
        pass

    # Uptake-clearance (Bateman)
    try:
        peak_idx = np.argmax(values)
        if peak_idx > 0:  # Only try if peak is not at t=0
            p0_uc = [values.max() * 2, 0.5, 0.01]
            bounds_uc = ([0, 1e-6, 1e-8], [values.max() * 100, 50.0, 10.0])
            popt, _ = curve_fit(uptake_clearance, time, values,
                                p0=p0_uc, bounds=bounds_uc, maxfev=10000)
            pred = uptake_clearance(time, *popt)
            r2 = _r_squared(values, pred)
            lam_up, lam_cl = popt[1], popt[2]
            if lam_up > lam_cl and lam_up > 0 and lam_cl > 0:
                t_peak = np.log(lam_up / lam_cl) / (lam_up - lam_cl)
            else:
                t_peak = np.nan
            t_half = np.log(2) / lam_cl if lam_cl > 0 else np.nan
            if r2 > best["R2"]:
                best = {
                    "model": "uptake_clearance",
                    "params": {"A": popt[0], "lambda_up": lam_up,
                               "lambda_cl": lam_cl},
                    "R2": r2,
                    "half_life": t_half,
                    "time_to_peak": t_peak,
                }
    except (RuntimeError, ValueError):
        pass

    return best


def _r_squared(obs: np.ndarray, pred: np.ndarray) -> float:
    ss_res = np.sum((obs - pred) ** 2)
    ss_tot = np.sum((obs - np.mean(obs)) ** 2)
    if ss_tot == 0:
        return float("nan")
    return 1.0 - ss_res / ss_tot


# ---------------------------------------------------------------------------
# %ID/g and AUC
# ---------------------------------------------------------------------------

def compute_id_per_gram(counts_per_gram: np.ndarray,
                        injected_dose: np.ndarray) -> np.ndarray:
    """%ID/g = (counts_per_gram / total_injected_dose) * 100"""
    return (counts_per_gram / injected_dose) * 100.0


def trapezoidal_auc(time: np.ndarray, values: np.ndarray) -> float:
    """AUC by trapezoidal rule."""
    order = np.argsort(time)
    return float(np.trapz(values[order], time[order]))


# ---------------------------------------------------------------------------
# Plotting
# ---------------------------------------------------------------------------

def plot_biodistribution(organ_data: Dict[str, pd.DataFrame],
                         output_dir: str) -> str:
    """Biodistribution curves for all organs."""
    fig, ax = plt.subplots(figsize=(10, 6))
    colors = plt.cm.tab20(np.linspace(0, 1, max(len(organ_data), 2)))

    for idx, (organ, sub) in enumerate(sorted(organ_data.items())):
        stats = sub.groupby("time_hours")["id_per_gram"].agg(
            ["mean", "sem"]).reset_index()
        ax.errorbar(stats["time_hours"], stats["mean"],
                     yerr=stats["sem"].fillna(0),
                     label=organ, color=colors[idx], capsize=3,
                     marker="o", markersize=4, linewidth=1.5)

    ax.set_xlabel("Time (hours)")
    ax.set_ylabel("%ID/g")
    ax.set_title("Biodistribution")
    ax.legend(fontsize=7, ncol=2, loc="upper right")
    fig.tight_layout()
    path = os.path.join(output_dir, "biodistribution_curves.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def plot_tb_ratio(tb_data: pd.DataFrame, output_dir: str) -> Optional[str]:
    """Tumor-to-blood ratio over time."""
    if tb_data.empty:
        return None
    fig, ax = plt.subplots(figsize=(7, 5))
    ax.plot(tb_data["time_hours"], tb_data["TB_ratio"],
            marker="o", color="crimson", linewidth=2)
    ax.set_xlabel("Time (hours)")
    ax.set_ylabel("Tumor : Blood Ratio")
    ax.set_title("Tumor-to-Blood Ratio")
    ax.axhline(1.0, linestyle="--", color="gray", alpha=0.5)
    fig.tight_layout()
    path = os.path.join(output_dir, "tumor_blood_ratio.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def load_data(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    required = {"time_hours", "organ", "counts_per_gram", "injected_dose"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"CSV missing required columns: {missing}")
    return df


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Radiolabeled antibody biodistribution analysis."
    )
    parser.add_argument("--data", required=True,
                        help="CSV: time_hours, organ, counts_per_gram, injected_dose")
    parser.add_argument("--output-dir", default=".", help="Output directory")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    df = load_data(args.data)

    # Compute %ID/g
    df["id_per_gram"] = compute_id_per_gram(
        df["counts_per_gram"].values.astype(float),
        df["injected_dose"].values.astype(float),
    )

    organs = sorted(df["organ"].str.lower().unique())
    organ_data: Dict[str, pd.DataFrame] = {}
    summary_rows: List[Dict] = []

    for organ in organs:
        sub = df[df["organ"].str.lower() == organ].copy()
        organ_data[organ] = sub

        # Mean %ID/g per timepoint
        stats = sub.groupby("time_hours")["id_per_gram"].mean().reset_index()
        time = stats["time_hours"].values.astype(float)
        vals = stats["id_per_gram"].values.astype(float)

        peak_val = vals.max()
        peak_time = time[np.argmax(vals)]
        auc = trapezoidal_auc(time, vals)

        # PK fit
        fit_result = fit_clearance(time, vals)

        summary_rows.append({
            "organ": organ,
            "peak_id_per_gram": peak_val,
            "time_to_peak_h": peak_time,
            "clearance_half_life_h": fit_result["half_life"],
            "AUC_pct_ID_g_h": auc,
            "model": fit_result["model"],
            "R_squared": fit_result["R2"],
        })

    summary_df = pd.DataFrame(summary_rows)

    # Tumor-to-blood ratio
    tb_data = pd.DataFrame()
    has_tumor = "tumor" in organs
    has_blood = "blood" in organs
    if has_tumor and has_blood:
        tumor_stats = organ_data["tumor"].groupby("time_hours")["id_per_gram"].mean()
        blood_stats = organ_data["blood"].groupby("time_hours")["id_per_gram"].mean()
        common = tumor_stats.index.intersection(blood_stats.index)
        if len(common) > 0:
            tb_rows = []
            for t in common:
                ratio = tumor_stats[t] / blood_stats[t] if blood_stats[t] > 0 else np.nan
                tb_rows.append({"time_hours": t, "TB_ratio": ratio})
            tb_data = pd.DataFrame(tb_rows)

    # Plots
    biodist_path = plot_biodistribution(organ_data, args.output_dir)
    tb_path = plot_tb_ratio(tb_data, args.output_dir)

    # Save CSVs
    summary_path = os.path.join(args.output_dir, "organ_summary.csv")
    summary_df.to_csv(summary_path, index=False)

    if not tb_data.empty:
        tb_csv_path = os.path.join(args.output_dir, "tumor_blood_ratios.csv")
        tb_data.to_csv(tb_csv_path, index=False)

    # Print
    print("=" * 75)
    print("BIODISTRIBUTION ANALYSIS RESULTS")
    print("=" * 75)

    print(f"\n{'Organ':<15}{'Peak %ID/g':>12}{'t_peak (h)':>12}{'t1/2 (h)':>12}{'AUC':>12}")
    print("-" * 63)
    for _, row in summary_df.iterrows():
        t_half_str = f"{row['clearance_half_life_h']:.1f}" if not np.isnan(
            row["clearance_half_life_h"]) else "N/A"
        print(f"{row['organ']:<15}{row['peak_id_per_gram']:>12.3f}"
              f"{row['time_to_peak_h']:>12.1f}{t_half_str:>12}"
              f"{row['AUC_pct_ID_g_h']:>12.2f}")

    if not tb_data.empty:
        print("\nTumor-to-Blood Ratios:")
        print(f"  {'Time (h)':<12}{'T:B Ratio':>12}")
        print("  " + "-" * 24)
        for _, row in tb_data.iterrows():
            print(f"  {row['time_hours']:<12.1f}{row['TB_ratio']:>12.3f}")

    print(f"\nBiodistribution plot: {biodist_path}")
    if tb_path:
        print(f"T:B ratio plot:       {tb_path}")
    print(f"Organ summary CSV:    {summary_path}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Xenograft tumor growth inhibition (TGI) analysis.

Computes TGI%, fits exponential growth models per treatment group,
performs statistical comparisons, and generates publication-quality
growth-curve plots.

Usage:
    python xenograft_tgi.py --data xenograft.csv --output-dir results/

Examples:
    # Standard TGI with mean +/- SEM growth curves
    python xenograft_tgi.py --data tumor_volumes.csv --output-dir ./tgi_out

    # Data with individual mouse IDs
    python xenograft_tgi.py --data study_data.csv --output-dir ./tgi_out
"""

import argparse
import os
import sys
import warnings
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from scipy.optimize import curve_fit
from scipy.stats import mannwhitneyu, f_oneway
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

def exponential_growth(t: np.ndarray, v0: float, k: float) -> np.ndarray:
    """V(t) = V0 * exp(k * t)"""
    return v0 * np.exp(k * t)


def fit_exponential(days: np.ndarray, volumes: np.ndarray
                    ) -> Tuple[float, float, float]:
    """Fit exponential growth, return (V0, k, R-squared).

    Uses log-linear OLS as a robust fallback when nonlinear fit diverges.
    """
    mask = volumes > 0
    d = days[mask]
    v = volumes[mask]
    if len(d) < 2:
        return (np.nan, np.nan, np.nan)

    # Attempt nonlinear fit
    try:
        popt, _ = curve_fit(exponential_growth, d, v,
                            p0=[v[0], 0.05], maxfev=10000)
        v0, k = popt
        pred = exponential_growth(d, v0, k)
        ss_res = np.sum((v - pred) ** 2)
        ss_tot = np.sum((v - np.mean(v)) ** 2)
        r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else np.nan
        return (v0, k, r2)
    except RuntimeError:
        pass

    # Log-linear fallback
    log_v = np.log(v)
    coeffs = np.polyfit(d, log_v, 1)
    k = coeffs[0]
    v0 = np.exp(coeffs[1])
    pred = v0 * np.exp(k * d)
    ss_res = np.sum((v - pred) ** 2)
    ss_tot = np.sum((v - np.mean(v)) ** 2)
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else np.nan
    return (v0, k, r2)


# ---------------------------------------------------------------------------
# TGI calculation
# ---------------------------------------------------------------------------

def compute_tgi(df: pd.DataFrame) -> float:
    """TGI% = (1 - (Vt_final - Vt_initial) / (Vc_final - Vc_initial)) * 100

    Expects df to have columns: day, volume, group.
    'group' must contain 'control' and at least one other value.
    """
    groups = df["group"].str.lower().unique()
    control = df[df["group"].str.lower() == "control"]
    treatment = df[df["group"].str.lower() != "control"]

    if control.empty or treatment.empty:
        return np.nan

    t_min = df["day"].min()
    t_max = df["day"].max()

    vc_init = control[control["day"] == t_min]["volume"].mean()
    vc_final = control[control["day"] == t_max]["volume"].mean()
    vt_init = treatment[treatment["day"] == t_min]["volume"].mean()
    vt_final = treatment[treatment["day"] == t_max]["volume"].mean()

    denom = vc_final - vc_init
    if denom == 0:
        return np.nan
    tgi = (1.0 - (vt_final - vt_init) / denom) * 100.0
    return tgi


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

def endpoint_statistics(df: pd.DataFrame) -> Tuple[float, str]:
    """Compare endpoint volumes between groups.

    Returns (p_value, test_name).
    Uses Mann-Whitney U for 2 groups, one-way ANOVA for >2.
    """
    t_max = df["day"].max()
    endpoint = df[df["day"] == t_max]

    groups = endpoint["group"].str.lower().unique()
    group_volumes = [
        endpoint[endpoint["group"].str.lower() == g]["volume"].values
        for g in groups
    ]
    group_volumes = [g for g in group_volumes if len(g) > 0]

    if len(group_volumes) < 2:
        return (np.nan, "insufficient_data")

    if len(group_volumes) == 2:
        stat, p = mannwhitneyu(group_volumes[0], group_volumes[1],
                               alternative="two-sided")
        return (p, "Mann-Whitney U")
    else:
        stat, p = f_oneway(*group_volumes)
        return (p, "One-way ANOVA")


# ---------------------------------------------------------------------------
# Plotting
# ---------------------------------------------------------------------------

def plot_growth_curves(df: pd.DataFrame, output_dir: str) -> str:
    """Mean +/- SEM growth curves per group."""
    fig, ax = plt.subplots(figsize=(8, 5))
    groups = df["group"].unique()
    colors = plt.cm.tab10(np.linspace(0, 1, max(len(groups), 2)))

    for idx, grp in enumerate(groups):
        sub = df[df["group"] == grp]
        stats = sub.groupby("day")["volume"].agg(["mean", "sem"]).reset_index()
        ax.errorbar(stats["day"], stats["mean"], yerr=stats["sem"],
                     label=grp, color=colors[idx], capsize=3, linewidth=2,
                     marker="o", markersize=4)

    ax.set_xlabel("Day")
    ax.set_ylabel("Tumor Volume (mm\u00b3)")
    ax.set_title("Xenograft Tumor Growth")
    ax.legend()
    fig.tight_layout()
    path = os.path.join(output_dir, "growth_curves.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def plot_individual_traces(df: pd.DataFrame, output_dir: str) -> Optional[str]:
    """Individual mouse traces (spider plot) if mouse_id is available."""
    if "mouse_id" not in df.columns:
        return None

    fig, ax = plt.subplots(figsize=(8, 5))
    groups = df["group"].unique()
    colors = plt.cm.tab10(np.linspace(0, 1, max(len(groups), 2)))
    color_map = {g: colors[i] for i, g in enumerate(groups)}

    for mid in df["mouse_id"].unique():
        sub = df[df["mouse_id"] == mid].sort_values("day")
        grp = sub["group"].iloc[0]
        ax.plot(sub["day"], sub["volume"], alpha=0.5, linewidth=1,
                color=color_map[grp])

    # Legend by group
    for grp, clr in color_map.items():
        ax.plot([], [], color=clr, label=grp, linewidth=2)
    ax.legend()
    ax.set_xlabel("Day")
    ax.set_ylabel("Tumor Volume (mm\u00b3)")
    ax.set_title("Individual Mouse Traces")
    fig.tight_layout()
    path = os.path.join(output_dir, "individual_traces.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def load_data(path: str) -> pd.DataFrame:
    """Load and validate CSV."""
    df = pd.read_csv(path)
    required = {"day", "volume", "group"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"CSV missing required columns: {missing}")
    return df


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Xenograft tumor growth inhibition analysis."
    )
    parser.add_argument("--data", required=True,
                        help="CSV with columns: day, volume, group [, mouse_id]")
    parser.add_argument("--output-dir", default=".", help="Directory for output files")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    df = load_data(args.data)

    # ---- TGI ----
    tgi = compute_tgi(df)

    # ---- Growth rate per group ----
    groups = df["group"].unique()
    growth_results: List[Dict] = []
    for grp in groups:
        sub = df[df["group"] == grp]
        day_mean = sub.groupby("day")["volume"].mean().reset_index()
        v0, k, r2 = fit_exponential(day_mean["day"].values, day_mean["volume"].values)
        doubling = np.log(2) / k if k > 0 else np.nan
        growth_results.append({
            "group": grp,
            "V0": v0,
            "growth_rate_k": k,
            "doubling_time_days": doubling,
            "R_squared": r2,
        })

    growth_df = pd.DataFrame(growth_results)

    # ---- Statistics ----
    p_val, test_name = endpoint_statistics(df)

    # ---- Plots ----
    curve_path = plot_growth_curves(df, args.output_dir)
    trace_path = plot_individual_traces(df, args.output_dir)

    # ---- Summary CSV ----
    summary = {
        "TGI_percent": [tgi],
        "endpoint_p_value": [p_val],
        "statistical_test": [test_name],
    }
    summary_df = pd.DataFrame(summary)
    summary_path = os.path.join(args.output_dir, "tgi_summary.csv")
    summary_df.to_csv(summary_path, index=False)

    growth_path = os.path.join(args.output_dir, "growth_parameters.csv")
    growth_df.to_csv(growth_path, index=False)

    # ---- Print ----
    print("=" * 65)
    print("XENOGRAFT TUMOR GROWTH INHIBITION ANALYSIS")
    print("=" * 65)
    print(f"\nTGI%: {tgi:.1f}%")
    print(f"Endpoint test: {test_name}, p = {p_val:.4g}")
    print()

    print("Growth Parameters by Group:")
    print(f"{'Group':<20}{'k (1/day)':>12}{'Doubling (d)':>14}{'R-squared':>12}")
    print("-" * 58)
    for _, row in growth_df.iterrows():
        dt = f"{row['doubling_time_days']:.2f}" if not np.isnan(row["doubling_time_days"]) else "N/A"
        print(f"{row['group']:<20}{row['growth_rate_k']:>12.4f}{dt:>14}{row['R_squared']:>12.4f}")

    print(f"\nGrowth curves: {curve_path}")
    if trace_path:
        print(f"Individual traces: {trace_path}")
    print(f"TGI summary: {summary_path}")
    print(f"Growth parameters: {growth_path}")


if __name__ == "__main__":
    main()

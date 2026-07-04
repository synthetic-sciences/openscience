#!/usr/bin/env python3
"""Pharmaceutical stability prediction using the Arrhenius equation.

Fits degradation kinetics at multiple temperatures, determines the best
kinetic model (zero- or first-order), applies the Arrhenius relationship
to predict the degradation rate at a target storage temperature, and
extrapolates the shelf life.

Usage:
    python stability_prediction.py --data stability.csv --target-temp 25 --spec-limit 90 --output-dir results/
    python stability_prediction.py --data accelerated.csv --output-dir results/

Examples:
    # Predict shelf life at 25 C with 90% potency limit
    python stability_prediction.py --data accel_stability.csv --target-temp 25 --spec-limit 90 --output-dir ./stab_out

    # Predict for cold-chain product at 5 C
    python stability_prediction.py --data cold_chain.csv --target-temp 5 --spec-limit 95 --output-dir ./stab_out
"""

import argparse
import os
import sys
import warnings
from typing import Dict, List, Tuple, Optional

import numpy as np
import pandas as pd
from scipy.optimize import curve_fit
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

# Gas constant (J / (mol * K))
R_GAS = 8.314


# ---------------------------------------------------------------------------
# Kinetic models
# ---------------------------------------------------------------------------

def zero_order(t: np.ndarray, c0: float, k: float) -> np.ndarray:
    """C(t) = C0 - k * t"""
    return c0 - k * t


def first_order(t: np.ndarray, c0: float, k: float) -> np.ndarray:
    """C(t) = C0 * exp(-k * t)"""
    return c0 * np.exp(-k * t)


def fit_zero_order(time: np.ndarray, potency: np.ndarray
                   ) -> Tuple[float, float, float]:
    """Fit zero-order, return (C0, k, R-squared)."""
    coeffs = np.polyfit(time, potency, 1)
    k = -coeffs[0]  # slope is -k
    c0 = coeffs[1]
    pred = c0 - k * time
    r2 = _r_squared(potency, pred)
    return c0, k, r2


def fit_first_order(time: np.ndarray, potency: np.ndarray
                    ) -> Tuple[float, float, float]:
    """Fit first-order (log-linear), return (C0, k, R-squared)."""
    mask = potency > 0
    t = time[mask]
    p = potency[mask]
    if len(t) < 2:
        return (np.nan, np.nan, np.nan)
    coeffs = np.polyfit(t, np.log(p), 1)
    k = -coeffs[0]
    c0 = np.exp(coeffs[1])
    pred = c0 * np.exp(-k * t)
    r2 = _r_squared(p, pred)
    return c0, k, r2


def _r_squared(obs: np.ndarray, pred: np.ndarray) -> float:
    ss_res = np.sum((obs - pred) ** 2)
    ss_tot = np.sum((obs - np.mean(obs)) ** 2)
    if ss_tot == 0:
        return float("nan")
    return 1.0 - ss_res / ss_tot


# ---------------------------------------------------------------------------
# Arrhenius
# ---------------------------------------------------------------------------

def arrhenius(inv_T: np.ndarray, ln_A: float, Ea_over_R: float) -> np.ndarray:
    """ln(k) = ln(A) - Ea / (R * T) ; parametrised as f(1/T)."""
    return ln_A - Ea_over_R * inv_T


def fit_arrhenius(temperatures_C: np.ndarray, rate_constants: np.ndarray
                  ) -> Tuple[float, float, float]:
    """Fit Arrhenius and return (Ea_J_mol, ln_A, R-squared).

    Parameters
    ----------
    temperatures_C : array  Celsius
    rate_constants : array  k values (>0)

    Returns
    -------
    Ea : float  Activation energy in J/mol
    ln_A : float  Pre-exponential factor (log)
    r2 : float
    """
    mask = rate_constants > 0
    T_K = temperatures_C[mask] + 273.15
    inv_T = 1.0 / T_K
    ln_k = np.log(rate_constants[mask])

    if len(inv_T) < 2:
        raise ValueError("Need at least 2 temperature points for Arrhenius fit.")

    coeffs = np.polyfit(inv_T, ln_k, 1)
    Ea_over_R = -coeffs[0]
    ln_A = coeffs[1]
    pred = ln_A - Ea_over_R * inv_T
    r2 = _r_squared(ln_k, pred)
    Ea = Ea_over_R * R_GAS
    return Ea, ln_A, r2


def predict_k(Ea: float, ln_A: float, target_C: float) -> float:
    """Predict rate constant at target temperature."""
    T_K = target_C + 273.15
    ln_k = ln_A - (Ea / R_GAS) / T_K
    return np.exp(ln_k)


def predict_shelf_life(c0: float, k: float, spec_limit: float,
                       order: int) -> float:
    """Time (months) to reach spec limit.

    order 0: t = (C0 - spec_limit) / k
    order 1: t = ln(C0 / spec_limit) / k
    """
    if k <= 0:
        return np.inf
    if order == 0:
        return (c0 - spec_limit) / k
    else:
        if c0 <= 0 or spec_limit <= 0:
            return np.nan
        return np.log(c0 / spec_limit) / k


# ---------------------------------------------------------------------------
# Plotting
# ---------------------------------------------------------------------------

def plot_degradation_curves(temp_data: Dict[float, pd.DataFrame],
                            fits: Dict[float, Dict],
                            output_dir: str) -> str:
    """Degradation curves at each temperature with model overlay."""
    fig, ax = plt.subplots(figsize=(8, 5))
    colors = plt.cm.coolwarm(np.linspace(0.1, 0.9, len(temp_data)))

    for idx, (temp, sub) in enumerate(sorted(temp_data.items())):
        c = colors[idx]
        ax.scatter(sub["time_months"], sub["potency_percent"],
                   color=c, edgecolors="black", s=40, zorder=3)
        info = fits[temp]
        t_range = np.linspace(0, sub["time_months"].max() * 1.2, 100)
        if info["order"] == 0:
            pred = zero_order(t_range, info["C0"], info["k"])
        else:
            pred = first_order(t_range, info["C0"], info["k"])
        ax.plot(t_range, pred, color=c, linewidth=1.5,
                label=f"{temp:.0f} \u00b0C (k={info['k']:.4g})")

    ax.set_xlabel("Time (months)")
    ax.set_ylabel("Potency (%)")
    ax.set_title("Degradation Curves")
    ax.legend(fontsize=8)
    fig.tight_layout()
    path = os.path.join(output_dir, "degradation_curves.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def plot_arrhenius(temperatures_C: np.ndarray, rate_constants: np.ndarray,
                   Ea: float, ln_A: float, output_dir: str) -> str:
    """Arrhenius plot: ln(k) vs 1/T."""
    fig, ax = plt.subplots(figsize=(7, 5))
    T_K = temperatures_C + 273.15
    inv_T = 1.0 / T_K
    ln_k = np.log(rate_constants[rate_constants > 0])
    inv_T_pos = inv_T[rate_constants > 0]

    ax.scatter(inv_T_pos * 1000, ln_k, color="steelblue", edgecolors="black",
               s=60, zorder=3)

    x_fit = np.linspace(inv_T_pos.min() * 0.98, inv_T_pos.max() * 1.02, 100)
    y_fit = ln_A - (Ea / R_GAS) * x_fit
    ax.plot(x_fit * 1000, y_fit, color="crimson", linewidth=2)

    ax.set_xlabel("1000/T (K\u207b\u00b9)")
    ax.set_ylabel("ln(k)")
    ax.set_title(f"Arrhenius Plot  (Ea = {Ea / 1000:.1f} kJ/mol)")
    fig.tight_layout()
    path = os.path.join(output_dir, "arrhenius_plot.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def plot_shelf_life(c0: float, k_target: float, order: int,
                    spec_limit: float, shelf_life: float,
                    target_temp: float, output_dir: str) -> str:
    """Predicted degradation at target temperature with shelf-life marker."""
    fig, ax = plt.subplots(figsize=(7, 5))
    t_max = shelf_life * 1.4 if np.isfinite(shelf_life) else 60
    t_range = np.linspace(0, t_max, 200)
    if order == 0:
        pred = zero_order(t_range, c0, k_target)
    else:
        pred = first_order(t_range, c0, k_target)

    ax.plot(t_range, pred, color="steelblue", linewidth=2)
    ax.axhline(spec_limit, linestyle="--", color="red", alpha=0.7,
               label=f"Spec limit ({spec_limit}%)")
    if np.isfinite(shelf_life):
        ax.axvline(shelf_life, linestyle="--", color="gray", alpha=0.6)
        ax.annotate(f"Shelf life = {shelf_life:.1f} mo",
                    xy=(shelf_life, spec_limit), fontsize=9, color="gray",
                    xytext=(shelf_life + t_max * 0.05, spec_limit + 2))

    ax.set_xlabel("Time (months)")
    ax.set_ylabel("Predicted Potency (%)")
    ax.set_title(f"Shelf-Life Prediction at {target_temp} \u00b0C")
    ax.legend()
    fig.tight_layout()
    path = os.path.join(output_dir, "shelf_life_prediction.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


# ---------------------------------------------------------------------------
# Main analysis
# ---------------------------------------------------------------------------

def load_data(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    required = {"temperature_C", "time_months", "potency_percent"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"CSV missing required columns: {missing}")
    return df


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pharmaceutical stability prediction via Arrhenius equation."
    )
    parser.add_argument("--data", required=True,
                        help="CSV: temperature_C, time_months, potency_percent")
    parser.add_argument("--target-temp", type=float, default=25.0,
                        help="Target storage temperature in Celsius (default: 25)")
    parser.add_argument("--spec-limit", type=float, default=90.0,
                        help="Minimum acceptable potency %% (default: 90)")
    parser.add_argument("--output-dir", default=".", help="Output directory")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    df = load_data(args.data)

    temperatures = sorted(df["temperature_C"].unique())
    if len(temperatures) < 2:
        print("ERROR: Need data at >= 2 temperatures for Arrhenius extrapolation.",
              file=sys.stderr)
        sys.exit(1)

    # Fit kinetics at each temperature
    temp_data: Dict[float, pd.DataFrame] = {}
    fits: Dict[float, Dict] = {}

    for temp in temperatures:
        sub = df[df["temperature_C"] == temp].sort_values("time_months")
        temp_data[temp] = sub
        t = sub["time_months"].values.astype(float)
        p = sub["potency_percent"].values.astype(float)

        c0_z, k_z, r2_z = fit_zero_order(t, p)
        c0_f, k_f, r2_f = fit_first_order(t, p)

        if r2_z >= r2_f:
            fits[temp] = {"order": 0, "C0": c0_z, "k": k_z, "R2": r2_z}
        else:
            fits[temp] = {"order": 1, "C0": c0_f, "k": k_f, "R2": r2_f}

    # Determine dominant kinetic order
    orders = [f["order"] for f in fits.values()]
    dominant_order = max(set(orders), key=orders.count)

    # Re-fit with dominant order for consistency
    temps_arr = np.array(temperatures, dtype=float)
    ks = np.zeros(len(temperatures))
    c0_ref = 100.0

    for i, temp in enumerate(temperatures):
        sub = temp_data[temp]
        t = sub["time_months"].values.astype(float)
        p = sub["potency_percent"].values.astype(float)
        if dominant_order == 0:
            c0, k, r2 = fit_zero_order(t, p)
        else:
            c0, k, r2 = fit_first_order(t, p)
        fits[temp]["order"] = dominant_order
        fits[temp]["C0"] = c0
        fits[temp]["k"] = k
        fits[temp]["R2"] = r2
        ks[i] = k
        c0_ref = c0  # use last C0 as reference

    # Arrhenius fit
    Ea, ln_A, arr_r2 = fit_arrhenius(temps_arr, ks)
    k_target = predict_k(Ea, ln_A, args.target_temp)
    shelf = predict_shelf_life(c0_ref, k_target, args.spec_limit, dominant_order)

    # Plots
    deg_path = plot_degradation_curves(temp_data, fits, args.output_dir)
    arr_path = plot_arrhenius(temps_arr, ks, Ea, ln_A, args.output_dir)
    sl_path = plot_shelf_life(c0_ref, k_target, dominant_order,
                              args.spec_limit, shelf, args.target_temp,
                              args.output_dir)

    # Summary CSV
    rows = []
    for temp in temperatures:
        f = fits[temp]
        rows.append({
            "temperature_C": temp,
            "order": f["order"],
            "C0": f["C0"],
            "k": f["k"],
            "R_squared": f["R2"],
        })
    summary_df = pd.DataFrame(rows)
    summary_path = os.path.join(args.output_dir, "stability_summary.csv")
    summary_df.to_csv(summary_path, index=False)

    # Print
    print("=" * 65)
    print("PHARMACEUTICAL STABILITY PREDICTION")
    print("=" * 65)

    order_label = "Zero-order" if dominant_order == 0 else "First-order"
    print(f"\nDegradation model: {order_label}")
    print()

    print(f"{'Temp (C)':<12}{'k':>12}{'R-squared':>12}")
    print("-" * 36)
    for temp in temperatures:
        f = fits[temp]
        print(f"{temp:<12.0f}{f['k']:>12.4g}{f['R2']:>12.4f}")

    print(f"\nArrhenius Fit:")
    print(f"  Activation energy (Ea) = {Ea / 1000:.2f} kJ/mol")
    print(f"  Arrhenius R-squared    = {arr_r2:.4f}")
    print(f"\nPredicted k at {args.target_temp} C = {k_target:.4g}")
    shelf_str = f"{shelf:.1f} months" if np.isfinite(shelf) else "Infinite (no degradation)"
    print(f"Predicted shelf life     = {shelf_str}")
    print(f"  (to reach {args.spec_limit}% potency)")

    print(f"\nDegradation curves: {deg_path}")
    print(f"Arrhenius plot:     {arr_path}")
    print(f"Shelf-life plot:    {sl_path}")
    print(f"Summary CSV:        {summary_path}")


if __name__ == "__main__":
    main()

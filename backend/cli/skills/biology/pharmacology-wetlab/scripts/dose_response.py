#!/usr/bin/env python3
"""Dose-response curve fitting for IC50/EC50 determination.

Fits a 4-parameter logistic (4PL) model to concentration-response data and
extracts pharmacological parameters including IC50/EC50, Hill coefficient,
and plateau values.  Supports multi-compound datasets with selectivity-index
calculations.

Usage:
    python dose_response.py --data dose_response.csv --response-type inhibition --output-dir results/
    python dose_response.py --data multi_compound.csv --response-type activation --output-dir results/

Examples:
    # Single compound IC50
    python dose_response.py --data viability.csv --response-type inhibition --output-dir ./ic50_out

    # Multi-compound with selectivity index
    python dose_response.py --data selectivity.csv --response-type inhibition --output-dir ./sel_out
"""

import argparse
import os
import sys
import warnings
from typing import Tuple, Optional, Dict, List

import numpy as np
import pandas as pd
from scipy.optimize import curve_fit
from scipy.stats import t as t_dist
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


# ---------------------------------------------------------------------------
# Core model
# ---------------------------------------------------------------------------

def four_param_logistic(log_conc: np.ndarray, bottom: float, top: float,
                        log_ec50: float, hill: float) -> np.ndarray:
    """4-parameter logistic: y = Bottom + (Top - Bottom) / (1 + 10^((logEC50 - x)*Hill))

    Parameters
    ----------
    log_conc : array
        Log10-transformed concentrations.
    bottom, top : float
        Response plateaus.
    log_ec50 : float
        Log10(EC50).
    hill : float
        Hill slope.

    Returns
    -------
    array
        Predicted response values.
    """
    return bottom + (top - bottom) / (1.0 + np.power(10.0, (log_ec50 - log_conc) * hill))


def compute_r_squared(y_obs: np.ndarray, y_pred: np.ndarray) -> float:
    """Coefficient of determination."""
    ss_res = np.sum((y_obs - y_pred) ** 2)
    ss_tot = np.sum((y_obs - np.mean(y_obs)) ** 2)
    if ss_tot == 0:
        return float("nan")
    return 1.0 - ss_res / ss_tot


# ---------------------------------------------------------------------------
# Fitting
# ---------------------------------------------------------------------------

def initial_guesses(log_conc: np.ndarray, response: np.ndarray,
                    response_type: str) -> list:
    """Heuristic starting parameters for the 4PL fit."""
    bottom_guess = np.min(response)
    top_guess = np.max(response)
    log_ec50_guess = np.median(log_conc)
    hill_guess = -1.0 if response_type == "inhibition" else 1.0
    return [bottom_guess, top_guess, log_ec50_guess, hill_guess]


def fit_dose_response(concentrations: np.ndarray, responses: np.ndarray,
                      response_type: str = "inhibition"
                      ) -> Tuple[np.ndarray, np.ndarray, float]:
    """Fit 4PL model and return (popt, pcov, r_squared).

    Parameters
    ----------
    concentrations : array
        Raw (linear-scale) concentrations.  Must be > 0.
    responses : array
        Measured response values.
    response_type : str
        ``"inhibition"`` or ``"activation"``.

    Returns
    -------
    popt : array
        [bottom, top, log_ec50, hill]
    pcov : 2-d array
        Covariance matrix of parameters.
    r_squared : float
    """
    mask = concentrations > 0
    if not np.all(mask):
        warnings.warn("Dropping non-positive concentrations for log transform.")
    log_conc = np.log10(concentrations[mask])
    resp = responses[mask]

    p0 = initial_guesses(log_conc, resp, response_type)

    bounds_lower = [-np.inf, -np.inf, -np.inf, -np.inf]
    bounds_upper = [np.inf, np.inf, np.inf, np.inf]

    popt, pcov = curve_fit(
        four_param_logistic, log_conc, resp,
        p0=p0, bounds=(bounds_lower, bounds_upper),
        maxfev=20000,
    )

    y_pred = four_param_logistic(log_conc, *popt)
    r2 = compute_r_squared(resp, y_pred)
    return popt, pcov, r2


def ec50_confidence_interval(log_ec50: float, pcov: np.ndarray,
                             n_points: int, alpha: float = 0.05
                             ) -> Tuple[float, float]:
    """95 % CI for EC50 (linear scale) via delta method on log_ec50."""
    se_log = np.sqrt(pcov[2, 2])
    dof = max(n_points - 4, 1)
    t_val = t_dist.ppf(1.0 - alpha / 2.0, dof)
    low = 10.0 ** (log_ec50 - t_val * se_log)
    high = 10.0 ** (log_ec50 + t_val * se_log)
    return low, high


# ---------------------------------------------------------------------------
# Plotting
# ---------------------------------------------------------------------------

def plot_dose_response(concentrations: np.ndarray, responses: np.ndarray,
                       popt: np.ndarray, compound_label: str,
                       response_type: str, output_path: str) -> None:
    """Save a dose-response curve (log-scale x) with fit overlay."""
    fig, ax = plt.subplots(figsize=(7, 5))
    log_conc = np.log10(concentrations[concentrations > 0])

    ax.scatter(concentrations[concentrations > 0], responses[concentrations > 0],
               color="steelblue", edgecolors="black", s=50, zorder=3,
               label="Data")

    x_fit = np.logspace(log_conc.min() - 0.5, log_conc.max() + 0.5, 300)
    y_fit = four_param_logistic(np.log10(x_fit), *popt)
    ax.plot(x_fit, y_fit, color="crimson", linewidth=2, label="4PL fit")

    ec50_val = 10.0 ** popt[2]
    ax.axvline(ec50_val, linestyle="--", color="gray", alpha=0.6)
    label = "IC50" if response_type == "inhibition" else "EC50"
    ax.annotate(f"{label} = {ec50_val:.4g}", xy=(ec50_val, (popt[0] + popt[1]) / 2),
                fontsize=9, color="gray")

    ax.set_xscale("log")
    ax.set_xlabel("Concentration")
    ax.set_ylabel("Response")
    ax.set_title(f"Dose-Response: {compound_label}")
    ax.legend()
    fig.tight_layout()
    fig.savefig(output_path, dpi=150)
    plt.close(fig)


# ---------------------------------------------------------------------------
# Per-compound analysis
# ---------------------------------------------------------------------------

def analyse_compound(name: str, df: pd.DataFrame, response_type: str,
                     output_dir: str) -> Dict:
    """Run full dose-response analysis for one compound.

    Returns dict of pharmacological parameters.
    """
    conc = df["concentration"].values.astype(float)
    resp = df["response"].values.astype(float)

    # Average replicates at each concentration
    df_avg = df.groupby("concentration")["response"].agg(["mean", "sem", "count"]).reset_index()
    conc_avg = df_avg["concentration"].values.astype(float)
    resp_avg = df_avg["mean"].values.astype(float)

    popt, pcov, r2 = fit_dose_response(conc, resp, response_type)
    bottom, top, log_ec50, hill = popt
    ec50 = 10.0 ** log_ec50
    ci_low, ci_high = ec50_confidence_interval(log_ec50, pcov, len(conc))

    label = "IC50" if response_type == "inhibition" else "EC50"
    plot_path = os.path.join(output_dir, f"{name}_dose_response.png")
    plot_dose_response(conc, resp, popt, name, response_type, plot_path)

    result = {
        "compound": name,
        f"{label}": ec50,
        f"{label}_95CI_low": ci_low,
        f"{label}_95CI_high": ci_high,
        "Hill": hill,
        "Bottom": bottom,
        "Top": top,
        "R_squared": r2,
    }
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def load_data(path: str) -> pd.DataFrame:
    """Load CSV, validate required columns."""
    df = pd.read_csv(path)
    required = {"concentration", "response"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"CSV missing required columns: {missing}")
    return df


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Dose-response curve fitting for IC50/EC50 determination."
    )
    parser.add_argument("--data", required=True, help="CSV with columns: concentration, response, [compound], [replicate]")
    parser.add_argument("--response-type", choices=["inhibition", "activation"],
                        default="inhibition", help="Type of response (default: inhibition)")
    parser.add_argument("--output-dir", default=".", help="Directory for output files")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    df = load_data(args.data)

    # Determine compound grouping
    if "compound" in df.columns:
        compounds = df["compound"].unique().tolist()
    else:
        df["compound"] = "compound_1"
        compounds = ["compound_1"]

    results: List[Dict] = []
    for name in compounds:
        sub = df[df["compound"] == name].copy()
        if sub.empty:
            warnings.warn(f"No data for compound '{name}', skipping.")
            continue
        try:
            res = analyse_compound(name, sub, args.response_type, args.output_dir)
            results.append(res)
        except RuntimeError as exc:
            print(f"WARNING: Fit failed for {name}: {exc}", file=sys.stderr)
            continue

    if not results:
        print("ERROR: No compounds could be fit.", file=sys.stderr)
        sys.exit(1)

    results_df = pd.DataFrame(results)
    param_path = os.path.join(args.output_dir, "dose_response_parameters.csv")
    results_df.to_csv(param_path, index=False)

    # Selectivity index (multi-compound only)
    label = "IC50" if args.response_type == "inhibition" else "EC50"
    if len(results) > 1 and label in results_df.columns:
        ref_val = results_df[label].iloc[0]
        results_df["Selectivity_Index"] = results_df[label] / ref_val
        results_df.to_csv(param_path, index=False)

    # Print summary
    print("=" * 65)
    print("DOSE-RESPONSE ANALYSIS RESULTS")
    print("=" * 65)
    for _, row in results_df.iterrows():
        print(f"\nCompound: {row['compound']}")
        print(f"  {label}        = {row[label]:.4g}")
        if f"{label}_95CI_low" in row:
            print(f"  {label} 95% CI = [{row[f'{label}_95CI_low']:.4g}, {row[f'{label}_95CI_high']:.4g}]")
        print(f"  Hill coeff  = {row['Hill']:.4f}")
        print(f"  Bottom      = {row['Bottom']:.2f}")
        print(f"  Top         = {row['Top']:.2f}")
        print(f"  R-squared   = {row['R_squared']:.4f}")
        if "Selectivity_Index" in row and not pd.isna(row.get("Selectivity_Index")):
            print(f"  Selectivity = {row['Selectivity_Index']:.4f}")

    print(f"\nParameters saved to: {param_path}")
    print(f"Plots saved to: {args.output_dir}/")


if __name__ == "__main__":
    main()
